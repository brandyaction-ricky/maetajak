-- 2026-10-30 Administrator "가입 순서대로 카피 시작" (ordered copy start).
--
-- The administrator starts the copy of READY members one at a time, in signup order (profiles.created_at, then
-- id). Every start is the existing administrator resume path private.request_member_copy_resume(user, false):
-- a FUTURE_ONLY resume (sync_current_master = false, no CURRENT_MASTER / new-operation receipt). Positions the
-- Master already holds are not bought; the member follows later Master changes proportionally to its equity.
-- Copy sizing and copy semantics are unchanged. Members can still start themselves (set_my_copy_pause RESUME);
-- a queued member whose session becomes ACTIVE that way resolves as ACTIVE.
--
-- Queue (private.copy_start_queue): one batch at a time (admin_enqueue_ordered_copy_start refuses with
-- ORDERED_COPY_START_RUNNING while a batch still has QUEUED/REQUESTED items; cancel or wait). Item states:
--   QUEUED     waiting for its turn
--   REQUESTED  its resume session was requested; waiting for the worker to validate and activate it
--   ACTIVE     the session became ACTIVE (success; also a self-start or an administrator RESUME)
--   SKIPPED    the member was not ready when its turn came (reason = readiness code)
--   FAILED     the session ended BLOCKED / expired / paused without becoming ACTIVE (reason = blocker)
--   CANCELLED  the administrator cancelled the pending item
-- Only one item is REQUESTED at a time; the next member is requested only after it resolves. A REQUESTED
-- item goes back to QUEUED (at most 3 requests per member) when its session expired while the system was not
-- LIVE (whatever the last blocker), expired after validation (activation never ran) or was paused by a Master
-- change; if the administrator cancelled the batch meanwhile (cancel_requested) it ends CANCELLED instead.
-- A transient error while requesting (lock timeout 55P03, deadlock 40P01, serialization 40001) leaves the item
-- QUEUED without counting an attempt; the next run retries.
-- A member is resolved over ALL of its ACTIVE MEMBER trading accounts (as request_member_copy_resume resumes
-- all of them): ACTIVE only when every session is ACTIVE.
--
-- Advancing (private.advance_copy_start_queue) runs under the copy-execution advisory lock:
--   * at the end of admin_enqueue_ordered_copy_start and every minute from pg_cron job
--     'maetajak-ordered-copy-start' (a no-op without open items): resolve, then request the next member;
--   * from an AFTER UPDATE OF state trigger on private.copy_resume_sessions, only for a member with an open
--     queue item: RESOLVE ONLY (never requests the next member, never locks another member's rows), try-lock,
--     200ms lock_timeout, every error (also query_canceled) swallowed with a WARNING and a trace in
--     private.copy_start_queue_trigger_errors (exposed as trigger_error): the session update that fired it
--     (e.g. the worker's activation) never fails.
-- New requests are made only while the system can activate a session: execution_enabled, not emergency_halted,
-- worker mode LIVE with a heartbeat in the last 60 seconds, Master account ACTIVE with a VERIFIED key. Otherwise
-- items stay QUEUED and get_admin_ordered_copy_start reports waiting_for_live (+ live_reason).
--
-- Members without queue items are not affected: the trigger returns after one indexed lookup.
--
-- Idempotent: CREATE TABLE/INDEX IF NOT EXISTS, CREATE OR REPLACE FUNCTION, DROP TRIGGER IF EXISTS + CREATE
-- TRIGGER, cron unschedule-then-schedule. No existing table, column or row is dropped or deleted; no existing
-- function is replaced (all functions are new).
-- Deploy order: after 20261021010000 (profiles.withdrawn_at) and 20261021032000 (profiles.admin_paused /
-- admin_reduce_only, private.request_member_copy_resume(uuid, boolean), private.is_master_pause_reason); before
-- the web build (src/main.js calls the three public RPCs). The worker is unchanged.

set lock_timeout = '5s';

create table if not exists private.copy_start_queue (
  id bigint generated always as identity primary key,
  batch_id uuid not null,
  user_id uuid not null,
  trading_account_id uuid,
  signup_at timestamptz not null,
  seq integer not null,
  state text not null default 'QUEUED'
    check (state in ('QUEUED', 'REQUESTED', 'ACTIVE', 'SKIPPED', 'FAILED', 'CANCELLED')),
  reason text,
  attempts integer not null default 0,
  resume_version uuid,
  requested_by uuid,
  created_at timestamptz not null default clock_timestamp(),
  requested_at timestamptz,
  resolved_at timestamptz,
  updated_at timestamptz not null default clock_timestamp(),
  cancel_requested boolean not null default false,
  last_error_code text,
  last_error_at timestamptz,
  unique (batch_id, seq)
);
alter table private.copy_start_queue
  add column if not exists cancel_requested boolean not null default false,
  add column if not exists last_error_code text,
  add column if not exists last_error_at timestamptz;
alter table private.copy_start_queue enable row level security;
revoke all on private.copy_start_queue from public, anon, authenticated;
comment on table private.copy_start_queue is
  'Administrator ordered copy start (2026-10-30): members started one at a time in signup order via the FUTURE_ONLY resume path.';
-- A member is in at most one open item.
create unique index if not exists copy_start_queue_open_user_uidx on private.copy_start_queue (user_id)
  where state in ('QUEUED', 'REQUESTED');
create index if not exists copy_start_queue_open_account_idx on private.copy_start_queue (trading_account_id)
  where state in ('QUEUED', 'REQUESTED');
create index if not exists copy_start_queue_batch_idx on private.copy_start_queue (batch_id, seq);

-- Last error the session trigger swallowed (one row): observable without failing the worker's transaction.
create table if not exists private.copy_start_queue_trigger_errors (
  singleton boolean primary key default true check (singleton),
  last_error_code text,
  last_error_message text,
  last_error_at timestamptz,
  trading_account_id uuid,
  error_count bigint not null default 0
);
alter table private.copy_start_queue_trigger_errors enable row level security;
revoke all on private.copy_start_queue_trigger_errors from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- Can a requested session be activated now? null = yes, otherwise the reason (the worker activates only in
-- LIVE with execution enabled and no emergency halt, see activate_member_copy_resume_core).
-- ---------------------------------------------------------------------------------------------
create or replace function private.copy_start_live_state()
returns text
language sql
stable
set search_path to 'pg_catalog'
as $$
  select case
    when c.singleton is null then 'SYSTEM_CONTROL_MISSING'
    when c.emergency_halted then 'EMERGENCY_HALTED'
    when not c.execution_enabled then 'EXECUTION_DISABLED'
    when r.singleton is null or r.mode <> 'LIVE' then 'WORKER_NOT_LIVE'
    when r.heartbeat_at is null or r.heartbeat_at <= now() - interval '60 seconds' then 'WORKER_OFFLINE'
    when not exists (select 1 from private.trading_accounts a join private.gate_api_credentials g on g.user_id = a.credential_user_id
        where a.account_role = 'MASTER' and a.status = 'ACTIVE' and g.status = 'VERIFIED') then 'MASTER_NOT_ACTIVE'
    else null end
  from (select true as present) x
  left join public.copy_system_control c on c.singleton
  left join private.copy_worker_runtime r on r.singleton
$$;
revoke all on function private.copy_start_live_state() from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- Is the member ready for an administrator copy start? null = ready, otherwise the reason.
-- Ready: MEMBER, approved, not withdrawn, not halted, no administrator pause/reduce-only, at least one ACTIVE
-- MEMBER trading account, and for EVERY such account (request_member_copy_resume resumes all of them): a Gate
-- key VERIFIED with futures read+trade, and a session that is not CLOSING / close requested, not paused by the
-- member (MEMBER_PAUSED) or an administrator (ADMIN_*), and no administrator new operation in progress.
-- REQUIRED (never started), BLOCKED, PAUSED for any other reason (Master change, settings change, key change,
-- ...) and REQUESTED/VALIDATED are ready. ALREADY_ACTIVE: every account's session is ACTIVE (an open queue
-- item resolves ACTIVE).
-- ---------------------------------------------------------------------------------------------
create or replace function private.copy_start_readiness(p_user_id uuid)
returns text
language plpgsql
stable
set search_path to 'pg_catalog'
as $$
declare p public.profiles; accounts integer;
begin
  select * into p from public.profiles where id = p_user_id;
  if p.id is null or p.role <> 'MEMBER' then return 'NOT_MEMBER'; end if;
  if p.withdrawn_at is not null then return 'WITHDRAWN'; end if;
  if p.approval_status <> 'APPROVED' then return 'NOT_APPROVED'; end if;
  if p.member_halted then return 'MEMBER_HALTED'; end if;
  if p.admin_paused then return 'ADMIN_PAUSED'; end if;
  if p.admin_reduce_only then return 'ADMIN_REDUCE_ONLY'; end if;
  select count(*) into accounts from private.trading_accounts a
    where a.user_id = p_user_id and a.account_role = 'MEMBER' and a.status = 'ACTIVE';
  if accounts = 0 then return 'TRADING_ACCOUNT_NOT_ACTIVE'; end if;
  if exists (select 1 from private.trading_accounts a
      where a.user_id = p_user_id and a.account_role = 'MEMBER' and a.status = 'ACTIVE'
        and not exists (select 1 from private.gate_api_credentials g where g.user_id = a.credential_user_id
          and g.status = 'VERIFIED' and g.futures_read and g.futures_trade)) then
    return 'GATE_API_NOT_VERIFIED';
  end if;
  if not exists (select 1 from private.trading_accounts a
      left join private.copy_resume_sessions s on s.trading_account_id = a.id
      where a.user_id = p_user_id and a.account_role = 'MEMBER' and a.status = 'ACTIVE'
        and s.state is distinct from 'ACTIVE') then
    return 'ALREADY_ACTIVE';
  end if;
  if p.close_positions_requested or exists (select 1 from private.trading_accounts a
      join private.copy_resume_sessions s on s.trading_account_id = a.id
      where a.user_id = p_user_id and a.account_role = 'MEMBER' and a.status = 'ACTIVE' and s.state = 'CLOSING') then
    return 'MEMBER_CLOSING';
  end if;
  if exists (select 1 from private.trading_accounts a join private.copy_resume_sessions s on s.trading_account_id = a.id
      where a.user_id = p_user_id and a.account_role = 'MEMBER' and a.status = 'ACTIVE'
        and s.state = 'PAUSED' and s.blocker_reason = 'MEMBER_PAUSED') then
    return 'MEMBER_PAUSED';
  end if;
  if exists (select 1 from private.trading_accounts a join private.copy_resume_sessions s on s.trading_account_id = a.id
      where a.user_id = p_user_id and a.account_role = 'MEMBER' and a.status = 'ACTIVE'
        and s.state = 'PAUSED' and s.blocker_reason like 'ADMIN\_%') then
    return 'ADMIN_PAUSED';
  end if;
  if exists (select 1 from private.trading_accounts a join private.copy_resume_sessions s on s.trading_account_id = a.id
      where a.user_id = p_user_id and a.account_role = 'MEMBER' and a.status = 'ACTIVE'
        and ((s.state = 'PAUSED' and s.blocker_reason = 'NEW_OPERATION_REQUESTED')
          or (s.state in ('REQUESTED', 'VALIDATED') and s.sync_current_master and s.expires_at > clock_timestamp()))) then
    return 'NEW_OPERATION_PENDING';
  end if;
  return null;
end;
$$;
revoke all on function private.copy_start_readiness(uuid) from public, anon, authenticated;

-- The session that decides a member's start over all its ACTIVE MEMBER accounts: a non-ACTIVE one (one still
-- being validated first), otherwise (every session ACTIVE) an ACTIVE one. All-null when there is none.
create or replace function private.copy_start_member_session(p_user_id uuid)
returns private.copy_resume_sessions
language sql
stable
set search_path to 'pg_catalog'
as $$
  select s.* from private.trading_accounts a
  left join private.copy_resume_sessions s on s.trading_account_id = a.id
  where a.user_id = p_user_id and a.account_role = 'MEMBER' and a.status = 'ACTIVE'
  order by (s.state is not distinct from 'ACTIVE'), (s.state in ('REQUESTED', 'VALIDATED')) desc nulls last, a.id
  limit 1
$$;
revoke all on function private.copy_start_member_session(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- Advance the queue. p_nonblocking: try-lock only (trigger). p_request_next: may request the next member
-- (enqueue and the per-minute job only; the trigger resolves only).
-- ---------------------------------------------------------------------------------------------
create or replace function private.advance_copy_start_queue(p_nonblocking boolean default false,
  p_request_next boolean default true)
returns jsonb
language plpgsql
set search_path to 'pg_catalog'
as $$
declare
  q private.copy_start_queue; s private.copy_resume_sessions; live text; ready text; why text;
  account_id uuid; before_versions jsonb; transient boolean; expired boolean;
  resolved integer := 0; requested integer := 0; skipped integer := 0; guard integer := 0;
begin
  if coalesce(current_setting('maetajak.copy_start_queue_busy', true), '') = 'on' then
    return jsonb_build_object('skipped', 'REENTRANT');
  end if;
  -- Cheap exit (the per-minute job) before taking the execution lock.
  if not exists (select 1 from private.copy_start_queue where state in ('QUEUED', 'REQUESTED')) then
    return jsonb_build_object('open', 0);
  end if;
  if p_nonblocking then
    if not pg_try_advisory_xact_lock(hashtextextended('maetajak:copy-execution', 0)) then
      return jsonb_build_object('skipped', 'LOCK_BUSY');
    end if;
  else
    perform pg_advisory_xact_lock(hashtextextended('maetajak:copy-execution', 0));
  end if;
  -- Session updates made below (request_member_copy_resume) must not re-enter through the trigger.
  perform set_config('maetajak.copy_start_queue_busy', 'on', true);
  live := private.copy_start_live_state();

  -- 1. A queued member who started another way (self-start, administrator RESUME): every session ACTIVE.
  for q in select * from private.copy_start_queue where state = 'QUEUED' order by seq, id for update loop
    s := private.copy_start_member_session(q.user_id);
    if s.state = 'ACTIVE' then
      update private.copy_start_queue set state = 'ACTIVE', reason = 'STARTED_OUTSIDE_QUEUE',
        resolved_at = clock_timestamp(), updated_at = clock_timestamp() where id = q.id;
      resolved := resolved + 1;
    end if;
  end loop;

  -- 2. Resolve the requested item(s).
  for q in select * from private.copy_start_queue where state = 'REQUESTED' order by seq, id for update loop
    s := private.copy_start_member_session(q.user_id);
    if s.state = 'ACTIVE' then
      update private.copy_start_queue set state = 'ACTIVE', reason = null, resume_version = s.version,
        resolved_at = clock_timestamp(), updated_at = clock_timestamp() where id = q.id;
      resolved := resolved + 1;
      continue;
    end if;
    -- Still being validated/activated (30 s grace after expiry for the worker's blocker report).
    if s.state in ('REQUESTED', 'VALIDATED') and s.expires_at + interval '30 seconds' > clock_timestamp() then
      continue;
    end if;
    ready := private.copy_start_readiness(q.user_id);
    expired := s.state in ('REQUESTED', 'VALIDATED', 'BLOCKED');
    why := coalesce(s.blocker_reason, case when s.state is null then 'RESUME_SESSION_MISSING'
      when s.state in ('REQUESTED', 'VALIDATED') then 'RESUME_REQUEST_EXPIRED' else 'RESUME_' || s.state end);
    if ready is not null and ready <> 'ALREADY_ACTIVE' then
      update private.copy_start_queue set state = 'SKIPPED', reason = ready,
        resolved_at = clock_timestamp(), updated_at = clock_timestamp() where id = q.id;
      skipped := skipped + 1;
    elsif q.attempts < 3 and ((expired and live is not null)
        or (why = 'RESUME_REQUEST_EXPIRED' and s.validated_at is not null)
        or private.is_master_pause_reason(why)) then
      -- Not the member's fault: the system was not LIVE, activation never ran, or the Master changed.
      if q.cancel_requested then
        update private.copy_start_queue set state = 'CANCELLED', reason = 'ADMIN_CANCELLED',
          resolved_at = clock_timestamp(), updated_at = clock_timestamp() where id = q.id;
        resolved := resolved + 1;
      else
        update private.copy_start_queue set state = 'QUEUED', requested_at = null,
          reason = case when private.is_master_pause_reason(why) then why
            when live is not null then 'WAITING_FOR_LIVE' else 'RETRY_AFTER_EXPIRY' end,
          updated_at = clock_timestamp() where id = q.id;
      end if;
    else
      update private.copy_start_queue set state = 'FAILED', reason = left(why, 80),
        resolved_at = clock_timestamp(), updated_at = clock_timestamp() where id = q.id;
      resolved := resolved + 1;
    end if;
  end loop;

  -- 3. One at a time: request the next member only when nothing is in progress and the system is LIVE.
  if p_request_next and live is null
    and not exists (select 1 from private.copy_start_queue where state = 'REQUESTED') then
    loop
      guard := guard + 1;
      exit when guard > 1000;
      select * into q from private.copy_start_queue where state = 'QUEUED' order by seq, id limit 1 for update;
      exit when not found;
      ready := private.copy_start_readiness(q.user_id);
      if ready = 'ALREADY_ACTIVE' then
        update private.copy_start_queue set state = 'ACTIVE', reason = 'STARTED_OUTSIDE_QUEUE',
          resolved_at = clock_timestamp(), updated_at = clock_timestamp() where id = q.id;
        resolved := resolved + 1;
        continue;
      elsif ready is not null then
        update private.copy_start_queue set state = 'SKIPPED', reason = ready,
          resolved_at = clock_timestamp(), updated_at = clock_timestamp() where id = q.id;
        skipped := skipped + 1;
        continue;
      end if;
      select a.id into account_id from private.trading_accounts a
        where a.user_id = q.user_id and a.account_role = 'MEMBER' and a.status = 'ACTIVE' order by a.id limit 1;
      select coalesce(jsonb_object_agg(a.id::text, rs.version), '{}'::jsonb) into before_versions
        from private.trading_accounts a left join private.copy_resume_sessions rs on rs.trading_account_id = a.id
        where a.user_id = q.user_id and a.account_role = 'MEMBER' and a.status = 'ACTIVE';
      transient := false;
      begin
        -- The administrator resume path (FUTURE_ONLY; preserves an in-progress request).
        perform private.request_member_copy_resume(q.user_id, false);
      exception
        when lock_not_available or deadlock_detected or serialization_failure then
          -- Transient: stay QUEUED (no attempt counted); the next run retries this member first.
          update private.copy_start_queue set reason = 'RETRY_TRANSIENT', last_error_code = sqlstate,
            last_error_at = clock_timestamp(), updated_at = clock_timestamp() where id = q.id;
          transient := true;
        when others then
          update private.copy_start_queue set state = 'FAILED', reason = left(sqlerrm, 80), last_error_code = sqlstate,
            last_error_at = clock_timestamp(), resolved_at = clock_timestamp(), updated_at = clock_timestamp() where id = q.id;
          resolved := resolved + 1;
          continue;
      end;
      exit when transient;
      -- A new generation is attributed to the administrator who queued it. Not a state change: no trigger.
      update private.copy_resume_sessions rs set requested_by = q.requested_by
        from private.trading_accounts a
        where a.id = rs.trading_account_id and a.user_id = q.user_id and a.account_role = 'MEMBER' and a.status = 'ACTIVE'
          and rs.state = 'REQUESTED' and rs.version::text is distinct from (before_versions->>a.id::text);
      s := private.copy_start_member_session(q.user_id);
      update private.copy_start_queue set state = 'REQUESTED', trading_account_id = account_id,
        resume_version = s.version, attempts = attempts + 1, reason = null,
        requested_at = clock_timestamp(), updated_at = clock_timestamp() where id = q.id;
      insert into public.admin_audit_logs(actor_id, action, target_user_id, next_value)
      values (q.requested_by, 'ADMIN_ORDERED_COPY_START_REQUESTED', q.user_id, jsonb_build_object('batch_id', q.batch_id,
        'seq', q.seq, 'attempt', q.attempts + 1, 'resume_version', s.version, 'resume_mode', 'FUTURE_ONLY'));
      requested := requested + 1;
      exit;
    end loop;
  end if;

  perform set_config('maetajak.copy_start_queue_busy', '', true);
  return jsonb_build_object('resolved', resolved, 'requested', requested, 'skipped', skipped,
    'live_reason', live, 'open', (select count(*) from private.copy_start_queue where state in ('QUEUED', 'REQUESTED')));
end;
$$;
revoke all on function private.advance_copy_start_queue(boolean, boolean) from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- Session trigger: cheap for members without an open queue item; RESOLVE ONLY (no request of the next member
-- inside the caller's transaction, which is typically the worker's activation); never fails the session update.
-- ---------------------------------------------------------------------------------------------
create or replace function private.copy_start_queue_on_session_state()
returns trigger
language plpgsql
set search_path to 'pg_catalog'
as $$
declare previous_timeout text; owner_id uuid; err_state text; err_message text;
begin
  if coalesce(current_setting('maetajak.copy_start_queue_busy', true), '') = 'on' then return null; end if;
  select a.user_id into owner_id from private.trading_accounts a where a.id = new.trading_account_id;
  if owner_id is null or not exists (select 1 from private.copy_start_queue
      where user_id = owner_id and state in ('QUEUED', 'REQUESTED')) then
    return null;
  end if;
  previous_timeout := current_setting('lock_timeout');
  begin
    perform set_config('lock_timeout', '200ms', true);
    perform private.advance_copy_start_queue(true, false);
    perform set_config('lock_timeout', previous_timeout, true);
  exception when others or query_canceled then
    -- The subtransaction (and its lock_timeout / busy settings) is rolled back; the per-minute job resolves later.
    get stacked diagnostics err_state = returned_sqlstate, err_message = message_text;
    raise warning 'copy_start_queue trigger swallowed %: %', err_state, err_message;
    begin
      perform set_config('lock_timeout', '200ms', true);
      insert into private.copy_start_queue_trigger_errors as e(singleton, last_error_code, last_error_message,
          last_error_at, trading_account_id, error_count)
        values (true, err_state, left(err_message, 200), clock_timestamp(), new.trading_account_id, 1)
        on conflict (singleton) do update set last_error_code = excluded.last_error_code,
          last_error_message = excluded.last_error_message, last_error_at = excluded.last_error_at,
          trading_account_id = excluded.trading_account_id, error_count = e.error_count + 1;
      perform set_config('lock_timeout', previous_timeout, true);
    exception when others or query_canceled then
      null;
    end;
  end;
  return null;
end;
$$;
revoke all on function private.copy_start_queue_on_session_state() from public, anon, authenticated;
drop trigger if exists copy_start_queue_on_session_state on private.copy_resume_sessions;
create trigger copy_start_queue_on_session_state after update of state on private.copy_resume_sessions
for each row when (old.state is distinct from new.state)
execute function private.copy_start_queue_on_session_state();

-- ---------------------------------------------------------------------------------------------
-- Status for the administrator page: live gate, latest batch with its items, READY members (signup order)
-- and the approved members that are not ready (with the reason).
-- ---------------------------------------------------------------------------------------------
create or replace function private.copy_start_queue_status()
returns jsonb
language plpgsql
stable
set search_path to 'pg_catalog'
as $$
declare live text := private.copy_start_live_state(); latest uuid; result jsonb;
begin
  select batch_id into latest from private.copy_start_queue order by created_at desc, id desc limit 1;
  with members as (
    select p.id, p.full_name, p.gate_uid, p.email, p.created_at, private.copy_start_readiness(p.id) as readiness,
      s.state as session_state, s.blocker_reason
    from public.profiles p
    left join lateral private.copy_start_member_session(p.id) s on true
    where p.role = 'MEMBER' and p.approval_status = 'APPROVED' and p.withdrawn_at is null
  )
  select jsonb_build_object(
    'live_ready', live is null,
    'live_reason', live,
    'trigger_error', (select jsonb_build_object('code', e.last_error_code, 'message', e.last_error_message,
        'at', e.last_error_at, 'count', e.error_count) from private.copy_start_queue_trigger_errors e where e.singleton),
    'running', exists (select 1 from private.copy_start_queue where state in ('QUEUED', 'REQUESTED')),
    'waiting_for_live', live is not null and exists (select 1 from private.copy_start_queue where state = 'QUEUED')
      and not exists (select 1 from private.copy_start_queue where state = 'REQUESTED'),
    'batch', case when latest is null then null else (select jsonb_build_object('batch_id', latest, 'created_at', min(q.created_at),
        'requested_by', (array_agg(q.requested_by))[1], 'total', count(*),
        'queued', count(*) filter (where q.state = 'QUEUED'), 'requested', count(*) filter (where q.state = 'REQUESTED'),
        'active', count(*) filter (where q.state = 'ACTIVE'), 'skipped', count(*) filter (where q.state = 'SKIPPED'),
        'failed', count(*) filter (where q.state = 'FAILED'), 'cancelled', count(*) filter (where q.state = 'CANCELLED'))
      from private.copy_start_queue q where q.batch_id = latest) end,
    'items', coalesce((select jsonb_agg(jsonb_build_object('id', q.id, 'seq', q.seq, 'user_id', q.user_id,
        'full_name', p.full_name, 'gate_uid', p.gate_uid, 'email', p.email, 'signup_at', q.signup_at,
        'state', q.state, 'reason', q.reason, 'attempts', q.attempts, 'requested_at', q.requested_at,
        'cancel_requested', q.cancel_requested, 'last_error_code', q.last_error_code, 'last_error_at', q.last_error_at,
        'resolved_at', q.resolved_at, 'session_state', s.state, 'session_blocker', s.blocker_reason,
        'session_expires_at', s.expires_at) order by q.seq)
      from private.copy_start_queue q
      left join public.profiles p on p.id = q.user_id
      left join lateral private.copy_start_member_session(q.user_id) s on true
      where latest is not null and q.batch_id = latest), '[]'::jsonb),
    'ready_members', coalesce((select jsonb_agg(jsonb_build_object('user_id', m.id, 'full_name', m.full_name,
        'gate_uid', m.gate_uid, 'email', m.email, 'signup_at', m.created_at, 'session_state', m.session_state,
        'session_blocker', m.blocker_reason) order by m.created_at, m.id)
      from members m where m.readiness is null), '[]'::jsonb),
    'not_ready_members', coalesce((select jsonb_agg(jsonb_build_object('user_id', m.id, 'full_name', m.full_name,
        'gate_uid', m.gate_uid, 'email', m.email, 'signup_at', m.created_at, 'reason', m.readiness) order by m.created_at, m.id)
      from members m where m.readiness is not null and m.readiness <> 'ALREADY_ACTIVE'), '[]'::jsonb))
  into result;
  return result;
end;
$$;
revoke all on function private.copy_start_queue_status() from public, anon, authenticated;

create or replace function public.get_admin_ordered_copy_start()
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog'
as $$
begin
  if not public.is_approved_admin() then raise exception 'ADMIN_REQUIRED'; end if;
  return private.copy_start_queue_status();
end;
$$;
revoke all on function public.get_admin_ordered_copy_start() from public, anon, service_role;
grant execute on function public.get_admin_ordered_copy_start() to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Enqueue: p_user_ids null = every READY member; otherwise the selected members (a selected member that is
-- not ready is recorded as SKIPPED with the reason). Order: signup time, then id.
-- ---------------------------------------------------------------------------------------------
create or replace function public.admin_enqueue_ordered_copy_start(p_user_ids uuid[] default null,
  p_confirmation text default null)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog'
as $$
declare batch uuid := gen_random_uuid(); queued integer; skipped integer; advance jsonb;
begin
  if not public.is_approved_admin() then raise exception 'ADMIN_REQUIRED'; end if;
  if p_confirmation is distinct from 'ADMIN_ORDERED_COPY_START' then raise exception 'CONFIRMATION_REQUIRED'; end if;
  if p_user_ids is not null and coalesce(cardinality(p_user_ids), 0) = 0 then raise exception 'NO_MEMBERS_SELECTED'; end if;
  perform pg_advisory_xact_lock(hashtextextended('maetajak:copy-execution', 0));
  if exists (select 1 from private.copy_start_queue where state in ('QUEUED', 'REQUESTED')) then
    raise exception 'ORDERED_COPY_START_RUNNING';
  end if;
  if not exists (select 1 from private.trading_accounts a join private.gate_api_credentials g on g.user_id = a.credential_user_id
      where a.account_role = 'MASTER' and a.status = 'ACTIVE' and g.status = 'VERIFIED') then
    raise exception 'MASTER_NOT_ACTIVE';
  end if;
  with candidates as (
    select p.id, p.created_at, private.copy_start_readiness(p.id) as readiness,
      (select a.id from private.trading_accounts a where a.user_id = p.id and a.account_role = 'MEMBER'
        and a.status = 'ACTIVE' order by a.id limit 1) as account_id
    from public.profiles p
    where p.role = 'MEMBER' and (case when p_user_ids is null
      then p.approval_status = 'APPROVED' and p.withdrawn_at is null else p.id = any(p_user_ids) end)
  ), chosen as (
    select * from candidates where readiness is null or p_user_ids is not null
  )
  insert into private.copy_start_queue(batch_id, user_id, trading_account_id, signup_at, seq, state, reason,
    requested_by, resolved_at)
  select batch, c.id, c.account_id, c.created_at, row_number() over (order by c.created_at, c.id),
    case when c.readiness is null then 'QUEUED' else 'SKIPPED' end, c.readiness, auth.uid(),
    case when c.readiness is not null then clock_timestamp() end
  from chosen c;
  select count(*) filter (where state = 'QUEUED'), count(*) filter (where state = 'SKIPPED')
    into queued, skipped from private.copy_start_queue where batch_id = batch;
  if queued = 0 then raise exception 'NO_READY_MEMBERS'; end if;
  insert into public.admin_audit_logs(actor_id, action, next_value)
  values (auth.uid(), 'ADMIN_ORDERED_COPY_START_ENQUEUED', jsonb_build_object('batch_id', batch, 'queued', queued,
    'skipped', skipped, 'resume_mode', 'FUTURE_ONLY',
    'user_ids', (select jsonb_agg(user_id order by seq) from private.copy_start_queue where batch_id = batch and state = 'QUEUED')));
  begin
    advance := private.advance_copy_start_queue(false, true);
  exception when others then
    advance := jsonb_build_object('error', left(sqlerrm, 80)); -- the per-minute job retries
  end;
  return private.copy_start_queue_status() || jsonb_build_object('batch_id', batch, 'queued', queued,
    'skipped', skipped, 'advance', advance);
end;
$$;
revoke all on function public.admin_enqueue_ordered_copy_start(uuid[], text) from public, anon, service_role;
grant execute on function public.admin_enqueue_ordered_copy_start(uuid[], text) to authenticated;

-- Cancel the pending (QUEUED) items. A REQUESTED item keeps its resume request and is followed to its result;
-- it is marked cancel_requested so that it ends CANCELLED instead of going back to QUEUED.
create or replace function public.admin_cancel_ordered_copy_start(p_confirmation text)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog'
as $$
declare cancelled integer; in_progress integer;
begin
  if not public.is_approved_admin() then raise exception 'ADMIN_REQUIRED'; end if;
  if p_confirmation is distinct from 'ADMIN_ORDERED_COPY_START_CANCEL' then raise exception 'CONFIRMATION_REQUIRED'; end if;
  perform pg_advisory_xact_lock(hashtextextended('maetajak:copy-execution', 0));
  update private.copy_start_queue set state = 'CANCELLED', reason = 'ADMIN_CANCELLED',
    resolved_at = clock_timestamp(), updated_at = clock_timestamp() where state = 'QUEUED';
  get diagnostics cancelled = row_count;
  -- A requested member is still followed: ACTIVE stays ACTIVE, a requeue becomes CANCELLED.
  update private.copy_start_queue set cancel_requested = true, updated_at = clock_timestamp() where state = 'REQUESTED';
  get diagnostics in_progress = row_count;
  insert into public.admin_audit_logs(actor_id, action, next_value)
  values (auth.uid(), 'ADMIN_ORDERED_COPY_START_CANCELLED', jsonb_build_object('cancelled', cancelled, 'in_progress', in_progress));
  return private.copy_start_queue_status() || jsonb_build_object('cancelled', cancelled, 'in_progress', in_progress);
end;
$$;
revoke all on function public.admin_cancel_ordered_copy_start(text) from public, anon, service_role;
grant execute on function public.admin_cancel_ordered_copy_start(text) to authenticated;

-- Every minute: resolves and requests the next member (the trigger only resolves); a no-op without open items. Re-running this migration replaces the
-- job. Skipped (notice) where pg_cron is not installed, e.g. a local test database.
do $cron$
begin
  if to_regclass('cron.job') is null then
    raise notice 'pg_cron is not installed: maetajak-ordered-copy-start was not scheduled';
    return;
  end if;
  perform cron.unschedule(j.jobid) from cron.job j where j.jobname = 'maetajak-ordered-copy-start';
  perform cron.schedule('maetajak-ordered-copy-start', '* * * * *',
    $job$set statement_timeout = '15s'; set lock_timeout = '5s'; select private.advance_copy_start_queue(false, true);$job$);
end $cron$;
