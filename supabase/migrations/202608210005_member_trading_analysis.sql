alter table public.profiles
  add column if not exists copy_started_at timestamptz;

create table if not exists public.member_symbol_daily_performance (
  user_id uuid not null references auth.users(id) on delete cascade,
  trading_date date not null,
  contract text not null,
  realised_pnl numeric not null default 0,
  fees numeric not null default 0 check (fees >= 0),
  funding_pnl numeric not null default 0,
  trade_count integer not null default 0 check (trade_count >= 0),
  winning_trade_count integer not null default 0 check (winning_trade_count >= 0),
  losing_trade_count integer not null default 0 check (losing_trade_count >= 0),
  source_snapshot_at timestamptz not null,
  source_hash text not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, trading_date, contract),
  check (winning_trade_count + losing_trade_count <= trade_count)
);

alter table public.member_symbol_daily_performance enable row level security;
drop policy if exists "members read own symbol performance" on public.member_symbol_daily_performance;
create policy "members read own symbol performance" on public.member_symbol_daily_performance
  for select to authenticated
  using (user_id = auth.uid() or public.is_approved_admin());
revoke insert, update, delete on public.member_symbol_daily_performance from public, anon, authenticated;
grant select on public.member_symbol_daily_performance to authenticated;

create or replace function public.set_member_copy_started_at(p_user_id uuid, p_started_at timestamptz)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if coalesce(current_setting('request.jwt.claim.role', true), '') <> 'service_role' then
    raise exception 'SERVICE_ROLE_REQUIRED';
  end if;
  update public.profiles set copy_started_at = coalesce(copy_started_at, p_started_at)
  where id = p_user_id and role = 'MEMBER' and approval_status = 'APPROVED';
end;
$$;

create or replace function public.upsert_member_symbol_daily_performance(
  p_user_id uuid, p_trading_date date, p_contract text, p_realised_pnl numeric,
  p_fees numeric, p_funding_pnl numeric, p_trade_count integer,
  p_winning_trade_count integer, p_losing_trade_count integer,
  p_source_snapshot_at timestamptz, p_source_hash text
)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if coalesce(current_setting('request.jwt.claim.role', true), '') <> 'service_role' then
    raise exception 'SERVICE_ROLE_REQUIRED';
  end if;
  insert into public.member_symbol_daily_performance (
    user_id, trading_date, contract, realised_pnl, fees, funding_pnl, trade_count,
    winning_trade_count, losing_trade_count, source_snapshot_at, source_hash, updated_at
  ) values (
    p_user_id, p_trading_date, upper(trim(p_contract)), coalesce(p_realised_pnl, 0),
    greatest(coalesce(p_fees, 0), 0), coalesce(p_funding_pnl, 0), greatest(coalesce(p_trade_count, 0), 0),
    greatest(coalesce(p_winning_trade_count, 0), 0), greatest(coalesce(p_losing_trade_count, 0), 0),
    p_source_snapshot_at, left(p_source_hash, 128), now()
  ) on conflict (user_id, trading_date, contract) do update set
    realised_pnl = excluded.realised_pnl, fees = excluded.fees, funding_pnl = excluded.funding_pnl,
    trade_count = excluded.trade_count, winning_trade_count = excluded.winning_trade_count,
    losing_trade_count = excluded.losing_trade_count, source_snapshot_at = excluded.source_snapshot_at,
    source_hash = excluded.source_hash, updated_at = now()
  where public.member_symbol_daily_performance.source_snapshot_at <= excluded.source_snapshot_at;
end;
$$;

create or replace function public.get_my_trading_analysis()
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare result jsonb;
declare started_on date;
begin
  if not exists (select 1 from public.profiles where id = auth.uid() and role = 'MEMBER' and approval_status = 'APPROVED') then
    raise exception 'APPROVED_MEMBER_REQUIRED';
  end if;
  select coalesce(profile.copy_started_at::date, min(performance.trading_date))
    into started_on
  from public.profiles as profile
  left join public.member_daily_performance as performance on performance.user_id = profile.id
  where profile.id = auth.uid()
  group by profile.copy_started_at;

  with daily as (
    select performance.trading_date,
      performance.realised_pnl - performance.fees + performance.funding_pnl as net_pnl,
      performance.realised_pnl, performance.fees, performance.funding_pnl,
      performance.trade_count, performance.winning_trade_count, performance.losing_trade_count
    from public.member_daily_performance as performance
    where performance.user_id = auth.uid()
      and (started_on is null or performance.trading_date >= started_on)
  ), totals as (
    select coalesce(sum(net_pnl) filter (where net_pnl > 0), 0) as gross_profit,
      coalesce(sum(net_pnl) filter (where net_pnl < 0), 0) as gross_loss,
      coalesce(sum(net_pnl), 0) as net_pnl, coalesce(sum(fees), 0) as fees,
      coalesce(sum(funding_pnl), 0) as funding_pnl, coalesce(sum(trade_count), 0) as trade_count,
      coalesce(sum(winning_trade_count), 0) as wins, coalesce(sum(losing_trade_count), 0) as losses
    from daily
  ), symbols as (
    select symbol.contract,
      sum(symbol.realised_pnl - symbol.fees + symbol.funding_pnl) as net_pnl,
      sum(symbol.trade_count) as trade_count
    from public.member_symbol_daily_performance as symbol
    where symbol.user_id = auth.uid() and (started_on is null or symbol.trading_date >= started_on)
    group by symbol.contract
  )
  select jsonb_build_object(
    'started_on', started_on, 'ended_on', current_date,
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

create or replace function public.get_admin_member_trading_analysis(p_user_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare result jsonb;
declare started_on date;
begin
  if not public.is_approved_admin() then raise exception 'ADMIN_REQUIRED'; end if;
  if not exists (select 1 from public.profiles where id = p_user_id) then raise exception 'MEMBER_NOT_FOUND'; end if;
  select coalesce(profile.copy_started_at::date, min(performance.trading_date))
    into started_on
  from public.profiles as profile
  left join public.member_daily_performance as performance on performance.user_id = profile.id
  where profile.id = p_user_id
  group by profile.copy_started_at;
  with daily as (
    select performance.trading_date,
      performance.realised_pnl - performance.fees + performance.funding_pnl as net_pnl,
      performance.fees, performance.funding_pnl, performance.trade_count,
      performance.winning_trade_count, performance.losing_trade_count
    from public.member_daily_performance as performance
    where performance.user_id = p_user_id and (started_on is null or performance.trading_date >= started_on)
  ), totals as (
    select coalesce(sum(net_pnl) filter (where net_pnl > 0), 0) as gross_profit,
      coalesce(sum(net_pnl) filter (where net_pnl < 0), 0) as gross_loss,
      coalesce(sum(net_pnl), 0) as net_pnl, coalesce(sum(fees), 0) as fees,
      coalesce(sum(funding_pnl), 0) as funding_pnl, coalesce(sum(trade_count), 0) as trade_count,
      coalesce(sum(winning_trade_count), 0) as wins, coalesce(sum(losing_trade_count), 0) as losses
    from daily
  ), symbols as (
    select symbol.contract, sum(symbol.realised_pnl - symbol.fees + symbol.funding_pnl) as net_pnl,
      sum(symbol.trade_count) as trade_count
    from public.member_symbol_daily_performance as symbol
    where symbol.user_id = p_user_id and (started_on is null or symbol.trading_date >= started_on)
    group by symbol.contract
  )
  select jsonb_build_object(
    'started_on', started_on, 'ended_on', current_date,
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

revoke all on function public.set_member_copy_started_at(uuid, timestamptz) from public;
revoke all on function public.upsert_member_symbol_daily_performance(uuid, date, text, numeric, numeric, numeric, integer, integer, integer, timestamptz, text) from public;
revoke all on function public.get_my_trading_analysis() from public;
revoke all on function public.get_admin_member_trading_analysis(uuid) from public;
grant execute on function public.set_member_copy_started_at(uuid, timestamptz) to service_role;
grant execute on function public.upsert_member_symbol_daily_performance(uuid, date, text, numeric, numeric, numeric, integer, integer, integer, timestamptz, text) to service_role;
grant execute on function public.get_my_trading_analysis() to authenticated;
grant execute on function public.get_admin_member_trading_analysis(uuid) to authenticated;
