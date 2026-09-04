-- Phase 2: remove unbounded snapshot scans from the five-second worker hot path.
--
-- Current State is already maintained after every successful cycle. Risk
-- baselines are therefore read from the bounded one-row-per-account table.
-- A newly connected account has no Current State row for its first cycle, so
-- the bounded baselines are null until the first Current State upsert completes.

create index if not exists copy_order_intents_account_contract_updated_idx
  on private.copy_order_intents (trading_account_id, contract, updated_at desc)
  include (filled_size, status);

create index if not exists copy_order_intents_unresolved_account_contract_idx
  on private.copy_order_intents (trading_account_id, contract)
  where status in ('SUBMITTING', 'ACKNOWLEDGED', 'PARTIALLY_FILLED', 'UNKNOWN');

create or replace function public.get_copy_worker_context()
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  encryption_key text;
  result jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'SERVICE_ROLE_REQUIRED';
  end if;

  select decrypted_secret
  into encryption_key
  from vault.decrypted_secrets
  where name = 'gate_api_credentials_key';

  if encryption_key is null then
    raise exception 'ENCRYPTION_KEY_NOT_CONFIGURED';
  end if;

  select jsonb_build_object(
    'system', (
      select jsonb_build_object(
        'execution_enabled', control.execution_enabled,
        'emergency_halted', control.emergency_halted,
        'halt_reason', control.halt_reason,
        'slippage_ratio', control.max_order_slippage_ratio
      )
      from public.copy_system_control control
      where control.singleton
    ),
    'master', (
      select jsonb_build_object(
        'trading_account_id', account.id,
        'user_id', account.user_id,
        'gate_uid', credentials.gate_uid,
        'api_key', pgp_sym_decrypt(credentials.api_key_ciphertext, encryption_key),
        'secret_key', pgp_sym_decrypt(credentials.secret_key_ciphertext, encryption_key)
      )
      from private.trading_accounts account
      join private.gate_api_credentials credentials
        on credentials.user_id = account.credential_user_id
      where account.account_role = 'MASTER'
        and account.status = 'ACTIVE'
        and credentials.status = 'VERIFIED'
        and credentials.futures_read
        and not credentials.futures_trade
      order by account.updated_at desc
      limit 1
    ),
    'members', coalesce((
      select jsonb_agg(jsonb_build_object(
        'trading_account_id', account.id,
        'user_id', account.user_id,
        'gate_uid', credentials.gate_uid,
        'api_key', pgp_sym_decrypt(credentials.api_key_ciphertext, encryption_key),
        'secret_key', pgp_sym_decrypt(credentials.secret_key_ciphertext, encryption_key),
        'copy_ratio', profile.copy_ratio,
        'max_position_ratio', profile.max_position_ratio,
        'copy_paused', profile.copy_paused,
        'halted', profile.member_halted,
        'reduce_only', profile.reduce_only,
        'close_positions_requested', profile.close_positions_requested,
        'daily_loss_limit_pct', profile.daily_loss_limit_pct,
        'max_drawdown_pct', profile.max_drawdown_pct,
        'max_leverage', profile.max_leverage,
        'day_start_equity', current_account.day_start_equity,
        'peak_equity', current_account.peak_equity,
        'current_state_observed_at', current_account.observed_at,
        'previous_states', coalesce((
          select jsonb_agg(jsonb_build_object(
            'contract', state.contract,
            'position_side', state.position_side,
            'state', state.state,
            'actual_size', state.actual_size,
            'target_leverage', state.target_leverage,
            'margin_mode', state.margin_mode,
            'position_mode', state.position_mode,
            'last_observed_at', state.last_observed_at,
            'known_fill_delta', coalesce((
              select sum(intent.filled_size)
              from private.copy_order_intents intent
              where intent.trading_account_id = account.id
                and intent.contract = state.contract
                and intent.position_side = state.position_side
                and intent.updated_at > coalesce(state.last_observed_at, '-infinity'::timestamptz)
                and intent.filled_size <> 0
            ), 0),
            'has_unresolved_order', exists(
              select 1
              from private.copy_order_intents intent
              where intent.trading_account_id = account.id
                and intent.contract = state.contract
                and intent.position_side = state.position_side
                and intent.status in ('SUBMITTING', 'ACKNOWLEDGED', 'PARTIALLY_FILLED', 'UNKNOWN')
            )
          ) order by state.contract, state.position_side)
          from public.copy_position_states state
          where state.trading_account_id = account.id
        ), '[]'::jsonb)
      ) order by profile.created_at)
      from private.trading_accounts account
      join private.gate_api_credentials credentials
        on credentials.user_id = account.credential_user_id
      join public.profiles profile
        on profile.id = account.user_id
      left join private.copy_current_accounts current_account
        on current_account.trading_account_id = account.id
      where account.account_role = 'MEMBER'
        and account.status = 'ACTIVE'
        and credentials.status = 'VERIFIED'
        and credentials.futures_read
        and credentials.futures_trade
        and profile.role = 'MEMBER'
        and profile.approval_status = 'APPROVED'
    ), '[]'::jsonb)
  ) into result;

  return result;
end;
$$;

revoke all on function public.get_copy_worker_context() from public, anon, authenticated;
grant execute on function public.get_copy_worker_context() to service_role;

comment on function public.get_copy_worker_context() is
  'Bounded worker context. Reads risk baselines from Current State, never Snapshot history.';
