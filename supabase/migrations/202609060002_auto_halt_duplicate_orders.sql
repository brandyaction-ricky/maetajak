-- Fail closed if the worker ever creates a second same-direction order from
-- the same stale position observation. The check runs after planning and
-- before claim_copy_order_intents, so the duplicate is never submitted.

create index if not exists copy_order_intents_duplicate_guard_idx
  on private.copy_order_intents (
    trading_account_id,
    contract,
    position_side,
    actual_size_at_plan,
    created_at desc
  )
  include (delta_size, status, reduce_only);

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

  select
    intent.trading_account_id,
    intent.contract,
    intent.position_side,
    intent.actual_size_at_plan,
    sign(intent.delta_size) as delta_direction,
    count(*) as duplicate_count,
    min(intent.created_at) as first_created_at,
    max(intent.created_at) as last_created_at
  into anomaly
  from private.copy_order_intents intent
  where intent.created_at >= greatest(control.updated_at, now() - interval '30 seconds')
    and intent.status in (
      'PLANNED', 'SUBMITTING', 'ACKNOWLEDGED',
      'PARTIALLY_FILLED', 'FILLED', 'UNKNOWN'
    )
    and intent.delta_size <> 0
  group by
    intent.trading_account_id,
    intent.contract,
    intent.position_side,
    intent.actual_size_at_plan,
    sign(intent.delta_size),
    intent.reduce_only
  having count(*) >= 2
  order by max(intent.created_at) desc
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

comment on function public.detect_and_halt_copy_order_anomaly() is
  'Atomically halts live copying before submission when repeated intents prove a stale-position order loop.';
