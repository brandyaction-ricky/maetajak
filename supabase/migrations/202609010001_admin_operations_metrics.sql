create or replace function public.get_admin_operations_metrics(
  p_start_date date default current_date - 29,
  p_end_date date default current_date
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
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
    where profile.role = 'MEMBER' and profile.approval_status = 'APPROVED'
  ), latest_accounts as (
    select member.id as user_id, snapshot.total_equity, snapshot.available_equity,
      snapshot.unrealised_pnl, snapshot.observed_at
    from approved_members member
    left join private.trading_accounts account
      on account.user_id = member.id and account.account_role = 'MEMBER' and account.settle = 'usdt'
    left join lateral (
      select source.total_equity, source.available_equity, source.unrealised_pnl, source.observed_at
      from private.copy_account_snapshots source
      where source.trading_account_id = account.id
      order by source.observed_at desc limit 1
    ) snapshot on true
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
      'period_pnl', (select coalesce(sum(pnl), 0) from daily),
      'trading_volume', (select coalesce(sum(trading_volume), 0) from daily),
      'fees', (select coalesce(sum(fees), 0) from daily),
      'active_users', (select count(distinct performance.user_id)
        from public.member_daily_performance performance
        where performance.trading_date between range_start and range_end
          and performance.trading_volume > 0)
    ),
    'members', coalesce((select jsonb_agg(jsonb_build_object(
      'id', id, 'full_name', full_name, 'email', email, 'copy_status', copy_status,
      'copy_ratio', copy_ratio, 'max_position_ratio', max_position_ratio,
      'total_equity', total_equity, 'today_pnl', today_pnl,
      'margin_usage_pct', margin_usage_pct, 'api_status', coalesce(api_status, 'NOT_CONNECTED'),
      'last_observed_at', last_observed_at
    ) order by full_name, email) from member_rows), '[]'::jsonb),
    'daily', coalesce((select jsonb_agg(jsonb_build_object(
      'date', trading_date, 'pnl', pnl, 'trading_volume', trading_volume,
      'fees', fees, 'users', users
    ) order by trading_date) from daily), '[]'::jsonb)
  ) into result;

  return result;
end;
$$;

revoke all on function public.get_admin_operations_metrics(date, date) from public, anon;
grant execute on function public.get_admin_operations_metrics(date, date) to authenticated;
