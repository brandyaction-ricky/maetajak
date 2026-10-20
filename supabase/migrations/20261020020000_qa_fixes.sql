-- 2026-10-20 DB QA fixes. Idempotent: every statement may be re-run.
--
-- Large production functions are NOT re-typed here. They are patched in place from the live catalog
-- text (pg_get_functiondef) with guarded, exact-anchor replacements, so the result is always the
-- current production definition plus the listed change (signatures, return shapes, owners and ACLs
-- are preserved by CREATE OR REPLACE). An anchor that is missing raises and aborts the migration.
--
--  1. KST business days. trading_date is written by the worker as a KST date (worker/performance.js
--     kstDayRange) and copy_operation_risk already cuts days in KST, but these RPCs cut "today",
--     "this month" and copy_started_at in the session time zone (UTC), so 00:00-09:00 KST was wrong:
--       get_my_dashboard_performance, get_my_dashboard_performance_range, get_my_trading_analysis,
--       get_admin_member_trading_analysis, get_admin_member_trading_analysis_range,
--       get_admin_member_monthly_performance, get_admin_operations_metrics
--       current_date        -> (now() at time zone 'Asia/Seoul')::date
--       copy_started_at::date -> (copy_started_at at time zone 'Asia/Seoul')::date
--     upsert_copy_current_state: copy_current_accounts.equity_day (the daily-loss day and the
--       opening equity of the KST performance row) observed_at::date -> KST date.
--       Deploy after 09:00 KST: then UTC and KST dates agree and no baseline resets at deploy time.
--     Not changed: get_admin_gate_broker_metrics. Its rows are UTC days by design (Gate broker API
--       timestamps bucketed in UTC by worker/broker-metrics.js), so a UTC "today" is consistent.
--  2. public.admin_disable_member_gate_api_connection(uuid,text) (called by src/main.js, missing in
--     production) recreated against the current schema.
--  3. Least privilege: anon loses EXECUTE on every public function except get_public_master_positions
--     (business decision pending); anon/authenticated lose write privileges on public tables and
--     sequences (the frontend only SELECTs profiles; all writes go through SECURITY DEFINER RPCs);
--     default privileges no longer give anon (or PUBLIC) EXECUTE on new functions.
--  4. RLS: auth.uid()/is_approved_admin() evaluated once per statement ((select ...)), same semantics.
--  5. Indexes for unindexed foreign keys (all tables < 50 MB). copy_position_states.last_cycle_id
--     is deliberately not indexed: it changes on every cycle and an index would turn ~155M HOT
--     updates into non-HOT updates.
--  6. claim_copy_entry_alerts: retry cap (20 claims). Exhausted rows stay undelivered with
--     last_error_code='ALERT_RETRY_EXHAUSTED' and next_attempt_at='infinity' (the table has no
--     status column; delivered_at/next_attempt_at/last_error_code are its state).
--  7. record_copy_worker_cycle: a member already in reduce_only is not rewritten every cycle.
--     copy_position_states is intentionally still written every cycle: last_cycle_id is the per-cycle
--     freshness proof read by observe_copy_ownership, claim_copy_order_intents,
--     authorize_copy_order_submission and record_verified_copy_worker_cycle.
--  8. record_copy_worker_cycle: position-state events (SYMBOL_PAUSED, POSITION_SYNCED, ...) carry
--     pause_reason next to previous_state.
--  9. copy_cycles: a PLANNED cycle becomes COMPLETED once all of its intents are terminal (no function,
--     worker or UI logic reads copy_cycles.status; prune_copy_history keys on created_at only).

set lock_timeout = '5s';

-- ---------------------------------------------------------------------------------------------
-- Session-temporary patch helpers (dropped at the end of this file).
-- ---------------------------------------------------------------------------------------------
create or replace function pg_temp.qa_patch_function(p_signature text, p_old text, p_new text,
  p_expected integer default 1)
returns text language plpgsql as $$
declare fn regprocedure := to_regprocedure(p_signature); def text; n integer;
begin
  if fn is null then raise notice 'QA patch skipped, function missing: %', p_signature; return 'MISSING'; end if;
  def := pg_get_functiondef(fn);
  if position(p_new in def) > 0 then return 'ALREADY_APPLIED'; end if;
  n := (length(def) - length(replace(def, p_old, ''))) / length(p_old);
  if n = 0 or (p_expected is not null and n <> p_expected) then
    raise exception 'QA_PATCH_ANCHOR_MISMATCH: % (found %, expected %)', p_signature, n, coalesce(p_expected::text, '>=1');
  end if;
  execute replace(def, p_old, p_new);
  return 'PATCHED';
end $$;

create or replace function pg_temp.qa_kst_dates(p_signature text)
returns text language plpgsql as $$
declare fn regprocedure := to_regprocedure(p_signature); def text; patched text;
begin
  if fn is null then raise notice 'QA KST patch skipped, function missing: %', p_signature; return 'MISSING'; end if;
  def := pg_get_functiondef(fn);
  patched := regexp_replace(def, '\mcurrent_date\M', '(now() at time zone ''Asia/Seoul'')::date', 'gi');
  patched := regexp_replace(patched, '\m((?:[a-z_]+\.)?copy_started_at)::date',
    '(\1 at time zone ''Asia/Seoul'')::date', 'g');
  if patched = def then return 'ALREADY_APPLIED'; end if;
  execute patched;
  if pg_get_functiondef(fn) ~* '\mcurrent_date\M' or pg_get_functiondef(fn) ~ 'copy_started_at::date' then
    raise exception 'QA_KST_PATCH_INCOMPLETE: %', p_signature;
  end if;
  return 'PATCHED';
end $$;

-- ---------------------------------------------------------------------------------------------
-- 1. KST business days
-- ---------------------------------------------------------------------------------------------
select pg_temp.qa_kst_dates(s) from unnest(array[
  'public.get_my_dashboard_performance(integer)',
  'public.get_my_dashboard_performance_range(date,date)',
  'public.get_my_trading_analysis()',
  'public.get_admin_member_trading_analysis(uuid)',
  'public.get_admin_member_trading_analysis_range(uuid,date,date)',
  'public.get_admin_member_monthly_performance(uuid,integer)',
  'public.get_admin_operations_metrics(date,date)'
]) s;

select pg_temp.qa_patch_function('public.upsert_copy_current_state(jsonb)',
  'observed_at::date', '(observed_at at time zone ''Asia/Seoul'')::date', null);

-- ---------------------------------------------------------------------------------------------
-- 7. A member already in reduce_only is not rewritten (profiles.updated_at bumped every ~5 s).
-- ---------------------------------------------------------------------------------------------
select pg_temp.qa_patch_function('public.record_copy_worker_cycle(jsonb)',
  E'set reduce_only = true, updated_at = now()\n      where id = (member->>''user_id'')::uuid;',
  E'set reduce_only = true, updated_at = now()\n      where id = (member->>''user_id'')::uuid and reduce_only is distinct from true;');

-- ---------------------------------------------------------------------------------------------
-- 8. Position-state events carry pause_reason (previous_state is already present).
-- ---------------------------------------------------------------------------------------------
select pg_temp.qa_patch_function('public.record_copy_worker_cycle(jsonb)',
  E'''previous_state'', previous_state,',
  E'''previous_state'', previous_state,\n            ''pause_reason'', nullif(position->>''pause_reason'', ''''),');

-- ---------------------------------------------------------------------------------------------
-- 2. Admin disconnects a member's Gate API connection (same effect as disable_my_gate_api_connection
--    for that member, plus unsubmitted intents cancelled and an admin audit row).
-- ---------------------------------------------------------------------------------------------
create or replace function public.admin_disable_member_gate_api_connection(p_user_id uuid, p_confirmation text)
 returns void
 language plpgsql
 security definer
 set search_path to 'public', 'extensions', 'pg_temp'
as $function$
declare encryption_key text; before_state jsonb;
begin
  if not public.is_approved_admin() then raise exception 'ADMIN_REQUIRED'; end if;
  if p_confirmation is distinct from 'ADMIN_DISCONNECT_MEMBER_GATE_API' then raise exception 'CONFIRMATION_REQUIRED'; end if;
  select jsonb_build_object('copy_paused',p.copy_paused,'member_halted',p.member_halted,
      'api_status',(select g.status from private.gate_api_credentials g where g.user_id=p.id and g.connection_role='MEMBER'))
    into before_state from public.profiles p where p.id=p_user_id and p.role='MEMBER';
  if before_state is null then raise exception 'MEMBER_NOT_FOUND'; end if;
  select decrypted_secret into encryption_key from vault.decrypted_secrets where name='gate_api_credentials_key';
  if coalesce(encryption_key,'')='' then raise exception 'CREDENTIAL_ENCRYPTION_KEY_MISSING'; end if;
  -- Same serialization as member pause/resume: no worker cycle interleaves with the disconnect.
  perform pg_advisory_xact_lock(hashtextextended('maetajak:copy-execution',0));
  update public.profiles set copy_paused=true,member_halted=true,updated_at=now() where id=p_user_id and role='MEMBER';
  update private.trading_accounts set status='DISABLED',updated_at=now()
    where credential_user_id=p_user_id and account_role='MEMBER';
  update private.copy_order_intents set status='CANCELLED',resolved_at=now(),
      last_error_code='MEMBER_API_DISCONNECTED_BY_ADMIN',updated_at=now()
    where user_id=p_user_id and status in ('PLANNED','QUEUED') and submit_attempts=0;
  delete from private.gate_api_verification_jobs where user_id=p_user_id;
  update private.gate_api_credentials set gate_uid='DISABLED',api_key_ciphertext=pgp_sym_encrypt(encode(gen_random_bytes(32),'hex'),encryption_key,'cipher-algo=aes256'),
    secret_key_ciphertext=pgp_sym_encrypt(encode(gen_random_bytes(32),'hex'),encryption_key,'cipher-algo=aes256'),api_key_last4='NONE',status='DISABLED',
    futures_read=false,futures_trade=false,ip_whitelisted=false,withdrawal_disabled=true,verified_at=null,updated_at=now()
    where user_id=p_user_id and connection_role='MEMBER';
  insert into public.copy_events(user_id,event_type,severity,safe_payload)
    values(p_user_id,'MEMBER_HALTED','WARNING',jsonb_build_object('reason','API_DISCONNECTED_BY_ADMIN'));
  insert into public.admin_audit_logs(actor_id,action,target_user_id,previous_value,next_value)
    values(auth.uid(),'MEMBER_GATE_API_DISCONNECTED',p_user_id,before_state,
      jsonb_build_object('copy_paused',true,'member_halted',true,'api_status','DISABLED'));
end;
$function$;
revoke all on function public.admin_disable_member_gate_api_connection(uuid, text) from public, anon, service_role;
grant execute on function public.admin_disable_member_gate_api_connection(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- 6. Entry alert outbox retry cap (production definition + cap). Each claim decrypts the member key,
--    so an undeliverable alert must stop being claimed.
-- ---------------------------------------------------------------------------------------------
create or replace function public.claim_copy_entry_alerts(p_limit integer default 10)
 returns table(alert_id bigint, event_type text, details jsonb, gate_order_id text, gate_order_text text, contract text, position_side text, delta_size numeric, reduce_only boolean, target_size numeric, filled_size numeric, result_status text, quanto_multiplier numeric, error_code text, api_key text, secret_key text)
 language plpgsql
 security definer
 set search_path to 'pg_catalog', 'extensions'
as $function$
declare encryption_key text;
begin
  perform private.require_copy_worker_role();
  -- Retry cap: after 20 claims an undelivered alert is dead. It stays undelivered (delivered_at null,
  -- still visible as pending_alerts) but is never claimed again.
  update private.copy_entry_alert_outbox o set claimed_at=null,next_attempt_at='infinity',
      last_error_code='ALERT_RETRY_EXHAUSTED',updated_at=now()
  where o.id in (select x.id from private.copy_entry_alert_outbox x
    where x.delivered_at is null and x.attempts>=20 and x.next_attempt_at<>'infinity'::timestamptz
      and (x.claimed_at is null or x.claimed_at<clock_timestamp()-interval '2 minutes')
    for update skip locked);
  select decrypted_secret into encryption_key from vault.decrypted_secrets where name='gate_api_credentials_key';
  return query with candidates as (
    select o.id from private.copy_entry_alert_outbox o
    where o.delivered_at is null and o.attempts<20 and o.next_attempt_at<=clock_timestamp()
      and (o.claimed_at is null or o.claimed_at<clock_timestamp()-interval '2 minutes')
    order by o.next_attempt_at,o.id for update skip locked
    limit greatest(1,least(coalesce(p_limit,10),50))
  ), claimed as (
    update private.copy_entry_alert_outbox o set claimed_at=clock_timestamp(),attempts=o.attempts+1,updated_at=now()
    from candidates c where o.id=c.id returning o.*
  ) select c.id,c.event_type,c.safe_payload,i.gate_order_id,i.gate_order_text,i.contract,i.position_side,
      i.delta_size,i.reduce_only,i.target_size,i.filled_size,i.status,(i.plan_evidence->>'quanto_multiplier')::numeric,i.last_error_code,
      extensions.pgp_sym_decrypt(g.api_key_ciphertext,encryption_key),extensions.pgp_sym_decrypt(g.secret_key_ciphertext,encryption_key)
    from claimed c join private.copy_order_intents i on i.id=c.intent_id
    join private.trading_accounts a on a.id=i.trading_account_id
    left join private.gate_api_credentials g on g.user_id=a.credential_user_id;
end;
$function$;
revoke all on function public.claim_copy_entry_alerts(integer) from public, anon, authenticated;
grant execute on function public.claim_copy_entry_alerts(integer) to service_role;

-- ---------------------------------------------------------------------------------------------
-- 9. Cycle lifecycle: PLANNED -> COMPLETED when the last intent of the cycle becomes terminal.
--    Terminal = FILLED, CANCELLED, REJECTED, or PARTIALLY_FILLED with exchange_terminal.
-- ---------------------------------------------------------------------------------------------
create or replace function private.complete_copy_cycle_after_terminal_intent()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'pg_catalog'
as $function$
begin
  if not (new.status in ('FILLED','CANCELLED','REJECTED') or (new.status='PARTIALLY_FILLED' and new.exchange_terminal)) then
    return null;
  end if;
  update private.copy_cycles c set status='COMPLETED',completed_at=coalesce(c.completed_at,now())
  where c.id=new.cycle_id and c.status='PLANNED'
    and not exists(select 1 from private.copy_order_intents i where i.cycle_id=c.id
      and not (i.status in ('FILLED','CANCELLED','REJECTED') or (i.status='PARTIALLY_FILLED' and i.exchange_terminal)));
  return null;
end;
$function$;
revoke all on function private.complete_copy_cycle_after_terminal_intent() from public, anon, authenticated;

do $$
begin
  if not exists (select 1 from pg_trigger where tgrelid='private.copy_order_intents'::regclass
      and tgname='complete_copy_cycle_after_terminal_intent' and not tgisinternal) then
    create trigger complete_copy_cycle_after_terminal_intent
      after update of status, exchange_terminal on private.copy_order_intents
      for each row when (old.status is distinct from new.status or old.exchange_terminal is distinct from new.exchange_terminal)
      execute function private.complete_copy_cycle_after_terminal_intent();
  end if;
end $$;

-- One-time catch-up for cycles whose intents are already all terminal (8,404 rows on 2026-10-20).
update private.copy_cycles c
set status='COMPLETED',
    completed_at=coalesce((select max(coalesce(i.resolved_at,i.updated_at)) from private.copy_order_intents i where i.cycle_id=c.id), now())
where c.status='PLANNED'
  and exists(select 1 from private.copy_order_intents i where i.cycle_id=c.id)
  and not exists(select 1 from private.copy_order_intents i where i.cycle_id=c.id
    and not (i.status in ('FILLED','CANCELLED','REJECTED') or (i.status='PARTIALLY_FILLED' and i.exchange_terminal)));

-- ---------------------------------------------------------------------------------------------
-- 4. RLS: evaluate auth.uid() and is_approved_admin() once per statement (same semantics).
-- ---------------------------------------------------------------------------------------------
do $$
declare p record;
begin
  for p in select * from (values
      ('profiles','profiles_select_self_or_admin','id'),
      ('copy_position_states','members read own copy position states','user_id'),
      ('copy_events','members read own copy events','user_id'),
      ('member_daily_performance','members read own daily performance','user_id'),
      ('legal_acceptances','members read own legal acceptances','user_id'),
      ('member_symbol_daily_performance','members read own symbol performance','user_id')
    ) v(tbl, pol, col)
  loop
    if exists (select 1 from pg_policies where schemaname='public' and tablename=p.tbl and policyname=p.pol) then
      execute format('alter policy %I on public.%I using ((%I = (select auth.uid())) or (select public.is_approved_admin()))',
        p.pol, p.tbl, p.col);
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------------------------------
-- 5. Covering indexes for foreign keys (performance advisor). Plain CREATE INDEX: every table is
--    small (largest: private.copy_order_intents, 42 MB). Tables above 50 MB are skipped.
-- ---------------------------------------------------------------------------------------------
do $$
declare x record;
begin
  for x in select * from (values
      ('private','copy_operation_history','user_id','copy_operation_history_user_id_idx'),
      ('private','copy_operation_risk','operation_id','copy_operation_risk_operation_id_idx'),
      ('private','copy_order_intents','user_id','copy_order_intents_user_id_idx'),
      ('private','copy_position_snapshots','trading_account_id','copy_position_snapshots_trading_account_id_idx'),
      ('private','open_order_cancel_jobs','requested_by','open_order_cancel_jobs_requested_by_idx'),
      ('public','admin_audit_logs','actor_id','admin_audit_logs_actor_id_idx'),
      ('public','admin_audit_logs','target_user_id','admin_audit_logs_target_user_id_idx'),
      ('public','copy_system_control','updated_by','copy_system_control_updated_by_idx'),
      ('public','profiles','approved_by','profiles_approved_by_idx')
    ) v(sch, tbl, col, idx)
  loop
    if to_regclass(format('%I.%I', x.sch, x.tbl)) is null or not exists (select 1 from pg_attribute
        where attrelid=to_regclass(format('%I.%I', x.sch, x.tbl)) and attname=x.col and not attisdropped) then
      raise notice 'FK index skipped, missing %.%.%', x.sch, x.tbl, x.col;
    elsif pg_total_relation_size(to_regclass(format('%I.%I', x.sch, x.tbl))) > 50 * 1024 * 1024 then
      raise notice 'FK index skipped, table above 50 MB: %.%', x.sch, x.tbl;
    else
      execute format('create index if not exists %I on %I.%I (%I)', x.idx, x.sch, x.tbl, x.col);
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------------------------------
-- 3. Least privilege for the logged-out (anon) role and table writes.
--    No RPC runs before login (src/main.js calls get_copy_system_status only with a profile), so
--    anon keeps EXECUTE only on get_public_master_positions (exposure decision pending).
-- ---------------------------------------------------------------------------------------------
do $$
declare f record;
begin
  if not exists (select 1 from pg_roles where rolname='anon') then return; end if;
  for f in
    select p.oid::regprocedure as sig, p.proname,
      (p.proacl is null or exists (select 1 from aclexplode(p.proacl) a where a.grantee=0 and a.privilege_type='EXECUTE')) as public_exec
    from pg_proc p
    where p.pronamespace='public'::regnamespace and p.prokind in ('f','p')
      and not exists (select 1 from pg_depend d where d.classid='pg_proc'::regclass and d.objid=p.oid and d.deptype='e')
      and has_function_privilege('anon', p.oid, 'EXECUTE')
      and p.proname <> 'get_public_master_positions'
  loop
    if f.public_exec then
      -- Keep what authenticated/service_role had through PUBLIC; only anon loses access.
      execute format('grant execute on function %s to authenticated, service_role', f.sig);
      execute format('revoke execute on function %s from public', f.sig);
    end if;
    execute format('revoke execute on function %s from anon', f.sig);
  end loop;
  if exists (select 1 from pg_proc p where p.pronamespace='public'::regnamespace
      and p.proname <> 'get_public_master_positions' and has_function_privilege('anon', p.oid, 'EXECUTE')
      and not exists (select 1 from pg_depend d where d.classid='pg_proc'::regclass and d.objid=p.oid and d.deptype='e')) then
    raise exception 'ANON_EXECUTE_REVOKE_INCOMPLETE';
  end if;
end $$;

do $$
declare t record;
begin
  if not exists (select 1 from pg_roles where rolname='anon')
    or not exists (select 1 from pg_roles where rolname='authenticated') then return; end if;
  -- TRUNCATE bypasses RLS, so it matters even though PostgREST does not expose it.
  for t in select c.oid::regclass as rel from pg_class c
    where c.relnamespace='public'::regnamespace and c.relkind in ('r','p','v','m','f')
  loop
    execute format('revoke insert, update, delete, truncate, references, trigger on table %s from anon, authenticated', t.rel);
  end loop;
  for t in select c.oid::regclass as rel from pg_class c
    where c.relnamespace='public'::regnamespace and c.relkind='S'
  loop
    execute format('revoke usage, update on sequence %s from anon, authenticated', t.rel);
  end loop;
end $$;

do $$
begin
  if not exists (select 1 from pg_roles where rolname='anon') then return; end if;
  begin
    -- Schema default (Supabase grants anon EXECUTE on new public functions) ...
    alter default privileges in schema public revoke execute on functions from anon;
    -- ... and the built-in global PUBLIC grant, which anon would otherwise still inherit.
    -- New public functions keep authenticated/service_role through the schema default.
    alter default privileges revoke execute on functions from public;
  exception when insufficient_privilege then
    raise warning 'default privileges unchanged for %: %', current_user, sqlerrm;
  end;
end $$;

drop function if exists pg_temp.qa_patch_function(text, text, text, integer);
drop function if exists pg_temp.qa_kst_dates(text);
