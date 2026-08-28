create or replace function public.get_my_dashboard_performance_range(p_start_date date, p_end_date date)
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare result jsonb;
declare started_on date;
declare range_start date;
declare range_end date;
begin
  if not exists (select 1 from public.profiles where id = auth.uid() and role = 'MEMBER' and approval_status = 'APPROVED') then
    raise exception 'APPROVED_MEMBER_REQUIRED';
  end if;
  select coalesce(copy_started_at::date, current_date) into started_on from public.profiles where id = auth.uid();
  range_start := greatest(started_on, coalesce(p_start_date, started_on));
  range_end := least(current_date, coalesce(p_end_date, current_date));
  if range_start > range_end then raise exception 'INVALID_DATE_RANGE'; end if;
  if range_end - range_start > 365 then raise exception 'DATE_RANGE_TOO_LARGE'; end if;

  with daily as (
    select trading_date, opening_equity, closing_equity,
      realised_pnl - fees + funding_pnl as net_pnl,
      daily_return_pct, trade_count, winning_trade_count as wins,
      losing_trade_count as losses, source_snapshot_at,
      max(closing_equity) over (order by trading_date rows between unbounded preceding and current row) as equity_peak
    from public.member_daily_performance
    where user_id = auth.uid() and trading_date between range_start and range_end
  ), totals as (
    select coalesce(sum(net_pnl), 0) as net_pnl, coalesce(sum(trade_count), 0) as trades,
      coalesce(sum(wins), 0) as wins, coalesce(sum(losses), 0) as losses,
      case when count(daily_return_pct) = 0 then null
        when bool_or(daily_return_pct <= -100) then -100
        else (exp(sum(ln(1 + daily_return_pct / 100))) - 1) * 100 end as roi,
      coalesce(max(case when equity_peak > 0 then (equity_peak - closing_equity) * 100 / equity_peak else 0 end), 0) as mdd,
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

create or replace function public.get_admin_live_trading_data()
returns jsonb language plpgsql stable security definer set search_path=public,pg_temp
as $$
declare result jsonb;
begin
  if not public.is_approved_admin() then raise exception 'ADMIN_REQUIRED'; end if;
  select jsonb_build_object(
    'master_positions',coalesce((select jsonb_agg(jsonb_build_object('contract',p.contract,'size',p.size,'mark_price',p.mark_price,'entry_price',p.entry_price,'leverage',p.leverage,'observed_at',p.observed_at) order by p.contract)
      from private.copy_position_snapshots p join private.trading_accounts a on a.id=p.trading_account_id
      where a.account_role='MASTER' and p.account_snapshot_id=(select s.id from private.copy_account_snapshots s where s.trading_account_id=a.id order by s.observed_at desc limit 1)),'[]'::jsonb),
    'member_states',coalesce((select jsonb_agg(jsonb_build_object(
      'name',p.full_name,'email',p.email,'contract',s.contract,'state',s.state,
      'target_size',s.target_size,'actual_size',s.actual_size,
      'actual_notional',abs(s.actual_size * latest.mark_price * latest.quanto_multiplier),
      'delta_size',s.delta_size,'pause_reason',s.pause_reason,'observed_at',s.last_observed_at
    ) order by s.updated_at desc)
      from public.copy_position_states s
      join public.profiles p on p.id=s.user_id
      left join lateral (select ps.mark_price,ps.quanto_multiplier from private.copy_position_snapshots ps
        where ps.trading_account_id=s.trading_account_id and ps.contract=s.contract
        order by ps.observed_at desc limit 1) latest on true),'[]'::jsonb),
    'orders',coalesce((select jsonb_agg(jsonb_build_object('name',p.full_name,'email',p.email,'contract',i.contract,'delta_size',i.delta_size,'filled_size',i.filled_size,'status',i.status,'gate_order_id',i.gate_order_id,'error_code',i.last_error_code,'created_at',i.created_at,'updated_at',i.updated_at) order by i.created_at desc) from (select * from private.copy_order_intents order by created_at desc limit 100) i join public.profiles p on p.id=i.user_id),'[]'::jsonb)
  ) into result;
  return result;
end;
$$;

revoke all on function public.get_admin_live_trading_data() from public, anon;
grant execute on function public.get_admin_live_trading_data() to authenticated;
