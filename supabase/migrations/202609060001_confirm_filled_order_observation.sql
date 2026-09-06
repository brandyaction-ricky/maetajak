-- Keep a completed Gate order locked until a later position observation proves
-- that its signed fill reached the member account. Gate's order endpoint can
-- report FILLED before the positions endpoint reflects the new quantity. If a
-- new five-second cycle treats that stale position as authoritative, it can
-- submit the same target delta again with a fresh cycle id.

create index if not exists copy_order_intents_account_contract_updated_idx
  on private.copy_order_intents (trading_account_id, contract, updated_at desc)
  include (filled_size, status);

create index if not exists copy_order_intents_unresolved_account_contract_idx
  on private.copy_order_intents (trading_account_id, contract)
  where status in ('SUBMITTING', 'ACKNOWLEDGED', 'PARTIALLY_FILLED', 'UNKNOWN');

create index if not exists copy_order_intents_filled_observation_guard_idx
  on private.copy_order_intents (
    trading_account_id, contract, position_side, resolved_at desc
  )
  include (created_at, actual_size_at_plan, filled_size)
  where status = 'FILLED' and filled_size <> 0;

create or replace function public.get_copy_order_observation_guards()
returns jsonb
language sql
security definer
set search_path = public, extensions, pg_temp
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'trading_account_id', state.trading_account_id,
    'contract', state.contract,
    'position_side', state.position_side
  ) order by state.trading_account_id, state.contract, state.position_side), '[]'::jsonb)
  from public.copy_position_states state
  cross join public.copy_system_control control
  where control.singleton
    and exists (
      select 1
      from private.copy_order_intents intent
      where intent.trading_account_id = state.trading_account_id
        and intent.contract = state.contract
        and intent.position_side = state.position_side
        and intent.created_at >= control.updated_at
        and (
          intent.status in ('SUBMITTING', 'ACKNOWLEDGED', 'PARTIALLY_FILLED', 'UNKNOWN')
          or (
            intent.status = 'FILLED'
            and intent.filled_size <> 0
            and (
              state.last_observed_at is null
              or state.last_observed_at <= intent.resolved_at
              or abs(
                state.actual_size
                - (intent.actual_size_at_plan + intent.filled_size)
              ) >= greatest(state.drift_tolerance_size, 1)
            )
          )
        )
    );
$$;

revoke all on function public.get_copy_order_observation_guards() from public, anon, authenticated;
grant execute on function public.get_copy_order_observation_guards() to service_role;

comment on function public.get_copy_order_observation_guards() is
  'Returns account-position keys that must remain locked until Gate position observation confirms the fill.';
