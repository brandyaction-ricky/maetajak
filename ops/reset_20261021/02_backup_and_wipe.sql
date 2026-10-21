-- STEP 2 / 2  (2026-10-21 회원·기록 전체 초기화, 백업 후 삭제)
-- 01_halt.sql 실행 후 1분 뒤 Supabase SQL Editor에서 이 파일 전체를 한 번에 실행한다.
-- 하나의 트랜잭션이다. 중간에 오류가 나면 아무것도 바뀌지 않는다.
--
-- 남기는 것 : 관리자 계정(auth + profile + 관리자 약관동의), copy_system_control(정지 상태),
--             copy_worker_runtime, master_alert.config(기준선 재설정), vault, cron.
-- 마스터 UID가 저장된 곳은 아래 3곳뿐이며 모두 비운다 (2026-10-21 운영 확인):
--   gate_api_credentials(MASTER 행), trading_accounts.bound_gate_uid, trading_account_rebind_archive.
--   → 새 마스터 UID 등록 시 GATE_UID_ALREADY_REGISTERED / 계좌 교체 가드에 걸리지 않음.
-- 지우는 것 : MEMBER 회원 6명(auth.users → profiles·세션 cascade), 마스터/회원 API 연결,
--             거래계좌, 카피 사이클·주문·체결·스냅샷·포지션, 성과, 이벤트, 감사로그,
--             브로커 지표(워커가 upsert로 다시 채움), 마스터 알림 상태.
-- 백업      : schema reset_backup_20261021 (API 키 암호문·비밀번호 해시는 백업하지 않음).
--             API 접근 권한 없음(public/anon/authenticated 회수).

begin;
set local lock_timeout = '15s';
set local statement_timeout = '10min';

-- 0) 안전 확인 -------------------------------------------------------------------------
do $guard$
begin
  if (select count(*) from public.profiles where role = 'ADMIN') <> 1 then
    raise exception 'ABORT: ADMIN 프로필이 정확히 1개가 아님';
  end if;
  if not exists (select 1 from public.copy_system_control
                 where singleton and emergency_halted and not execution_enabled) then
    raise exception 'ABORT: 01_halt.sql 을 먼저 실행해야 함 (비상정지 상태 아님)';
  end if;
  if to_regnamespace('reset_backup_20261021') is not null then
    raise exception 'ABORT: reset_backup_20261021 스키마가 이미 있음 (이미 실행됨?)';
  end if;
end;
$guard$;

-- 실행 중인 카피 RPC와 겹치지 않게 같은 락을 잡는다.
select pg_advisory_xact_lock(hashtextextended('maetajak:copy-execution', 0));

-- 1) 백업 -----------------------------------------------------------------------------
create schema reset_backup_20261021;
revoke all on schema reset_backup_20261021 from public, anon, authenticated;

do $backup$
declare
  t text;
  tables text[] := array[
    'private.copy_account_snapshots', 'private.copy_current_accounts',
    'private.copy_current_positions', 'private.copy_current_verifications',
    'private.copy_cycles', 'private.copy_entry_alert_outbox',
    'private.copy_fund_flow_tracking', 'private.copy_fund_flows',
    'private.copy_operation_history', 'private.copy_operation_risk',
    'private.copy_order_attempts', 'private.copy_order_intents',
    'private.copy_ownership_checkpoints', 'private.copy_ownership_fills',
    'private.copy_position_snapshots', 'private.copy_reconciliation_jobs',
    'private.copy_resume_sessions', 'private.copy_snapshot_checkpoints',
    'private.copy_target_anchors', 'private.gate_api_verification_jobs',
    'private.gate_broker_daily_metrics', 'private.gate_broker_sync_status',
    'private.member_copy_onboarding_baselines', 'private.open_order_cancel_jobs',
    'private.trading_account_rebind_archive', 'private.trading_accounts',
    'private.copy_worker_runtime',
    'public.admin_audit_logs', 'public.copy_events', 'public.copy_position_states',
    'public.copy_system_control', 'public.legal_acceptances',
    'public.member_daily_performance', 'public.member_symbol_daily_performance',
    'public.profiles',
    'master_alert.config', 'master_alert.entry_outbox', 'master_alert.position_state'
  ];
begin
  foreach t in array tables loop
    execute format('create table reset_backup_20261021.%I as table %s', replace(t, '.', '__'), t);
  end loop;
end;
$backup$;

-- API 키 암호문은 제외하고 연결 메타데이터만 백업.
create table reset_backup_20261021.private__gate_api_credentials as
  select user_id, gate_uid, api_key_last4, status, futures_read, futures_trade, ip_whitelisted,
         withdrawal_disabled, last_error, verified_at, created_at, updated_at, connection_role,
         permissions_confirmed, gate_user_id, last_checked_at, last_error_code,
         verification_version, verified_worker_ip
    from private.gate_api_credentials;

-- auth.users: 식별 정보만 (비밀번호 해시·토큰 제외).
create table reset_backup_20261021.auth__users as
  select id, email, created_at, last_sign_in_at, email_confirmed_at, banned_until, raw_user_meta_data
    from auth.users;

revoke all on all tables in schema reset_backup_20261021 from public, anon, authenticated;

-- 2) 삭제 -----------------------------------------------------------------------------
truncate table
  private.copy_account_snapshots, private.copy_current_accounts,
  private.copy_current_positions, private.copy_current_verifications,
  private.copy_cycles, private.copy_entry_alert_outbox,
  private.copy_fund_flow_tracking, private.copy_fund_flows,
  private.copy_operation_history, private.copy_operation_risk,
  private.copy_order_attempts, private.copy_order_intents,
  private.copy_ownership_checkpoints, private.copy_ownership_fills,
  private.copy_position_snapshots, private.copy_reconciliation_jobs,
  private.copy_resume_sessions, private.copy_snapshot_checkpoints,
  private.copy_target_anchors, private.gate_api_credentials,
  private.gate_api_verification_jobs, private.gate_broker_daily_metrics,
  private.gate_broker_sync_status, private.member_copy_onboarding_baselines,
  private.open_order_cancel_jobs, private.trading_account_rebind_archive,
  private.trading_accounts,
  public.admin_audit_logs, public.copy_events, public.copy_position_states,
  public.member_daily_performance, public.member_symbol_daily_performance,
  master_alert.entry_outbox, master_alert.position_state
  restart identity;

-- 새 마스터가 처음 관측될 때 기준선을 다시 잡는다(기존 포지션을 신규 진입으로 알리지 않음).
update master_alert.config set baseline_seeded = false, updated_at = now() where id;

-- 회원 계정 삭제 (profiles, 남은 약관동의, 세션·토큰은 cascade).
delete from auth.users
 where id in (select id from public.profiles where role = 'MEMBER');

-- 3) 확인 -----------------------------------------------------------------------------
do $verify$
begin
  if (select count(*) from public.profiles) <> 1
     or (select count(*) from public.profiles where role = 'ADMIN') <> 1
     or (select count(*) from auth.users) <> 1 then
    raise exception 'ABORT: 삭제 후 계정 수가 예상과 다름 (관리자 1명만 남아야 함)';
  end if;
  if exists (select 1 from private.trading_accounts)
     or exists (select 1 from private.gate_api_credentials)
     or exists (select 1 from private.trading_account_rebind_archive)
     or exists (select 1 from public.copy_events) then
    raise exception 'ABORT: 삭제 후 데이터가 남아 있음';
  end if;
end;
$verify$;

commit;

-- 결과 표시 (커밋 후 읽기 전용)
select 'auth.users' as item, count(*)::text as value from auth.users
union all select 'profiles', count(*)::text from public.profiles
union all select 'trading_accounts', count(*)::text from private.trading_accounts
union all select 'gate_api_credentials', count(*)::text from private.gate_api_credentials
union all select 'master_bound_uid', count(*)::text from private.trading_accounts
          where account_role = 'MASTER' and bound_gate_uid is not null
union all select 'rebind_archive', count(*)::text from private.trading_account_rebind_archive
union all select 'copy_cycles', count(*)::text from private.copy_cycles
union all select 'copy_events', count(*)::text from public.copy_events
union all select 'backup_tables', count(*)::text from information_schema.tables
          where table_schema = 'reset_backup_20261021'
union all select 'backup_copy_events_rows', count(*)::text from reset_backup_20261021.public__copy_events
union all select 'backup_profiles_rows', count(*)::text from reset_backup_20261021.public__profiles;
-- 기대값: auth.users 1, profiles 1, trading_accounts 0, gate_api_credentials 0,
--         master_bound_uid 0, rebind_archive 0, copy_cycles 0,
--         copy_events 0, backup_tables 40, backup_copy_events_rows ≈ 28만, backup_profiles_rows 7
