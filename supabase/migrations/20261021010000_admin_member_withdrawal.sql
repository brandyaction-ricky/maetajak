-- 2026-10-21: administrator member withdrawal ("회원 탈퇴 처리") and restore.
--
-- Operator decisions: withdrawal is a soft delete (records kept: trades, performance, audit), it is
-- allowed while the member still holds Gate positions (the platform simply stops managing them), and
-- a withdrawn member comes back only through an administrator restore.
--
-- admin_withdraw_member: stops copying (paused + halted, sessions PAUSED), disables the trading
--   account, cancels unsubmitted plans, revokes the stored Gate API key (same way as a disconnect),
--   parks pending verification jobs, marks the profile SUSPENDED + withdrawn_at, and bans the auth user
--   so they cannot sign in. Refused while a platform order is in flight (outcome not yet known).
-- admin_restore_withdrawn_member: clears the withdrawal and the ban; the member returns as PENDING
--   (approved again through the normal approval flow), still paused/halted with no API key.
-- set_user_approval: a withdrawn member cannot be approved/rejected directly (restore first).
-- No row is deleted anywhere.

set lock_timeout = '5s';

alter table public.profiles
  add column if not exists withdrawn_at timestamptz,
  add column if not exists withdrawn_by uuid,
  add column if not exists withdrawal_reason text;

create or replace function public.admin_withdraw_member(p_user_id uuid, p_confirmation text, p_reason text default null)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'extensions', 'pg_temp'
as $function$
declare encryption_key text; target public.profiles; open_positions integer;
begin
  if not public.is_approved_admin() then raise exception 'ADMIN_REQUIRED'; end if;
  if p_confirmation is distinct from 'ADMIN_WITHDRAW_MEMBER' then raise exception 'CONFIRMATION_REQUIRED'; end if;
  perform pg_advisory_xact_lock(hashtextextended('maetajak:copy-execution',0));
  select * into target from public.profiles where id = p_user_id and role = 'MEMBER' for update;
  if target.id is null then raise exception 'MEMBER_NOT_FOUND'; end if;
  if target.withdrawn_at is not null then raise exception 'MEMBER_ALREADY_WITHDRAWN'; end if;
  -- A platform order whose outcome is not known yet must settle first (it may still fill).
  if exists (select 1 from private.copy_order_intents i where i.user_id = p_user_id
      and i.submit_attempts > 0 and not i.exchange_terminal
      and i.status in ('SUBMITTING','ACKNOWLEDGED','UNKNOWN','PARTIALLY_FILLED')) then
    raise exception 'MEMBER_HAS_UNRESOLVED_ORDERS';
  end if;
  select decrypted_secret into encryption_key from vault.decrypted_secrets where name = 'gate_api_credentials_key';
  if coalesce(encryption_key, '') = '' then raise exception 'CREDENTIAL_ENCRYPTION_KEY_MISSING'; end if;
  select count(*) into open_positions from private.copy_current_positions p
    join private.trading_accounts a on a.id = p.trading_account_id
    where a.credential_user_id = p_user_id and a.account_role = 'MEMBER' and p.size <> 0
      and p.copy_cycle_id = (select c.copy_cycle_id from private.copy_current_accounts c where c.trading_account_id = a.id);

  update public.profiles set copy_paused = true, member_halted = true, close_positions_requested = false,
      approval_status = 'SUSPENDED', withdrawn_at = now(), withdrawn_by = auth.uid(),
      withdrawal_reason = left(nullif(trim(p_reason), ''), 300), updated_at = now()
    where id = p_user_id;
  update private.trading_accounts set status = 'DISABLED', updated_at = now()
    where credential_user_id = p_user_id and account_role = 'MEMBER';
  update private.copy_order_intents set status = 'CANCELLED', resolved_at = now(),
      last_error_code = 'MEMBER_WITHDRAWN', updated_at = now()
    where user_id = p_user_id and status in ('PLANNED','QUEUED') and submit_attempts = 0;
  -- Pending verification jobs are parked (never claimed: run_after is compared with now()).
  update private.gate_api_verification_jobs set run_after = 'infinity', claimed_at = null, updated_at = now()
    where user_id = p_user_id;
  update private.gate_api_credentials set gate_uid = 'DISABLED',
      api_key_ciphertext = pgp_sym_encrypt(encode(gen_random_bytes(32),'hex'), encryption_key, 'cipher-algo=aes256'),
      secret_key_ciphertext = pgp_sym_encrypt(encode(gen_random_bytes(32),'hex'), encryption_key, 'cipher-algo=aes256'),
      api_key_last4 = 'NONE', status = 'DISABLED', futures_read = false, futures_trade = false,
      ip_whitelisted = false, withdrawal_disabled = true, verified_at = null, updated_at = now()
    where user_id = p_user_id and connection_role = 'MEMBER';
  -- Last: the account/credential triggers above also pause sessions with their own reason.
  update private.copy_resume_sessions s set state = 'PAUSED', blocker_reason = 'MEMBER_WITHDRAWN', updated_at = now()
    from private.trading_accounts a where a.id = s.trading_account_id and a.user_id = p_user_id;
  update auth.users set banned_until = 'infinity', updated_at = now() where id = p_user_id;

  insert into public.copy_events(user_id, event_type, severity, safe_payload)
    values (p_user_id, 'MEMBER_HALTED', 'WARNING',
      jsonb_build_object('reason', 'MEMBER_WITHDRAWN', 'open_positions', open_positions));
  insert into public.admin_audit_logs(actor_id, action, target_user_id, previous_value, next_value)
    values (auth.uid(), 'MEMBER_WITHDRAWN', p_user_id,
      jsonb_build_object('approval_status', target.approval_status, 'copy_paused', target.copy_paused,
        'member_halted', target.member_halted),
      jsonb_build_object('approval_status', 'SUSPENDED', 'reason', left(nullif(trim(p_reason), ''), 300),
        'open_positions', open_positions));
  return jsonb_build_object('user_id', p_user_id, 'withdrawn', true, 'open_positions', open_positions);
end;
$function$;
revoke all on function public.admin_withdraw_member(uuid, text, text) from public, anon, service_role;
grant execute on function public.admin_withdraw_member(uuid, text, text) to authenticated;

create or replace function public.admin_restore_withdrawn_member(p_user_id uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare target public.profiles;
begin
  if not public.is_approved_admin() then raise exception 'ADMIN_REQUIRED'; end if;
  select * into target from public.profiles where id = p_user_id and role = 'MEMBER' for update;
  if target.id is null then raise exception 'MEMBER_NOT_FOUND'; end if;
  if target.withdrawn_at is null then raise exception 'MEMBER_NOT_WITHDRAWN'; end if;
  update public.profiles set approval_status = 'PENDING', withdrawn_at = null, withdrawn_by = null,
      withdrawal_reason = null, updated_at = now()
    where id = p_user_id;
  update auth.users set banned_until = null, updated_at = now() where id = p_user_id;
  insert into public.admin_audit_logs(actor_id, action, target_user_id, previous_value, next_value)
    values (auth.uid(), 'MEMBER_RESTORED', p_user_id,
      jsonb_build_object('withdrawn_at', target.withdrawn_at, 'reason', target.withdrawal_reason),
      jsonb_build_object('approval_status', 'PENDING'));
  return jsonb_build_object('user_id', p_user_id, 'restored', true, 'approval_status', 'PENDING');
end;
$function$;
revoke all on function public.admin_restore_withdrawn_member(uuid) from public, anon, service_role;
grant execute on function public.admin_restore_withdrawn_member(uuid) to authenticated;

-- A withdrawn member is restored only through admin_restore_withdrawn_member (which also lifts the ban).
create or replace function public.set_user_approval(target_user_id uuid, new_status text)
 returns profiles
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  previous_profile public.profiles;
  updated_profile public.profiles;
begin
  if not public.is_approved_admin() then
    raise exception 'ADMIN_REQUIRED';
  end if;
  if new_status not in ('APPROVED', 'REJECTED', 'SUSPENDED') then
    raise exception 'INVALID_APPROVAL_STATUS';
  end if;

  select * into previous_profile from public.profiles where id = target_user_id for update;
  if not found then raise exception 'PROFILE_NOT_FOUND'; end if;
  if previous_profile.withdrawn_at is not null then raise exception 'MEMBER_WITHDRAWN'; end if;

  update public.profiles
  set approval_status = new_status,
      approved_at = case when new_status = 'APPROVED' then now() else approved_at end,
      approved_by = auth.uid(),
      updated_at = now()
  where id = target_user_id
  returning * into updated_profile;

  insert into public.admin_audit_logs (actor_id, action, target_user_id, previous_value, next_value)
  values (auth.uid(), 'USER_APPROVAL_CHANGED', target_user_id, to_jsonb(previous_profile), to_jsonb(updated_profile));
  return updated_profile;
end;
$function$;
