-- QA 2026-10-21 area C (infrastructure). Idempotent; no table is dropped and no data is deleted.
--
--  C-2  A worker outage (host down, network loss, Supabase outage) ended with the worker resuming LIVE on its own
--       and catching up to the current Master at current prices with no operator check. copy_worker_heartbeat
--       now halts the system (execution_enabled=false, emergency_halted=true, halt_reason WORKER_HEARTBEAT_GAP,
--       SYSTEM_HALTED event + audit row) when the worker's previous contact with the database (heartbeat or cycle
--       report) is older than 180 s while LIVE execution is enabled. An administrator re-enables LIVE. A deploy
--       restart (stop, 40 s wait, lease wait <= 30 s) stays well below the threshold. The response gains
--       newly_halted / gap_seconds / last_contact_at / gap_halt_seconds (the worker alerts on newly_halted).
--       Body = 20260914163259_preserve_confirmed_copy_ownership_on_resume.sql plus the marked C-2 lines.
--  C-3  Dead-man switch independent of the worker: pg_cron job 'maetajak-worker-deadman' (every minute) runs
--       private.worker_deadman_check(). When copy_worker_runtime.heartbeat_at is older than 90 s while the last
--       runtime mode was LIVE or DRY_RUN, it sends a Telegram CRITICAL (once on going stale, again every 30
--       minutes while stale) and one recovery message. Delivery: pg_net -> Telegram Bot API, with the bot token
--       and chat id from Vault (worker_deadman_bot_token / worker_deadman_chat_id when set, otherwise the
--       existing master_alert_bot_token / master_alert_chat_id = the operator DM of the master-alert bot).
--       Missing pg_net or secrets: no-op, recorded in private.worker_deadman_state.last_result and the log.
--       Kill switch: update private.worker_deadman_state set enabled=false where singleton;

set lock_timeout = '5s';

-- Drift guard: copy_worker_heartbeat must still be the repo body of 20260914163259 (or this migration's own body,
-- if re-applied). A database without the function (fresh test database) is not guarded.
do $guard$
declare current_md5 text;
begin
  if to_regprocedure('public.copy_worker_heartbeat(text,text,text,text,text,text,boolean)') is null then return; end if;
  select md5(prosrc) into current_md5 from pg_proc
    where oid = to_regprocedure('public.copy_worker_heartbeat(text,text,text,text,text,text,boolean)');
  if current_md5 not in ('82c3c266f1f197d8481dac08c0908345', '77c34b3b1d05b3cb3026af2390ea4f4a') then
    raise exception 'ABORT_FUNCTION_DRIFT public.copy_worker_heartbeat md5=%', current_md5;
  end if;
end $guard$;

-- C-2 ----------------------------------------------------------------------------------------------------------
create or replace function public.copy_worker_heartbeat(p_worker_id text,p_worker_version text,p_gate_base_url text,
  p_public_ip text default null,p_broker_channel_id text default null,p_mode text default 'OBSERVE',p_test_passed boolean default false)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare runtime private.copy_worker_runtime; expected_channel_id text;
  supplied_channel_id text:=nullif(trim(p_broker_channel_id),''); acquired_at timestamptz;
  -- C-2: longest tolerated time without any worker contact (heartbeat or cycle report) before LIVE is halted.
  gap_halt_seconds constant integer := 180;
  previous private.copy_worker_runtime; last_contact timestamptz; gap_seconds integer; newly_halted boolean:=false;
begin
  perform private.require_copy_worker_role();
  if nullif(trim(p_worker_id),'') is null or length(p_worker_id)>120 or p_worker_id<>trim(p_worker_id) then raise exception 'INVALID_WORKER_ID'; end if;
  if p_mode is null or p_mode not in ('OBSERVE','DRY_RUN','LIVE') then raise exception 'INVALID_WORKER_MODE'; end if;
  if p_test_passed and p_mode<>'DRY_RUN' then raise exception 'DRY_RUN_REQUIRED_FOR_READINESS'; end if;
  select broker_channel_id into expected_channel_id from public.copy_system_control where singleton;
  if supplied_channel_id is not null and supplied_channel_id !~ '^[a-z0-9]{1,19}$' then raise exception 'INVALID_BROKER_CHANNEL_ID'; end if;
  if supplied_channel_id is not null and supplied_channel_id is distinct from expected_channel_id then raise exception 'BROKER_CHANNEL_ID_MISMATCH'; end if;
  if p_mode in ('DRY_RUN','LIVE') and supplied_channel_id is null then raise exception 'BROKER_CHANNEL_ID_REQUIRED'; end if;
  if p_mode='LIVE' and (nullif(trim(p_public_ip),'') is null or p_gate_base_url is distinct from 'https://api.gateio.ws') then raise exception 'LIVE_WORKER_CONFIGURATION_REQUIRED'; end if;
  perform pg_advisory_xact_lock(hashtextextended('maetajak:worker-lease',0));
  acquired_at:=clock_timestamp();
  if exists(select 1 from private.copy_worker_runtime r where r.singleton and r.worker_id is distinct from p_worker_id
    and r.heartbeat_at>acquired_at-interval '30 seconds') then raise exception 'WORKER_LEASE_HELD'; end if;
  -- C-2: the previous contact is the later of the last heartbeat and the last cycle report (updated_at). A slow
  -- cycle that still reports is contact; only a real outage leaves both old. Never overwrites an existing halt.
  select * into previous from private.copy_worker_runtime r where r.singleton;
  if previous.heartbeat_at is not null then
    last_contact:=greatest(previous.heartbeat_at,previous.updated_at);
    gap_seconds:=floor(extract(epoch from acquired_at-last_contact))::integer;
    if gap_seconds>gap_halt_seconds then
      update public.copy_system_control set execution_enabled=false,emergency_halted=true,
        halt_reason='WORKER_HEARTBEAT_GAP',updated_at=acquired_at
        where singleton and execution_enabled and not emergency_halted;
      newly_halted:=found;
      if newly_halted then
        insert into public.copy_events(event_type,severity,safe_payload)
        values('SYSTEM_HALTED','CRITICAL',jsonb_build_object('reason','WORKER_HEARTBEAT_GAP','gap_seconds',gap_seconds,
          'gap_halt_seconds',gap_halt_seconds,'last_contact_at',last_contact,'previous_mode',previous.mode,'mode',p_mode,
          'same_worker',previous.worker_id is not distinct from p_worker_id));
        insert into public.admin_audit_logs(action,next_value)
        values('LIVE_COPY_HALTED',jsonb_build_object('reason','WORKER_HEARTBEAT_GAP','gap_seconds',gap_seconds,
          'execution_enabled',false));
      end if;
    end if;
  end if;
  insert into private.copy_worker_runtime(singleton,worker_id,worker_version,gate_base_url,public_ip,broker_channel_id,mode,
    heartbeat_at,last_test_passed_at,started_at,updated_at)
  values(true,p_worker_id,left(p_worker_version,80),left(p_gate_base_url,200),nullif(trim(p_public_ip),'')::inet,
    supplied_channel_id,p_mode,acquired_at,case when p_test_passed then acquired_at end,acquired_at,acquired_at)
  on conflict(singleton) do update set worker_id=excluded.worker_id,worker_version=excluded.worker_version,
    gate_base_url=excluded.gate_base_url,public_ip=excluded.public_ip,broker_channel_id=excluded.broker_channel_id,
    mode=excluded.mode,heartbeat_at=excluded.heartbeat_at,
    last_test_passed_at=case when p_test_passed then acquired_at else private.copy_worker_runtime.last_test_passed_at end,
    started_at=case when private.copy_worker_runtime.worker_id is distinct from p_worker_id then acquired_at
      else coalesce(private.copy_worker_runtime.started_at,acquired_at) end,updated_at=acquired_at returning * into runtime;
  return jsonb_build_object('mode',runtime.mode,'broker_channel_id',runtime.broker_channel_id,
    'heartbeat_at',runtime.heartbeat_at,'test_passed_at',runtime.last_test_passed_at,
    'newly_halted',newly_halted,'gap_seconds',gap_seconds,'last_contact_at',last_contact,'gap_halt_seconds',gap_halt_seconds);
end;
$$;
revoke all on function public.copy_worker_heartbeat(text,text,text,text,text,text,boolean) from public,anon,authenticated;
grant execute on function public.copy_worker_heartbeat(text,text,text,text,text,text,boolean) to service_role;

-- C-3 ----------------------------------------------------------------------------------------------------------
create table if not exists private.worker_deadman_state (
  singleton boolean primary key default true check (singleton),
  enabled boolean not null default true,
  stale_since timestamptz,
  last_alert_at timestamptz,
  alert_count integer not null default 0,
  last_checked_at timestamptz,
  last_result text,
  updated_at timestamptz not null default now()
);
insert into private.worker_deadman_state(singleton) values (true) on conflict (singleton) do nothing;
alter table private.worker_deadman_state enable row level security;
revoke all on private.worker_deadman_state from public, anon, authenticated;

-- Queues one Telegram message through pg_net. Returns 'QUEUED:<request id>' or why nothing was sent; never raises.
create or replace function private.worker_deadman_send(p_text text)
returns text language plpgsql security definer set search_path=pg_catalog as $$
declare bot_token text; chat_id text; request_id bigint;
begin
  if to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') is null then return 'PG_NET_MISSING'; end if;
  select coalesce(
      (select nullif(trim(s.decrypted_secret),'') from vault.decrypted_secrets s where s.name='worker_deadman_bot_token' limit 1),
      (select nullif(trim(s.decrypted_secret),'') from vault.decrypted_secrets s where s.name='master_alert_bot_token' limit 1)),
    coalesce(
      (select nullif(trim(s.decrypted_secret),'') from vault.decrypted_secrets s where s.name='worker_deadman_chat_id' limit 1),
      (select nullif(trim(s.decrypted_secret),'') from vault.decrypted_secrets s where s.name='master_alert_chat_id' limit 1))
    into bot_token, chat_id;
  if bot_token is null or chat_id is null then return 'SECRETS_MISSING'; end if;
  if bot_token !~ '^[0-9]+:[A-Za-z0-9_-]{20,}$' or chat_id !~ '^(-?[0-9]+|@[A-Za-z0-9_]{5,})$' then return 'SECRETS_INVALID'; end if;
  select net.http_post(url := 'https://api.telegram.org/bot' || bot_token || '/sendMessage',
    body := jsonb_build_object('chat_id', chat_id, 'text', left(p_text, 4000), 'disable_web_page_preview', true),
    headers := '{"Content-Type":"application/json"}'::jsonb, timeout_milliseconds := 5000) into request_id;
  return 'QUEUED:' || coalesce(request_id::text, '?');
exception when others then
  return 'SEND_FAILED:' || sqlstate;
end;
$$;
revoke all on function private.worker_deadman_send(text) from public, anon, authenticated;

create or replace function private.worker_deadman_check()
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare
  -- C-3: heartbeat age that counts as "worker not running", and the repeat interval while it stays stale.
  stale_after_seconds constant integer := 90;
  repeat_every constant interval := interval '30 minutes';
  state private.worker_deadman_state; runtime private.copy_worker_runtime; control public.copy_system_control;
  now_at timestamptz := clock_timestamp(); expected boolean; stale boolean; age_seconds integer; result text;
  live_enabled boolean; kst text;
begin
  if not pg_try_advisory_xact_lock(hashtextextended('maetajak:worker-deadman',0)) then
    return jsonb_build_object('skipped','locked');
  end if;
  insert into private.worker_deadman_state(singleton) values (true) on conflict (singleton) do nothing;
  select * into state from private.worker_deadman_state where singleton for update;
  if not state.enabled then
    update private.worker_deadman_state set last_checked_at=now_at,last_result='DISABLED',updated_at=now_at where singleton;
    return jsonb_build_object('skipped','disabled');
  end if;
  select * into runtime from private.copy_worker_runtime where singleton;
  select * into control from public.copy_system_control where singleton;
  -- Expected to run: the last worker that reported was a DRY_RUN or LIVE worker (an OBSERVE-only or never-started
  -- worker is not watched).
  expected := coalesce(runtime.mode in ('LIVE','DRY_RUN') and runtime.heartbeat_at is not null, false);
  age_seconds := case when runtime.heartbeat_at is not null then floor(extract(epoch from now_at-runtime.heartbeat_at))::integer end;
  stale := expected and age_seconds > stale_after_seconds;
  live_enabled := coalesce(control.execution_enabled and not control.emergency_halted, false);
  kst := to_char(runtime.heartbeat_at at time zone 'Asia/Seoul', 'MM-DD HH24:MI:SS') || ' KST';
  if stale then
    if state.stale_since is null then state.stale_since := runtime.heartbeat_at; end if;
    if state.last_alert_at is null or state.last_alert_at <= now_at - repeat_every then
      result := private.worker_deadman_send(concat_ws(chr(10),
        '🚨 매타작 · 카피 워커 응답 없음 (DB 감시)', '',
        '상태: ' || case when state.last_alert_at is null then '워커 중지 감지' else '워커 중지 지속' end,
        '마지막 응답: ' || kst || ' (' || age_seconds || '초 전)',
        '실행 모드: ' || runtime.mode || case when live_enabled then ' · 실거래 활성' else ' · 실거래 중단 상태' end,
        '내용: 카피 워커가 90초 넘게 DB에 응답하지 않습니다. 이 동안 마스터 변화를 따라가지 못하고 신규 주문도 나가지 않습니다.',
        '대응: Lightsail 서버와 워커 서비스(maetajak-worker), 네트워크, Supabase 상태를 확인해 주세요. '
          || '워커가 3분 넘게 멈췄다가 돌아오면 전체 카피가 자동 중단(WORKER_HEARTBEAT_GAP)되며 관리자가 직접 재개해야 합니다. '
          || '멈춘 동안 30분마다 다시 알립니다.'));
      if result like 'QUEUED:%' then
        state.last_alert_at := now_at; state.alert_count := state.alert_count + 1;
      end if;
    else
      result := 'STALE_ALERTED';
    end if;
  elsif state.stale_since is not null then
    if state.last_alert_at is not null then
      result := private.worker_deadman_send(concat_ws(chr(10),
        '✅ 매타작 · 카피 워커 응답 복구 (DB 감시)', '',
        '상태: 워커 응답 재개 (' || runtime.mode || ')',
        '중단 시간: 약 ' || greatest(1, round(extract(epoch from runtime.heartbeat_at-state.stale_since)/60))::integer || '분',
        '현재 실거래: ' || case when live_enabled then '활성' else '중단 (halt_reason ' || coalesce(control.halt_reason,'-') || ')' end,
        '대응: 3분 넘게 멈췄다면 전체 카피가 자동 중단되었습니다. 서버·회원 포지션을 확인한 뒤 관리자 화면에서 실거래를 다시 켜 주세요.'));
    else
      result := 'RECOVERED_NOT_ALERTED';
    end if;
    state.stale_since := null; state.last_alert_at := null; state.alert_count := 0;
  else
    result := case when expected then 'OK' else 'NOT_EXPECTED' end;
  end if;
  update private.worker_deadman_state set stale_since=state.stale_since,last_alert_at=state.last_alert_at,
    alert_count=state.alert_count,last_checked_at=now_at,last_result=left(result,120),updated_at=now_at where singleton;
  if result !~ '^(OK|NOT_EXPECTED|STALE_ALERTED|RECOVERED_NOT_ALERTED|QUEUED:)' then
    raise log 'maetajak worker dead-man: %', result;
  end if;
  return jsonb_build_object('expected',expected,'stale',stale,'heartbeat_age_seconds',age_seconds,'result',result,
    'stale_since',state.stale_since,'alert_count',state.alert_count);
end;
$$;
revoke all on function private.worker_deadman_check() from public, anon, authenticated;

-- Every minute; re-running this migration replaces the job instead of adding a second one. Skipped (notice) where
-- pg_cron is not installed, e.g. a local test database.
do $cron$
begin
  if to_regclass('cron.job') is null then
    raise notice 'pg_cron is not installed: maetajak-worker-deadman was not scheduled';
    return;
  end if;
  perform cron.unschedule(j.jobid) from cron.job j where j.jobname = 'maetajak-worker-deadman';
  perform cron.schedule('maetajak-worker-deadman', '* * * * *',
    $job$set statement_timeout = '10s'; select private.worker_deadman_check();$job$);
end $cron$;
