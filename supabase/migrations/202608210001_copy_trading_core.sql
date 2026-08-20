-- Copy-trading control plane. Live order execution is intentionally disabled by default.
create table if not exists public.copy_system_control (
  singleton boolean primary key default true check (singleton),
  execution_enabled boolean not null default false,
  emergency_halted boolean not null default true,
  halt_reason text not null default 'TRADING_WORKER_NOT_CONFIGURED',
  updated_by uuid references auth.users(id),
  updated_at timestamptz not null default now()
);
insert into public.copy_system_control (singleton) values (true) on conflict (singleton) do nothing;
alter table public.copy_system_control enable row level security;

create table if not exists private.trading_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  credential_user_id uuid references auth.users(id) on delete restrict,
  account_role text not null check (account_role in ('MASTER', 'MEMBER')),
  settle text not null default 'usdt',
  status text not null default 'DISABLED'
    check (status in ('ACTIVE', 'DISABLED', 'ERROR', 'HALTED')),
  is_primary boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, account_role, settle),
  unique (credential_user_id, account_role, settle)
);
alter table private.trading_accounts enable row level security;
revoke all on private.trading_accounts from public, anon, authenticated;

create table if not exists private.copy_account_snapshots (
  id bigint generated always as identity primary key,
  trading_account_id uuid not null references private.trading_accounts(id) on delete cascade,
  total_equity numeric not null check (total_equity >= 0),
  available_equity numeric not null check (available_equity >= 0),
  unrealised_pnl numeric,
  observed_at timestamptz not null,
  source_hash text not null,
  created_at timestamptz not null default now(),
  unique (trading_account_id, observed_at, source_hash)
);
create index if not exists copy_account_snapshots_latest_idx
  on private.copy_account_snapshots (trading_account_id, observed_at desc);
alter table private.copy_account_snapshots enable row level security;
revoke all on private.copy_account_snapshots from public, anon, authenticated;

create table if not exists private.copy_position_snapshots (
  id bigint generated always as identity primary key,
  account_snapshot_id bigint not null references private.copy_account_snapshots(id) on delete cascade,
  trading_account_id uuid not null references private.trading_accounts(id) on delete cascade,
  contract text not null,
  size numeric not null,
  mark_price numeric not null check (mark_price > 0),
  entry_price numeric,
  leverage numeric,
  quanto_multiplier numeric not null check (quanto_multiplier > 0),
  observed_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (account_snapshot_id, contract)
);
create index if not exists copy_position_snapshots_latest_idx
  on private.copy_position_snapshots (trading_account_id, contract, observed_at desc);
alter table private.copy_position_snapshots enable row level security;
revoke all on private.copy_position_snapshots from public, anon, authenticated;

create table if not exists private.copy_cycles (
  id uuid primary key default gen_random_uuid(),
  master_account_id uuid not null references private.trading_accounts(id) on delete restrict,
  master_snapshot_id bigint references private.copy_account_snapshots(id) on delete restrict,
  status text not null default 'PLANNED'
    check (status in ('PLANNED', 'RECONCILING', 'COMPLETED', 'PARTIAL', 'ERROR', 'HALTED')),
  source_version text not null,
  started_at timestamptz,
  completed_at timestamptz,
  error_code text,
  created_at timestamptz not null default now(),
  unique (master_account_id, source_version)
);
create index if not exists copy_cycles_queue_idx on private.copy_cycles (status, created_at);
alter table private.copy_cycles enable row level security;
revoke all on private.copy_cycles from public, anon, authenticated;

create table if not exists public.copy_position_states (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  trading_account_id uuid not null references private.trading_accounts(id) on delete cascade,
  contract text not null,
  state text not null default 'PAUSED'
    check (state in ('SYNCED', 'DRIFT', 'MANUAL_OVERRIDE', 'PAUSED', 'REDUCE_ONLY', 'ERROR', 'HALTED')),
  target_size numeric not null default 0,
  actual_size numeric not null default 0,
  delta_size numeric not null default 0,
  previous_actual_size numeric,
  unexplained_delta numeric not null default 0,
  copy_ratio numeric not null,
  max_position_ratio numeric not null,
  drift_tolerance_size numeric not null default 1 check (drift_tolerance_size >= 0),
  manual_override_confirmed_at timestamptz,
  pause_reason text,
  last_cycle_id uuid references private.copy_cycles(id) on delete set null,
  last_observed_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (trading_account_id, contract)
);
create index if not exists copy_position_states_user_idx on public.copy_position_states (user_id, state);
alter table public.copy_position_states enable row level security;

drop policy if exists "members read own copy position states" on public.copy_position_states;
create policy "members read own copy position states" on public.copy_position_states
  for select to authenticated using (user_id = auth.uid() or public.is_approved_admin());

create table if not exists public.copy_events (
  id bigint generated always as identity primary key,
  user_id uuid references auth.users(id) on delete cascade,
  contract text,
  event_type text not null check (event_type in (
    'MASTER_POSITION_CHANGED', 'TARGET_POSITION_CALCULATED', 'DELTA_ORDER_PLANNED',
    'ORDER_SUBMITTED', 'ORDER_FILLED', 'ORDER_UNKNOWN', 'POSITION_SYNCED',
    'MANUAL_OVERRIDE_DETECTED', 'SYMBOL_PAUSED', 'RISK_REDUCE_ONLY',
    'MEMBER_HALTED', 'SYSTEM_HALTED', 'ERROR'
  )),
  severity text not null default 'INFO' check (severity in ('INFO', 'WARNING', 'CRITICAL')),
  cycle_id uuid references private.copy_cycles(id) on delete set null,
  safe_payload jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now()
);
create index if not exists copy_events_user_time_idx on public.copy_events (user_id, occurred_at desc);
alter table public.copy_events enable row level security;

drop policy if exists "members read own copy events" on public.copy_events;
create policy "members read own copy events" on public.copy_events
  for select to authenticated using (user_id = auth.uid() or public.is_approved_admin());

create table if not exists private.copy_order_intents (
  id uuid primary key default gen_random_uuid(),
  cycle_id uuid not null references private.copy_cycles(id) on delete restrict,
  user_id uuid not null references auth.users(id) on delete cascade,
  trading_account_id uuid not null references private.trading_accounts(id) on delete cascade,
  contract text not null,
  target_size numeric not null,
  actual_size_at_plan numeric not null,
  delta_size numeric not null check (delta_size <> 0),
  reduce_only boolean not null default false,
  idempotency_key text not null unique,
  gate_order_text text not null unique,
  status text not null default 'PLANNED' check (status in (
    'PLANNED', 'QUEUED', 'SUBMITTING', 'ACKNOWLEDGED', 'PARTIALLY_FILLED',
    'FILLED', 'CANCELLED', 'REJECTED', 'UNKNOWN'
  )),
  gate_order_id text,
  filled_size numeric not null default 0,
  average_fill_price numeric,
  submit_attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error_code text,
  created_at timestamptz not null default now(),
  submitted_at timestamptz,
  resolved_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (cycle_id, trading_account_id, contract)
);
create index if not exists copy_order_intents_queue_idx
  on private.copy_order_intents (status, next_attempt_at, created_at);
alter table private.copy_order_intents enable row level security;
revoke all on private.copy_order_intents from public, anon, authenticated;

create table if not exists private.copy_order_attempts (
  id bigint generated always as identity primary key,
  intent_id uuid not null references private.copy_order_intents(id) on delete cascade,
  attempt_number integer not null,
  request_fingerprint text not null,
  http_status integer,
  gate_label text,
  result_status text not null check (result_status in ('ACKNOWLEDGED', 'REJECTED', 'TIMEOUT', 'NETWORK_ERROR', 'UNKNOWN')),
  safe_response jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (intent_id, attempt_number)
);
alter table private.copy_order_attempts enable row level security;
revoke all on private.copy_order_attempts from public, anon, authenticated;

create table if not exists private.copy_reconciliation_jobs (
  id bigint generated always as identity primary key,
  intent_id uuid not null unique references private.copy_order_intents(id) on delete cascade,
  attempts integer not null default 0,
  run_after timestamptz not null default now(),
  claimed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists copy_reconciliation_jobs_queue_idx
  on private.copy_reconciliation_jobs (run_after, claimed_at);
alter table private.copy_reconciliation_jobs enable row level security;
revoke all on private.copy_reconciliation_jobs from public, anon, authenticated;

create or replace function public.get_my_copy_position_states()
returns jsonb language sql stable security definer set search_path = public, pg_temp
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'contract', state.contract, 'state', state.state,
    'target_size', state.target_size, 'actual_size', state.actual_size,
    'delta_size', state.delta_size, 'pause_reason', state.pause_reason,
    'last_observed_at', state.last_observed_at, 'updated_at', state.updated_at
  ) order by state.contract), '[]'::jsonb)
  from public.copy_position_states as state where state.user_id = auth.uid();
$$;
revoke all on function public.get_my_copy_position_states() from public;
grant execute on function public.get_my_copy_position_states() to authenticated;

create or replace function public.get_copy_system_status()
returns jsonb language sql stable security definer set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'execution_enabled', control.execution_enabled,
    'emergency_halted', control.emergency_halted,
    'halt_reason', control.halt_reason,
    'updated_at', control.updated_at
  ) from public.copy_system_control as control where control.singleton;
$$;
revoke all on function public.get_copy_system_status() from public;
grant execute on function public.get_copy_system_status() to authenticated;

-- Only the service role may claim order work. The global control must be explicitly enabled
-- and unhalted, preventing accidental live orders immediately after migration/deployment.
create or replace function public.claim_copy_order_intents(p_limit integer default 10)
returns table (
  intent_id uuid, user_id uuid, credential_user_id uuid, contract text,
  delta_size numeric, reduce_only boolean, gate_order_text text, idempotency_key text
)
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if coalesce(current_setting('request.jwt.claim.role', true), '') <> 'service_role' then
    raise exception 'SERVICE_ROLE_REQUIRED';
  end if;
  if not exists (
    select 1 from public.copy_system_control
    where singleton and execution_enabled and not emergency_halted
  ) then
    return;
  end if;

  return query
  with claimable as (
    select intent.id from private.copy_order_intents as intent
    join public.copy_position_states as state
      on state.trading_account_id = intent.trading_account_id and state.contract = intent.contract
    where intent.status in ('PLANNED', 'QUEUED')
      and intent.next_attempt_at <= now()
      and state.state in ('DRIFT', 'REDUCE_ONLY')
    order by intent.created_at
    for update of intent skip locked
    limit greatest(1, least(coalesce(p_limit, 10), 50))
  ), claimed as (
    update private.copy_order_intents as intent
    set status = 'SUBMITTING', submit_attempts = intent.submit_attempts + 1, updated_at = now()
    from claimable where intent.id = claimable.id returning intent.*
  )
  select claimed.id, claimed.user_id, account.credential_user_id, claimed.contract,
    claimed.delta_size, claimed.reduce_only, claimed.gate_order_text, claimed.idempotency_key
  from claimed join private.trading_accounts as account on account.id = claimed.trading_account_id;
end;
$$;
revoke all on function public.claim_copy_order_intents(integer) from public;
grant execute on function public.claim_copy_order_intents(integer) to service_role;

create or replace function public.set_copy_system_control(
  p_execution_enabled boolean, p_emergency_halted boolean, p_reason text
)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $$
declare result public.copy_system_control;
begin
  if not public.is_approved_admin() then raise exception 'ADMIN_REAUTH_REQUIRED'; end if;
  -- Enabling execution remains unavailable from the browser. It must be performed by a
  -- separately authenticated deployment procedure after Worker and Gate TESTNET QA.
  if p_execution_enabled then raise exception 'DEPLOYMENT_APPROVAL_REQUIRED'; end if;

  update public.copy_system_control set
    execution_enabled = false,
    emergency_halted = coalesce(p_emergency_halted, true),
    halt_reason = left(coalesce(nullif(trim(p_reason), ''), 'ADMIN_HALT'), 160),
    updated_by = auth.uid(), updated_at = now()
  where singleton returning * into result;

  insert into public.admin_audit_logs (actor_id, action, next_value)
  values (auth.uid(), 'COPY_SYSTEM_CONTROL_UPDATED', jsonb_build_object(
    'execution_enabled', result.execution_enabled,
    'emergency_halted', result.emergency_halted,
    'halt_reason', result.halt_reason
  ));
  return to_jsonb(result);
end;
$$;
revoke all on function public.set_copy_system_control(boolean, boolean, text) from public;
grant execute on function public.set_copy_system_control(boolean, boolean, text) to authenticated;
