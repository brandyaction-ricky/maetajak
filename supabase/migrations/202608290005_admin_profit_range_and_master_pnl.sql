create or replace function public.get_admin_member_trading_analysis_range(
  p_user_id uuid, p_start_date date, p_end_date date
)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare result jsonb;
declare copy_started_on date;
declare first_data_on date;
declare range_start date;
declare range_end date;
begin
  if not public.is_approved_admin() then raise exception 'ADMIN_REQUIRED'; end if;
  if not exists (select 1 from public.profiles where id = p_user_id and role = 'MEMBER') then
    raise exception 'MEMBER_NOT_FOUND';
  end if;

  select copy_started_at::date into copy_started_on from public.profiles where id = p_user_id;
  select min(trading_date) into first_data_on from public.member_daily_performance where user_id = p_user_id;
  range_start := greatest(coalesce(copy_started_on, first_data_on, current_date), coalesce(p_start_date, copy_started_on, first_data_on, current_date));
  range_end := least(current_date, coalesce(p_end_date, current_date));
  if range_start > range_end then raise exception 'INVALID_DATE_RANGE'; end if;
  if range_end - range_start > 365 then raise exception 'DATE_RANGE_TOO_LARGE'; end if;

  with daily as (
    select performance.trading_date,
      performance.realised_pnl - performance.fees + performance.funding_pnl as net_pnl,
      performance.fees, performance.funding_pnl, performance.trade_count,
      performance.winning_trade_count, performance.losing_trade_count
    from public.member_daily_performance performance
    where performance.user_id = p_user_id and performance.trading_date between range_start and range_end
  ), totals as (
    select coalesce(sum(net_pnl) filter (where net_pnl > 0), 0) as gross_profit,
      coalesce(sum(net_pnl) filter (where net_pnl < 0), 0) as gross_loss,
      coalesce(sum(net_pnl), 0) as net_pnl, coalesce(sum(fees), 0) as fees,
      coalesce(sum(funding_pnl), 0) as funding_pnl, coalesce(sum(trade_count), 0) as trade_count,
      coalesce(sum(winning_trade_count), 0) as wins, coalesce(sum(losing_trade_count), 0) as losses
    from daily
  ), symbols as (
    select contract, sum(realised_pnl - fees + funding_pnl) as net_pnl, sum(trade_count) as trade_count
    from public.member_symbol_daily_performance
    where user_id = p_user_id and trading_date between range_start and range_end
    group by contract
  )
  select jsonb_build_object(
    'started_on', range_start, 'ended_on', range_end, 'copy_started_on', copy_started_on,
    'totals', (select jsonb_build_object(
      'gross_profit', gross_profit, 'gross_loss', gross_loss, 'net_pnl', net_pnl,
      'fees', fees, 'funding_pnl', funding_pnl, 'trade_count', trade_count,
      'wins', wins, 'losses', losses,
      'win_rate', case when wins + losses > 0 then wins * 100.0 / (wins + losses) end,
      'profit_factor', case when gross_loss < 0 then gross_profit / abs(gross_loss) end,
      'average_profit', case when wins > 0 then gross_profit / wins end,
      'average_loss', case when losses > 0 then gross_loss / losses end
    ) from totals),
    'days', coalesce((select jsonb_agg(jsonb_build_object('date', trading_date, 'net_pnl', net_pnl) order by trading_date) from daily), '[]'::jsonb),
    'symbols', coalesce((select jsonb_agg(jsonb_build_object('contract', contract, 'net_pnl', net_pnl, 'trade_count', trade_count) order by net_pnl desc) from symbols), '[]'::jsonb)
  ) into result;
  return result;
end;
$$;

revoke all on function public.get_admin_member_trading_analysis_range(uuid, date, date) from public, anon;
grant execute on function public.get_admin_member_trading_analysis_range(uuid, date, date) to authenticated;

create or replace function public.get_admin_live_trading_data()
returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare result jsonb;
begin
  if not public.is_approved_admin() then raise exception 'ADMIN_REQUIRED'; end if;
  select jsonb_build_object(
    'master_positions',coalesce((select jsonb_agg(jsonb_build_object(
      'contract',p.contract,'size',p.size,'mark_price',p.mark_price,'entry_price',p.entry_price,
      'leverage',p.leverage,'quanto_multiplier',p.quanto_multiplier,
      'unrealised_pnl',(p.mark_price-p.entry_price)*p.size*p.quanto_multiplier,'observed_at',p.observed_at
    ) order by p.contract)
      from private.copy_position_snapshots p join private.trading_accounts a on a.id=p.trading_account_id
      where a.account_role='MASTER' and p.account_snapshot_id=(select s.id from private.copy_account_snapshots s where s.trading_account_id=a.id order by s.observed_at desc limit 1)),'[]'::jsonb),
    'member_states',coalesce((select jsonb_agg(jsonb_build_object(
      'name',p.full_name,'email',p.email,'contract',s.contract,'state',s.state,
      'target_size',s.target_size,'actual_size',s.actual_size,
      'actual_notional',abs(s.actual_size * latest.mark_price * latest.quanto_multiplier),
      'delta_size',s.delta_size,'pause_reason',s.pause_reason,'observed_at',s.last_observed_at
    ) order by s.updated_at desc)
      from public.copy_position_states s join public.profiles p on p.id=s.user_id
      left join lateral (select ps.mark_price,ps.quanto_multiplier from private.copy_position_snapshots ps
        where ps.trading_account_id=s.trading_account_id and ps.contract=s.contract order by ps.observed_at desc limit 1) latest on true),'[]'::jsonb),
    'orders',coalesce((select jsonb_agg(jsonb_build_object('name',p.full_name,'email',p.email,'contract',i.contract,'delta_size',i.delta_size,'filled_size',i.filled_size,'status',i.status,'gate_order_id',i.gate_order_id,'error_code',i.last_error_code,'created_at',i.created_at,'updated_at',i.updated_at) order by i.created_at desc) from (select * from private.copy_order_intents order by created_at desc limit 100) i join public.profiles p on p.id=i.user_id),'[]'::jsonb)
  ) into result;
  return result;
end;
$$;

revoke all on function public.get_admin_live_trading_data() from public, anon;
grant execute on function public.get_admin_live_trading_data() to authenticated;
