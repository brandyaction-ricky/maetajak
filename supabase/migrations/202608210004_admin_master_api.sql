alter table private.gate_api_credentials
  add column if not exists connection_role text not null default 'MEMBER'
    check (connection_role in ('MEMBER', 'MASTER'));

create or replace function public.save_admin_gate_api_credentials(
  p_gate_uid text, p_api_key text, p_secret_key text, p_permission_confirmed boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare encryption_key text;
declare saved_connection private.gate_api_credentials;
begin
  if not public.is_approved_admin() then raise exception 'ADMIN_REQUIRED'; end if;
  if p_permission_confirmed is not true then raise exception 'PERMISSION_CONFIRMATION_REQUIRED'; end if;
  if length(trim(p_gate_uid)) < 4 or length(trim(p_api_key)) < 16 or length(trim(p_secret_key)) < 16 then
    raise exception 'INVALID_CREDENTIALS';
  end if;

  select decrypted_secret into encryption_key from vault.decrypted_secrets
  where name = 'gate_api_credentials_key';
  if encryption_key is null then raise exception 'ENCRYPTION_KEY_NOT_CONFIGURED'; end if;

  insert into private.gate_api_credentials (
    user_id, gate_uid, api_key_ciphertext, secret_key_ciphertext, api_key_last4,
    status, futures_read, futures_trade, ip_whitelisted, withdrawal_disabled,
    permissions_confirmed, connection_role, last_error, last_error_code,
    verified_at, last_checked_at, updated_at
  ) values (
    auth.uid(), trim(p_gate_uid),
    pgp_sym_encrypt(trim(p_api_key), encryption_key, 'cipher-algo=aes256'),
    pgp_sym_encrypt(trim(p_secret_key), encryption_key, 'cipher-algo=aes256'),
    right(trim(p_api_key), 4), 'PENDING_VERIFICATION', false, true, false, true,
    true, 'MASTER', null, null, null, null, now()
  )
  on conflict (user_id) do update set
    gate_uid = excluded.gate_uid,
    api_key_ciphertext = excluded.api_key_ciphertext,
    secret_key_ciphertext = excluded.secret_key_ciphertext,
    api_key_last4 = excluded.api_key_last4,
    status = 'PENDING_VERIFICATION', futures_read = false, futures_trade = true,
    ip_whitelisted = false, withdrawal_disabled = true, permissions_confirmed = true,
    connection_role = 'MASTER', gate_user_id = null, last_error = null,
    last_error_code = null, verified_at = null, last_checked_at = null, updated_at = now()
  returning * into saved_connection;

  insert into private.gate_api_verification_jobs (user_id, attempts, run_after, claimed_at, updated_at)
  values (auth.uid(), 0, now(), null, now())
  on conflict (user_id) do update set attempts = 0, run_after = now(), claimed_at = null, updated_at = now();

  update private.trading_accounts set status = 'DISABLED', updated_at = now()
  where credential_user_id = auth.uid() and account_role = 'MASTER';

  insert into public.admin_audit_logs (actor_id, action, target_user_id, next_value)
  values (auth.uid(), 'MASTER_GATE_API_CREDENTIALS_SAVED', auth.uid(),
    jsonb_build_object('gate_uid', saved_connection.gate_uid, 'api_key_last4', saved_connection.api_key_last4));

  return jsonb_build_object(
    'gate_uid', saved_connection.gate_uid, 'api_key_last4', saved_connection.api_key_last4,
    'status', saved_connection.status, 'futures_read', saved_connection.futures_read,
    'futures_trade', saved_connection.futures_trade, 'ip_whitelisted', saved_connection.ip_whitelisted,
    'withdrawal_disabled', saved_connection.withdrawal_disabled,
    'permissions_confirmed', saved_connection.permissions_confirmed,
    'last_error_code', saved_connection.last_error_code,
    'last_checked_at', saved_connection.last_checked_at, 'updated_at', saved_connection.updated_at
  );
end;
$$;

create or replace function public.get_admin_master_gate_api_connection()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare result jsonb;
begin
  if not public.is_approved_admin() then raise exception 'ADMIN_REQUIRED'; end if;
  select jsonb_build_object(
    'gate_uid', connection.gate_uid, 'api_key_last4', connection.api_key_last4,
    'status', connection.status, 'futures_read', connection.futures_read,
    'futures_trade', connection.futures_trade, 'ip_whitelisted', connection.ip_whitelisted,
    'withdrawal_disabled', connection.withdrawal_disabled,
    'permissions_confirmed', connection.permissions_confirmed,
    'last_error_code', connection.last_error_code,
    'last_checked_at', connection.last_checked_at, 'updated_at', connection.updated_at
  ) into result from private.gate_api_credentials as connection
  where connection.user_id = auth.uid() and connection.connection_role = 'MASTER';
  return result;
end;
$$;

create or replace function public.complete_gate_api_verification(
  p_job_id bigint, p_success boolean, p_gate_user_id text default null,
  p_error_code text default null, p_error_message text default null
)
returns void language plpgsql security definer set search_path = public, pg_temp
as $$
declare target_user_id uuid;
declare target_connection_role text;
begin
  if coalesce(current_setting('request.jwt.claim.role', true), '') <> 'service_role' then
    raise exception 'SERVICE_ROLE_REQUIRED';
  end if;
  select job.user_id, credentials.connection_role
    into target_user_id, target_connection_role
  from private.gate_api_verification_jobs as job
  join private.gate_api_credentials as credentials on credentials.user_id = job.user_id
  where job.id = p_job_id for update of job;
  if target_user_id is null then raise exception 'JOB_NOT_FOUND'; end if;

  update private.gate_api_credentials set
    status = case when p_success then 'VERIFIED' else 'ERROR' end,
    futures_read = p_success, ip_whitelisted = p_success,
    gate_user_id = nullif(trim(p_gate_user_id), ''),
    last_error_code = case when p_success then null else left(coalesce(p_error_code, 'VERIFICATION_FAILED'), 80) end,
    last_error = case when p_success then null else left(coalesce(p_error_message, 'Gate.io verification failed'), 300) end,
    last_checked_at = now(), verified_at = case when p_success then now() else null end, updated_at = now()
  where user_id = target_user_id;

  if p_success then
    insert into private.trading_accounts (
      user_id, credential_user_id, account_role, settle, status, is_primary, updated_at
    ) values (
      target_user_id, target_user_id, target_connection_role, 'usdt', 'ACTIVE', true, now()
    ) on conflict (credential_user_id, account_role, settle) do update set
      status = 'ACTIVE', updated_at = now();
  else
    update private.trading_accounts set status = 'ERROR', updated_at = now()
    where credential_user_id = target_user_id and account_role = target_connection_role;
  end if;

  delete from private.gate_api_verification_jobs where id = p_job_id;
  insert into public.admin_audit_logs (action, target_user_id, next_value)
  values (case when p_success then 'GATE_API_VERIFIED' else 'GATE_API_VERIFICATION_FAILED' end,
    target_user_id, jsonb_build_object(
      'success', p_success, 'connection_role', target_connection_role, 'error_code', p_error_code
    ));
end;
$$;

revoke all on function public.save_admin_gate_api_credentials(text, text, text, boolean) from public;
revoke all on function public.get_admin_master_gate_api_connection() from public;
revoke all on function public.complete_gate_api_verification(bigint, boolean, text, text, text) from public;
grant execute on function public.save_admin_gate_api_credentials(text, text, text, boolean) to authenticated;
grant execute on function public.get_admin_master_gate_api_connection() to authenticated;
grant execute on function public.complete_gate_api_verification(bigint, boolean, text, text, text) to service_role;
