-- 2026-10-21 review fixes (R4) on top of 20261021032000 / 20261021033000.
--
-- R4: a MEMBER whose Gate account is in unified-account mode is held reduce-only by the worker (QA D6) in memory
-- only; the administrator saw "카피 중". The worker now reports the account policy it applies
-- (report_copy_account_policy -> private.copy_account_policies) and get_admin_operations_metrics shows copy_status
-- ACCOUNT_POLICY_BLOCKED ("통합계정 미지원") with the code. The worker also sends a safety alert
-- (MEMBER_ACCOUNT_POLICY_BLOCKED, at most every 6 hours per account). A table of its own rather than a column of
-- copy_current_verifications: every update of that table re-runs the ownership observation trigger.
--
-- Deploy order: after 20261021033000. A worker without this migration's RPC logs the failed report and keeps the
-- in-memory hold (behaviour of 20261021033000); an older worker never reports (no row, status as before).
-- Idempotent: CREATE TABLE IF NOT EXISTS, CREATE OR REPLACE. get_admin_operations_metrics is the 20261021032000
-- definition plus the marked policy lines.

set lock_timeout = '5s';

create table if not exists private.copy_account_policies (
  trading_account_id uuid primary key references private.trading_accounts(id) on delete cascade,
  policy_code text not null check (policy_code in ('UNIFIED_ACCOUNT_UNSUPPORTED')),
  policy_since timestamptz not null default clock_timestamp(),
  reported_at timestamptz not null default clock_timestamp()
);
alter table private.copy_account_policies enable row level security;
revoke all on private.copy_account_policies from public, anon, authenticated;
comment on table private.copy_account_policies is
  'Review R4: account policy the worker applies to a MEMBER (UNIFIED_ACCOUNT_UNSUPPORTED: reduce-only, exits follow the Master). No row = none.';

-- Worker: the account policy it currently applies to a MEMBER account (null clears it). policy_since keeps the
-- start of the current code. Returns true when stored.
create or replace function public.report_copy_account_policy(p_trading_account_id uuid, p_policy_code text)
returns boolean
language plpgsql
security definer
set search_path to 'pg_catalog'
as $$
begin
  perform private.require_copy_worker_role();
  if p_policy_code is not null and p_policy_code not in ('UNIFIED_ACCOUNT_UNSUPPORTED') then
    raise exception 'INVALID_ACCOUNT_POLICY_CODE';
  end if;
  if not exists (select 1 from private.trading_accounts a where a.id = p_trading_account_id and a.account_role = 'MEMBER') then
    return false;
  end if;
  if p_policy_code is null then
    delete from private.copy_account_policies where trading_account_id = p_trading_account_id;
  else
    insert into private.copy_account_policies(trading_account_id, policy_code)
    values (p_trading_account_id, p_policy_code)
    on conflict (trading_account_id) do update set reported_at = clock_timestamp(),
      policy_since = case when private.copy_account_policies.policy_code = excluded.policy_code
        then private.copy_account_policies.policy_since else clock_timestamp() end,
      policy_code = excluded.policy_code;
  end if;
  return true;
end;
$$;
revoke all on function public.report_copy_account_policy(uuid, text) from public, anon, authenticated;
grant execute on function public.report_copy_account_policy(uuid, text) to service_role;

-- ---------------------------------------------------------------------------------------------
-- Admin member copy status: ACCOUNT_POLICY_BLOCKED (20261021032000 section 2 + review R4).
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
      verification.error_since as read_error_since,
      policy.policy_code, policy.policy_since
    from private.trading_accounts account
    left join private.copy_resume_sessions session on session.trading_account_id = account.id
    left join private.copy_current_verifications verification on verification.trading_account_id = account.id
    left join private.copy_account_policies policy on policy.trading_account_id = account.id
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
      session.policy_code as account_policy_code, session.policy_since as account_policy_since,
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
        -- Review R4: the worker holds the member reduce-only for its account mode (Gate unified account).
        when session.policy_code is not null then 'ACCOUNT_POLICY_BLOCKED'
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
      'account_policy_code', account_policy_code,
      'account_policy_since', account_policy_since,
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

notify pgrst, 'reload schema';

reset lock_timeout;
