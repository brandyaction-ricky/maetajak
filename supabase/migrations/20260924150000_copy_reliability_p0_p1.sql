-- [03_BUGFIX] Copy reliability P0/P1 (QA 2026-09-24). DB half of the fix; the worker half ships separately.
-- Backward compatible with the running worker 0.5.0: every signature is unchanged except
-- claim_copy_reconciliation_jobs, which only gains OUT columns (PostgREST returns them as extra JSON keys
-- that 0.5.0 ignores). worker_version gates stay '0.5.0'.
--
--  P1-1  Transient failures no longer freeze the whole system: claims already stop while
--        consecutive_failures>0 (degraded, no orders); the global halt now needs >=3 failures that have
--        lasted >=5 minutes. An existing halt reason is never overwritten; SYSTEM_HALTED only on transition.
--  P1-7  Duplicate-order detector: a repeated same-size intent is a duplicate only while the earlier
--        order was in flight or its fill was not yet observation-confirmed when the later one was planned.
--        Open -> close -> reopen after confirmed observations is normal trading, not a halt.
--  P1-4  CLOSE ("stop copy + close positions") works as an exit: the ownership ledger no longer latches
--        UNKNOWN during CLOSING (closing a protected leg made the journal invalid), UNKNOWN no longer blocks
--        close-only orders, and whatever remains is recorded as member-owned so a later RESUME can start.
--  P1-5  Orders that provably never reached Gate stop blocking the account: never-authorized UNKNOWN
--        intents are cancelled like never-authorized SUBMITTING ones, and "not found after Exptime"
--        resolutions are accepted only when the Gate expiry has long passed.
--  P1-6  Read-only feed of fills whose observation never confirmed (alerting).
--  P0-1  Target anchors can store the Master quantity actually consumed by an incremental member lot, so
--        rounding remainders accumulate instead of being lost on every Master increase.

alter table private.copy_worker_runtime add column if not exists failure_started_at timestamptz;

-- P1-1 ---------------------------------------------------------------------------------------------
create or replace function public.report_copy_worker_cycle(p_success boolean, p_error_code text default null)
returns jsonb language plpgsql security definer set search_path=public,pg_temp
as $$
declare runtime private.copy_worker_runtime; control public.copy_system_control; newly_halted boolean := false;
begin
  update private.copy_worker_runtime set
    consecutive_failures=case when p_success then 0 else consecutive_failures+1 end,
    failure_started_at=case when p_success then null
      when consecutive_failures=0 or failure_started_at is null then now() else failure_started_at end,
    last_success_at=case when p_success then now() else last_success_at end,
    last_error_code=case when p_success then null else left(coalesce(p_error_code,'WORKER_CYCLE_ERROR'),80) end,
    updated_at=now()
  where singleton returning * into runtime;
  -- While failures>0 no order can be claimed or authorized (both require consecutive_failures=0),
  -- so a short outage is already safe. Halt (manual re-enable) only for a sustained failure.
  if not p_success and runtime.mode='LIVE' and runtime.consecutive_failures>=3
    and runtime.failure_started_at<=now()-interval '5 minutes' then
    update public.copy_system_control set execution_enabled=false,emergency_halted=true,
      halt_reason='WORKER_REPEATED_FAILURE',updated_at=now()
      where singleton and execution_enabled and not emergency_halted;
    newly_halted := found;
    if newly_halted then
      insert into public.copy_events(event_type,severity,safe_payload)
      values('SYSTEM_HALTED','CRITICAL',jsonb_build_object('reason','WORKER_REPEATED_FAILURE',
        'error_code',runtime.last_error_code,'failures',runtime.consecutive_failures,
        'failure_started_at',runtime.failure_started_at));
    end if;
  end if;
  select * into control from public.copy_system_control where singleton;
  return jsonb_build_object('consecutive_failures',runtime.consecutive_failures,'last_success_at',runtime.last_success_at,
    'last_error_code',runtime.last_error_code,'failure_started_at',runtime.failure_started_at,
    'halted',coalesce(control.emergency_halted or not control.execution_enabled,true),
    'newly_halted',newly_halted,'halt_after_seconds',300);
end;
$$;
revoke all on function public.report_copy_worker_cycle(boolean,text) from public, anon, authenticated;
grant execute on function public.report_copy_worker_cycle(boolean,text) to service_role;

-- P1-7 ---------------------------------------------------------------------------------------------
create or replace function public.detect_and_halt_copy_order_anomaly()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  control public.copy_system_control%rowtype;
  anomaly record;
begin
  if auth.role() <> 'service_role' then
    raise exception 'SERVICE_ROLE_REQUIRED';
  end if;

  select * into control
  from public.copy_system_control
  where singleton
  for update;

  if not control.execution_enabled or control.emergency_halted then
    return jsonb_build_object(
      'anomaly_detected', false,
      'newly_halted', false,
      'reason', control.halt_reason
    );
  end if;

  -- A stale-position order loop plans the same order again from the same observed size while the
  -- earlier order's effect is not yet visible. Only such pairs are duplicates. An earlier intent that
  -- never reached Gate (submit_attempts=0) or whose fill was observation-confirmed before the later
  -- plan was created cannot be repeated by the later one.
  select
    later.trading_account_id,
    later.contract,
    later.position_side,
    later.actual_size_at_plan,
    sign(later.delta_size) as delta_direction,
    count(*) + 1 as duplicate_count,
    min(earlier.created_at) as first_created_at,
    max(later.created_at) as last_created_at
  into anomaly
  from private.copy_order_intents later
  join private.copy_order_intents earlier
    on earlier.trading_account_id = later.trading_account_id
   and earlier.contract = later.contract
   and earlier.position_side = later.position_side
   and earlier.actual_size_at_plan = later.actual_size_at_plan
   and sign(earlier.delta_size) = sign(later.delta_size)
   and earlier.reduce_only = later.reduce_only
   and (earlier.created_at < later.created_at
     or (earlier.created_at = later.created_at and earlier.id < later.id))
  where later.created_at >= greatest(control.updated_at, now() - interval '30 seconds')
    and earlier.created_at >= greatest(control.updated_at, now() - interval '30 seconds')
    and later.status in ('PLANNED', 'SUBMITTING', 'ACKNOWLEDGED', 'PARTIALLY_FILLED', 'FILLED', 'UNKNOWN')
    and earlier.status in ('SUBMITTING', 'ACKNOWLEDGED', 'PARTIALLY_FILLED', 'FILLED', 'UNKNOWN')
    and later.delta_size <> 0
    and earlier.delta_size <> 0
    and earlier.submit_attempts > 0
    and (earlier.observation_confirmed_at is null or earlier.observation_confirmed_at > later.created_at)
  group by
    later.trading_account_id,
    later.contract,
    later.position_side,
    later.actual_size_at_plan,
    sign(later.delta_size),
    later.reduce_only
  order by max(later.created_at) desc
  limit 1;

  if anomaly.trading_account_id is null then
    return jsonb_build_object('anomaly_detected', false, 'newly_halted', false);
  end if;

  update public.copy_system_control
  set execution_enabled = false,
      emergency_halted = true,
      halt_reason = 'DUPLICATE_ORDER_ANOMALY',
      updated_at = now()
  where singleton;

  insert into public.copy_events(event_type, severity, safe_payload)
  values (
    'SYSTEM_HALTED',
    'CRITICAL',
    jsonb_build_object(
      'reason', 'DUPLICATE_ORDER_ANOMALY',
      'contract', anomaly.contract,
      'position_side', anomaly.position_side,
      'duplicate_count', anomaly.duplicate_count,
      'first_created_at', anomaly.first_created_at,
      'last_created_at', anomaly.last_created_at
    )
  );

  return jsonb_build_object(
    'anomaly_detected', true,
    'newly_halted', true,
    'reason', 'DUPLICATE_ORDER_ANOMALY',
    'contract', anomaly.contract,
    'position_side', anomaly.position_side,
    'duplicate_count', anomaly.duplicate_count
  );
end;
$$;
revoke all on function public.detect_and_halt_copy_order_anomaly() from public, anon, authenticated;
grant execute on function public.detect_and_halt_copy_order_anomaly() to service_role;

-- P1-4 ---------------------------------------------------------------------------------------------
-- UNKNOWN ownership must not trap a member who asked to stop and close. The claim, authorization and
-- intent guards already restrict a close-requested (reduce_only) member to reduce-only target-0 orders.
create or replace function private.copy_resume_policy_authorized(p_account uuid,p_version uuid)
returns boolean language sql stable set search_path=pg_catalog as $$
  select exists(select 1 from private.copy_resume_sessions s where s.trading_account_id=p_account and s.version=p_version
    and (not s.sync_current_master or private.copy_resume_operation_id(p_account,p_version) is not null)
    and (not exists(select 1 from private.copy_ownership_checkpoints where trading_account_id=p_account and status='UNKNOWN')
      or (s.state='CLOSING' and exists(select 1 from private.trading_accounts a join public.profiles p on p.id=a.user_id
        where a.id=p_account and p.close_positions_requested and p.reduce_only))))
$$;
revoke all on function private.copy_resume_policy_authorized(uuid,uuid) from public,anon,authenticated;

-- Base: production body after 20260921125321 (md5 14896b3e33341e8e79154f170ba2205a). Only the CLOSING
-- branch is new. CLOSE rotates the session version and may close protected legs, which the per-fill
-- journal cannot express (a negative copy leg), so it latched UNKNOWN after the first closed leg.
-- During CLOSING the platform releases ownership: once no order is in flight, the checkpoint records
-- the verified holdings as member-owned (copy=[]) and journals the confirmed fills, so a later RESUME
-- starts FUTURE_ONLY from what the member actually holds.
create or replace function private.observe_copy_ownership()
returns trigger language plpgsql security definer set search_path=pg_catalog as $$
declare proof private.copy_ownership_checkpoints; baseline private.member_copy_onboarding_baselines;
  actual jsonb; copied jsonb; expected jsonb; item private.copy_order_intents;
  applied uuid[] := '{}'; invalid boolean := false;
  closing_session private.copy_resume_sessions; closing boolean := false; has_proof boolean := false;
begin
  if new.status<>'VERIFIED' then return new; end if;
  perform pg_advisory_xact_lock(hashtextextended('maetajak:copy-execution',0));
  select * into baseline from private.member_copy_onboarding_baselines where trading_account_id=new.trading_account_id;
  if not found then return new; end if; -- not a member baseline
  select private.copy_position_sum(coalesce(jsonb_agg(jsonb_build_object('contract',p.contract,
    'position_side',p.position_side,'size',p.size)),'[]')) into actual
    from private.copy_current_positions p where p.trading_account_id=new.trading_account_id and p.copy_cycle_id=new.cycle_id;
  select s.* into closing_session from private.copy_resume_sessions s
    join private.trading_accounts a on a.id=s.trading_account_id
    join public.profiles pr on pr.id=a.user_id
    where s.trading_account_id=new.trading_account_id and s.state='CLOSING' and pr.close_positions_requested;
  closing := found;
  select * into proof from private.copy_ownership_checkpoints where trading_account_id=new.trading_account_id for update;
  has_proof := found;
  if closing then
    if exists(select 1 from private.copy_order_intents i where i.trading_account_id=new.trading_account_id
      and ((i.submit_attempts>0 and i.status in ('SUBMITTING','ACKNOWLEDGED','UNKNOWN','PARTIALLY_FILLED') and not i.exchange_terminal)
        or (i.filled_size<>0 and i.observation_confirmed_at is null and i.resume_version is not null))) then return new; end if;
    if (has_proof and new.observed_at<=proof.observed_at) or not private.copy_resume_positions_valid(actual) then return new; end if;
    insert into private.copy_ownership_checkpoints(trading_account_id,resume_version,status,protected_positions,
      copy_positions,observed_at,source_cycle_id,reason)
      values(new.trading_account_id,closing_session.version,'CONFIRMED',actual,'[]',new.observed_at,new.cycle_id,
        'CLOSE_OWNERSHIP_RELEASED')
      on conflict(trading_account_id) do update set resume_version=excluded.resume_version,status='CONFIRMED',
        protected_positions=excluded.protected_positions,copy_positions='[]',observed_at=excluded.observed_at,
        source_cycle_id=excluded.source_cycle_id,reason=excluded.reason,
        revision=private.copy_ownership_checkpoints.revision+1
      where private.copy_ownership_checkpoints.status<>'CONFIRMED'
        or private.copy_ownership_checkpoints.resume_version is distinct from excluded.resume_version
        or private.copy_ownership_checkpoints.protected_positions is distinct from excluded.protected_positions
        or private.copy_ownership_checkpoints.copy_positions<>'[]'::jsonb;
    insert into private.copy_ownership_fills(intent_id,trading_account_id,resume_version,filled_size,confirmed_at)
      select i.id,i.trading_account_id,i.resume_version,i.filled_size,i.observation_confirmed_at
      from private.copy_order_intents i
      where i.trading_account_id=new.trading_account_id and i.filled_size<>0
        and i.resume_version is not null and i.observation_confirmed_at is not null
      on conflict(intent_id) do update set filled_size=excluded.filled_size,resume_version=excluded.resume_version,
        confirmed_at=excluded.confirmed_at
      where (private.copy_ownership_fills.filled_size,private.copy_ownership_fills.resume_version,
          private.copy_ownership_fills.confirmed_at)
        is distinct from (excluded.filled_size,excluded.resume_version,excluded.confirmed_at);
    return new;
  end if;
  if not has_proof then
    -- A migration must not silently bless an already traded/legacy account.
    if exists(select 1 from private.copy_order_intents where trading_account_id=new.trading_account_id and filled_size<>0)
      or actual is distinct from private.copy_position_sum(baseline.member_positions) then return new; end if;
    insert into private.copy_ownership_checkpoints(trading_account_id,resume_version,status,
      protected_positions,observed_at,source_cycle_id)
      values(new.trading_account_id,baseline.resume_version,'CONFIRMED',actual,new.observed_at,new.cycle_id);
    return new;
  end if;
  if proof.status='UNKNOWN' or new.observed_at<=proof.observed_at then return new; end if;
  -- A pending/ambiguous fill is not failure and is not reusable ownership.
  if exists(select 1 from private.copy_order_intents i where i.trading_account_id=new.trading_account_id
    and ((i.submit_attempts>0 and i.status in ('SUBMITTING','ACKNOWLEDGED','UNKNOWN','PARTIALLY_FILLED') and not i.exchange_terminal)
      or (i.filled_size<>0 and i.observation_confirmed_at is null and i.resume_version is not null))) then return new; end if;
  copied:=proof.copy_positions;
  for item in select i.* from private.copy_order_intents i
    where i.trading_account_id=new.trading_account_id and i.filled_size<>0 and i.resume_version is not null
      and not exists(select 1 from private.copy_ownership_fills f where f.intent_id=i.id)
    order by i.resolved_at,i.id
  loop
    expected:=private.copy_position_sum(proof.protected_positions||copied);
    if item.resume_version is distinct from proof.resume_version or item.observation_confirmed_at is null
      -- cycle observed_at is the read START, confirmation is the account read
      -- END. Compare to this verified write, not to the earlier cycle start.
      or item.observation_confirmed_at>new.verified_at
      or (not item.exchange_terminal and item.status not in ('FILLED','CANCELLED','REJECTED'))
      or item.actual_size_at_plan is distinct from coalesce((select (p->>'size')::numeric
        from jsonb_array_elements(expected) p where p->>'contract'=item.contract and p->>'position_side'=item.position_side),0)
      then invalid:=true; exit; end if;
    copied:=private.copy_position_sum(copied||jsonb_build_array(jsonb_build_object(
      'contract',item.contract,'position_side',item.position_side,'size',item.filled_size)));
    applied:=array_append(applied,item.id);
  end loop;
  if invalid or not private.copy_resume_positions_valid(copied)
    or actual is distinct from private.copy_position_sum(proof.protected_positions||copied)
    or exists(select 1 from private.copy_ownership_fills f join private.copy_order_intents i on i.id=f.intent_id
      where f.trading_account_id=new.trading_account_id and (f.filled_size<>i.filled_size
        or f.resume_version is distinct from i.resume_version or f.confirmed_at is distinct from i.observation_confirmed_at)) then
    update private.copy_ownership_checkpoints set status='UNKNOWN',reason='OBSERVED_OWNERSHIP_MISMATCH',revision=revision+1
      where trading_account_id=new.trading_account_id;
    -- Only unsubmitted engine candidates, never Gate orders, are invalidated.
    update private.copy_order_intents set status='CANCELLED',last_error_code='COPY_OWNERSHIP_UNKNOWN',updated_at=now()
      where trading_account_id=new.trading_account_id and status in ('PLANNED','QUEUED') and submit_attempts=0;
    update public.copy_position_states set state=case when state='MANUAL_OVERRIDE' then state else 'PAUSED' end,
      pause_reason='COPY_OWNERSHIP_UNKNOWN'
      where trading_account_id=new.trading_account_id;
  else
    insert into private.copy_ownership_fills(intent_id,trading_account_id,resume_version,filled_size,confirmed_at)
      select id,trading_account_id,resume_version,filled_size,observation_confirmed_at
      from private.copy_order_intents where id=any(applied);
    update private.copy_ownership_checkpoints set copy_positions=copied,observed_at=new.observed_at,
      source_cycle_id=new.cycle_id,revision=revision+1 where trading_account_id=new.trading_account_id;
  end if;
  return new;
end;
$$;
revoke all on function private.observe_copy_ownership() from public,anon,authenticated;

-- P1-5 ---------------------------------------------------------------------------------------------
drop function if exists public.claim_copy_reconciliation_jobs(integer);
create function public.claim_copy_reconciliation_jobs(p_limit integer default 10)
 returns table(job_id bigint, intent_id uuid, contract text, gate_order_id text, gate_order_text text, api_key text,
   secret_key text, delta_size numeric, position_side text, reduce_only boolean, target_size numeric,
   trading_account_id uuid, user_id uuid, actual_size_at_plan numeric, source_observed_at timestamptz,
   submitted_at timestamptz, submission_authorized_at timestamptz, job_attempts integer)
 language plpgsql
 security definer
 set search_path to 'public', 'extensions', 'pg_temp'
as $function$
declare encryption_key text;
begin
  perform private.require_copy_worker_role();
  perform pg_advisory_xact_lock(hashtextextended('maetajak:copy-execution',0));
  -- A new-generation claim that was never authorized cannot have reached Gate: the worker places an
  -- order only after authorize_copy_order_submission committed submission_authorized_at. This also
  -- settles pre-send failures an older worker recorded as UNKNOWN (e.g. a leverage POST timeout).
  update private.copy_order_intents i set status='CANCELLED',exchange_terminal=true,resolved_at=now(),
    last_error_code=case when i.status='UNKNOWN' then 'UNSENT_UNKNOWN_RESOLVED' else 'UNSENT_CLAIM_EXPIRED' end,
    updated_at=now()
    where i.resume_version is not null and i.status in ('SUBMITTING','UNKNOWN') and i.submission_authorized_at is null
      and i.gate_order_id is null and i.filled_size=0 and i.submitted_at<now()-interval '30 seconds';
  delete from private.copy_reconciliation_jobs j using private.copy_order_intents i
    where i.id=j.intent_id and (i.exchange_terminal or i.status in ('FILLED','CANCELLED','REJECTED'));
  insert into private.copy_reconciliation_jobs(intent_id,run_after,claimed_at,updated_at)
  select i.id,now(),null,now() from private.copy_order_intents i
  where i.status='SUBMITTING' and i.updated_at<now()-interval '30 seconds'
  on conflict on constraint copy_reconciliation_jobs_intent_id_key do nothing;
  select decrypted_secret into encryption_key from vault.decrypted_secrets where name='gate_api_credentials_key';
  return query with claimed as (
    select j.id from private.copy_reconciliation_jobs j
    where j.run_after<=now() and (j.claimed_at is null or j.claimed_at<now()-interval '1 minute')
    order by j.run_after for update skip locked
    limit greatest(1,least(coalesce(p_limit,10),50))
  ),updated as (
    update private.copy_reconciliation_jobs j
    set claimed_at=now(),attempts=j.attempts+1,updated_at=now()
    from claimed where j.id=claimed.id returning j.*
  )
  select u.id,i.id,i.contract,i.gate_order_id,i.gate_order_text,
    pgp_sym_decrypt(g.api_key_ciphertext,encryption_key),
    pgp_sym_decrypt(g.secret_key_ciphertext,encryption_key),i.delta_size,i.position_side,i.reduce_only,i.target_size,
    i.trading_account_id,i.user_id,i.actual_size_at_plan,i.source_observed_at,i.submitted_at,i.submission_authorized_at,
    u.attempts
  from updated u
  join private.copy_order_intents i on i.id=u.intent_id
  join private.trading_accounts a on a.id=i.trading_account_id
  join private.gate_api_credentials g on g.user_id=a.credential_user_id;
end;
$function$;
revoke all on function public.claim_copy_reconciliation_jobs(integer) from public,anon,authenticated;
grant execute on function public.claim_copy_reconciliation_jobs(integer) to service_role;

-- "Not found" proves non-placement only after the order's Gate expiry (X-Gate-Exptime =
-- source_observed_at + 15 s) has passed with a wide margin; otherwise it stays UNKNOWN and retries.
create or replace function public.complete_copy_reconciliation(p_job_id bigint,p_status text,p_gate_order_id text default null,
  p_filled_size numeric default 0,p_average_fill_price numeric default null,p_safe_response jsonb default '{}')
returns void language plpgsql security definer set search_path=pg_catalog
as $$
declare job private.copy_reconciliation_jobs; target private.copy_order_intents; terminal boolean;
  not_found_resolution boolean := false;
begin
  perform private.require_copy_worker_role();
  perform pg_advisory_xact_lock(hashtextextended('maetajak:copy-execution',0));
  select * into job from private.copy_reconciliation_jobs where id=p_job_id for update;
  if not found then return; end if;
  select * into target from private.copy_order_intents where id=job.intent_id for update;
  if p_status is null or p_status not in ('ACKNOWLEDGED','PARTIALLY_FILLED','FILLED','CANCELLED','REJECTED','UNKNOWN')
    then raise exception 'INVALID_RECONCILIATION_RESULT'; end if;
  if target.exchange_terminal or target.status in ('FILLED','CANCELLED','REJECTED') then
    delete from private.copy_reconciliation_jobs where id=job.id; return;
  end if;
  if coalesce(p_safe_response->>'resolution','')='NOT_FOUND_AFTER_EXPIRY' then
    if p_status='CANCELLED' and coalesce(p_filled_size,0)=0 and nullif(p_gate_order_id,'') is null
      and target.gate_order_id is null and target.filled_size=0 and target.source_observed_at is not null
      and target.source_observed_at<now()-interval '75 seconds' then
      not_found_resolution:=true;
    else
      p_status:='UNKNOWN';
    end if;
  end if;
  if coalesce(p_safe_response->>'error_code','') ~ 'ORDER_(QUANTITY|IDENTITY)_MISMATCH'
    or p_filled_size is null or abs(p_filled_size)>abs(target.delta_size)
    or (p_filled_size<>0 and sign(p_filled_size)<>sign(target.delta_size)) then
    update public.copy_system_control set execution_enabled=false,emergency_halted=true,
      halt_reason='RECONCILIATION_QUANTITY_MISMATCH',updated_at=now() where singleton;
    raise warning 'RECONCILIATION_QUANTITY_MISMATCH';
    return;
  end if;
  terminal:=p_status in ('FILLED','CANCELLED','REJECTED')
    or coalesce((p_safe_response->>'terminal')::boolean,false);
  if abs(p_filled_size)>=abs(target.filled_size) then
    update private.copy_order_intents set status=p_status,gate_order_id=coalesce(nullif(p_gate_order_id,''),gate_order_id),
      filled_size=p_filled_size,average_fill_price=coalesce(p_average_fill_price,average_fill_price),
      exchange_terminal=terminal,resolved_at=case when terminal then now() else resolved_at end,
      last_error_code=case when not_found_resolution then 'NOT_FOUND_AFTER_EXPIRY' else last_error_code end,
      updated_at=now()
      where id=target.id;
  else terminal:=false;
  end if;
  if terminal then delete from private.copy_reconciliation_jobs where id=job.id;
  else update private.copy_reconciliation_jobs set claimed_at=null,
    run_after=now()+greatest(10,least(attempts,30))*interval '10 seconds',updated_at=now() where id=job.id; end if;
end;
$$;
revoke all on function public.complete_copy_reconciliation(bigint,text,text,numeric,numeric,jsonb) from public,anon,authenticated;
grant execute on function public.complete_copy_reconciliation(bigint,text,text,numeric,numeric,jsonb) to service_role;

-- P1-6 ---------------------------------------------------------------------------------------------
create or replace function public.get_copy_stale_fill_observations(p_older_than_seconds integer default 300)
returns jsonb language plpgsql security definer set search_path=pg_catalog
as $$
begin
  perform private.require_copy_worker_role();
  return (select coalesce(jsonb_agg(jsonb_build_object('intent_id',i.id,'user_id',i.user_id,
      'trading_account_id',i.trading_account_id,'contract',i.contract,'position_side',i.position_side,
      'filled_size',i.filled_size,'actual_size_at_plan',i.actual_size_at_plan,'resolved_at',i.resolved_at)
      order by i.resolved_at,i.id),'[]'::jsonb)
    from private.copy_order_intents i
    where i.resume_version is not null and i.filled_size<>0 and i.observation_confirmed_at is null
      and coalesce(i.resolved_at,i.updated_at)<now()-make_interval(secs=>greatest(60,least(coalesce(p_older_than_seconds,300),86400))));
end;
$$;
revoke all on function public.get_copy_stale_fill_observations(integer) from public,anon,authenticated;
grant execute on function public.get_copy_stale_fill_observations(integer) to service_role;

-- P0-1 ---------------------------------------------------------------------------------------------
-- A worker may send `anchor_master_copyable_size`: the Master quantity actually consumed by the member
-- lots it decided (fractional remainder stays unconsumed). Older workers omit it (same as before).
create or replace function public.record_copy_worker_cycle_with_target_anchors(p_payload jsonb)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  cycle_id uuid;
  member jsonb;
  position jsonb;
  account_id uuid;
  observed_at timestamptz := coalesce((p_payload->>'observed_at')::timestamptz, clock_timestamp());
begin
  perform private.require_copy_worker_role();
  cycle_id := public.record_copy_worker_cycle(p_payload);

  for member in
    select value from jsonb_array_elements(coalesce(p_payload->'members', '[]'::jsonb))
  loop
    if member->>'error_code' is not null or member->>'resume_version' is null then
      continue;
    end if;
    account_id := (member->>'trading_account_id')::uuid;
    for position in
      select value from jsonb_array_elements(coalesce(member->'planned_positions', '[]'::jsonb))
    loop
      if position->>'anchor_update_allowed'='false'
        or position->>'target_resume_version' is null
        or position->>'master_copyable_size' is null
        or (position->>'target_resume_version')::uuid is distinct from (member->>'resume_version')::uuid then
        continue;
      end if;
      insert into private.copy_target_anchors(
        trading_account_id, contract, position_side, resume_version,
        master_copyable_size, target_size, protected_member_size,
        lock_reason, observed_at, updated_at
      ) values (
        account_id,
        position->>'contract',
        coalesce(nullif(position->>'position_side',''),
          case when (position->>'master_copyable_size')::numeric < 0 then 'SHORT' else 'LONG' end),
        (position->>'target_resume_version')::uuid,
        coalesce((nullif(position->>'anchor_master_copyable_size',''))::numeric,
          (position->>'master_copyable_size')::numeric),
        (position->>'target_size')::numeric,
        coalesce((position->>'member_baseline_size')::numeric, 0),
        left(coalesce(nullif(position->>'target_lock_reason',''), 'TARGET_ANCHOR_INITIALIZED'), 80),
        observed_at,
        now()
      )
      on conflict (trading_account_id, contract, position_side) do update set
        resume_version = excluded.resume_version,
        master_copyable_size = excluded.master_copyable_size,
        target_size = excluded.target_size,
        protected_member_size = excluded.protected_member_size,
        lock_reason = excluded.lock_reason,
        observed_at = excluded.observed_at,
        updated_at = now()
      where excluded.observed_at > private.copy_target_anchors.observed_at;
    end loop;
  end loop;
  return cycle_id;
end;
$$;
revoke all on function public.record_copy_worker_cycle_with_target_anchors(jsonb) from public, anon, authenticated;
grant execute on function public.record_copy_worker_cycle_with_target_anchors(jsonb) to service_role;

-- Capability flag for workers and deploy checks (additive; existing keys unchanged).
create or replace function public.get_copy_safety_version()
returns jsonb language plpgsql security definer set search_path=pg_catalog
as $$
begin
  perform private.require_copy_worker_role();
  return jsonb_build_object('schema_version',3,'worker_version','0.5.0','resume_requires_validation',true,
    'current_state_atomic',true,'trade_alert_exchange_verification',true,'reliability_patch',1);
end;
$$;
revoke all on function public.get_copy_safety_version() from public,anon,authenticated;
grant execute on function public.get_copy_safety_version() to service_role;

notify pgrst, 'reload schema';
