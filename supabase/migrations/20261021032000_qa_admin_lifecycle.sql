-- 2026-10-21 QA (scenario A/D): administrator, account lifecycle and member-control fixes.
-- Idempotent: every statement may be re-run. No table is dropped; the only data written at apply time
-- is the backfill of the administrator restriction flags (section 6; only in the run that adds the columns, from
-- the session blocker and the latest administrator control) and the removal of stale ADMIN_* blockers on ACTIVE
-- sessions without an administrator restriction.
--
--  1. A1  Master key replacement with the SAME Gate UID (key rotation, IP whitelist fix, re-verify) no
--         longer disables the Master account and pauses every member. While the Master key is VERIFIED
--         and its account ACTIVE on that UID, the new key waits in gate_api_credentials.pending_* and the
--         current key keeps copying. Verification success swaps the key in place (no account/credential
--         status change, no member pause); a failure keeps the current key and is shown to the admin
--         (pending_status = ERROR). A DIFFERENT UID still goes through the rebind/pause flow.
--         Members paused because of the Master get a MASTER_* blocker that is never written over an
--         existing pause reason, an admin audit row MEMBERS_PAUSED_BY_MASTER and a SYMBOL_PAUSED event per
--         member. public.admin_request_all_member_copy_resume asks a normal (validated) resume for every
--         member paused by the Master.
--  2. A2  get_admin_operations_metrics.copy_status reflects the resume session and Gate read errors:
--         NOT_STARTED / RESUME_REQUIRED / API_ERROR (credential read errors for 5+ minutes) / READ_ERROR /
--         CLOSING besides the old values. copy_current_verifications.error_since records when the current
--         run of read errors began.
--  3. A3  admin_disable_member_gate_api_connection (20261020020000 section 2, missing in production).
--  4. A4  A withdrawn account that never had a verified Gate API, and a rejected account without a live
--         key, release profiles.gate_uid (kept in released_gate_uid) and their synthetic login email, so
--         the real owner can sign up. release_member_gate_uid is the administrator action ("UID 해제").
--  5. A7  Restoring a withdrawn member clears member_halted (still paused), archives the member's
--         copy-derived state like a Gate account rebind and unbinds the Gate UID, so a reconnect starts
--         clean. Account resets (rebind, Master change, restore) start a new ownership epoch: platform fills
--         from before the reset are no longer copy-ownership evidence (they made every later resume fail
--         with RESUME_COPY_OWNERSHIP_UNKNOWN).
--  6. D3  Administrator PAUSE/REDUCE_ONLY are stored separately (profiles.admin_paused,
--         admin_reduce_only). A member HOLD/RESUME cannot clear them; only the administrator RESUME does.
--  7. D8  RESUME_COPY_SOURCE_MISSING: request_my_copy_resume_reclassify lets the member resume while the
--         confirmed COPY legs the Master no longer holds become the member's own (protected) quantity.
--  8. D11 Dashboard ROI/MDD: MDD is measured on the daily-return index (deposits/withdrawals neutral).
--
-- Deploy order: this migration before the web build (src/main.js selects profiles.admin_paused,
-- admin_reduce_only, released_gate_uid). The worker change (worker/performance.js daily return) is
-- independent of it.

set lock_timeout = '5s';

-- ---------------------------------------------------------------------------------------------
-- Columns
-- ---------------------------------------------------------------------------------------------
alter table private.gate_api_credentials
  add column if not exists pending_gate_uid text,
  add column if not exists pending_api_key_ciphertext bytea,
  add column if not exists pending_secret_key_ciphertext bytea,
  add column if not exists pending_api_key_last4 text,
  add column if not exists pending_status text,
  add column if not exists pending_error_code text,
  add column if not exists pending_error text,
  add column if not exists pending_requested_at timestamptz,
  add column if not exists pending_checked_at timestamptz;
comment on column private.gate_api_credentials.pending_status is
  'Same-UID Master key replacement: PENDING_VERIFICATION/VERIFYING while the new key waits (the current key keeps copying), then VERIFIED (swapped) or ERROR (current key kept).';

alter table private.copy_current_verifications add column if not exists error_since timestamptz;

-- Review R6: the administrator-restriction backfill (section 6) runs only in the run that adds the columns.
select pg_catalog.set_config('maetajak.qa_admin_restriction_backfill', case when exists (select 1 from pg_catalog.pg_attribute
  where attrelid = 'public.profiles'::regclass and attname = 'admin_reduce_only' and not attisdropped) then 'off' else 'on' end, false);
alter table public.profiles
  add column if not exists admin_paused boolean not null default false,
  add column if not exists admin_reduce_only boolean not null default false,
  add column if not exists released_gate_uid text,
  add column if not exists gate_uid_released_at timestamptz,
  add column if not exists gate_uid_released_by uuid;
comment on column public.profiles.admin_paused is 'Administrator PAUSE/HALT: only the administrator RESUME lifts it.';
comment on column public.profiles.admin_reduce_only is 'Administrator REDUCE_ONLY: only the administrator RESUME lifts it.';
comment on column public.profiles.released_gate_uid is 'Gate UID this account held before it was released (withdrawal/rejection/admin).';

alter table private.copy_resume_sessions
  add column if not exists reclassify_missing_copy boolean not null default false;

create table if not exists private.copy_ownership_resets (
  trading_account_id uuid primary key,
  reset_at timestamptz not null,
  reason text
);
alter table private.copy_ownership_resets enable row level security;
revoke all on private.copy_ownership_resets from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- 5. Ownership epoch: fills created before an account reset are not ownership evidence.
-- ---------------------------------------------------------------------------------------------
create or replace function private.copy_ownership_reset_at(p_trading_account_id uuid)
returns timestamptz
language sql
stable
set search_path to 'pg_catalog'
as $$
  select coalesce((select r.reset_at from private.copy_ownership_resets r
    where r.trading_account_id = p_trading_account_id), '-infinity'::timestamptz)
$$;
revoke all on function private.copy_ownership_reset_at(uuid) from public, anon, authenticated;

-- Review R5: only the ownership EVIDENCE clauses are limited to the current epoch (fills the journal must explain,
-- fills that make an account without a checkpoint "already traded", and the fills journalled by CLOSE). The guards
-- "filled but not observed yet" (observation_confirmed_at is null) and the CLOSE update that confirms older terminal
-- fills are NOT: a fill in flight across a reset still changes the holdings and must still block. Each clause is
-- matched literally (whitespace-tolerant) exactly once, and the result is checked before it is executed.
do $$
declare sig text; def text; base text; patched text; spec text[]; pattern text; hits integer; expected integer;
  -- {function, clause (regex, whitespace-tolerant), aliased: 'i' or ''}
  specs text[][] := array[
    ['core', 'i\.trading_account_id=p_account\s+and\s+i\.filled_size<>0\s+and\s+i\.resume_version\s+is\s+not\s+null(?=\s+and\s+not\s+exists\(select\s+1\s+from\s+private\.copy_ownership_fills)', 'i'],
    ['core', 'from\s+private\.copy_order_intents\s+where\s+trading_account_id=p_account\s+and\s+filled_size<>0\s+and\s+resume_version\s+is\s+not\s+null(?=\))', ''],
    ['observe', 'i\.trading_account_id=new\.trading_account_id\s+and\s+i\.filled_size<>0\s+and\s+i\.resume_version\s+is\s+not\s+null(?=\s+and\s+not\s+exists\(select\s+1\s+from\s+private\.copy_ownership_fills)', 'i'],
    ['observe', 'i\.trading_account_id=new\.trading_account_id\s+and\s+i\.filled_size<>0\s+and\s+i\.resume_version\s+is\s+not\s+null(?=\s+and\s+i\.observation_confirmed_at\s+is\s+not\s+null)', 'i'],
    ['observe', 'from\s+private\.copy_order_intents\s+where\s+trading_account_id=new\.trading_account_id\s+and\s+filled_size<>0(?=\))', '']];
  guard_re constant text := 'observation_confirmed_at\s+is\s+null\s+and\s+(i\.)?resume_version\s+is\s+not\s+null\)';
begin
  -- On a re-run copy_resume_ownership is the D8 wrapper (section 7) and the original body is *_core.
  foreach sig in array array[case when to_regprocedure('private.copy_resume_ownership_core(uuid,uuid,jsonb,jsonb)') is null
      then 'private.copy_resume_ownership(uuid,uuid,jsonb,jsonb)' else 'private.copy_resume_ownership_core(uuid,uuid,jsonb,jsonb)' end,
    'private.observe_copy_ownership()'] loop
    if to_regprocedure(sig) is null then raise notice 'ownership epoch patch skipped, missing %', sig; continue; end if;
    def := pg_get_functiondef(to_regprocedure(sig));
    -- Idempotent: start from the unpatched text (this also repairs an earlier, broader patch).
    base := regexp_replace(def, '\s+and\s+(i\.)?created_at>private\.copy_ownership_reset_at\((i\.)?trading_account_id\)', '', 'g');
    patched := base; expected := 0;
    foreach spec slice 1 in array specs loop
      if spec[1] <> (case when sig like 'private.observe%' then 'observe' else 'core' end) then continue; end if;
      pattern := spec[2];
      select count(*) into hits from regexp_matches(base, pattern, 'g');
      if hits <> 1 then raise exception 'OWNERSHIP_EPOCH_ANCHOR_MISSING: % (% matches of %)', sig, hits, pattern; end if;
      patched := regexp_replace(patched, '(' || pattern || ')', '\1 and '
        || case when spec[3] = 'i' then 'i.created_at>private.copy_ownership_reset_at(i.trading_account_id)'
          else 'created_at>private.copy_ownership_reset_at(trading_account_id)' end);
      expected := expected + 1;
    end loop;
    -- Post-patch checks: exactly the intended clauses, guards untouched, unaliased references only in the
    -- single-table (no alias, no join) intent queries.
    if (select count(*) from regexp_matches(patched, 'copy_ownership_reset_at', 'g')) <> expected
      or (select count(*) from regexp_matches(patched, guard_re, 'g')) <> (select count(*) from regexp_matches(base, guard_re, 'g'))
      or patched ~ 'observation_confirmed_at\s+is\s+null[^;]{0,80}copy_ownership_reset_at'
      or (select count(*) from regexp_matches(patched, '(^|[^.a-z_])created_at>private\.copy_ownership_reset_at\(trading_account_id\)', 'g'))
        <> (select count(*) from regexp_matches(patched,
          'from\s+private\.copy_order_intents\s+where\s+trading_account_id=[a-z_.]+\s+and\s+filled_size<>0(\s+and\s+resume_version\s+is\s+not\s+null)?\s+and\s+created_at>private\.copy_ownership_reset_at\(trading_account_id\)', 'g'))
      or (select count(*) from regexp_matches(patched, '[a-z_]+\.created_at>private\.copy_ownership_reset_at\(([a-z_]+\.)?trading_account_id\)', 'g'))
        <> (select count(*) from regexp_matches(patched, 'i\.created_at>private\.copy_ownership_reset_at\(i\.trading_account_id\)', 'g')) then
      raise exception 'OWNERSHIP_EPOCH_PATCH_UNSAFE: %', sig;
    end if;
    if patched <> def then execute patched; end if;
  end loop;
end $$;

-- Rebind / Master change / restore archive: also starts a new ownership epoch for the account.
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

  -- The ownership ledger is gone: earlier platform fills can no longer be attributed (2026-10-21).
  insert into private.copy_ownership_resets(trading_account_id, reset_at, reason)
  values (p_trading_account_id, clock_timestamp(), case when p_master_derived_only then 'MASTER_DERIVED_RESET' else 'ACCOUNT_RESET' end)
  on conflict (trading_account_id) do update set reset_at = excluded.reset_at, reason = excluded.reason;

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
revoke all on function private.archive_account_rows(uuid, boolean) from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- 1. Member pauses caused by the Master: own blocker reasons, an audit row and per-member events.
--    An already PAUSED session keeps its original reason (a member/admin pause is not relabelled), and a
--    REQUIRED session (never started / restored) stays REQUIRED: both already need a validated resume.
-- ---------------------------------------------------------------------------------------------
create or replace function private.is_master_pause_reason(p_reason text)
returns boolean
language sql
immutable
set search_path to 'pg_catalog'
as $$
  select coalesce(p_reason, '') in ('MASTER_TRADING_ACCOUNT_CHANGED', 'MASTER_CREDENTIAL_CHANGED',
    'MASTER_ACCOUNT_CHANGED', 'MASTER_ACCOUNT_CHANGE_PENDING')
$$;
revoke all on function private.is_master_pause_reason(text) from public, anon, authenticated;

create or replace function private.pause_sessions_for_master_change(p_reason text, p_trading_account_id uuid)
returns integer
language plpgsql
set search_path to 'pg_catalog'
as $$
declare active_count integer;
begin
  insert into public.copy_events(user_id, event_type, severity, safe_payload)
  select a.user_id, 'SYMBOL_PAUSED', 'WARNING', jsonb_build_object('reason', p_reason, 'cause', 'MASTER')
  from private.copy_resume_sessions s join private.trading_accounts a on a.id = s.trading_account_id
  where s.state = 'ACTIVE' and a.account_role = 'MEMBER' and a.user_id is not null;
  get diagnostics active_count = row_count;
  update private.copy_resume_sessions set state = 'PAUSED', blocker_reason = p_reason, updated_at = now()
  where state not in ('PAUSED', 'REQUIRED');
  if active_count > 0 then
    insert into public.admin_audit_logs(actor_id, action, next_value)
    values (auth.uid(), 'MEMBERS_PAUSED_BY_MASTER', jsonb_build_object('reason', p_reason,
      'paused_sessions', active_count, 'master_trading_account_id', p_trading_account_id));
  end if;
  return active_count;
end;
$$;
revoke all on function private.pause_sessions_for_master_change(text, uuid) from public, anon, authenticated;

create or replace function private.invalidate_copy_account_resume()
returns trigger language plpgsql security definer set search_path=pg_catalog
as $$
begin
  if old.status is distinct from new.status then
    perform pg_advisory_xact_lock(hashtextextended('maetajak:copy-execution',0));
    if new.account_role = 'MASTER' then
      perform private.pause_sessions_for_master_change('MASTER_TRADING_ACCOUNT_CHANGED', new.id);
    else
      update private.copy_resume_sessions set state='PAUSED',blocker_reason='TRADING_ACCOUNT_CHANGED',updated_at=now()
        where trading_account_id=new.id and state not in ('PAUSED','REQUIRED');
    end if;
  end if;
  return new;
end;
$$;
revoke all on function private.invalidate_copy_account_resume() from public,anon,authenticated;

create or replace function private.invalidate_copy_credential_resume()
returns trigger language plpgsql security definer set search_path=pg_catalog
as $$
declare master_account uuid;
begin
  if row(old.status,old.api_key_ciphertext,old.secret_key_ciphertext,old.gate_uid)
    is not distinct from row(new.status,new.api_key_ciphertext,new.secret_key_ciphertext,new.gate_uid) then
    return new;
  end if;
  -- Same-UID Master key replacement verified by the worker (complete_gate_api_verification swaps the
  -- pending key in place): the Gate account is unchanged, nothing is paused.
  if old.status = 'VERIFIED' and new.status = 'VERIFIED' and trim(old.gate_uid) = trim(new.gate_uid)
    and old.pending_api_key_ciphertext is not null and new.pending_api_key_ciphertext is null then
    return new;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('maetajak:copy-execution',0));
  select a.id into master_account from private.trading_accounts a
    where a.credential_user_id=new.user_id and a.account_role='MASTER' limit 1;
  if master_account is not null or new.connection_role = 'MASTER' then
    perform private.pause_sessions_for_master_change('MASTER_CREDENTIAL_CHANGED', master_account);
  else
    update private.copy_resume_sessions s set state='PAUSED',blocker_reason='GATE_CREDENTIAL_CHANGED',updated_at=now()
      where s.state not in ('PAUSED','REQUIRED') and exists(select 1 from private.trading_accounts a
        where a.credential_user_id=new.user_id and a.id=s.trading_account_id);
  end if;
  return new;
end;
$$;
revoke all on function private.invalidate_copy_credential_resume() from public,anon,authenticated;

-- A disabled credential never keeps a key waiting for verification.
create or replace function private.clear_pending_gate_key_on_disable()
returns trigger language plpgsql set search_path=pg_catalog
as $$
begin
  if new.status = 'DISABLED' then
    new.pending_gate_uid := null; new.pending_api_key_ciphertext := null; new.pending_secret_key_ciphertext := null;
    new.pending_api_key_last4 := null; new.pending_status := null; new.pending_error_code := null;
    new.pending_error := null; new.pending_requested_at := null; new.pending_checked_at := null;
  end if;
  return new;
end;
$$;
revoke all on function private.clear_pending_gate_key_on_disable() from public,anon,authenticated;
drop trigger if exists clear_pending_gate_key_on_disable on private.gate_api_credentials;
create trigger clear_pending_gate_key_on_disable before update of status on private.gate_api_credentials
for each row execute function private.clear_pending_gate_key_on_disable();

-- Master change pauses (different UID): reasons recognisable as Master-caused.
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
  if members_archived > 0 then
    insert into public.admin_audit_logs(actor_id, action, next_value)
    values (auth.uid(), 'MEMBERS_PAUSED_BY_MASTER', jsonb_build_object('reason', 'MASTER_ACCOUNT_CHANGED',
      'paused_sessions', members_archived, 'old_gate_uid', p_old_gate_uid, 'new_gate_uid', p_new_gate_uid));
  end if;
  return members_archived;
end;
$$;
revoke all on function private.reset_members_for_master_change(text, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- 1. Same-UID Master key replacement.
-- ---------------------------------------------------------------------------------------------
-- The Master key that members follow right now: VERIFIED and its ACTIVE account bound to that UID.
create or replace function private.master_key_rotation_allowed(p_user_id uuid, p_gate_uid text)
returns boolean
language sql
stable
set search_path to 'pg_catalog'
as $$
  select exists (
    select 1 from private.gate_api_credentials c
    join private.trading_accounts a on a.credential_user_id = c.user_id and a.account_role = 'MASTER' and a.settle = 'usdt'
    where c.user_id = p_user_id and c.connection_role = 'MASTER' and c.status = 'VERIFIED'
      and trim(c.gate_uid) = trim(p_gate_uid) and a.status = 'ACTIVE' and a.bound_gate_uid = trim(p_gate_uid))
$$;
revoke all on function private.master_key_rotation_allowed(uuid, text) from public, anon, authenticated;

create or replace function private.admin_master_connection_json(p_user_id uuid)
returns jsonb
language sql
stable
set search_path to 'pg_catalog'
as $$
  select jsonb_build_object(
    'gate_uid', c.gate_uid, 'api_key_last4', c.api_key_last4,
    'status', c.status, 'futures_read', c.futures_read,
    'futures_trade', c.futures_trade, 'ip_whitelisted', c.ip_whitelisted,
    'withdrawal_disabled', c.withdrawal_disabled,
    'permissions_confirmed', c.permissions_confirmed,
    'last_error_code', c.last_error_code,
    'last_checked_at', c.last_checked_at, 'updated_at', c.updated_at,
    'pending_status', c.pending_status, 'pending_api_key_last4', c.pending_api_key_last4,
    'pending_error_code', c.pending_error_code, 'pending_requested_at', c.pending_requested_at,
    'pending_checked_at', c.pending_checked_at)
  from private.gate_api_credentials c
  where c.user_id = p_user_id and c.connection_role = 'MASTER'
$$;
revoke all on function private.admin_master_connection_json(uuid) from public, anon, authenticated;

create or replace function public.get_admin_master_gate_api_connection()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_approved_admin() then raise exception 'ADMIN_REQUIRED'; end if;
  return private.admin_master_connection_json(auth.uid());
end;
$$;
revoke all on function public.get_admin_master_gate_api_connection() from public, anon;
grant execute on function public.get_admin_master_gate_api_connection() to authenticated;

create or replace function private.queue_master_key_rotation(p_gate_uid text, p_api_key_ciphertext bytea,
  p_secret_key_ciphertext bytea, p_api_key_last4 text, p_audit_action text)
returns jsonb
language plpgsql
set search_path to 'pg_catalog'
as $$
begin
  -- The worker is verifying the previous pending key right now: its result would be applied to this one.
  if exists (select 1 from private.gate_api_credentials c join private.gate_api_verification_jobs j on j.user_id = c.user_id
      where c.user_id = auth.uid() and c.pending_status = 'VERIFYING'
        and j.claimed_at is not null and j.claimed_at > now() - interval '2 minutes') then
    raise exception 'MASTER_KEY_VERIFICATION_IN_PROGRESS';
  end if;
  update private.gate_api_credentials set pending_gate_uid = trim(p_gate_uid),
    pending_api_key_ciphertext = p_api_key_ciphertext, pending_secret_key_ciphertext = p_secret_key_ciphertext,
    pending_api_key_last4 = p_api_key_last4, pending_status = 'PENDING_VERIFICATION', pending_error_code = null,
    pending_error = null, pending_requested_at = now(), pending_checked_at = null, updated_at = now()
  where user_id = auth.uid() and connection_role = 'MASTER';
  insert into private.gate_api_verification_jobs (user_id, attempts, run_after, claimed_at, updated_at)
  values (auth.uid(), 0, now(), null, now())
  on conflict (user_id) do update set attempts = 0, run_after = now(), claimed_at = null, updated_at = now();
  insert into public.admin_audit_logs (actor_id, action, target_user_id, next_value)
  values (auth.uid(), p_audit_action, auth.uid(),
    jsonb_build_object('gate_uid', trim(p_gate_uid), 'api_key_last4', p_api_key_last4, 'current_key_kept', true));
  return private.admin_master_connection_json(auth.uid());
end;
$$;
revoke all on function private.queue_master_key_rotation(text, bytea, bytea, text, text) from public, anon, authenticated;

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

  -- Same Gate UID as the Master members follow now: the new key waits for verification while the
  -- current key keeps copying (2026-10-21 QA A1).
  if private.master_key_rotation_allowed(auth.uid(), p_gate_uid) then
    return private.queue_master_key_rotation(p_gate_uid,
      pgp_sym_encrypt(trim(p_api_key), encryption_key, 'cipher-algo=aes256'),
      pgp_sym_encrypt(trim(p_secret_key), encryption_key, 'cipher-algo=aes256'),
      right(trim(p_api_key), 4), 'MASTER_GATE_API_KEY_ROTATION_REQUESTED');
  end if;

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
    last_error_code = null, verified_at = null, last_checked_at = null, updated_at = now(),
    pending_gate_uid = null, pending_api_key_ciphertext = null, pending_secret_key_ciphertext = null,
    pending_api_key_last4 = null, pending_status = null, pending_error_code = null, pending_error = null,
    pending_requested_at = null, pending_checked_at = null
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

-- Re-verifying the stored Master key while it is in use checks it as a pending key: a failure no longer
-- disables the Master account (the key keeps being used until the admin replaces it).
create or replace function public.retry_admin_master_gate_api_verification(
  p_permission_confirmed boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare saved_connection private.gate_api_credentials;
begin
  if not public.is_approved_admin() then raise exception 'ADMIN_REQUIRED'; end if;
  if p_permission_confirmed is not true then raise exception 'PERMISSION_CONFIRMATION_REQUIRED'; end if;

  select * into saved_connection
  from private.gate_api_credentials
  where user_id = auth.uid()
    and connection_role = 'MASTER'
    and status <> 'DISABLED'
  for update;

  if not found then raise exception 'MASTER_CREDENTIALS_NOT_FOUND'; end if;

  perform pg_advisory_xact_lock(hashtextextended('maetajak:copy-execution',0));
  if private.master_key_rotation_allowed(auth.uid(), saved_connection.gate_uid) then
    return private.queue_master_key_rotation(saved_connection.gate_uid, saved_connection.api_key_ciphertext,
      saved_connection.secret_key_ciphertext, saved_connection.api_key_last4, 'MASTER_GATE_API_REVERIFICATION_REQUESTED');
  end if;

  update private.gate_api_credentials
  set status = 'PENDING_VERIFICATION',
      futures_read = false,
      futures_trade = false,
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
    and connection_role = 'MASTER'
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
    and account_role = 'MASTER';

  insert into public.admin_audit_logs (actor_id, action, target_user_id, next_value)
  values (
    auth.uid(),
    'MASTER_GATE_API_REVERIFICATION_REQUESTED',
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
revoke all on function public.retry_admin_master_gate_api_verification(boolean) from public, anon;
grant execute on function public.retry_admin_master_gate_api_verification(boolean) to authenticated;

-- The worker verifies the pending key when one is waiting (the current key's status is left alone).
-- Review R7: the claim returns its claimed_at; complete_gate_api_verification refuses a completion whose claim is no
-- longer the job's current one (a requeue keeps the job id: a late result for the previous key must not verify the
-- next one). The return type changes, so the function is dropped first.
drop function if exists public.claim_gate_api_verification_jobs(integer);
create function public.claim_gate_api_verification_jobs(p_limit integer default 5)
returns table (
  job_id bigint, user_id uuid, connection_role text, gate_uid text, api_key text, secret_key text, claimed_at timestamptz
)
language plpgsql security definer set search_path = public, extensions, pg_temp
as $$
declare encryption_key text;
begin
  select decrypted_secret into encryption_key
  from vault.decrypted_secrets where name = 'gate_api_credentials_key';
  if encryption_key is null then raise exception 'ENCRYPTION_KEY_NOT_CONFIGURED'; end if;

  return query
  with claimed as (
    select job.id
    from private.gate_api_verification_jobs as job
    where job.run_after <= now()
      and (job.claimed_at is null or job.claimed_at < now() - interval '2 minutes')
    order by job.created_at
    for update skip locked
    limit greatest(1, least(coalesce(p_limit, 5), 20))
  ), updated_jobs as (
    update private.gate_api_verification_jobs as job
    -- clock_timestamp(): the claim token is unique even for two claims in one transaction.
    set claimed_at = clock_timestamp(), attempts = job.attempts + 1, updated_at = now()
    from claimed where job.id = claimed.id
    returning job.id, job.user_id, job.claimed_at
  ), marked as (
    update private.gate_api_credentials as credentials
    set status = case when credentials.pending_api_key_ciphertext is null then 'VERIFYING' else credentials.status end,
        pending_status = case when credentials.pending_api_key_ciphertext is null then credentials.pending_status else 'VERIFYING' end,
        updated_at = now()
    from updated_jobs where credentials.user_id = updated_jobs.user_id
    returning credentials.user_id
  )
  select updated_jobs.id, credentials.user_id, credentials.connection_role,
    coalesce(credentials.pending_gate_uid, credentials.gate_uid),
    pgp_sym_decrypt(coalesce(credentials.pending_api_key_ciphertext, credentials.api_key_ciphertext), encryption_key),
    pgp_sym_decrypt(coalesce(credentials.pending_secret_key_ciphertext, credentials.secret_key_ciphertext), encryption_key),
    updated_jobs.claimed_at
  from updated_jobs
  join private.gate_api_credentials as credentials on credentials.user_id = updated_jobs.user_id
  join marked on marked.user_id = updated_jobs.user_id;
end;
$$;
revoke all on function public.claim_gate_api_verification_jobs(integer) from public, anon, authenticated;
grant execute on function public.claim_gate_api_verification_jobs(integer) to service_role;

-- Review R7: p_claimed_at is the claim this result belongs to (claim_gate_api_verification_jobs.claimed_at); a result
-- of a superseded claim is refused (VERIFICATION_JOB_CLAIM_STALE). null = a worker from before this change (no check;
-- remove the default once every worker passes it). The old 6-argument signature is dropped (an overload with a
-- defaulted 7th argument would make 6-argument calls ambiguous).
drop function if exists public.complete_gate_api_verification(bigint, boolean, text, text, text, text);
create or replace function public.complete_gate_api_verification(p_job_id bigint, p_success boolean, p_gate_user_id text DEFAULT NULL::text, p_error_code text DEFAULT NULL::text, p_error_message text DEFAULT NULL::text, p_worker_public_ip text DEFAULT NULL::text, p_claimed_at timestamptz DEFAULT NULL::timestamptz)
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
declare pending_key boolean;
declare pending_uid text;
declare job_claimed_at timestamptz;
begin
  if p_success and nullif(trim(p_worker_public_ip), '') is null then raise exception 'WORKER_IP_REQUIRED'; end if;
  perform pg_advisory_xact_lock(hashtextextended('maetajak:copy-execution',0));
  select job.user_id, credentials.connection_role, trim(credentials.gate_uid),
    credentials.pending_api_key_ciphertext is not null, trim(credentials.pending_gate_uid), job.claimed_at
  into target_user_id, target_connection_role, target_gate_uid, pending_key, pending_uid, job_claimed_at
  from private.gate_api_verification_jobs job
  join private.gate_api_credentials credentials on credentials.user_id = job.user_id
  where job.id = p_job_id for update of job;
  if target_user_id is null then raise exception 'JOB_NOT_FOUND'; end if;
  -- Compared at millisecond precision (a JavaScript client may drop the microseconds).
  if p_claimed_at is not null
    and date_trunc('milliseconds', job_claimed_at) is distinct from date_trunc('milliseconds', p_claimed_at) then
    raise exception 'VERIFICATION_JOB_CLAIM_STALE';
  end if;

  -- Same-UID key replacement: swap in place on success, keep the current key on failure.
  if pending_key then
    if p_success and pending_uid is not distinct from target_gate_uid then
      update private.gate_api_credentials set
        api_key_ciphertext = pending_api_key_ciphertext, secret_key_ciphertext = pending_secret_key_ciphertext,
        api_key_last4 = pending_api_key_last4, status = 'VERIFIED', futures_read = true,
        futures_trade = target_connection_role = 'MEMBER', ip_whitelisted = true, withdrawal_disabled = true,
        permissions_confirmed = true, gate_user_id = nullif(trim(p_gate_user_id), ''), verification_version = 2,
        verified_worker_ip = trim(p_worker_public_ip)::inet, last_error_code = null, last_error = null,
        last_checked_at = now(), verified_at = now(),
        pending_gate_uid = null, pending_api_key_ciphertext = null, pending_secret_key_ciphertext = null,
        pending_status = 'VERIFIED', pending_error_code = null, pending_error = null, pending_checked_at = now(),
        updated_at = now()
      where user_id = target_user_id;
    else
      update private.gate_api_credentials set
        pending_gate_uid = null, pending_api_key_ciphertext = null, pending_secret_key_ciphertext = null,
        pending_status = 'ERROR',
        pending_error_code = case when p_success then 'UID_MISMATCH' else left(coalesce(p_error_code, 'VERIFICATION_FAILED'), 80) end,
        pending_error = case when p_success then null else left(coalesce(p_error_message, 'Gate.io verification failed'), 300) end,
        pending_checked_at = now(), updated_at = now()
      where user_id = target_user_id;
    end if;
    delete from private.gate_api_verification_jobs where id = p_job_id;
    insert into public.admin_audit_logs(action, target_user_id, next_value)
    values(case when p_success then 'MASTER_GATE_API_KEY_ROTATED' else 'MASTER_GATE_API_KEY_ROTATION_FAILED' end, target_user_id,
      jsonb_build_object('success', p_success, 'connection_role', target_connection_role, 'current_key_kept', not p_success,
        'error_code', p_error_code));
    return;
  end if;

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
revoke all on function public.complete_gate_api_verification(bigint, boolean, text, text, text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.complete_gate_api_verification(bigint, boolean, text, text, text, text, timestamptz) to service_role;

-- ---------------------------------------------------------------------------------------------
-- 2. Read-error run start (copy_current_verifications.error_since).
-- ---------------------------------------------------------------------------------------------
create or replace function private.track_copy_read_error_since()
returns trigger language plpgsql set search_path=pg_catalog
as $$
begin
  if new.status = 'ERROR' then
    if tg_op = 'UPDATE' and old.status = 'ERROR' then
      -- The cycle upsert does not write error_since, so the run start carries over.
      new.error_since := coalesce(new.error_since, old.error_since, clock_timestamp());
    else
      new.error_since := clock_timestamp();
    end if;
  else
    new.error_since := null;
  end if;
  return new;
end;
$$;
revoke all on function private.track_copy_read_error_since() from public,anon,authenticated;
drop trigger if exists track_copy_read_error_since on private.copy_current_verifications;
create trigger track_copy_read_error_since before insert or update on private.copy_current_verifications
for each row execute function private.track_copy_read_error_since();

-- ---------------------------------------------------------------------------------------------
-- 6. D3: administrator restrictions are stored separately and enforced on every profile write.
--    (Trigger name sorts before invalidate_member_copy_resume, so that trigger sees the enforced row.)
-- ---------------------------------------------------------------------------------------------
create or replace function private.enforce_admin_copy_restrictions()
returns trigger language plpgsql set search_path=pg_catalog
as $$
begin
  if new.admin_reduce_only then new.reduce_only := true; end if;
  if new.admin_paused then new.copy_paused := true; end if;
  return new;
end;
$$;
revoke all on function private.enforce_admin_copy_restrictions() from public,anon,authenticated;
drop trigger if exists enforce_admin_copy_restrictions on public.profiles;
create trigger enforce_admin_copy_restrictions before update on public.profiles
for each row execute function private.enforce_admin_copy_restrictions();

-- Backfill: restrictions an administrator set before this migration. Review R6: only in the run that added the
-- columns (a re-run must not turn a later risk reduce-only into an administrator one), and only with both pieces of
-- evidence: the session blocker the administrator control wrote AND the member's latest administrator control
-- (admin_audit_logs) being that restriction (an earlier administrator RESUME left ACTIVE sessions on ADMIN_REDUCE_ONLY).
update public.profiles p set admin_reduce_only = true
where pg_catalog.current_setting('maetajak.qa_admin_restriction_backfill', true) = 'on'
  and p.reduce_only and not p.admin_reduce_only and exists (select 1 from private.copy_resume_sessions s
  join private.trading_accounts a on a.id = s.trading_account_id
  where a.user_id = p.id and a.account_role = 'MEMBER' and s.blocker_reason = 'ADMIN_REDUCE_ONLY')
  and (select l.next_value->>'mode' from public.admin_audit_logs l where l.target_user_id = p.id
    and l.action = 'MEMBER_COPY_CONTROL_UPDATED' order by l.created_at desc, l.id desc limit 1) = 'REDUCE_ONLY';
update public.profiles p set admin_paused = true
where pg_catalog.current_setting('maetajak.qa_admin_restriction_backfill', true) = 'on'
  and p.copy_paused and not p.admin_paused and exists (select 1 from private.copy_resume_sessions s
  join private.trading_accounts a on a.id = s.trading_account_id
  where a.user_id = p.id and a.account_role = 'MEMBER' and s.state = 'PAUSED' and s.blocker_reason in ('ADMIN_PAUSE', 'ADMIN_HALT'))
  and (select l.next_value->>'mode' from public.admin_audit_logs l where l.target_user_id = p.id
    and l.action = 'MEMBER_COPY_CONTROL_UPDATED' order by l.created_at desc, l.id desc limit 1) in ('PAUSE', 'HALT');
select pg_catalog.set_config('maetajak.qa_admin_restriction_backfill', 'off', false);
-- An ACTIVE session's ADMIN_* blocker without an administrator restriction is left over from an administrator RESUME
-- (review R6; set_member_copy_control now clears it).
update private.copy_resume_sessions s set blocker_reason = null, updated_at = now()
from private.trading_accounts a join public.profiles p on p.id = a.user_id
where a.id = s.trading_account_id and s.state = 'ACTIVE' and s.blocker_reason like 'ADMIN\_%'
  and not p.admin_reduce_only and not p.admin_paused;

-- Resume request. p_reclassify (D8): the member confirmed that confirmed COPY legs the Master no longer
-- holds become their own quantity (applied by copy_resume_ownership for this generation only).
create or replace function private.request_member_copy_resume(p_user_id uuid, p_reclassify boolean)
 returns jsonb
 language plpgsql
 set search_path to 'pg_catalog'
as $function$
declare a record; result jsonb := '[]'; s private.copy_resume_sessions; target public.profiles;
begin
  perform pg_advisory_xact_lock(hashtextextended('maetajak:copy-execution',0));
  select * into target from public.profiles where id=p_user_id;
  if target.id is null or target.role<>'MEMBER' or target.approval_status<>'APPROVED' or target.member_halted then
    raise exception 'MEMBER_HALTED_OR_NOT_APPROVED';
  end if;
  -- Only the administrator RESUME (set_member_copy_control) lifts an administrator pause.
  if target.admin_paused then raise exception 'ADMIN_PAUSED'; end if;
  for a in select id from private.trading_accounts
    where user_id=p_user_id and account_role='MEMBER' and status='ACTIVE' order by id
  loop
    insert into private.copy_resume_sessions(trading_account_id) values(a.id) on conflict do nothing;
    select * into s from private.copy_resume_sessions where trading_account_id=a.id for update;
    if s.state='ACTIVE' and not coalesce(p_reclassify,false)
      and exists(select 1 from public.profiles where id=p_user_id and not copy_paused) then
      -- An ACTIVE member asking to resume: clear a risk reduce-only (with a fresh risk baseline, or the
      -- worker re-applies it next cycle). An administrator's REDUCE_ONLY is lifted only by an admin.
      if exists(select 1 from public.profiles where id=p_user_id and reduce_only and not admin_reduce_only) then
        perform private.reset_copy_risk_baseline(a.id);
        update public.profiles set reduce_only=false, updated_at=now() where id=p_user_id;
      end if;
      result:=result||jsonb_build_array(jsonb_build_object('version',s.version,'state',s.state)); continue;
    end if;
    -- A resume from a pause acknowledges past results: risk limits are measured from current equity.
    perform private.reset_copy_risk_baseline(a.id);
    -- Repeated clicks preserve both the in-progress version and its sync mode. A reclassification
    -- request always starts a new generation (it changes the ownership evidence).
    if coalesce(p_reclassify,false) or s.state not in ('REQUESTED','VALIDATED') or s.expires_at<=clock_timestamp() then
      update private.copy_resume_sessions set version=gen_random_uuid(),state='REQUESTED',
        requested_at=clock_timestamp(),requested_by=auth.uid(),
        expires_at=clock_timestamp()+interval '5 minutes',
        snapshot_started_at=null,snapshot_observed_at=null,validated_at=null,activated_at=null,
        master_positions=null,member_positions=null,settings=null,blocker_reason=null,
        sync_current_master=false,reclassify_missing_copy=coalesce(p_reclassify,false),updated_at=now()
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
revoke all on function private.request_member_copy_resume(uuid, boolean) from public, anon, authenticated;

create or replace function private.request_member_copy_resume(p_user_id uuid)
 returns jsonb
 language plpgsql
 set search_path to 'pg_catalog'
as $function$
begin
  return private.request_member_copy_resume(p_user_id, false);
end;
$function$;
revoke all on function private.request_member_copy_resume(uuid) from public, anon, authenticated;

create or replace function public.set_member_copy_control(p_user_id uuid,p_mode text,p_reason text default null)
returns jsonb language plpgsql security definer set search_path=pg_catalog
as $$
declare result jsonb;
begin
  if not public.is_approved_admin() then raise exception 'ADMIN_REQUIRED'; end if;
  if p_mode is null or p_mode not in ('PAUSE','REDUCE_ONLY','HALT','RESUME') then raise exception 'INVALID_CONTROL_MODE'; end if;
  perform pg_advisory_xact_lock(hashtextextended('maetajak:copy-execution',0));
  if p_mode='RESUME' then
    -- The administrator RESUME is the only path that lifts administrator restrictions.
    update public.profiles set member_halted=false,admin_paused=false,
      reduce_only=case when admin_reduce_only then false else reduce_only end,admin_reduce_only=false,updated_at=now()
      where id=p_user_id and role='MEMBER';
    -- Review R6: an ACTIVE session keeps copying through the RESUME below; its administrator blocker is lifted here.
    update private.copy_resume_sessions s set blocker_reason=null,updated_at=now()
      from private.trading_accounts a where a.id=s.trading_account_id and a.user_id=p_user_id
        and s.state='ACTIVE' and s.blocker_reason like 'ADMIN\_%';
    result:=private.request_member_copy_resume(p_user_id, false);
  else
    update public.profiles set
      copy_paused=case when p_mode='REDUCE_ONLY' then copy_paused else true end,
      member_halted=p_mode='HALT',
      admin_paused=p_mode in ('PAUSE','HALT'),
      admin_reduce_only=case when p_mode='REDUCE_ONLY' then true else admin_reduce_only end,
      reduce_only=case when p_mode='REDUCE_ONLY' then true else reduce_only end,
      close_positions_requested=false,updated_at=now()
      where id=p_user_id and role='MEMBER';
    if not found then raise exception 'MEMBER_NOT_FOUND'; end if;
    update private.copy_resume_sessions s set
      state=case when p_mode='REDUCE_ONLY' and s.state='ACTIVE' then 'ACTIVE' else 'PAUSED' end,
      blocker_reason='ADMIN_'||p_mode,updated_at=now()
      from private.trading_accounts a where a.id=s.trading_account_id and a.user_id=p_user_id;
    update private.copy_order_intents set status='CANCELLED',resolved_at=now(),updated_at=now()
      where user_id=p_user_id and status in ('PLANNED','QUEUED') and submit_attempts=0;
    result:=jsonb_build_object('mode',p_mode);
  end if;
  insert into public.admin_audit_logs(actor_id,action,target_user_id,next_value)
    values(auth.uid(),'MEMBER_COPY_CONTROL_UPDATED',p_user_id,
      jsonb_build_object('mode',p_mode,'reason',left(p_reason,160)));
  return result||jsonb_build_object('user_id',p_user_id);
end;
$$;
revoke all on function public.set_member_copy_control(uuid,text,text) from public, anon;
grant execute on function public.set_member_copy_control(uuid,text,text) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- 1. Administrator bulk resume for members the Master paused (normal validated resume per member).
-- ---------------------------------------------------------------------------------------------
create or replace function public.admin_request_all_member_copy_resume(p_confirmation text)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog'
as $$
declare m record; requested integer := 0; skipped jsonb := '[]'::jsonb;
begin
  if not public.is_approved_admin() then raise exception 'ADMIN_REQUIRED'; end if;
  if p_confirmation is distinct from 'ADMIN_RESUME_MEMBERS_PAUSED_BY_MASTER' then raise exception 'CONFIRMATION_REQUIRED'; end if;
  perform pg_advisory_xact_lock(hashtextextended('maetajak:copy-execution',0));
  if not exists (select 1 from private.trading_accounts a join private.gate_api_credentials g on g.user_id = a.credential_user_id
      where a.account_role = 'MASTER' and a.status = 'ACTIVE' and g.status = 'VERIFIED') then
    raise exception 'MASTER_NOT_ACTIVE';
  end if;
  for m in select distinct a.user_id from private.copy_resume_sessions s
      join private.trading_accounts a on a.id = s.trading_account_id
      join public.profiles p on p.id = a.user_id
    where a.account_role = 'MEMBER' and a.status = 'ACTIVE' and s.state = 'PAUSED'
      and private.is_master_pause_reason(s.blocker_reason)
      and p.role = 'MEMBER' and p.approval_status = 'APPROVED' and not p.member_halted and not p.admin_paused
      and p.withdrawn_at is null
  loop
    begin
      perform private.request_member_copy_resume(m.user_id, false);
      requested := requested + 1;
    exception when others then
      skipped := skipped || jsonb_build_array(jsonb_build_object('user_id', m.user_id, 'reason', left(sqlerrm, 80)));
    end;
  end loop;
  insert into public.admin_audit_logs(actor_id, action, next_value)
  values (auth.uid(), 'ADMIN_BULK_COPY_RESUME_REQUESTED', jsonb_build_object('requested', requested, 'skipped', skipped));
  return jsonb_build_object('requested', requested, 'skipped', skipped);
end;
$$;
revoke all on function public.admin_request_all_member_copy_resume(text) from public, anon, service_role;
grant execute on function public.admin_request_all_member_copy_resume(text) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- 7. D8: resume while turning confirmed COPY legs the Master no longer holds into the member's own.
-- ---------------------------------------------------------------------------------------------
do $$
begin
  if to_regprocedure('private.copy_resume_ownership_core(uuid,uuid,jsonb,jsonb)') is null then
    alter function private.copy_resume_ownership(uuid,uuid,jsonb,jsonb) rename to copy_resume_ownership_core;
  end if;
end $$;
revoke all on function private.copy_resume_ownership_core(uuid,uuid,jsonb,jsonb) from public, anon, authenticated;

create or replace function private.copy_resume_ownership(p_account uuid,p_version uuid,p_master jsonb,p_member jsonb)
returns jsonb language plpgsql set search_path=pg_catalog as $$
declare proof private.copy_ownership_checkpoints; session private.copy_resume_sessions; missing jsonb; kept jsonb;
begin
  select * into session from private.copy_resume_sessions where trading_account_id=p_account and version=p_version;
  if session.reclassify_missing_copy and private.copy_resume_positions_valid(p_master) then
    select * into proof from private.copy_ownership_checkpoints where trading_account_id=p_account for update;
    if found and proof.status='CONFIRMED' then
      -- Same source test as copy_resume_ownership_core's RESUME_COPY_SOURCE_MISSING.
      select coalesce(jsonb_agg(l.c) filter (where not l.has_source),'[]'),
        coalesce(jsonb_agg(l.c) filter (where l.has_source),'[]')
        into missing, kept
      from (select c, exists(select 1 from jsonb_array_elements(p_master) m
          where m->>'contract'=c->>'contract' and m->>'position_side'=c->>'position_side'
            and sign((m->>'size')::numeric)=sign((c->>'size')::numeric)) has_source
        from jsonb_array_elements(proof.copy_positions) c) l;
      if missing<>'[]'::jsonb then
        update private.copy_ownership_checkpoints set
          protected_positions=private.copy_position_sum(protected_positions||missing),
          copy_positions=private.copy_position_sum(kept),
          reason='COPY_RECLASSIFIED_AS_PERSONAL',revision=revision+1
          where trading_account_id=p_account;
        insert into public.admin_audit_logs(actor_id,action,target_user_id,next_value)
          select session.requested_by,'MEMBER_COPY_RECLASSIFIED_AS_PERSONAL',a.user_id,
            jsonb_build_object('trading_account_id',p_account,'resume_version',p_version,'positions',missing)
          from private.trading_accounts a where a.id=p_account;
      end if;
    end if;
  end if;
  return private.copy_resume_ownership_core(p_account,p_version,p_master,p_member);
end;
$$;
revoke all on function private.copy_resume_ownership(uuid,uuid,jsonb,jsonb) from public,anon,authenticated;

create or replace function public.request_my_copy_resume_reclassify(p_confirmation text)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog'
as $$
declare result jsonb;
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED'; end if;
  if p_confirmation is distinct from 'RECLASSIFY_UNMATCHED_COPY_AS_PERSONAL' then raise exception 'CONFIRMATION_REQUIRED'; end if;
  perform pg_advisory_xact_lock(hashtextextended('maetajak:copy-execution',0));
  -- Offered only for the blocker it resolves.
  if not exists (select 1 from private.copy_resume_sessions s join private.trading_accounts a on a.id = s.trading_account_id
      where a.user_id = auth.uid() and a.account_role = 'MEMBER' and a.status = 'ACTIVE'
        and s.blocker_reason = 'RESUME_COPY_SOURCE_MISSING') then
    raise exception 'RECLASSIFY_NOT_AVAILABLE';
  end if;
  result := private.request_member_copy_resume(auth.uid(), true);
  insert into public.admin_audit_logs(actor_id, action, target_user_id, next_value)
  values (auth.uid(), 'MEMBER_COPY_RECLASSIFY_REQUESTED', auth.uid(), jsonb_build_object('sessions', result->'sessions'));
  return result || jsonb_build_object('reclassify_missing_copy', true);
end;
$$;
revoke all on function public.request_my_copy_resume_reclassify(text) from public, anon, service_role;
grant execute on function public.request_my_copy_resume_reclassify(text) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- 3. A3: administrator disconnect of a member's Gate API (20261020020000 section 2, unchanged).
-- ---------------------------------------------------------------------------------------------
create or replace function public.admin_disable_member_gate_api_connection(p_user_id uuid, p_confirmation text)
 returns void
 language plpgsql
 security definer
 set search_path to 'public', 'extensions', 'pg_temp'
as $function$
declare encryption_key text; before_state jsonb;
begin
  if not public.is_approved_admin() then raise exception 'ADMIN_REQUIRED'; end if;
  if p_confirmation is distinct from 'ADMIN_DISCONNECT_MEMBER_GATE_API' then raise exception 'CONFIRMATION_REQUIRED'; end if;
  select jsonb_build_object('copy_paused',p.copy_paused,'member_halted',p.member_halted,
      'api_status',(select g.status from private.gate_api_credentials g where g.user_id=p.id and g.connection_role='MEMBER'))
    into before_state from public.profiles p where p.id=p_user_id and p.role='MEMBER';
  if before_state is null then raise exception 'MEMBER_NOT_FOUND'; end if;
  select decrypted_secret into encryption_key from vault.decrypted_secrets where name='gate_api_credentials_key';
  if coalesce(encryption_key,'')='' then raise exception 'CREDENTIAL_ENCRYPTION_KEY_MISSING'; end if;
  -- Same serialization as member pause/resume: no worker cycle interleaves with the disconnect.
  perform pg_advisory_xact_lock(hashtextextended('maetajak:copy-execution',0));
  update public.profiles set copy_paused=true,member_halted=true,updated_at=now() where id=p_user_id and role='MEMBER';
  update private.trading_accounts set status='DISABLED',updated_at=now()
    where credential_user_id=p_user_id and account_role='MEMBER';
  update private.copy_order_intents set status='CANCELLED',resolved_at=now(),
      last_error_code='MEMBER_API_DISCONNECTED_BY_ADMIN',updated_at=now()
    where user_id=p_user_id and status in ('PLANNED','QUEUED') and submit_attempts=0;
  delete from private.gate_api_verification_jobs where user_id=p_user_id;
  update private.gate_api_credentials set gate_uid='DISABLED',api_key_ciphertext=pgp_sym_encrypt(encode(gen_random_bytes(32),'hex'),encryption_key,'cipher-algo=aes256'),
    secret_key_ciphertext=pgp_sym_encrypt(encode(gen_random_bytes(32),'hex'),encryption_key,'cipher-algo=aes256'),api_key_last4='NONE',status='DISABLED',
    futures_read=false,futures_trade=false,ip_whitelisted=false,withdrawal_disabled=true,verified_at=null,updated_at=now()
    where user_id=p_user_id and connection_role='MEMBER';
  insert into public.copy_events(user_id,event_type,severity,safe_payload)
    values(p_user_id,'MEMBER_HALTED','WARNING',jsonb_build_object('reason','API_DISCONNECTED_BY_ADMIN'));
  insert into public.admin_audit_logs(actor_id,action,target_user_id,previous_value,next_value)
    values(auth.uid(),'MEMBER_GATE_API_DISCONNECTED',p_user_id,before_state,
      jsonb_build_object('copy_paused',true,'member_halted',true,'api_status','DISABLED'));
end;
$function$;
revoke all on function public.admin_disable_member_gate_api_connection(uuid, text) from public, anon, service_role;
grant execute on function public.admin_disable_member_gate_api_connection(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- 4. A4: Gate UID release.
-- ---------------------------------------------------------------------------------------------
-- Keeps the email identity of a UID account in step with auth.users.email (best effort: login uses
-- auth.users; a missing table or privilege never blocks the withdrawal/restore).
create or replace function private.sync_auth_identity_email(p_user_id uuid, p_email text)
returns void
language plpgsql
security definer
set search_path to 'pg_catalog'
as $$
begin
  if to_regclass('auth.identities') is null then return; end if;
  execute 'update auth.identities set identity_data = identity_data || jsonb_build_object(''email'', $1::text), updated_at = now()'
    || ' where user_id = $2 and provider = ''email'''
    using p_email, p_user_id;
exception when insufficient_privilege or undefined_column then
  raise warning 'auth.identities email not updated for %: %', p_user_id, sqlerrm;
end;
$$;
revoke all on function private.sync_auth_identity_email(uuid, text) from public, anon, authenticated;

-- Frees the UID for a new signup: profiles.gate_uid (uid-signup's UID_TAKEN check) and the synthetic
-- login email (<uid>@uid.maetajak.trading, Supabase Auth's unique email) both move aside.
create or replace function private.release_profile_gate_uid(p_user_id uuid, p_reason text)
returns text
language plpgsql
security definer
set search_path to 'pg_catalog'
as $$
declare target public.profiles; released_email text;
begin
  select * into target from public.profiles where id = p_user_id for update;
  if target.id is null or target.gate_uid is null then return null; end if;
  released_email := 'released+' || replace(p_user_id::text, '-', '') || '@uid.maetajak.trading';
  update public.profiles set gate_uid = null, released_gate_uid = target.gate_uid, gate_uid_released_at = now(),
    gate_uid_released_by = auth.uid(),
    email = case when lower(email) = target.gate_uid || '@uid.maetajak.trading' then released_email else email end,
    updated_at = now()
  where id = p_user_id;
  update auth.users set email = released_email,
    raw_user_meta_data = (coalesce(raw_user_meta_data, '{}'::jsonb) - 'gate_uid')
      || jsonb_build_object('released_gate_uid', target.gate_uid),
    updated_at = now()
  where id = p_user_id and lower(email) = target.gate_uid || '@uid.maetajak.trading';
  perform private.sync_auth_identity_email(p_user_id, released_email);
  insert into public.admin_audit_logs(actor_id, action, target_user_id, previous_value, next_value)
  values (auth.uid(), 'MEMBER_GATE_UID_RELEASED', p_user_id, jsonb_build_object('gate_uid', target.gate_uid),
    jsonb_build_object('reason', p_reason, 'login_email_released', true));
  return target.gate_uid;
end;
$$;
revoke all on function private.release_profile_gate_uid(uuid, text) from public, anon, authenticated;

create or replace function public.release_member_gate_uid(p_user_id uuid, p_confirmation text)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog'
as $$
declare target public.profiles; released text;
begin
  if not public.is_approved_admin() then raise exception 'ADMIN_REQUIRED'; end if;
  if p_confirmation is distinct from 'RELEASE_MEMBER_GATE_UID' then raise exception 'CONFIRMATION_REQUIRED'; end if;
  select * into target from public.profiles where id = p_user_id and role = 'MEMBER' for update;
  if target.id is null then raise exception 'MEMBER_NOT_FOUND'; end if;
  if target.gate_uid is null then raise exception 'GATE_UID_NOT_SET'; end if;
  if target.approval_status = 'APPROVED' and target.withdrawn_at is null then raise exception 'MEMBER_ACTIVE'; end if;
  if exists (select 1 from private.gate_api_credentials g where g.user_id = p_user_id and g.status <> 'DISABLED') then
    raise exception 'MEMBER_GATE_API_CONNECTED';
  end if;
  released := private.release_profile_gate_uid(p_user_id, 'ADMIN_RELEASE');
  return jsonb_build_object('user_id', p_user_id, 'released_gate_uid', released);
end;
$$;
revoke all on function public.release_member_gate_uid(uuid, text) from public, anon, service_role;
grant execute on function public.release_member_gate_uid(uuid, text) to authenticated;

create or replace function public.admin_withdraw_member(p_user_id uuid, p_confirmation text, p_reason text default null)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'extensions', 'pg_temp'
as $function$
declare encryption_key text; target public.profiles; open_positions integer; released text;
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
  -- An account that never verified a Gate API never proved it owns its UID: free the UID (A4).
  if target.gate_uid is not null
    and not exists (select 1 from private.trading_accounts a where a.credential_user_id = p_user_id and a.account_role = 'MEMBER')
    and not exists (select 1 from public.admin_audit_logs l where l.target_user_id = p_user_id and l.action = 'GATE_API_VERIFIED') then
    released := private.release_profile_gate_uid(p_user_id, 'WITHDRAWN_WITHOUT_VERIFIED_API');
  end if;

  insert into public.copy_events(user_id, event_type, severity, safe_payload)
    values (p_user_id, 'MEMBER_HALTED', 'WARNING',
      jsonb_build_object('reason', 'MEMBER_WITHDRAWN', 'open_positions', open_positions));
  insert into public.admin_audit_logs(actor_id, action, target_user_id, previous_value, next_value)
    values (auth.uid(), 'MEMBER_WITHDRAWN', p_user_id,
      jsonb_build_object('approval_status', target.approval_status, 'copy_paused', target.copy_paused,
        'member_halted', target.member_halted),
      jsonb_build_object('approval_status', 'SUSPENDED', 'reason', left(nullif(trim(p_reason), ''), 300),
        'open_positions', open_positions, 'released_gate_uid', released));
  return jsonb_build_object('user_id', p_user_id, 'withdrawn', true, 'open_positions', open_positions,
    'released_gate_uid', released);
end;
$function$;
revoke all on function public.admin_withdraw_member(uuid, text, text) from public, anon, service_role;
grant execute on function public.admin_withdraw_member(uuid, text, text) to authenticated;

-- 5. A7: restore clears the halt (still paused), archives copy-derived state and unbinds the UID, so a
--    reconnect of the same Gate account does not inherit ownership/anchors from before the withdrawal.
create or replace function public.admin_restore_withdrawn_member(p_user_id uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare target public.profiles; acct record; archived jsonb; reclaimed boolean := false; accounts_reset integer := 0;
begin
  if not public.is_approved_admin() then raise exception 'ADMIN_REQUIRED'; end if;
  perform pg_advisory_xact_lock(hashtextextended('maetajak:copy-execution',0));
  select * into target from public.profiles where id = p_user_id and role = 'MEMBER' for update;
  if target.id is null then raise exception 'MEMBER_NOT_FOUND'; end if;
  if target.withdrawn_at is null then raise exception 'MEMBER_NOT_WITHDRAWN'; end if;
  update public.profiles set approval_status = 'PENDING', withdrawn_at = null, withdrawn_by = null,
      withdrawal_reason = null, member_halted = false, copy_paused = true, close_positions_requested = false,
      reduce_only = false, updated_at = now()
    where id = p_user_id;
  for acct in select a.id, a.bound_gate_uid from private.trading_accounts a
      where a.user_id = p_user_id and a.account_role = 'MEMBER' loop
    archived := private.archive_account_rows(acct.id, false);
    insert into private.trading_account_rebind_archive(trading_account_id, account_role, reason, old_gate_uid, new_gate_uid, archived)
    values (acct.id, 'MEMBER', 'MEMBER_RESTORED', acct.bound_gate_uid, null, archived);
    update private.trading_accounts set bound_gate_uid = null, updated_at = now() where id = acct.id;
    update private.copy_resume_sessions set version = gen_random_uuid(), state = 'REQUIRED',
      blocker_reason = 'MEMBER_RESTORED', requested_at = null, requested_by = null, expires_at = null,
      snapshot_started_at = null, snapshot_observed_at = null, validated_at = null, activated_at = null,
      master_positions = null, member_positions = null, settings = null, validation_evidence = null,
      sync_current_master = false, reclassify_missing_copy = false, updated_at = now()
    where trading_account_id = acct.id;
    accounts_reset := accounts_reset + 1;
  end loop;
  -- A UID released at withdrawal comes back when nobody took it meanwhile.
  if target.gate_uid is null and target.released_gate_uid is not null
    and not exists (select 1 from public.profiles p where p.gate_uid = target.released_gate_uid)
    and not exists (select 1 from auth.users u where lower(u.email) = target.released_gate_uid || '@uid.maetajak.trading') then
    update public.profiles set gate_uid = released_gate_uid, released_gate_uid = null, gate_uid_released_at = null,
      gate_uid_released_by = null,
      email = case when email like 'released+%@uid.maetajak.trading' then target.released_gate_uid || '@uid.maetajak.trading' else email end
    where id = p_user_id;
    update auth.users set email = target.released_gate_uid || '@uid.maetajak.trading',
      raw_user_meta_data = (coalesce(raw_user_meta_data, '{}'::jsonb) - 'released_gate_uid')
        || jsonb_build_object('gate_uid', target.released_gate_uid), updated_at = now()
    where id = p_user_id and email like 'released+%@uid.maetajak.trading';
    perform private.sync_auth_identity_email(p_user_id, target.released_gate_uid || '@uid.maetajak.trading');
    reclaimed := true;
  end if;
  update auth.users set banned_until = null, updated_at = now() where id = p_user_id;
  insert into public.admin_audit_logs(actor_id, action, target_user_id, previous_value, next_value)
    values (auth.uid(), 'MEMBER_RESTORED', p_user_id,
      jsonb_build_object('withdrawn_at', target.withdrawn_at, 'reason', target.withdrawal_reason,
        'member_halted', target.member_halted),
      jsonb_build_object('approval_status', 'PENDING', 'member_halted', false, 'copy_state_reset', accounts_reset,
        'gate_uid_reclaimed', reclaimed));
  return jsonb_build_object('user_id', p_user_id, 'restored', true, 'approval_status', 'PENDING',
    'copy_state_reset', accounts_reset,
    'gate_uid', (select gate_uid from public.profiles where id = p_user_id),
    'released_gate_uid', (select released_gate_uid from public.profiles where id = p_user_id));
end;
$function$;
revoke all on function public.admin_restore_withdrawn_member(uuid) from public, anon, service_role;
grant execute on function public.admin_restore_withdrawn_member(uuid) to authenticated;

-- A rejected account without a live Gate key releases its UID (A4).
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

  if new_status = 'REJECTED' and updated_profile.role = 'MEMBER' and updated_profile.gate_uid is not null
    and not exists (select 1 from private.gate_api_credentials g where g.user_id = target_user_id and g.status <> 'DISABLED') then
    perform private.release_profile_gate_uid(target_user_id, 'REJECTED');
    select * into updated_profile from public.profiles where id = target_user_id;
  end if;
  return updated_profile;
end;
$function$;

-- ---------------------------------------------------------------------------------------------
-- 2. A2: admin member copy status reflects the resume session and Gate read errors.
--    Production definition 20260924123930 + KST dates (20261020020000 section 1) + session/read state.
-- ---------------------------------------------------------------------------------------------
create or replace function public.get_admin_operations_metrics(p_start_date date default ((now() at time zone 'Asia/Seoul')::date - 29), p_end_date date default (now() at time zone 'Asia/Seoul')::date)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  kst_today date := (now() at time zone 'Asia/Seoul')::date;
  range_start date := greatest(coalesce(p_start_date, kst_today - 29), kst_today - 364);
  range_end date := least(coalesce(p_end_date, kst_today), kst_today);
  result jsonb;
begin
  if not public.is_approved_admin() then raise exception 'ADMIN_REQUIRED'; end if;
  if range_start > range_end then raise exception 'INVALID_DATE_RANGE'; end if;

  with approved_members as (
    select profile.*,
      connection.status as api_status,
      connection.updated_at as api_updated_at
    from public.profiles profile
    left join private.gate_api_credentials connection on connection.user_id = profile.id
    where profile.role = 'MEMBER'
      and profile.approval_status = 'APPROVED'
  ), account_equity as (
    select account.id as trading_account_id, account.user_id, account.account_role,
      current_account.total_equity,
      current_account.available_equity,
      current_account.unrealised_pnl,
      current_account.observed_at,
      coalesce(sample_mode.includes_unrealised, false) as equity_includes_unrealised
    from private.trading_accounts account
    left join private.copy_current_accounts current_account
      on current_account.trading_account_id = account.id
    left join lateral (
      select count(*) filter (where sample.upnl_moved) >= 5
        and count(*) filter (where sample.total_moved) >= 0.8 * count(*) filter (where sample.upnl_moved)
        as includes_unrealised
      from (
        select recent.total_equity is distinct from lag(recent.total_equity) over w as total_moved,
          recent.unrealised_pnl is distinct from lag(recent.unrealised_pnl) over w as upnl_moved,
          row_number() over w as sample_no
        from (
          select snapshot.total_equity, snapshot.unrealised_pnl, snapshot.observed_at
          from private.copy_account_snapshots snapshot
          where snapshot.trading_account_id = account.id
          order by snapshot.observed_at desc
          limit 30
        ) recent
        window w as (order by recent.observed_at)
      ) sample
      where sample.sample_no > 1
    ) sample_mode on true
    where account.settle = 'usdt'
  ), latest_accounts as (
    select member.id as user_id,
      equity.total_equity,
      equity.available_equity,
      equity.unrealised_pnl,
      equity.observed_at,
      equity.equity_includes_unrealised
    from approved_members member
    left join account_equity equity
      on equity.user_id = member.id
     and equity.account_role = 'MEMBER'
  ), member_session as (
    select account.user_id, account.status as account_status,
      session.state as session_state, session.blocker_reason, session.activated_at,
      verification.status as read_status, verification.error_code as read_error_code,
      verification.error_since as read_error_since
    from private.trading_accounts account
    left join private.copy_resume_sessions session on session.trading_account_id = account.id
    left join private.copy_current_verifications verification on verification.trading_account_id = account.id
    where account.account_role = 'MEMBER' and account.settle = 'usdt'
  ), member_state as (
    select state.user_id,
      bool_or(state.state in ('ERROR', 'HALTED')) as has_error,
      bool_or(state.state = 'MANUAL_OVERRIDE') as has_override,
      max(state.last_observed_at) as state_observed_at
    from public.copy_position_states state
    group by state.user_id
  ), member_today as (
    select performance.user_id,
      performance.realised_pnl - performance.fees + performance.funding_pnl + performance.unrealised_pnl as today_pnl
    from public.member_daily_performance performance
    where performance.trading_date = kst_today
  ), member_rows as (
    select member.id, member.full_name, member.email, member.gate_uid, member.copy_ratio,
      member.max_position_ratio, member.copy_paused, member.member_halted, member.reduce_only,
      member.admin_paused, member.admin_reduce_only,
      member.api_status, account.total_equity, account.available_equity,
      account.unrealised_pnl,
      coalesce(account.equity_includes_unrealised, false) as equity_includes_unrealised,
      case when account.total_equity is null then null
        when account.equity_includes_unrealised then account.total_equity - coalesce(account.unrealised_pnl, 0)
        else account.total_equity end as balance_equity,
      case when account.total_equity is null then null
        when account.equity_includes_unrealised then account.total_equity
        else account.total_equity + coalesce(account.unrealised_pnl, 0) end as current_equity,
      case when coalesce(account.total_equity, 0) > 0
        then greatest(0, (account.total_equity - account.available_equity) * 100 / account.total_equity)
        else 0 end as margin_usage_pct,
      today.today_pnl,
      greatest(account.observed_at, state.state_observed_at, member.api_updated_at) as last_observed_at,
      session.session_state, session.blocker_reason as resume_blocker,
      case when session.read_status = 'ERROR' then session.read_error_code end as read_error_code,
      case when session.read_status = 'ERROR' then session.read_error_since end as read_error_since,
      case
        when member.member_halted then 'HALTED'
        when coalesce(member.api_status, 'NOT_CONNECTED') <> 'VERIFIED' then 'API_ERROR'
        -- A key revoked / IP whitelist removed: every read fails with a credential error.
        when session.read_status = 'ERROR'
          and session.read_error_code ~ '(INVALID_CREDENTIALS|FUTURES_READ_REQUIRED|UNIFIED_READ_REQUIRED|IP_NOT_ALLOWED)$'
          and session.read_error_since <= now() - interval '5 minutes' then 'API_ERROR'
        when session.user_id is null or session.account_status <> 'ACTIVE'
          or (coalesce(session.session_state, 'REQUIRED') = 'REQUIRED' and session.activated_at is null) then 'NOT_STARTED'
        when session.session_state = 'CLOSING' then 'CLOSING'
        when member.admin_paused or (member.copy_paused and session.session_state = 'PAUSED') then 'PAUSED'
        when session.session_state <> 'ACTIVE' then 'RESUME_REQUIRED'
        when member.copy_paused then 'PAUSED'
        when session.read_status = 'ERROR' then 'READ_ERROR'
        when member.reduce_only then 'REDUCE_ONLY'
        when state.has_error then 'ERROR'
        when state.has_override then 'ATTENTION'
        else 'COPYING'
      end as copy_status
    from approved_members member
    left join latest_accounts account on account.user_id = member.id
    left join member_session session on session.user_id = member.id
    left join member_state state on state.user_id = member.id
    left join member_today today on today.user_id = member.id
  ), master_row as (
    select owner.full_name, owner.email,
      equity.total_equity, equity.available_equity, equity.unrealised_pnl, equity.observed_at,
      equity.equity_includes_unrealised,
      case when equity.total_equity is null then null
        when equity.equity_includes_unrealised then equity.total_equity - coalesce(equity.unrealised_pnl, 0)
        else equity.total_equity end as balance_equity,
      case when equity.total_equity is null then null
        when equity.equity_includes_unrealised then equity.total_equity
        else equity.total_equity + coalesce(equity.unrealised_pnl, 0) end as current_equity
    from account_equity equity
    join public.profiles owner on owner.id = equity.user_id
    where equity.account_role = 'MASTER'
    order by equity.observed_at desc nulls last
    limit 1
  ), daily as (
    select performance.trading_date,
      sum(performance.realised_pnl - performance.fees + performance.funding_pnl +
        case when performance.trading_date = kst_today then performance.unrealised_pnl else 0 end) as pnl,
      sum(performance.trading_volume) as trading_volume,
      sum(performance.fees) as fees,
      count(distinct performance.user_id) filter (where performance.trading_volume > 0) as users
    from public.member_daily_performance performance
    where performance.trading_date between range_start and range_end
    group by performance.trading_date
  )
  select jsonb_build_object(
    'range_start', range_start,
    'range_end', range_end,
    'totals', jsonb_build_object(
      'members', (select count(*) from member_rows),
      'copying_members', (select count(*) from member_rows where copy_status = 'COPYING'),
      'attention_members', (select count(*) from member_rows where copy_status <> 'COPYING'),
      'paused_by_master', (select count(*) from member_rows where copy_status in ('RESUME_REQUIRED', 'PAUSED')
        and private.is_master_pause_reason(resume_blocker)),
      'total_assets', (select coalesce(sum(total_equity), 0) from member_rows),
      'current_assets', (select coalesce(sum(current_equity), 0) from member_rows),
      'period_pnl', (select coalesce(sum(pnl), 0) from daily),
      'trading_volume', (select coalesce(sum(trading_volume), 0) from daily),
      'fees', (select coalesce(sum(fees), 0) from daily),
      'active_users', (select count(distinct performance.user_id)
        from public.member_daily_performance performance
        where performance.trading_date between range_start and range_end
          and performance.trading_volume > 0)
    ),
    'members', coalesce((select jsonb_agg(jsonb_build_object(
      'id', id,
      'full_name', full_name,
      'email', email,
      'gate_uid', gate_uid,
      'copy_status', copy_status,
      'session_state', session_state,
      'resume_blocker', resume_blocker,
      'paused_by_master', private.is_master_pause_reason(resume_blocker),
      'read_error_code', read_error_code,
      'read_error_since', read_error_since,
      'admin_paused', admin_paused,
      'admin_reduce_only', admin_reduce_only,
      'reduce_only', reduce_only,
      'copy_ratio', copy_ratio,
      'max_position_ratio', max_position_ratio,
      'total_equity', total_equity,
      'balance_equity', balance_equity,
      'current_equity', current_equity,
      'unrealised_pnl', unrealised_pnl,
      'equity_includes_unrealised', equity_includes_unrealised,
      'today_pnl', today_pnl,
      'margin_usage_pct', margin_usage_pct,
      'api_status', coalesce(api_status, 'NOT_CONNECTED'),
      'last_observed_at', last_observed_at
    ) order by full_name, email) from member_rows), '[]'::jsonb),
    'master', (select jsonb_build_object(
      'full_name', full_name,
      'email', email,
      'total_equity', total_equity,
      'balance_equity', balance_equity,
      'current_equity', current_equity,
      'unrealised_pnl', unrealised_pnl,
      'equity_includes_unrealised', equity_includes_unrealised,
      'last_observed_at', observed_at
    ) from master_row),
    'daily', coalesce((select jsonb_agg(jsonb_build_object(
      'date', trading_date,
      'pnl', pnl,
      'trading_volume', trading_volume,
      'fees', fees,
      'users', users
    ) order by trading_date) from daily), '[]'::jsonb)
  ) into result;

  return result;
end;
$function$;
revoke all on function public.get_admin_operations_metrics(date, date) from public, anon;
grant execute on function public.get_admin_operations_metrics(date, date) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- 8. D11: MDD on the daily-return index (a deposit/withdrawal moves equity, not the index). The worker
--    writes daily_return_pct = (closing - opening - net transfers) / opening from 2026-10-21, opening and closing
--    on one equity basis (review R1: MTM when the opening is the risk day-start, wallet when rebuilt from the
--    ledger); these functions only compound daily_return_pct, so they need no basis of their own.
--    Definitions 202608280004 / 202608290004 + KST dates (20261020020000 section 1).
-- ---------------------------------------------------------------------------------------------
create or replace function public.get_my_dashboard_performance(p_days integer default 30)
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare result jsonb;
declare started_on date;
declare range_start date;
declare kst_today date := (now() at time zone 'Asia/Seoul')::date;
begin
  if not exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'MEMBER' and approval_status = 'APPROVED'
  ) then raise exception 'APPROVED_MEMBER_REQUIRED'; end if;
  select coalesce((copy_started_at at time zone 'Asia/Seoul')::date, kst_today) into started_on
  from public.profiles where id = auth.uid();
  range_start := greatest(started_on, kst_today - (greatest(1, least(coalesce(p_days, 30), 180)) - 1));

  with base as (
    select trading_date, opening_equity, closing_equity,
      realised_pnl - fees + funding_pnl as net_pnl,
      daily_return_pct, trade_count, winning_trade_count as wins,
      losing_trade_count as losses, source_snapshot_at,
      exp(sum(ln(greatest(1 + coalesce(daily_return_pct, 0) / 100, 0.000001)))
        over (order by trading_date rows between unbounded preceding and current row)) as return_index
    from public.member_daily_performance
    where user_id = auth.uid() and trading_date between range_start and kst_today
  ), daily as (
    select base.*, greatest(1, max(return_index) over (order by trading_date rows between unbounded preceding and current row)) as index_peak
    from base
  ), totals as (
    select coalesce(sum(net_pnl), 0) as net_pnl,
      coalesce(sum(trade_count), 0) as trades,
      coalesce(sum(wins), 0) as wins, coalesce(sum(losses), 0) as losses,
      case when count(daily_return_pct) = 0 then null
        when bool_or(daily_return_pct <= -100) then -100
        else (exp(sum(ln(1 + daily_return_pct / 100))) - 1) * 100 end as roi,
      coalesce(max((index_peak - return_index) * 100 / index_peak), 0) as mdd,
      max(source_snapshot_at) filter (where trade_count > 0) as last_trade_at
    from daily
  )
  select jsonb_build_object(
    'requested_days', greatest(1, least(coalesce(p_days, 30), 180)),
    'started_on', started_on, 'range_start', range_start, 'range_end', kst_today,
    'totals', (select jsonb_build_object(
      'roi', roi, 'net_pnl', net_pnl, 'trades', trades, 'wins', wins, 'losses', losses,
      'win_rate', case when wins + losses > 0 then wins * 100.0 / (wins + losses) end,
      'mdd', mdd, 'average_daily_trades', trades::numeric / greatest(1, kst_today - range_start + 1),
      'last_trade_at', last_trade_at
    ) from totals),
    'days', coalesce((select jsonb_agg(jsonb_build_object(
      'date', trading_date, 'net_pnl', net_pnl, 'daily_return_pct', daily_return_pct,
      'closing_equity', closing_equity
    ) order by trading_date) from daily), '[]'::jsonb)
  ) into result;
  return result;
end;
$$;
revoke all on function public.get_my_dashboard_performance(integer) from public, anon;
grant execute on function public.get_my_dashboard_performance(integer) to authenticated;

create or replace function public.get_my_dashboard_performance_range(p_start_date date, p_end_date date)
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare result jsonb;
declare started_on date;
declare range_start date;
declare range_end date;
declare kst_today date := (now() at time zone 'Asia/Seoul')::date;
begin
  if not exists (select 1 from public.profiles where id = auth.uid() and role = 'MEMBER' and approval_status = 'APPROVED') then
    raise exception 'APPROVED_MEMBER_REQUIRED';
  end if;
  select coalesce((copy_started_at at time zone 'Asia/Seoul')::date, kst_today) into started_on from public.profiles where id = auth.uid();
  range_start := greatest(started_on, coalesce(p_start_date, started_on));
  range_end := least(kst_today, coalesce(p_end_date, kst_today));
  if range_start > range_end then raise exception 'INVALID_DATE_RANGE'; end if;
  if range_end - range_start > 365 then raise exception 'DATE_RANGE_TOO_LARGE'; end if;

  with base as (
    select trading_date, opening_equity, closing_equity,
      realised_pnl - fees + funding_pnl as net_pnl,
      daily_return_pct, trade_count, winning_trade_count as wins,
      losing_trade_count as losses, source_snapshot_at,
      exp(sum(ln(greatest(1 + coalesce(daily_return_pct, 0) / 100, 0.000001)))
        over (order by trading_date rows between unbounded preceding and current row)) as return_index
    from public.member_daily_performance
    where user_id = auth.uid() and trading_date between range_start and range_end
  ), daily as (
    select base.*, greatest(1, max(return_index) over (order by trading_date rows between unbounded preceding and current row)) as index_peak
    from base
  ), totals as (
    select coalesce(sum(net_pnl), 0) as net_pnl, coalesce(sum(trade_count), 0) as trades,
      coalesce(sum(wins), 0) as wins, coalesce(sum(losses), 0) as losses,
      case when count(daily_return_pct) = 0 then null
        when bool_or(daily_return_pct <= -100) then -100
        else (exp(sum(ln(1 + daily_return_pct / 100))) - 1) * 100 end as roi,
      coalesce(max((index_peak - return_index) * 100 / index_peak), 0) as mdd,
      max(source_snapshot_at) filter (where trade_count > 0) as last_trade_at
    from daily
  )
  select jsonb_build_object(
    'started_on', started_on, 'range_start', range_start, 'range_end', range_end,
    'totals', (select jsonb_build_object(
      'roi', roi, 'net_pnl', net_pnl, 'trades', trades, 'wins', wins, 'losses', losses,
      'win_rate', case when wins + losses > 0 then wins * 100.0 / (wins + losses) end,
      'mdd', mdd, 'average_daily_trades', trades::numeric / greatest(1, range_end - range_start + 1),
      'last_trade_at', last_trade_at) from totals),
    'days', coalesce((select jsonb_agg(jsonb_build_object(
      'date', trading_date, 'net_pnl', net_pnl, 'daily_return_pct', daily_return_pct,
      'closing_equity', closing_equity) order by trading_date) from daily), '[]'::jsonb)
  ) into result;
  return result;
end;
$$;
revoke all on function public.get_my_dashboard_performance_range(date, date) from public, anon;
grant execute on function public.get_my_dashboard_performance_range(date, date) to authenticated;

notify pgrst, 'reload schema';

reset lock_timeout;
