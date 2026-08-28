-- Allow an approved administrator to revoke one member's Gate credentials.
-- This is deliberately fail-closed: copying is halted before credentials are destroyed.
create or replace function public.admin_disable_member_gate_api_connection(
  p_user_id uuid,
  p_confirmation text
)
returns void
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  encryption_key text;
begin
  if not public.is_approved_admin() then
    raise exception 'ADMIN_REQUIRED';
  end if;
  if p_confirmation <> 'ADMIN_DISCONNECT_MEMBER_GATE_API' then
    raise exception 'CONFIRMATION_REQUIRED';
  end if;
  if not exists (
    select 1 from public.profiles
    where id = p_user_id and role = 'MEMBER' and approval_status = 'APPROVED'
  ) then
    raise exception 'APPROVED_MEMBER_REQUIRED';
  end if;

  select decrypted_secret into encryption_key
  from vault.decrypted_secrets
  where name = 'gate_api_credentials_key';
  if coalesce(encryption_key, '') = '' then
    raise exception 'CREDENTIAL_ENCRYPTION_KEY_MISSING';
  end if;

  update public.profiles
  set copy_paused = true, member_halted = true, updated_at = now()
  where id = p_user_id;

  update private.copy_order_intents
  set status = 'CANCELLED', resolved_at = now(), updated_at = now(),
      last_error_code = 'MEMBER_API_DISCONNECTED_BY_ADMIN'
  where user_id = p_user_id and status in ('PLANNED', 'QUEUED');

  update private.trading_accounts
  set status = 'DISABLED', updated_at = now()
  where credential_user_id = p_user_id and account_role = 'MEMBER';

  delete from private.gate_api_verification_jobs where user_id = p_user_id;

  update private.gate_api_credentials
  set gate_uid = 'DISABLED',
      api_key_ciphertext = pgp_sym_encrypt(encode(gen_random_bytes(32), 'hex'), encryption_key, 'cipher-algo=aes256'),
      secret_key_ciphertext = pgp_sym_encrypt(encode(gen_random_bytes(32), 'hex'), encryption_key, 'cipher-algo=aes256'),
      api_key_last4 = 'NONE', status = 'DISABLED', futures_read = false,
      futures_trade = false, ip_whitelisted = false, withdrawal_disabled = true,
      verified_at = null, updated_at = now()
  where user_id = p_user_id and connection_role = 'MEMBER';

  insert into public.copy_events(user_id, event_type, severity, safe_payload)
  values(p_user_id, 'MEMBER_HALTED', 'WARNING',
    jsonb_build_object('reason', 'API_DISCONNECTED_BY_ADMIN', 'actor_id', auth.uid()));
  insert into public.admin_audit_logs(actor_id, action, target_user_id, next_value)
  values(auth.uid(), 'MEMBER_GATE_API_DISCONNECTED', p_user_id,
    jsonb_build_object('copy_paused', true, 'member_halted', true));
end;
$$;

revoke all on function public.admin_disable_member_gate_api_connection(uuid, text)
  from public, anon, authenticated;
grant execute on function public.admin_disable_member_gate_api_connection(uuid, text)
  to authenticated;
