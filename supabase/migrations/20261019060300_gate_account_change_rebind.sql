-- 2026-10-19: connecting a DIFFERENT Gate account (new UID) starts that platform account from a
-- clean state, and RESUME clears reduce-only with a fresh risk baseline.
--
-- Before: re-registering credentials kept the same private.trading_accounts row, and nothing compared
-- the new Gate UID with the old one. Every per-account state row therefore carried over to the new
-- Gate account:
--   * peak/day-start equity of the old account -> immediate false drawdown/daily-loss reduce-only;
--   * the ownership ledger, anchors and FUTURE_ONLY baselines of the old account -> positions in the
--     new account could be labelled COPY and later sold by a Master reduction;
--   * a new MASTER account was diffed against the old Master's baselines/anchors -> members would buy
--     the new Master's whole book or sell on a "reduction" the Master never made.
-- Also: RESUME on an ACTIVE, unpaused member returned early and left reduce_only set; and after a
-- risk stop the old peak re-triggered reduce-only on the very next cycle.
--
-- After:
--   1. trading_accounts.bound_gate_uid records the Gate UID the account's state belongs to
--      (back-filled from the current VERIFIED credentials).
--   2. Saving credentials with a different UID: refused while that account has an unresolved order;
--      otherwise the member (or, for the Master, every member) is paused immediately.
--      A UID already registered by another user, or equal to the Master's, is refused.
--   3. When the new UID verifies, the account's per-account state is archived to
--      private.trading_account_rebind_archive and removed, and bound_gate_uid is updated. A Master
--      change also archives every member's Master-derived state (anchors, ownership ledger,
--      baselines), so the next resume treats everything a member holds as the member's own.
--      Other MASTER rows are disabled so only one Master is ever active.
--   4. RESUME clears reduce_only in every branch and resets the risk baseline to current equity.

set lock_timeout = '5s';

alter table private.trading_accounts add column if not exists bound_gate_uid text;

-- Back-fill from the stored credentials (a key that later failed - ERROR - still names the Gate
-- account the state belongs to). Credentials already re-saved and waiting for verification are
-- skipped: their UID may be the new account's.
update private.trading_accounts a set bound_gate_uid = trim(c.gate_uid)
from private.gate_api_credentials c
where c.user_id = a.credential_user_id and a.bound_gate_uid is null
  and c.status in ('VERIFIED', 'ERROR', 'DISABLED')
  and nullif(trim(c.gate_uid), '') is not null;

create table if not exists private.trading_account_rebind_archive (
  id bigserial primary key,
  trading_account_id uuid not null,
  account_role text not null,
  reason text not null,
  old_gate_uid text,
  new_gate_uid text,
  archived jsonb not null,
  created_at timestamptz not null default now()
);
alter table private.trading_account_rebind_archive enable row level security;

-- Orders that may still change positions: an account with one of these cannot change Gate account.
create or replace function private.trading_account_has_unresolved_orders(p_trading_account_id uuid)
returns boolean
language sql
stable
set search_path to 'pg_catalog'
as $$
  select exists (
    select 1 from private.copy_order_intents i
    where (p_trading_account_id is null or i.trading_account_id = p_trading_account_id)
      and i.status in ('SUBMITTING', 'ACKNOWLEDGED', 'PARTIALLY_FILLED', 'UNKNOWN')
      and not coalesce(i.exchange_terminal, false))
$$;

create or replace function private.archive_account_rows(p_trading_account_id uuid, p_master_derived_only boolean)
returns jsonb
language plpgsql
set search_path to 'pg_catalog'
as $$
declare result jsonb := '{}'::jsonb; rows jsonb;
begin
  -- Master-derived state (also cleared on every member when the Master account changes).
  select coalesce(jsonb_agg(to_jsonb(x)), '[]') into rows from private.copy_target_anchors x where x.trading_account_id = p_trading_account_id;
  result := result || jsonb_build_object('copy_target_anchors', rows);
  delete from private.copy_target_anchors where trading_account_id = p_trading_account_id;

  -- Fills reference their checkpoint: remove them first.
  select coalesce(jsonb_agg(to_jsonb(x)), '[]') into rows from private.copy_ownership_fills x where x.trading_account_id = p_trading_account_id;
  result := result || jsonb_build_object('copy_ownership_fills', rows);
  delete from private.copy_ownership_fills where trading_account_id = p_trading_account_id;

  select coalesce(jsonb_agg(to_jsonb(x)), '[]') into rows from private.copy_ownership_checkpoints x where x.trading_account_id = p_trading_account_id;
  result := result || jsonb_build_object('copy_ownership_checkpoints', rows);
  delete from private.copy_ownership_checkpoints where trading_account_id = p_trading_account_id;

  select coalesce(jsonb_agg(to_jsonb(x)), '[]') into rows from private.member_copy_onboarding_baselines x where x.trading_account_id = p_trading_account_id;
  result := result || jsonb_build_object('member_copy_onboarding_baselines', rows);
  delete from private.member_copy_onboarding_baselines where trading_account_id = p_trading_account_id;

  if p_master_derived_only then return result; end if;

  -- Observation and risk state of the Gate account itself.
  select coalesce(jsonb_agg(to_jsonb(x)), '[]') into rows from public.copy_position_states x where x.trading_account_id = p_trading_account_id;
  result := result || jsonb_build_object('copy_position_states', rows);
  delete from public.copy_position_states where trading_account_id = p_trading_account_id;

  select coalesce(jsonb_agg(to_jsonb(x)), '[]') into rows from private.copy_operation_risk x where x.trading_account_id = p_trading_account_id;
  result := result || jsonb_build_object('copy_operation_risk', rows);
  delete from private.copy_operation_risk where trading_account_id = p_trading_account_id;

  select coalesce(jsonb_agg(to_jsonb(x)), '[]') into rows from private.copy_current_accounts x where x.trading_account_id = p_trading_account_id;
  result := result || jsonb_build_object('copy_current_accounts', rows);
  delete from private.copy_current_accounts where trading_account_id = p_trading_account_id;

  select coalesce(jsonb_agg(to_jsonb(x)), '[]') into rows from private.copy_current_positions x where x.trading_account_id = p_trading_account_id;
  result := result || jsonb_build_object('copy_current_positions', rows);
  delete from private.copy_current_positions where trading_account_id = p_trading_account_id;

  select coalesce(jsonb_agg(to_jsonb(x)), '[]') into rows from private.copy_current_verifications x where x.trading_account_id = p_trading_account_id;
  result := result || jsonb_build_object('copy_current_verifications', rows);
  delete from private.copy_current_verifications where trading_account_id = p_trading_account_id;

  delete from private.copy_snapshot_checkpoints where trading_account_id = p_trading_account_id;

  select coalesce(jsonb_agg(to_jsonb(x)), '[]') into rows from private.copy_fund_flows x where x.trading_account_id = p_trading_account_id;
  result := result || jsonb_build_object('copy_fund_flows', rows);
  delete from private.copy_fund_flows where trading_account_id = p_trading_account_id;
  delete from private.copy_fund_flow_tracking where trading_account_id = p_trading_account_id;

  -- A pending open-order cancel job must never run against the new Gate account.
  update private.open_order_cancel_jobs set state = 'FAILED', attempts = greatest(attempts, 5),
    last_error_code = 'ACCOUNT_REBOUND', completed_at = coalesce(completed_at, now()), updated_at = now()
  where trading_account_id = p_trading_account_id and state in ('PENDING', 'PROCESSING', 'FAILED');
  return result;
end;
$$;

create or replace function private.pause_member_for_account_change(p_user_id uuid, p_reason text)
returns void
language plpgsql
set search_path to 'pg_catalog'
as $$
begin
  update public.profiles set copy_paused = true, reduce_only = false, close_positions_requested = false,
    updated_at = now() where id = p_user_id and role = 'MEMBER';
  update private.copy_resume_sessions s set state = 'PAUSED', blocker_reason = p_reason, updated_at = now()
  from private.trading_accounts a where a.id = s.trading_account_id and a.user_id = p_user_id
    and a.account_role = 'MEMBER';
  update private.copy_order_intents set status = 'CANCELLED', resolved_at = now(),
    last_error_code = left(p_reason, 80), updated_at = now()
  where user_id = p_user_id and status in ('PLANNED', 'QUEUED') and submit_attempts = 0;
end;
$$;

-- The Master's Gate account changed (new UID, or a different MASTER row became the active one):
-- every member is paused and loses the old Master's baselines/anchors/ownership ledger, and the
-- entry-alert bot is re-seeded silently (otherwise it would announce every old leg as closed and
-- every new leg as opened).
create or replace function private.reset_members_for_master_change(p_old_gate_uid text, p_new_gate_uid text)
returns integer
language plpgsql
set search_path to 'pg_catalog'
as $$
declare member_account record; archived jsonb; members_archived int := 0;
begin
  if to_regclass('master_alert.config') is not null then
    execute 'update master_alert.config set baseline_seeded = false, updated_at = now() where id';
    execute 'delete from master_alert.position_state where contract is not null';
  end if;
  for member_account in select a.id, a.user_id from private.trading_accounts a where a.account_role = 'MEMBER' loop
    perform private.pause_member_for_account_change(member_account.user_id, 'MASTER_ACCOUNT_CHANGED');
    archived := private.archive_account_rows(member_account.id, true);
    insert into private.trading_account_rebind_archive(trading_account_id, account_role, reason, old_gate_uid, new_gate_uid, archived)
    values (member_account.id, 'MEMBER', 'MASTER_ACCOUNT_CHANGED', p_old_gate_uid, p_new_gate_uid, archived);
    members_archived := members_archived + 1;
  end loop;
  return members_archived;
end;
$$;

create or replace function private.rebind_trading_account(p_trading_account_id uuid, p_new_gate_uid text)
returns jsonb
language plpgsql
set search_path to 'pg_catalog'
as $$
declare acct private.trading_accounts; archived jsonb; members_archived int := 0; has_state boolean;
begin
  select * into acct from private.trading_accounts where id = p_trading_account_id for update;
  if acct.id is null then raise exception 'TRADING_ACCOUNT_NOT_FOUND'; end if;
  if acct.bound_gate_uid is not distinct from p_new_gate_uid then
    return jsonb_build_object('rebound', false);
  end if;
  -- Unbound: a brand-new account binds; an unbound account that already has state (its Gate
  -- account is unknown) is treated as changed - archiving is safe, carrying over is not.
  has_state := exists (select 1 from public.copy_position_states where trading_account_id = acct.id)
    or exists (select 1 from private.copy_target_anchors where trading_account_id = acct.id)
    or exists (select 1 from private.copy_ownership_checkpoints where trading_account_id = acct.id)
    or exists (select 1 from private.copy_current_accounts where trading_account_id = acct.id);
  if acct.bound_gate_uid is null and not has_state then
    update private.trading_accounts set bound_gate_uid = p_new_gate_uid where id = acct.id;
    return jsonb_build_object('rebound', false, 'bound', true);
  end if;

  archived := private.archive_account_rows(acct.id, false);
  insert into private.trading_account_rebind_archive(trading_account_id, account_role, reason, old_gate_uid, new_gate_uid, archived)
  values (acct.id, acct.account_role, 'GATE_ACCOUNT_CHANGED', acct.bound_gate_uid, p_new_gate_uid, archived);

  if acct.account_role = 'MEMBER' then
    perform private.pause_member_for_account_change(acct.user_id, 'GATE_ACCOUNT_CHANGED');
  else
    members_archived := private.reset_members_for_master_change(acct.bound_gate_uid, p_new_gate_uid);
  end if;

  update private.trading_accounts set bound_gate_uid = p_new_gate_uid, updated_at = now() where id = acct.id;
  insert into public.admin_audit_logs(action, target_user_id, next_value)
  values ('GATE_ACCOUNT_REBOUND', acct.user_id, jsonb_build_object('trading_account_id', acct.id,
    'account_role', acct.account_role, 'old_gate_uid', acct.bound_gate_uid, 'new_gate_uid', p_new_gate_uid,
    'members_reset', members_archived));
  return jsonb_build_object('rebound', true, 'members_reset', members_archived);
end;
$$;

revoke all on function private.trading_account_has_unresolved_orders(uuid) from public, anon, authenticated;
revoke all on function private.archive_account_rows(uuid, boolean) from public, anon, authenticated;
revoke all on function private.pause_member_for_account_change(uuid, text) from public, anon, authenticated;
revoke all on function private.reset_members_for_master_change(text, text) from public, anon, authenticated;
revoke all on function private.rebind_trading_account(uuid, text) from public, anon, authenticated;

-- Shared checks for a credential save. p_role: 'MEMBER' or 'MASTER'.
create or replace function private.guard_gate_account_change(p_user_id uuid, p_role text, p_gate_uid text)
returns void
language plpgsql
set search_path to 'pg_catalog'
as $$
declare acct private.trading_accounts; uid text := trim(p_gate_uid);
begin
  -- One Gate account belongs to one platform user, and a member can never connect the Master's.
  if exists (select 1 from private.gate_api_credentials c
      where c.user_id <> p_user_id and trim(c.gate_uid) = uid and c.status <> 'DISABLED')
    or exists (select 1 from private.trading_accounts a
      where a.credential_user_id <> p_user_id and a.bound_gate_uid = uid and a.status <> 'DISABLED') then
    raise exception 'GATE_UID_ALREADY_REGISTERED';
  end if;

  if p_role = 'MASTER' then
    -- The Master that members currently follow, whichever admin registered it.
    select * into acct from private.trading_accounts
    where account_role = 'MASTER' and settle = 'usdt' and bound_gate_uid is not null
    order by (status = 'ACTIVE') desc, updated_at desc limit 1;
  else
    select * into acct from private.trading_accounts
    where credential_user_id = p_user_id and account_role = p_role and settle = 'usdt';
  end if;
  if acct.id is null or acct.bound_gate_uid is null or acct.bound_gate_uid = uid then return; end if;

  -- A different Gate account: nothing may still be in flight anywhere it could affect.
  if private.trading_account_has_unresolved_orders(case when p_role = 'MASTER' then null else acct.id end) then
    raise exception 'ACCOUNT_CHANGE_UNRESOLVED_ORDERS';
  end if;
  if p_role = 'MEMBER' then
    perform private.pause_member_for_account_change(acct.user_id, 'GATE_ACCOUNT_CHANGE_PENDING');
  else
    perform private.pause_member_for_account_change(a.user_id, 'MASTER_ACCOUNT_CHANGE_PENDING')
    from private.trading_accounts a where a.account_role = 'MEMBER';
  end if;
  insert into public.admin_audit_logs(actor_id, action, target_user_id, next_value)
  values (auth.uid(), 'GATE_ACCOUNT_CHANGE_REQUESTED', acct.user_id, jsonb_build_object(
    'trading_account_id', acct.id, 'account_role', p_role, 'old_gate_uid', acct.bound_gate_uid, 'new_gate_uid', uid));
end;
$$;
revoke all on function private.guard_gate_account_change(uuid, text, text) from public, anon, authenticated;

create or replace function public.save_gate_api_credentials(p_gate_uid text, p_api_key text, p_secret_key text, p_permission_confirmed boolean)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'extensions', 'pg_temp'
as $function$
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

  perform pg_advisory_xact_lock(hashtextextended('maetajak:copy-execution',0));
  perform private.guard_gate_account_change(auth.uid(), 'MEMBER', p_gate_uid);

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
$function$;

create or replace function public.save_admin_gate_api_credentials(p_gate_uid text, p_api_key text, p_secret_key text, p_permission_confirmed boolean)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'extensions', 'pg_temp'
as $function$
declare encryption_key text;
declare saved_connection private.gate_api_credentials;
begin
  if not public.is_approved_admin() then raise exception 'ADMIN_REQUIRED'; end if;
  if p_permission_confirmed is not true then raise exception 'PERMISSION_CONFIRMATION_REQUIRED'; end if;
  if length(trim(p_gate_uid)) < 4 or length(trim(p_api_key)) < 16 or length(trim(p_secret_key)) < 16 then
    raise exception 'INVALID_CREDENTIALS';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('maetajak:copy-execution',0));
  perform private.guard_gate_account_change(auth.uid(), 'MASTER', p_gate_uid);

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
$function$;

create or replace function public.complete_gate_api_verification(p_job_id bigint, p_success boolean, p_gate_user_id text DEFAULT NULL::text, p_error_code text DEFAULT NULL::text, p_error_message text DEFAULT NULL::text, p_worker_public_ip text DEFAULT NULL::text)
 returns void
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare target_user_id uuid;
declare target_connection_role text;
declare target_gate_uid text;
declare account_id uuid;
declare previous_master private.trading_accounts;
declare rebind jsonb;
begin
  if p_success and nullif(trim(p_worker_public_ip), '') is null then raise exception 'WORKER_IP_REQUIRED'; end if;
  perform pg_advisory_xact_lock(hashtextextended('maetajak:copy-execution',0));
  select job.user_id, credentials.connection_role, trim(credentials.gate_uid)
  into target_user_id, target_connection_role, target_gate_uid
  from private.gate_api_verification_jobs job
  join private.gate_api_credentials credentials on credentials.user_id = job.user_id
  where job.id = p_job_id for update of job;
  if target_user_id is null then raise exception 'JOB_NOT_FOUND'; end if;

  update private.gate_api_credentials set
    status = case when p_success then 'VERIFIED' else 'ERROR' end,
    futures_read = p_success,
    futures_trade = p_success and target_connection_role = 'MEMBER',
    ip_whitelisted = p_success,
    withdrawal_disabled = p_success,
    permissions_confirmed = p_success,
    gate_user_id = nullif(trim(p_gate_user_id), ''),
    verification_version = case when p_success then 2 else 1 end,
    verified_worker_ip = case when p_success then trim(p_worker_public_ip)::inet else null end,
    last_error_code = case when p_success then null else left(coalesce(p_error_code, 'VERIFICATION_FAILED'), 80) end,
    last_error = case when p_success then null else left(coalesce(p_error_message, 'Gate.io verification failed'), 300) end,
    last_checked_at = now(), verified_at = case when p_success then now() else null end, updated_at = now()
  where user_id = target_user_id;

  if p_success then
    insert into private.trading_accounts(user_id, credential_user_id, account_role, settle, status, is_primary, updated_at)
    values(target_user_id, target_user_id, target_connection_role, 'usdt', 'ACTIVE', true, now())
    on conflict(credential_user_id, account_role, settle) do update set status = 'ACTIVE', updated_at = now()
    returning id into account_id;
    if target_connection_role = 'MASTER' then
      select * into previous_master from private.trading_accounts
      where account_role = 'MASTER' and id <> account_id and status <> 'DISABLED'
      order by updated_at desc limit 1;
    end if;
    -- A different Gate account starts from a clean state (archived first).
    rebind := private.rebind_trading_account(account_id, target_gate_uid);
    -- Exactly one Master is active.
    if target_connection_role = 'MASTER' then
      update private.trading_accounts set status = 'DISABLED', updated_at = now()
      where account_role = 'MASTER' and id <> account_id and status <> 'DISABLED';
    end if;
    -- Another admin's MASTER row taking over is a Master change too, even if this row is new.
    if target_connection_role = 'MASTER' and previous_master.id is not null
      and coalesce((rebind->>'rebound')::boolean, false) = false
      and previous_master.bound_gate_uid is distinct from target_gate_uid then
      perform private.reset_members_for_master_change(previous_master.bound_gate_uid, target_gate_uid);
    end if;
  else
    update private.trading_accounts set status = 'ERROR', updated_at = now()
    where credential_user_id = target_user_id and account_role = target_connection_role;
  end if;

  delete from private.gate_api_verification_jobs where id = p_job_id;
  insert into public.admin_audit_logs(action, target_user_id, next_value)
  values(case when p_success then 'GATE_API_VERIFIED' else 'GATE_API_VERIFICATION_FAILED' end, target_user_id,
    jsonb_build_object('success', p_success, 'connection_role', target_connection_role,
      'futures_trade', p_success and target_connection_role = 'MEMBER',
      'verification_version', case when p_success then 2 else 1 end, 'error_code', p_error_code));
end;
$function$;

create or replace function private.request_member_copy_resume(p_user_id uuid)
 returns jsonb
 language plpgsql
 set search_path to 'pg_catalog'
as $function$
declare a record; result jsonb := '[]'; s private.copy_resume_sessions;
begin
  perform pg_advisory_xact_lock(hashtextextended('maetajak:copy-execution',0));
  if not exists(select 1 from public.profiles where id=p_user_id and role='MEMBER'
      and approval_status='APPROVED' and not member_halted) then
    raise exception 'MEMBER_HALTED_OR_NOT_APPROVED';
  end if;
  for a in select id from private.trading_accounts
    where user_id=p_user_id and account_role='MEMBER' and status='ACTIVE' order by id
  loop
    insert into private.copy_resume_sessions(trading_account_id) values(a.id) on conflict do nothing;
    select * into s from private.copy_resume_sessions where trading_account_id=a.id for update;
    if s.state='ACTIVE' and exists(select 1 from public.profiles where id=p_user_id and not copy_paused) then
      -- An ACTIVE member asking to resume: clear a risk reduce-only (with a fresh risk baseline, or the
      -- worker re-applies it next cycle). An administrator's REDUCE_ONLY is lifted only by an admin.
      if exists(select 1 from public.profiles where id=p_user_id and reduce_only)
        and (coalesce(s.blocker_reason,'') <> 'ADMIN_REDUCE_ONLY' or public.is_approved_admin()) then
        perform private.reset_copy_risk_baseline(a.id);
        update public.profiles set reduce_only=false, updated_at=now() where id=p_user_id;
        update private.copy_resume_sessions set blocker_reason=null, updated_at=now()
        where trading_account_id=a.id and blocker_reason='ADMIN_REDUCE_ONLY';
      end if;
      result:=result||jsonb_build_array(jsonb_build_object('version',s.version,'state',s.state)); continue;
    end if;
    -- A resume from a pause acknowledges past results: risk limits are measured from current equity.
    perform private.reset_copy_risk_baseline(a.id);
    -- Repeated clicks preserve both the in-progress version and its sync mode.
    if s.state not in ('REQUESTED','VALIDATED') or s.expires_at<=clock_timestamp() then
      update private.copy_resume_sessions set version=gen_random_uuid(),state='REQUESTED',
        requested_at=clock_timestamp(),requested_by=auth.uid(),
        expires_at=clock_timestamp()+interval '5 minutes',
        snapshot_started_at=null,snapshot_observed_at=null,validated_at=null,activated_at=null,
        master_positions=null,member_positions=null,settings=null,blocker_reason=null,
        sync_current_master=false,updated_at=now()
      where trading_account_id=a.id returning * into s;
    end if;
    update public.profiles set copy_paused=true,close_positions_requested=false,reduce_only=false,updated_at=now()
      where id=p_user_id;
    update private.copy_order_intents set status='CANCELLED',resolved_at=now(),
      last_error_code='SUPERSEDED_BY_RESUME',updated_at=now()
      where trading_account_id=a.id and status in ('PLANNED','QUEUED') and submit_attempts=0;
    insert into private.copy_reconciliation_jobs(intent_id)
      select id from private.copy_order_intents where trading_account_id=a.id
        and status in ('SUBMITTING','ACKNOWLEDGED','PARTIALLY_FILLED','UNKNOWN')
        and not exchange_terminal
      on conflict(intent_id) do update set run_after=now();
    result:=result||jsonb_build_array(jsonb_build_object('version',s.version,'state',s.state));
  end loop;
  if result='[]'::jsonb then raise exception 'ACTIVE_MEMBER_ACCOUNT_REQUIRED'; end if;
  return jsonb_build_object('mode','RESUME','copy_paused',true,'sessions',result);
end;
$function$;
