-- Daily performance facts are written by the fixed-IP Trading Worker.
-- The browser can only read its own rows; administrators use the protected monthly RPC.
create table if not exists public.member_daily_performance (
  user_id uuid not null references auth.users(id) on delete cascade,
  trading_date date not null,
  opening_equity numeric not null check (opening_equity >= 0),
  closing_equity numeric not null check (closing_equity >= 0),
  deposits numeric not null default 0 check (deposits >= 0),
  withdrawals numeric not null default 0 check (withdrawals >= 0),
  realised_pnl numeric not null default 0,
  unrealised_pnl numeric not null default 0,
  fees numeric not null default 0 check (fees >= 0),
  funding_pnl numeric not null default 0,
  trading_volume numeric not null default 0 check (trading_volume >= 0),
  trade_count integer not null default 0 check (trade_count >= 0),
  winning_trade_count integer not null default 0 check (winning_trade_count >= 0),
  losing_trade_count integer not null default 0 check (losing_trade_count >= 0),
  daily_return_pct numeric check (daily_return_pct is null or daily_return_pct >= -100),
  source_snapshot_at timestamptz not null,
  source_hash text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, trading_date),
  check (winning_trade_count + losing_trade_count <= trade_count)
);
create index if not exists member_daily_performance_date_idx
  on public.member_daily_performance (trading_date desc, user_id);
alter table public.member_daily_performance enable row level security;

drop policy if exists "members read own daily performance" on public.member_daily_performance;
create policy "members read own daily performance" on public.member_daily_performance
  for select to authenticated
  using (user_id = auth.uid() or public.is_approved_admin());

revoke insert, update, delete on public.member_daily_performance from public, anon, authenticated;
grant select on public.member_daily_performance to authenticated;

create or replace function public.upsert_member_daily_performance(
  p_user_id uuid,
  p_trading_date date,
  p_opening_equity numeric,
  p_closing_equity numeric,
  p_deposits numeric,
  p_withdrawals numeric,
  p_realised_pnl numeric,
  p_unrealised_pnl numeric,
  p_fees numeric,
  p_funding_pnl numeric,
  p_trading_volume numeric,
  p_trade_count integer,
  p_winning_trade_count integer,
  p_losing_trade_count integer,
  p_daily_return_pct numeric,
  p_source_snapshot_at timestamptz,
  p_source_hash text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if coalesce(current_setting('request.jwt.claim.role', true), '') <> 'service_role' then
    raise exception 'SERVICE_ROLE_REQUIRED';
  end if;
  if not exists (
    select 1 from public.profiles
    where id = p_user_id and role = 'MEMBER' and approval_status = 'APPROVED'
  ) then raise exception 'APPROVED_MEMBER_REQUIRED'; end if;

  insert into public.member_daily_performance (
    user_id, trading_date, opening_equity, closing_equity, deposits, withdrawals,
    realised_pnl, unrealised_pnl, fees, funding_pnl, trading_volume,
    trade_count, winning_trade_count, losing_trade_count, daily_return_pct,
    source_snapshot_at, source_hash, updated_at
  ) values (
    p_user_id, p_trading_date, p_opening_equity, p_closing_equity,
    greatest(coalesce(p_deposits, 0), 0), greatest(coalesce(p_withdrawals, 0), 0),
    coalesce(p_realised_pnl, 0), coalesce(p_unrealised_pnl, 0),
    greatest(coalesce(p_fees, 0), 0), coalesce(p_funding_pnl, 0),
    greatest(coalesce(p_trading_volume, 0), 0), greatest(coalesce(p_trade_count, 0), 0),
    greatest(coalesce(p_winning_trade_count, 0), 0), greatest(coalesce(p_losing_trade_count, 0), 0),
    p_daily_return_pct, p_source_snapshot_at, left(p_source_hash, 128), now()
  )
  on conflict (user_id, trading_date) do update set
    opening_equity = excluded.opening_equity,
    closing_equity = excluded.closing_equity,
    deposits = excluded.deposits,
    withdrawals = excluded.withdrawals,
    realised_pnl = excluded.realised_pnl,
    unrealised_pnl = excluded.unrealised_pnl,
    fees = excluded.fees,
    funding_pnl = excluded.funding_pnl,
    trading_volume = excluded.trading_volume,
    trade_count = excluded.trade_count,
    winning_trade_count = excluded.winning_trade_count,
    losing_trade_count = excluded.losing_trade_count,
    daily_return_pct = excluded.daily_return_pct,
    source_snapshot_at = excluded.source_snapshot_at,
    source_hash = excluded.source_hash,
    updated_at = now()
  where public.member_daily_performance.source_snapshot_at <= excluded.source_snapshot_at;
end;
$$;

create or replace function public.get_admin_member_monthly_performance(
  p_user_id uuid,
  p_months integer default 12
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  member_profile public.profiles;
  monthly_rows jsonb;
begin
  if not public.is_approved_admin() then raise exception 'ADMIN_REQUIRED'; end if;
  select * into member_profile from public.profiles where id = p_user_id;
  if member_profile.id is null then raise exception 'MEMBER_NOT_FOUND'; end if;

  with monthly as (
    select
      date_trunc('month', performance.trading_date)::date as month,
      sum(performance.realised_pnl) as realised_pnl,
      sum(performance.fees) as fees,
      sum(performance.funding_pnl) as funding_pnl,
      sum(performance.trading_volume) as trading_volume,
      sum(performance.trade_count) as trade_count,
      sum(performance.winning_trade_count) as winning_trade_count,
      sum(performance.losing_trade_count) as losing_trade_count,
      (array_agg(performance.opening_equity order by performance.trading_date asc))[1] as opening_equity,
      (array_agg(performance.closing_equity order by performance.trading_date desc))[1] as closing_equity,
      case
        when count(performance.daily_return_pct) = 0 then null
        when bool_or(performance.daily_return_pct <= -100) then -100
        else (exp(sum(ln(1 + performance.daily_return_pct / 100))) - 1) * 100
      end as return_pct
    from public.member_daily_performance as performance
    where performance.user_id = p_user_id
      and performance.trading_date >= date_trunc('month', current_date) -
        make_interval(months => greatest(1, least(coalesce(p_months, 12), 36)) - 1)
    group by date_trunc('month', performance.trading_date)
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'month', monthly.month,
    'realised_pnl', monthly.realised_pnl,
    'net_pnl', monthly.realised_pnl - monthly.fees + monthly.funding_pnl,
    'return_pct', monthly.return_pct,
    'fees', monthly.fees,
    'funding_pnl', monthly.funding_pnl,
    'trading_volume', monthly.trading_volume,
    'trade_count', monthly.trade_count,
    'winning_trade_count', monthly.winning_trade_count,
    'losing_trade_count', monthly.losing_trade_count,
    'win_rate', case when monthly.winning_trade_count + monthly.losing_trade_count > 0
      then monthly.winning_trade_count * 100.0 /
        (monthly.winning_trade_count + monthly.losing_trade_count) else null end,
    'opening_equity', monthly.opening_equity,
    'closing_equity', monthly.closing_equity
  ) order by monthly.month desc), '[]'::jsonb) into monthly_rows from monthly;

  return jsonb_build_object(
    'member', jsonb_build_object(
      'id', member_profile.id,
      'full_name', member_profile.full_name,
      'email', member_profile.email,
      'role', member_profile.role,
      'approval_status', member_profile.approval_status,
      'copy_ratio', member_profile.copy_ratio,
      'max_position_ratio', member_profile.max_position_ratio,
      'created_at', member_profile.created_at
    ),
    'months', monthly_rows
  );
end;
$$;

revoke all on function public.upsert_member_daily_performance(
  uuid, date, numeric, numeric, numeric, numeric, numeric, numeric, numeric,
  numeric, numeric, integer, integer, integer, numeric, timestamptz, text
) from public;
revoke all on function public.get_admin_member_monthly_performance(uuid, integer) from public;
grant execute on function public.upsert_member_daily_performance(
  uuid, date, numeric, numeric, numeric, numeric, numeric, numeric, numeric,
  numeric, numeric, integer, integer, integer, numeric, timestamptz, text
) to service_role;
grant execute on function public.get_admin_member_monthly_performance(uuid, integer) to authenticated;
