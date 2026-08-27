-- Re-run a member API verification after Gate.io permission or IP changes.
-- Existing encrypted credentials are reused and never returned to the browser.
create or replace function public.retry_my_gate_api_verification(
  p_permission_confirmed boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare saved_connection private.gate_api_credentials;
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED'; end if;
  if not exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'MEMBER' and approval_status = 'APPROVED'
  ) then raise exception 'APPROVED_MEMBER_REQUIRED'; end if;
  if p_permission_confirmed is not true then raise exception 'PERMISSION_CONFIRMATION_REQUIRED'; end if;

  select * into saved_connection
  from private.gate_api_credentials
  where user_id = auth.uid()
    and connection_role = 'MEMBER'
    and status <> 'DISABLED'
  for update;

  if not found then raise exception 'MEMBER_CREDENTIALS_NOT_FOUND'; end if;

  update private.gate_api_credentials
  set status = 'PENDING_VERIFICATION',
      futures_read = false,
      futures_trade = true,
      ip_whitelisted = false,
      withdrawal_disabled = true,
      permissions_confirmed = true,
      gate_user_id = null,
      last_error = null,
      last_error_code = null,
      verified_at = null,
      last_checked_at = null,
      updated_at = now()
  where user_id = auth.uid()
    and connection_role = 'MEMBER'
  returning * into saved_connection;

  insert into private.gate_api_verification_jobs (user_id, attempts, run_after, claimed_at, updated_at)
  values (auth.uid(), 0, now(), null, now())
  on conflict (user_id) do update set
    attempts = 0,
    run_after = now(),
    claimed_at = null,
    updated_at = now();

  update private.trading_accounts
  set status = 'DISABLED', updated_at = now()
  where credential_user_id = auth.uid()
    and account_role = 'MEMBER';

  insert into public.admin_audit_logs (actor_id, action, target_user_id, next_value)
  values (
    auth.uid(),
    'MEMBER_GATE_API_REVERIFICATION_REQUESTED',
    auth.uid(),
    jsonb_build_object(
      'gate_uid', saved_connection.gate_uid,
      'api_key_last4', saved_connection.api_key_last4,
      'credentials_reused', true
    )
  );

  return jsonb_build_object(
    'gate_uid', saved_connection.gate_uid,
    'api_key_last4', saved_connection.api_key_last4,
    'status', saved_connection.status,
    'futures_read', saved_connection.futures_read,
    'futures_trade', saved_connection.futures_trade,
    'ip_whitelisted', saved_connection.ip_whitelisted,
    'withdrawal_disabled', saved_connection.withdrawal_disabled,
    'permissions_confirmed', saved_connection.permissions_confirmed,
    'last_error_code', saved_connection.last_error_code,
    'last_checked_at', saved_connection.last_checked_at,
    'updated_at', saved_connection.updated_at
  );
end;
$$;

revoke all on function public.retry_my_gate_api_verification(boolean)
  from public, anon;
grant execute on function public.retry_my_gate_api_verification(boolean)
  to authenticated;
