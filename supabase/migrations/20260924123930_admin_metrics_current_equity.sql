-- Admin member table: show current equity (balance + unrealised PnL) next to the balance, and the
-- operator's own Master account figures. Owner request 2026-09-24.
-- Applied to production on 2026-09-24 as migration version 20260924123930 (admin_metrics_current_equity)
-- with a one-time guard that aborted unless the previous body had md5(prosrc) = 4afa3fc1a10de71c8aa9283ded74d87c.
--
-- Gate reports two different things as the account "total" (worker/gate.js getFuturesAccount):
--   * classic futures accounts: `total` = balance WITHOUT unrealised PnL
--   * unified accounts:         `unified_account_total_equity` = equity WITH unrealised PnL
-- copy_current_accounts.total_equity stores whichever applied, and the mode is not persisted.
-- The mode is inferred from the latest 30 account samples: unified equity moves together with the
-- unrealised PnL on nearly every sample, a classic balance only moves on realised events.
-- (Evidence 2026-09-24: Master 29/29 samples moved with PnL; every member 0/29.)
-- Flat accounts (no PnL movement) are treated as classic, which is exact because PnL is zero.
--
-- Additive only: every existing key keeps its value; new keys are balance_equity, current_equity,
-- unrealised_pnl, equity_includes_unrealised (members and master), totals.current_assets, master.
create or replace function public.get_admin_operations_metrics(p_start_date date default (current_date - 29), p_end_date date default current_date)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  range_start date := greatest(coalesce(p_start_date, current_date - 29), current_date - 364);
  range_end date := least(coalesce(p_end_date, current_date), current_date);
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
    where performance.trading_date = current_date
  ), member_rows as (
    select member.id, member.full_name, member.email, member.copy_ratio,
      member.max_position_ratio, member.copy_paused, member.member_halted, member.reduce_only,
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
      case
        when member.member_halted then 'HALTED'
        when member.copy_paused then 'PAUSED'
        when member.reduce_only then 'REDUCE_ONLY'
        when coalesce(member.api_status, 'NOT_CONNECTED') <> 'VERIFIED' then 'API_ERROR'
        when state.has_error then 'ERROR'
        when state.has_override then 'ATTENTION'
        else 'COPYING'
      end as copy_status
    from approved_members member
    left join latest_accounts account on account.user_id = member.id
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
        case when performance.trading_date = current_date then performance.unrealised_pnl else 0 end) as pnl,
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
      'copy_status', copy_status,
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
