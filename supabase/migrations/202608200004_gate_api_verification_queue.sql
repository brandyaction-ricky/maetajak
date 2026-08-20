alter table private.gate_api_credentials
  add column if not exists permissions_confirmed boolean not null default false,
  add column if not exists gate_user_id text,
  add column if not exists last_checked_at timestamptz,
  add column if not exists last_error_code text;

alter table private.gate_api_credentials drop constraint if exists gate_api_credentials_status_check;
alter table private.gate_api_credentials add constraint gate_api_credentials_status_check
  check (status in ('PENDING_VERIFICATION', 'VERIFYING', 'VERIFIED', 'ERROR', 'DISABLED'));

create table if not exists private.gate_api_verification_jobs (
  id bigint generated always as identity primary key,
  user_id uuid not null unique references auth.users(id) on delete cascade,
  attempts integer not null default 0,
  run_after timestamptz not null default now(),
  claimed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table private.gate_api_verification_jobs enable row level security;
revoke all on private.gate_api_verification_jobs from public, anon, authenticated;

create or replace function public.save_gate_api_credentials(
  p_gate_uid text, p_api_key text, p_secret_key text, p_permission_confirmed boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  encryption_key text;
  saved_connection private.gate_api_credentials;
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED'; end if;
  if not exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'MEMBER' and approval_status = 'APPROVED'
  ) then raise exception 'APPROVED_MEMBER_REQUIRED'; end if;
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
    permissions_confirmed, last_error, last_error_code, verified_at, last_checked_at, updated_at
  ) values (
    auth.uid(), trim(p_gate_uid),
    pgp_sym_encrypt(trim(p_api_key), encryption_key, 'cipher-algo=aes256'),
    pgp_sym_encrypt(trim(p_secret_key), encryption_key, 'cipher-algo=aes256'),
    right(trim(p_api_key), 4), 'PENDING_VERIFICATION', false, true, false, true,
    true, null, null, null, null, now()
  )
  on conflict (user_id) do update set
    gate_uid = excluded.gate_uid,
    api_key_ciphertext = excluded.api_key_ciphertext,
    secret_key_ciphertext = excluded.secret_key_ciphertext,
    api_key_last4 = excluded.api_key_last4,
    status = 'PENDING_VERIFICATION', futures_read = false, futures_trade = true,
    ip_whitelisted = false, withdrawal_disabled = true, permissions_confirmed = true,
    gate_user_id = null, last_error = null, last_error_code = null,
    verified_at = null, last_checked_at = null, updated_at = now()
  returning * into saved_connection;

  insert into private.gate_api_verification_jobs (user_id, attempts, run_after, claimed_at, updated_at)
  values (auth.uid(), 0, now(), null, now())
  on conflict (user_id) do update set attempts = 0, run_after = now(), claimed_at = null, updated_at = now();

  insert into public.admin_audit_logs (actor_id, action, target_user_id, next_value)
  values (auth.uid(), 'GATE_API_CREDENTIALS_SAVED', auth.uid(),
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

create or replace function public.get_my_gate_api_connection()
returns jsonb language sql stable security definer set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'gate_uid', connection.gate_uid, 'api_key_last4', connection.api_key_last4,
    'status', connection.status, 'futures_read', connection.futures_read,
    'futures_trade', connection.futures_trade, 'ip_whitelisted', connection.ip_whitelisted,
    'withdrawal_disabled', connection.withdrawal_disabled,
    'permissions_confirmed', connection.permissions_confirmed,
    'last_error_code', connection.last_error_code,
    'last_checked_at', connection.last_checked_at, 'updated_at', connection.updated_at
  ) from private.gate_api_credentials as connection where connection.user_id = auth.uid();
$$;

create or replace function public.get_admin_gate_api_connections()
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare result jsonb;
begin
  if not public.is_approved_admin() then raise exception 'ADMIN_REQUIRED'; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'user_id', profile.id, 'full_name', profile.full_name, 'email', profile.email,
    'gate_uid', connection.gate_uid, 'api_key_last4', connection.api_key_last4,
    'status', coalesce(connection.status, 'NOT_CONNECTED'),
    'futures_read', coalesce(connection.futures_read, false),
    'permissions_confirmed', coalesce(connection.permissions_confirmed, false),
    'last_error_code', connection.last_error_code,
    'last_checked_at', connection.last_checked_at, 'updated_at', connection.updated_at
  ) order by profile.created_at desc), '[]'::jsonb) into result
  from public.profiles as profile
  left join private.gate_api_credentials as connection on connection.user_id = profile.id
  where profile.role = 'MEMBER' and profile.approval_status = 'APPROVED';
  return result;
end;
$$;

create or replace function public.claim_gate_api_verification_jobs(p_limit integer default 5)
returns table (job_id bigint, user_id uuid, gate_uid text, api_key text, secret_key text)
language plpgsql security definer set search_path = public, pg_temp
as $$
declare encryption_key text;
begin
  if coalesce(current_setting('request.jwt.claim.role', true), '') <> 'service_role' then
    raise exception 'SERVICE_ROLE_REQUIRED';
  end if;
  select decrypted_secret into encryption_key from vault.decrypted_secrets
  where name = 'gate_api_credentials_key';
  if encryption_key is null then raise exception 'ENCRYPTION_KEY_NOT_CONFIGURED'; end if;

  return query
  with claimed as (
    select job.id from private.gate_api_verification_jobs as job
    where job.run_after <= now() and (job.claimed_at is null or job.claimed_at < now() - interval '2 minutes')
    order by job.created_at for update skip locked
    limit greatest(1, least(coalesce(p_limit, 5), 20))
  ), updated_jobs as (
    update private.gate_api_verification_jobs as job
    set claimed_at = now(), attempts = job.attempts + 1, updated_at = now()
    from claimed where job.id = claimed.id returning job.id, job.user_id
  ), marked as (
    update private.gate_api_credentials as credentials
    set status = 'VERIFYING', updated_at = now()
    from updated_jobs where credentials.user_id = updated_jobs.user_id
    returning credentials.user_id
  )
  select updated_jobs.id, credentials.user_id, credentials.gate_uid,
    pgp_sym_decrypt(credentials.api_key_ciphertext, encryption_key),
    pgp_sym_decrypt(credentials.secret_key_ciphertext, encryption_key)
  from updated_jobs
  join private.gate_api_credentials as credentials on credentials.user_id = updated_jobs.user_id
  join marked on marked.user_id = updated_jobs.user_id;
end;
$$;

create or replace function public.complete_gate_api_verification(
  p_job_id bigint, p_success boolean, p_gate_user_id text default null,
  p_error_code text default null, p_error_message text default null
)
returns void language plpgsql security definer set search_path = public, pg_temp
as $$
declare target_user_id uuid;
begin
  if coalesce(current_setting('request.jwt.claim.role', true), '') <> 'service_role' then
    raise exception 'SERVICE_ROLE_REQUIRED';
  end if;
  select user_id into target_user_id from private.gate_api_verification_jobs where id = p_job_id for update;
  if target_user_id is null then raise exception 'JOB_NOT_FOUND'; end if;

  update private.gate_api_credentials set
    status = case when p_success then 'VERIFIED' else 'ERROR' end,
    futures_read = p_success, ip_whitelisted = p_success,
    gate_user_id = nullif(trim(p_gate_user_id), ''),
    last_error_code = case when p_success then null else left(coalesce(p_error_code, 'VERIFICATION_FAILED'), 80) end,
    last_error = case when p_success then null else left(coalesce(p_error_message, 'Gate.io verification failed'), 300) end,
    last_checked_at = now(), verified_at = case when p_success then now() else null end, updated_at = now()
  where user_id = target_user_id;
  delete from private.gate_api_verification_jobs where id = p_job_id;
  insert into public.admin_audit_logs (action, target_user_id, next_value)
  values (case when p_success then 'GATE_API_VERIFIED' else 'GATE_API_VERIFICATION_FAILED' end,
    target_user_id, jsonb_build_object('success', p_success, 'error_code', p_error_code));
end;
$$;

revoke all on function public.get_admin_gate_api_connections() from public;
revoke all on function public.claim_gate_api_verification_jobs(integer) from public;
revoke all on function public.complete_gate_api_verification(bigint, boolean, text, text, text) from public;
grant execute on function public.get_admin_gate_api_connections() to authenticated;
grant execute on function public.claim_gate_api_verification_jobs(integer) to service_role;
grant execute on function public.complete_gate_api_verification(bigint, boolean, text, text, text) to service_role;

