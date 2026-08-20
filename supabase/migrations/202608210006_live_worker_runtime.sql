-- Production copy worker runtime. All credential-bearing functions are service-role only.
alter table public.copy_system_control
  add column if not exists max_order_slippage_ratio numeric not null default 0.005
    check (max_order_slippage_ratio between 0.0001 and 0.03);

alter table public.profiles
  add column if not exists copy_paused boolean not null default false,
  add column if not exists member_halted boolean not null default false,
  add column if not exists reduce_only boolean not null default false,
  add column if not exists close_positions_requested boolean not null default false,
  add column if not exists daily_loss_limit_pct numeric not null default 5 check (daily_loss_limit_pct between 0.1 and 100),
  add column if not exists max_drawdown_pct numeric not null default 15 check (max_drawdown_pct between 0.1 and 100),
  add column if not exists max_leverage numeric not null default 10 check (max_leverage between 1 and 100);

create table if not exists private.copy_worker_runtime (
  singleton boolean primary key default true check (singleton),
  worker_id text,
  worker_version text,
  gate_base_url text,
  public_ip inet,
  mode text not null default 'OBSERVE' check (mode in ('OBSERVE', 'DRY_RUN', 'LIVE')),
  heartbeat_at timestamptz,
  last_test_passed_at timestamptz,
  started_at timestamptz,
  updated_at timestamptz not null default now()
);
insert into private.copy_worker_runtime(singleton) values (true) on conflict (singleton) do nothing;
alter table private.copy_worker_runtime enable row level security;
revoke all on private.copy_worker_runtime from public, anon, authenticated;

create or replace function public.copy_worker_heartbeat(
  p_worker_id text,
  p_worker_version text,
  p_gate_base_url text,
  p_public_ip text default null,
  p_mode text default 'OBSERVE',
  p_test_passed boolean default false
)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $$
declare runtime private.copy_worker_runtime;
begin
  if coalesce(current_setting('request.jwt.claim.role', true), '') <> 'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  if p_mode not in ('OBSERVE', 'DRY_RUN', 'LIVE') then raise exception 'INVALID_WORKER_MODE'; end if;
  if p_mode = 'LIVE' and (nullif(trim(p_public_ip), '') is null or p_gate_base_url <> 'https://api.gateio.ws') then
    raise exception 'LIVE_WORKER_CONFIGURATION_REQUIRED';
  end if;
  if exists(select 1 from private.copy_worker_runtime r where r.singleton and r.worker_id is distinct from p_worker_id and r.heartbeat_at > now()-interval '30 seconds') then
    raise exception 'WORKER_LEASE_HELD';
  end if;
  insert into private.copy_worker_runtime(singleton, worker_id, worker_version, gate_base_url, public_ip, mode, heartbeat_at, last_test_passed_at, started_at, updated_at)
  values (true, left(p_worker_id, 120), left(p_worker_version, 80), left(p_gate_base_url, 200), nullif(trim(p_public_ip), '')::inet,
    p_mode, now(), case when p_test_passed then now() end, now(), now())
  on conflict (singleton) do update set
    worker_id = excluded.worker_id, worker_version = excluded.worker_version,
    gate_base_url = excluded.gate_base_url, public_ip = excluded.public_ip,
    mode = excluded.mode, heartbeat_at = now(),
    last_test_passed_at = case when p_test_passed then now() else private.copy_worker_runtime.last_test_passed_at end,
    started_at = coalesce(private.copy_worker_runtime.started_at, now()), updated_at = now()
  returning * into runtime;
  return jsonb_build_object('mode', runtime.mode, 'heartbeat_at', runtime.heartbeat_at, 'test_passed_at', runtime.last_test_passed_at);
end;
$$;
revoke all on function public.copy_worker_heartbeat(text, text, text, text, text, boolean) from public;
grant execute on function public.copy_worker_heartbeat(text, text, text, text, text, boolean) to service_role;

create or replace function public.get_copy_worker_context()
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $$
declare encryption_key text;
declare result jsonb;
begin
  if coalesce(current_setting('request.jwt.claim.role', true), '') <> 'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  select decrypted_secret into encryption_key from vault.decrypted_secrets where name = 'gate_api_credentials_key';
  if encryption_key is null then raise exception 'ENCRYPTION_KEY_NOT_CONFIGURED'; end if;

  select jsonb_build_object(
    'system', (select jsonb_build_object('execution_enabled', c.execution_enabled, 'emergency_halted', c.emergency_halted, 'halt_reason', c.halt_reason, 'slippage_ratio', c.max_order_slippage_ratio) from public.copy_system_control c where c.singleton),
    'master', (select jsonb_build_object(
      'trading_account_id', a.id, 'user_id', a.user_id, 'gate_uid', g.gate_uid,
      'api_key', pgp_sym_decrypt(g.api_key_ciphertext, encryption_key),
      'secret_key', pgp_sym_decrypt(g.secret_key_ciphertext, encryption_key)
    ) from private.trading_accounts a join private.gate_api_credentials g on g.user_id = a.credential_user_id
      where a.account_role = 'MASTER' and a.status = 'ACTIVE' and g.status = 'VERIFIED' and g.futures_read and g.futures_trade
      order by a.updated_at desc limit 1),
    'members', coalesce((select jsonb_agg(jsonb_build_object(
      'trading_account_id', a.id, 'user_id', a.user_id, 'gate_uid', g.gate_uid,
      'api_key', pgp_sym_decrypt(g.api_key_ciphertext, encryption_key),
      'secret_key', pgp_sym_decrypt(g.secret_key_ciphertext, encryption_key),
      'copy_ratio', p.copy_ratio, 'max_position_ratio', p.max_position_ratio,
      'copy_paused', p.copy_paused, 'halted', p.member_halted, 'reduce_only', p.reduce_only,
      'close_positions_requested', p.close_positions_requested,
      'daily_loss_limit_pct', p.daily_loss_limit_pct, 'max_drawdown_pct', p.max_drawdown_pct, 'max_leverage', p.max_leverage,
      'day_start_equity', (select s.total_equity from private.copy_account_snapshots s where s.trading_account_id=a.id and s.observed_at>=date_trunc('day',now()) order by s.observed_at limit 1),
      'peak_equity', (select max(s.total_equity) from private.copy_account_snapshots s where s.trading_account_id=a.id),
      'previous_states', coalesce((select jsonb_agg(jsonb_build_object(
        'contract', s.contract, 'state', s.state, 'actual_size', s.actual_size,
        'last_observed_at', s.last_observed_at,
        'known_fill_delta', coalesce((select sum(i.filled_size) from private.copy_order_intents i where i.trading_account_id = a.id and i.contract = s.contract and i.updated_at > coalesce(s.last_observed_at, '-infinity'::timestamptz) and i.filled_size <> 0), 0),
        'has_unresolved_order', exists(select 1 from private.copy_order_intents i where i.trading_account_id = a.id and i.contract = s.contract and i.status in ('SUBMITTING','ACKNOWLEDGED','PARTIALLY_FILLED','UNKNOWN'))
      ) order by s.contract) from public.copy_position_states s where s.trading_account_id = a.id), '[]'::jsonb)
    ) order by p.created_at) from private.trading_accounts a
      join private.gate_api_credentials g on g.user_id = a.credential_user_id
      join public.profiles p on p.id = a.user_id
      where a.account_role = 'MEMBER' and a.status = 'ACTIVE' and g.status = 'VERIFIED'
        and g.futures_read and g.futures_trade and p.role = 'MEMBER' and p.approval_status = 'APPROVED'), '[]'::jsonb)
  ) into result;
  return result;
end;
$$;
revoke all on function public.get_copy_worker_context() from public;
grant execute on function public.get_copy_worker_context() to service_role;

create or replace function public.record_copy_worker_cycle(p_payload jsonb)
returns uuid language plpgsql security definer set search_path = public, pg_temp
as $$
declare cycle_id uuid := (p_payload->>'cycle_id')::uuid;
declare observed_at timestamptz := coalesce((p_payload->>'observed_at')::timestamptz, now());
declare master jsonb := p_payload->'master';
declare member jsonb;
declare position jsonb;
declare v_master_snapshot_id bigint;
declare member_snapshot_id bigint;
declare previous_state text;
declare intent_count integer := 0;
declare source_hash text := encode(digest(p_payload::text, 'sha256'), 'hex');
begin
  if coalesce(current_setting('request.jwt.claim.role', true), '') <> 'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  if master is null or master->>'trading_account_id' is null then raise exception 'MASTER_REQUIRED'; end if;

  insert into private.copy_cycles(id, master_account_id, status, source_version, started_at)
  values (cycle_id, (master->>'trading_account_id')::uuid, 'RECONCILING', left(p_payload->>'source_version', 160), observed_at)
  on conflict (id) do nothing;
  insert into private.copy_account_snapshots(trading_account_id, total_equity, available_equity, unrealised_pnl, observed_at, source_hash)
  values ((master->>'trading_account_id')::uuid, greatest(0, (master->>'total')::numeric), greatest(0, (master->>'available')::numeric), (master->>'unrealisedPnl')::numeric, observed_at, source_hash)
  returning id into v_master_snapshot_id;
  for position in select value from jsonb_array_elements(coalesce(master->'positions', '[]'::jsonb)) loop
    if coalesce((position->>'markPrice')::numeric, 0) > 0 then
      insert into private.copy_position_snapshots(account_snapshot_id, trading_account_id, contract, size, mark_price, entry_price, leverage, quanto_multiplier, observed_at)
      values (v_master_snapshot_id, (master->>'trading_account_id')::uuid, position->>'contract', (position->>'size')::numeric,
        (position->>'markPrice')::numeric, nullif(position->>'entryPrice','')::numeric, nullif(position->>'leverage','')::numeric,
        coalesce(nullif(position->>'quanto_multiplier','')::numeric, 1), observed_at);
    end if;
  end loop;
  update private.copy_cycles set master_snapshot_id = v_master_snapshot_id where id = cycle_id;

  for member in select value from jsonb_array_elements(coalesce(p_payload->'members', '[]'::jsonb)) loop
    if member->>'error_code' is not null then
      insert into public.copy_events(user_id, event_type, severity, cycle_id, safe_payload)
      values ((member->>'user_id')::uuid, 'ERROR', 'CRITICAL', cycle_id, jsonb_build_object('code', left(member->>'error_code', 80)));
      continue;
    end if;
    if member->>'risk_halt_reason' in ('DAILY_LOSS_LIMIT','MAX_DRAWDOWN_LIMIT') then
      update public.profiles set member_halted=true,updated_at=now() where id=(member->>'user_id')::uuid;
    end if;
    insert into private.copy_account_snapshots(trading_account_id, total_equity, available_equity, unrealised_pnl, observed_at, source_hash)
    values ((member->>'trading_account_id')::uuid, greatest(0, (member->>'total')::numeric), greatest(0, (member->>'available')::numeric), (member->>'unrealisedPnl')::numeric, observed_at, source_hash)
    returning id into member_snapshot_id;
    for position in select value from jsonb_array_elements(coalesce(member->'planned_positions', '[]'::jsonb)) loop
      select state into previous_state from public.copy_position_states
      where trading_account_id = (member->>'trading_account_id')::uuid and contract = position->>'contract';
      insert into private.copy_position_snapshots(account_snapshot_id, trading_account_id, contract, size, mark_price, entry_price, leverage, quanto_multiplier, observed_at)
      values (member_snapshot_id, (member->>'trading_account_id')::uuid, position->>'contract', (position->>'size')::numeric,
        (position->>'mark_price')::numeric, nullif(position->>'entry_price','')::numeric, nullif(position->>'leverage','')::numeric,
        (position->>'quanto_multiplier')::numeric, observed_at);
      insert into public.copy_position_states(user_id, trading_account_id, contract, state, target_size, actual_size, delta_size,
        previous_actual_size, unexplained_delta, copy_ratio, max_position_ratio, drift_tolerance_size, pause_reason,
        manual_override_confirmed_at, last_cycle_id, last_observed_at, updated_at)
      values ((member->>'user_id')::uuid, (member->>'trading_account_id')::uuid, position->>'contract', position->>'state',
        (position->>'target_size')::numeric, (position->>'size')::numeric, (position->>'delta_size')::numeric,
        nullif(position->>'previous_actual_size','')::numeric, coalesce((position->>'unexplained_delta')::numeric, 0),
        (member->>'copy_ratio')::numeric, (member->>'max_position_ratio')::numeric, 1,
        nullif(position->>'pause_reason',''), case when position->>'state' = 'MANUAL_OVERRIDE' then now() end,
        cycle_id, observed_at, now())
      on conflict (trading_account_id, contract) do update set
        state = excluded.state, target_size = excluded.target_size, actual_size = excluded.actual_size,
        delta_size = excluded.delta_size, previous_actual_size = excluded.previous_actual_size,
        unexplained_delta = excluded.unexplained_delta, copy_ratio = excluded.copy_ratio,
        max_position_ratio = excluded.max_position_ratio, pause_reason = excluded.pause_reason,
        manual_override_confirmed_at = coalesce(public.copy_position_states.manual_override_confirmed_at, excluded.manual_override_confirmed_at),
        last_cycle_id = excluded.last_cycle_id, last_observed_at = excluded.last_observed_at, updated_at = now();
      if previous_state is distinct from position->>'state' then
        insert into public.copy_events(user_id, contract, event_type, severity, cycle_id, safe_payload)
        values ((member->>'user_id')::uuid, position->>'contract',
          case position->>'state' when 'MANUAL_OVERRIDE' then 'MANUAL_OVERRIDE_DETECTED' when 'SYNCED' then 'POSITION_SYNCED' when 'PAUSED' then 'SYMBOL_PAUSED' when 'REDUCE_ONLY' then 'RISK_REDUCE_ONLY' when 'HALTED' then 'MEMBER_HALTED' else 'TARGET_POSITION_CALCULATED' end,
          case when position->>'state' in ('MANUAL_OVERRIDE','ERROR','HALTED') then 'CRITICAL' when position->>'state' in ('DRIFT','PAUSED','REDUCE_ONLY') then 'WARNING' else 'INFO' end,
          cycle_id, jsonb_build_object('previous_state', previous_state, 'state', position->>'state', 'target_size', position->>'target_size', 'actual_size', position->>'size'));
      end if;
      if position->'intent' is not null then
        insert into private.copy_order_intents(cycle_id, user_id, trading_account_id, contract, target_size, actual_size_at_plan,
          delta_size, reduce_only, idempotency_key, gate_order_text, status)
        values (cycle_id, (member->>'user_id')::uuid, (member->>'trading_account_id')::uuid, position->>'contract',
          (position->>'target_size')::numeric, (position->>'size')::numeric, (position->'intent'->>'delta_size')::numeric,
          (position->'intent'->>'reduce_only')::boolean, position->'intent'->>'idempotency_key', position->'intent'->>'gate_order_text', 'PLANNED')
        on conflict (idempotency_key) do nothing;
        intent_count := intent_count + 1;
      end if;
    end loop;
  end loop;
  update private.copy_cycles set status = case when intent_count > 0 then 'PLANNED' else 'COMPLETED' end,
    completed_at = case when intent_count = 0 then now() end where id = cycle_id;
  return cycle_id;
end;
$$;
revoke all on function public.record_copy_worker_cycle(jsonb) from public;
grant execute on function public.record_copy_worker_cycle(jsonb) to service_role;

drop function if exists public.claim_copy_order_intents(integer);
create function public.claim_copy_order_intents(p_limit integer default 10)
returns table (intent_id uuid, user_id uuid, contract text, delta_size numeric, reduce_only boolean,
  gate_order_text text, idempotency_key text, api_key text, secret_key text, slippage_ratio numeric)
language plpgsql security definer set search_path = public, pg_temp
as $$
declare encryption_key text;
begin
  if coalesce(current_setting('request.jwt.claim.role', true), '') <> 'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  if exists (select 1 from public.copy_system_control c where c.singleton and c.execution_enabled and not c.emergency_halted)
    and not exists (select 1 from private.copy_worker_runtime r where r.singleton and r.mode = 'LIVE' and r.gate_base_url = 'https://api.gateio.ws' and r.public_ip is not null and r.heartbeat_at > now() - interval '30 seconds') then
    update public.copy_system_control set emergency_halted = true, execution_enabled = false, halt_reason = 'STALE_OR_INVALID_WORKER', updated_at = now() where singleton;
  end if;
  if not exists (select 1 from public.copy_system_control c where c.singleton and c.execution_enabled and not c.emergency_halted) then return; end if;
  select decrypted_secret into encryption_key from vault.decrypted_secrets where name = 'gate_api_credentials_key';
  return query with claimable as (
    select i.id from private.copy_order_intents i join public.copy_position_states s on s.trading_account_id = i.trading_account_id and s.contract = i.contract
    where i.status in ('PLANNED','QUEUED') and i.next_attempt_at <= now() and s.state in ('DRIFT','REDUCE_ONLY')
    order by i.created_at for update of i skip locked limit greatest(1, least(coalesce(p_limit,10),50))
  ), claimed as (
    update private.copy_order_intents i set status='SUBMITTING', submit_attempts=i.submit_attempts+1, updated_at=now()
    from claimable where i.id=claimable.id returning i.*
  ) select c.id, c.user_id, c.contract, c.delta_size, c.reduce_only, c.gate_order_text, c.idempotency_key,
    pgp_sym_decrypt(g.api_key_ciphertext, encryption_key), pgp_sym_decrypt(g.secret_key_ciphertext, encryption_key), control.max_order_slippage_ratio
  from claimed c join private.trading_accounts a on a.id=c.trading_account_id
    join private.gate_api_credentials g on g.user_id=a.credential_user_id
    cross join public.copy_system_control control
  where a.status='ACTIVE' and g.status='VERIFIED' and g.futures_trade and control.singleton;
end;
$$;
revoke all on function public.claim_copy_order_intents(integer) from public;
grant execute on function public.claim_copy_order_intents(integer) to service_role;

create or replace function public.complete_copy_order_attempt(
  p_intent_id uuid, p_result_status text, p_gate_order_id text default null, p_filled_size numeric default 0,
  p_average_fill_price numeric default null, p_http_status integer default null, p_gate_label text default null,
  p_error_code text default null, p_safe_response jsonb default '{}'::jsonb
)
returns void language plpgsql security definer set search_path = public, pg_temp
as $$
declare target private.copy_order_intents;
begin
  if coalesce(current_setting('request.jwt.claim.role', true), '') <> 'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  if p_result_status not in ('ACKNOWLEDGED','PARTIALLY_FILLED','FILLED','CANCELLED','REJECTED','UNKNOWN') then raise exception 'INVALID_ORDER_RESULT'; end if;
  select * into target from private.copy_order_intents where id=p_intent_id for update;
  if target.id is null then raise exception 'INTENT_NOT_FOUND'; end if;
  insert into private.copy_order_attempts(intent_id, attempt_number, request_fingerprint, http_status, gate_label, result_status, safe_response)
  values (target.id, target.submit_attempts, target.idempotency_key, nullif(p_http_status,0), left(p_gate_label,100),
    case when p_result_status='UNKNOWN' then 'UNKNOWN' when p_result_status='REJECTED' then 'REJECTED' else 'ACKNOWLEDGED' end,
    coalesce(p_safe_response,'{}'::jsonb));
  update private.copy_order_intents set status=p_result_status, gate_order_id=coalesce(nullif(p_gate_order_id,''),gate_order_id),
    filled_size=coalesce(p_filled_size,filled_size), average_fill_price=coalesce(p_average_fill_price,average_fill_price),
    last_error_code=left(p_error_code,80), submitted_at=coalesce(submitted_at,now()),
    resolved_at=case when p_result_status in ('FILLED','CANCELLED','REJECTED') then now() else resolved_at end, updated_at=now()
  where id=target.id;
  if p_result_status in ('ACKNOWLEDGED','PARTIALLY_FILLED','UNKNOWN') then
    insert into private.copy_reconciliation_jobs(intent_id,run_after,claimed_at,updated_at) values(target.id,now()+interval '2 seconds',null,now())
    on conflict(intent_id) do update set run_after=excluded.run_after,claimed_at=null,updated_at=now();
  end if;
  insert into public.copy_events(user_id,contract,event_type,severity,cycle_id,safe_payload)
  values(target.user_id,target.contract,case when p_result_status='FILLED' then 'ORDER_FILLED' when p_result_status='UNKNOWN' then 'ORDER_UNKNOWN' else 'ORDER_SUBMITTED' end,
    case when p_result_status='UNKNOWN' then 'CRITICAL' when p_result_status='REJECTED' then 'WARNING' else 'INFO' end,target.cycle_id,
    jsonb_build_object('status',p_result_status,'order_id',p_gate_order_id,'filled_size',p_filled_size,'error_code',p_error_code));
end;
$$;
revoke all on function public.complete_copy_order_attempt(uuid,text,text,numeric,numeric,integer,text,text,jsonb) from public;
grant execute on function public.complete_copy_order_attempt(uuid,text,text,numeric,numeric,integer,text,text,jsonb) to service_role;

create or replace function public.claim_copy_reconciliation_jobs(p_limit integer default 10)
returns table(job_id bigint,intent_id uuid,contract text,gate_order_id text,gate_order_text text,api_key text,secret_key text)
language plpgsql security definer set search_path=public,pg_temp
as $$
declare encryption_key text;
begin
  if coalesce(current_setting('request.jwt.claim.role',true),'')<>'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  select decrypted_secret into encryption_key from vault.decrypted_secrets where name='gate_api_credentials_key';
  return query with claimed as (
    select j.id from private.copy_reconciliation_jobs j where j.run_after<=now() and (j.claimed_at is null or j.claimed_at<now()-interval '1 minute')
    order by j.run_after for update skip locked limit greatest(1,least(coalesce(p_limit,10),50))
  ), updated as (
    update private.copy_reconciliation_jobs j set claimed_at=now(),attempts=j.attempts+1,updated_at=now() from claimed where j.id=claimed.id returning j.*
  ) select u.id,i.id,i.contract,i.gate_order_id,i.gate_order_text,pgp_sym_decrypt(g.api_key_ciphertext,encryption_key),pgp_sym_decrypt(g.secret_key_ciphertext,encryption_key)
    from updated u join private.copy_order_intents i on i.id=u.intent_id join private.trading_accounts a on a.id=i.trading_account_id join private.gate_api_credentials g on g.user_id=a.credential_user_id;
end;
$$;
revoke all on function public.claim_copy_reconciliation_jobs(integer) from public;
grant execute on function public.claim_copy_reconciliation_jobs(integer) to service_role;

create or replace function public.complete_copy_reconciliation(p_job_id bigint,p_status text,p_gate_order_id text default null,p_filled_size numeric default 0,p_average_fill_price numeric default null,p_safe_response jsonb default '{}'::jsonb)
returns void language plpgsql security definer set search_path=public,pg_temp
as $$
declare target private.copy_reconciliation_jobs;
begin
  if coalesce(current_setting('request.jwt.claim.role',true),'')<>'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  select * into target from private.copy_reconciliation_jobs where id=p_job_id for update;
  if target.id is null then raise exception 'JOB_NOT_FOUND'; end if;
  if p_status not in ('ACKNOWLEDGED','PARTIALLY_FILLED','FILLED','CANCELLED','REJECTED','UNKNOWN') then raise exception 'INVALID_RECONCILIATION_RESULT'; end if;
  update private.copy_order_intents set status=p_status,gate_order_id=coalesce(nullif(p_gate_order_id,''),gate_order_id),
    filled_size=case when p_filled_size<>0 then p_filled_size else filled_size end,average_fill_price=coalesce(p_average_fill_price,average_fill_price),
    resolved_at=case when p_status in('FILLED','CANCELLED','REJECTED') then now() else resolved_at end,updated_at=now() where id=target.intent_id;
  if p_status in('FILLED','CANCELLED','REJECTED') then delete from private.copy_reconciliation_jobs where id=target.id;
  else update private.copy_reconciliation_jobs set claimed_at=null,run_after=now()+(least(attempts,10)*interval '10 seconds'),updated_at=now() where id=target.id; end if;
  if p_status='UNKNOWN' and target.attempts in (3,8) then
    insert into public.copy_events(user_id,contract,event_type,severity,cycle_id,safe_payload)
    select i.user_id,i.contract,'ORDER_UNKNOWN','CRITICAL',i.cycle_id,jsonb_build_object('attempts',target.attempts,'diagnostic',coalesce(p_safe_response,'{}'::jsonb))
    from private.copy_order_intents i where i.id=target.intent_id;
  end if;
end;
$$;
revoke all on function public.complete_copy_reconciliation(bigint,text,text,numeric,numeric,jsonb) from public;
grant execute on function public.complete_copy_reconciliation(bigint,text,text,numeric,numeric,jsonb) to service_role;

create or replace function public.set_copy_live_activation(p_enable boolean,p_confirmation text,p_reason text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp
as $$
declare result public.copy_system_control;
begin
  if coalesce(current_setting('request.jwt.claim.role',true),'')<>'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  if p_enable then
    if p_confirmation<>'ENABLE_LIVE_COPY_TRADING' then raise exception 'LIVE_CONFIRMATION_REQUIRED'; end if;
    if not exists(select 1 from private.copy_worker_runtime r where r.singleton and r.mode='LIVE' and r.gate_base_url='https://api.gateio.ws' and r.public_ip is not null and r.heartbeat_at>now()-interval '30 seconds' and r.last_test_passed_at>now()-interval '7 days') then raise exception 'WORKER_READINESS_REQUIRED'; end if;
    if not exists(select 1 from private.trading_accounts a join private.gate_api_credentials g on g.user_id=a.credential_user_id where a.account_role='MASTER' and a.status='ACTIVE' and g.status='VERIFIED') then raise exception 'VERIFIED_MASTER_REQUIRED'; end if;
    if not exists(select 1 from private.trading_accounts a join private.gate_api_credentials g on g.user_id=a.credential_user_id where a.account_role='MEMBER' and a.status='ACTIVE' and g.status='VERIFIED') then raise exception 'VERIFIED_MEMBER_REQUIRED'; end if;
  end if;
  update public.copy_system_control set execution_enabled=p_enable,emergency_halted=not p_enable,
    halt_reason=case when p_enable then 'LIVE_EXECUTION_ENABLED' else left(coalesce(nullif(trim(p_reason),''),'DEPLOYMENT_HALT'),160) end,updated_at=now()
  where singleton returning * into result;
  insert into public.admin_audit_logs(action,next_value) values(case when p_enable then 'LIVE_COPY_ENABLED' else 'LIVE_COPY_HALTED' end,jsonb_build_object('reason',p_reason,'execution_enabled',p_enable));
  return to_jsonb(result);
end;
$$;
revoke all on function public.set_copy_live_activation(boolean,text,text) from public;
grant execute on function public.set_copy_live_activation(boolean,text,text) to service_role;

create or replace function public.get_copy_system_status()
returns jsonb language plpgsql stable security definer set search_path=public,pg_temp
as $$
declare result jsonb;
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED'; end if;
  select jsonb_build_object('execution_enabled',c.execution_enabled,'emergency_halted',c.emergency_halted,'halt_reason',c.halt_reason,'updated_at',c.updated_at,
    'worker',jsonb_build_object('mode',r.mode,'worker_version',r.worker_version,'public_ip',case when public.is_approved_admin() then host(r.public_ip) end,'heartbeat_at',r.heartbeat_at,'test_passed_at',r.last_test_passed_at,'healthy',coalesce(r.heartbeat_at>now()-interval '30 seconds',false)))
  into result from public.copy_system_control c left join private.copy_worker_runtime r on r.singleton where c.singleton;
  return result;
end;
$$;
revoke all on function public.get_copy_system_status() from public;
grant execute on function public.get_copy_system_status() to authenticated;

create or replace function public.set_my_copy_pause(p_mode text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp
as $$
declare updated_profile public.profiles;
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED'; end if;
  if p_mode not in ('HOLD','CLOSE','RESUME') then raise exception 'INVALID_PAUSE_MODE'; end if;
  update public.profiles set
    copy_paused = p_mode in ('HOLD','CLOSE'),
    close_positions_requested = p_mode='CLOSE',
    reduce_only = case when p_mode='CLOSE' then true when p_mode='RESUME' then false else reduce_only end,
    updated_at=now()
  where id=auth.uid() and role='MEMBER' and approval_status='APPROVED' returning * into updated_profile;
  if updated_profile.id is null then raise exception 'APPROVED_MEMBER_REQUIRED'; end if;
  if p_mode='RESUME' then
    update public.copy_position_states set state='DRIFT',pause_reason=null,manual_override_confirmed_at=null,updated_at=now()
    where user_id=auth.uid() and state in ('PAUSED','MANUAL_OVERRIDE');
  end if;
  insert into public.copy_events(user_id,event_type,severity,safe_payload)
  values(auth.uid(),case when p_mode='RESUME' then 'TARGET_POSITION_CALCULATED' else 'SYMBOL_PAUSED' end,
    case when p_mode='CLOSE' then 'WARNING' else 'INFO' end,jsonb_build_object('mode',p_mode));
  return jsonb_build_object('mode',p_mode,'copy_paused',updated_profile.copy_paused,'close_positions_requested',updated_profile.close_positions_requested);
end;
$$;
revoke all on function public.set_my_copy_pause(text) from public;
grant execute on function public.set_my_copy_pause(text) to authenticated;

create or replace function public.get_my_live_trading_data()
returns jsonb language plpgsql stable security definer set search_path=public,pg_temp
as $$
declare account_id uuid;
declare result jsonb;
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED'; end if;
  select id into account_id from private.trading_accounts where user_id=auth.uid() and account_role='MEMBER' order by updated_at desc limit 1;
  select jsonb_build_object(
    'account',(select jsonb_build_object('total_equity',s.total_equity,'available_equity',s.available_equity,'unrealised_pnl',s.unrealised_pnl,'observed_at',s.observed_at) from private.copy_account_snapshots s where s.trading_account_id=account_id order by s.observed_at desc limit 1),
    'positions',coalesce((select jsonb_agg(jsonb_build_object('contract',s.contract,'state',s.state,'target_size',s.target_size,'actual_size',s.actual_size,'delta_size',s.delta_size,'pause_reason',s.pause_reason,'observed_at',s.last_observed_at) order by s.contract) from public.copy_position_states s where s.user_id=auth.uid()),'[]'::jsonb),
    'events',coalesce((select jsonb_agg(jsonb_build_object('contract',e.contract,'type',e.event_type,'severity',e.severity,'payload',e.safe_payload,'occurred_at',e.occurred_at) order by e.occurred_at desc) from (select * from public.copy_events where user_id=auth.uid() order by occurred_at desc limit 50) e),'[]'::jsonb)
  ) into result;
  return result;
end;
$$;
revoke all on function public.get_my_live_trading_data() from public;
grant execute on function public.get_my_live_trading_data() to authenticated;

create or replace function public.get_admin_live_trading_data()
returns jsonb language plpgsql stable security definer set search_path=public,pg_temp
as $$
declare result jsonb;
begin
  if not public.is_approved_admin() then raise exception 'ADMIN_REQUIRED'; end if;
  select jsonb_build_object(
    'master_positions',coalesce((select jsonb_agg(jsonb_build_object('contract',p.contract,'size',p.size,'mark_price',p.mark_price,'entry_price',p.entry_price,'leverage',p.leverage,'observed_at',p.observed_at) order by p.contract)
      from private.copy_position_snapshots p join private.trading_accounts a on a.id=p.trading_account_id
      where a.account_role='MASTER' and p.account_snapshot_id=(select s.id from private.copy_account_snapshots s where s.trading_account_id=a.id order by s.observed_at desc limit 1)),'[]'::jsonb),
    'member_states',coalesce((select jsonb_agg(jsonb_build_object('name',p.full_name,'email',p.email,'contract',s.contract,'state',s.state,'target_size',s.target_size,'actual_size',s.actual_size,'delta_size',s.delta_size,'pause_reason',s.pause_reason,'observed_at',s.last_observed_at) order by s.updated_at desc) from public.copy_position_states s join public.profiles p on p.id=s.user_id),'[]'::jsonb),
    'orders',coalesce((select jsonb_agg(jsonb_build_object('name',p.full_name,'email',p.email,'contract',i.contract,'delta_size',i.delta_size,'filled_size',i.filled_size,'status',i.status,'gate_order_id',i.gate_order_id,'error_code',i.last_error_code,'created_at',i.created_at,'updated_at',i.updated_at) order by i.created_at desc) from (select * from private.copy_order_intents order by created_at desc limit 100) i join public.profiles p on p.id=i.user_id),'[]'::jsonb)
  ) into result;
  return result;
end;
$$;
revoke all on function public.get_admin_live_trading_data() from public;
grant execute on function public.get_admin_live_trading_data() to authenticated;
