create extension if not exists supabase_vault with schema vault;

create schema if not exists private;
revoke all on schema private from public;

create table if not exists private.gate_api_credentials (
  user_id uuid primary key references auth.users(id) on delete cascade,
  gate_uid text not null,
  api_key_ciphertext bytea not null,
  secret_key_ciphertext bytea not null,
  api_key_last4 text not null,
  status text not null default 'PENDING_VERIFICATION'
    check (status in ('PENDING_VERIFICATION', 'VERIFIED', 'ERROR', 'DISABLED')),
  futures_read boolean not null default false,
  futures_trade boolean not null default false,
  ip_whitelisted boolean not null default false,
  withdrawal_disabled boolean not null default true,
  last_error text,
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table private.gate_api_credentials enable row level security;
revoke all on private.gate_api_credentials from public, anon, authenticated;

do $$
begin
  if not exists (select 1 from vault.secrets where name = 'gate_api_credentials_key') then
    perform vault.create_secret(
      encode(gen_random_bytes(32), 'hex'),
      'gate_api_credentials_key',
      'maetajak Gate.io credential encryption key'
    );
  end if;
end;
$$;

create or replace function public.save_gate_api_credentials(
  p_gate_uid text,
  p_api_key text,
  p_secret_key text,
  p_permission_confirmed boolean
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

  select decrypted_secret into encryption_key
  from vault.decrypted_secrets
  where name = 'gate_api_credentials_key';
  if encryption_key is null then raise exception 'ENCRYPTION_KEY_NOT_CONFIGURED'; end if;

  insert into private.gate_api_credentials (
    user_id, gate_uid, api_key_ciphertext, secret_key_ciphertext, api_key_last4,
    status, futures_read, futures_trade, ip_whitelisted, withdrawal_disabled, updated_at
  ) values (
    auth.uid(), trim(p_gate_uid),
    pgp_sym_encrypt(trim(p_api_key), encryption_key, 'cipher-algo=aes256'),
    pgp_sym_encrypt(trim(p_secret_key), encryption_key, 'cipher-algo=aes256'),
    right(trim(p_api_key), 4), 'PENDING_VERIFICATION', false, false, false, true, now()
  )
  on conflict (user_id) do update set
    gate_uid = excluded.gate_uid,
    api_key_ciphertext = excluded.api_key_ciphertext,
    secret_key_ciphertext = excluded.secret_key_ciphertext,
    api_key_last4 = excluded.api_key_last4,
    status = 'PENDING_VERIFICATION',
    futures_read = false,
    futures_trade = false,
    ip_whitelisted = false,
    withdrawal_disabled = true,
    last_error = null,
    verified_at = null,
    updated_at = now()
  returning * into saved_connection;

  return jsonb_build_object(
    'gate_uid', saved_connection.gate_uid,
    'api_key_last4', saved_connection.api_key_last4,
    'status', saved_connection.status,
    'futures_read', saved_connection.futures_read,
    'futures_trade', saved_connection.futures_trade,
    'ip_whitelisted', saved_connection.ip_whitelisted,
    'withdrawal_disabled', saved_connection.withdrawal_disabled,
    'updated_at', saved_connection.updated_at
  );
end;
$$;

create or replace function public.get_my_gate_api_connection()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'gate_uid', connection.gate_uid,
    'api_key_last4', connection.api_key_last4,
    'status', connection.status,
    'futures_read', connection.futures_read,
    'futures_trade', connection.futures_trade,
    'ip_whitelisted', connection.ip_whitelisted,
    'withdrawal_disabled', connection.withdrawal_disabled,
    'updated_at', connection.updated_at
  )
  from private.gate_api_credentials as connection
  where connection.user_id = auth.uid();
$$;

revoke all on function public.save_gate_api_credentials(text, text, text, boolean) from public;
revoke all on function public.get_my_gate_api_connection() from public;
grant execute on function public.save_gate_api_credentials(text, text, text, boolean) to authenticated;
grant execute on function public.get_my_gate_api_connection() to authenticated;
