create table if not exists private.member_copy_onboarding_baselines (
  trading_account_id uuid primary key references private.trading_accounts(id) on delete cascade,
  positions jsonb not null default '[]'::jsonb,
  initialized_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (jsonb_typeof(positions) = 'array')
);

-- Preserve current behavior for accounts that were already copying before this
-- migration. Only accounts connected afterwards receive a non-zero onboarding
-- baseline from their first observed Master snapshot.
insert into private.member_copy_onboarding_baselines(trading_account_id, positions)
select id, '[]'::jsonb
from private.trading_accounts
where account_role = 'MEMBER' and status = 'ACTIVE'
on conflict (trading_account_id) do nothing;

create or replace function public.get_or_initialize_member_copy_baseline(
  p_trading_account_id uuid,
  p_master_positions jsonb
)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare result jsonb;
begin
  if coalesce(current_setting('request.jwt.claim.role', true), '') <> 'service_role' then
    raise exception 'SERVICE_ROLE_REQUIRED';
  end if;
  if not exists (
    select 1 from private.trading_accounts
    where id = p_trading_account_id and account_role = 'MEMBER' and status = 'ACTIVE'
  ) then
    raise exception 'ACTIVE_MEMBER_ACCOUNT_REQUIRED';
  end if;

  insert into private.member_copy_onboarding_baselines(trading_account_id, positions)
  values (
    p_trading_account_id,
    coalesce((
      select jsonb_agg(jsonb_build_object('contract', item->>'contract', 'size', (item->>'size')::numeric)
        order by item->>'contract')
      from jsonb_array_elements(coalesce(p_master_positions, '[]'::jsonb)) item
      where nullif(item->>'contract', '') is not null and coalesce((item->>'size')::numeric, 0) <> 0
    ), '[]'::jsonb)
  )
  on conflict (trading_account_id) do nothing;

  select jsonb_build_object(
    'initialized_at', initialized_at,
    'positions', positions
  ) into result
  from private.member_copy_onboarding_baselines
  where trading_account_id = p_trading_account_id;
  return result;
end;
$$;
revoke all on function public.get_or_initialize_member_copy_baseline(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.get_or_initialize_member_copy_baseline(uuid, jsonb) to service_role;

create or replace function public.clear_member_copy_baselines(
  p_trading_account_id uuid,
  p_contracts text[]
)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp
as $$
declare result jsonb;
begin
  if coalesce(current_setting('request.jwt.claim.role', true), '') <> 'service_role' then
    raise exception 'SERVICE_ROLE_REQUIRED';
  end if;
  update private.member_copy_onboarding_baselines baseline
  set positions = coalesce((
    select jsonb_agg(item order by item->>'contract')
    from jsonb_array_elements(baseline.positions) item
    where not (item->>'contract' = any(coalesce(p_contracts, array[]::text[])))
  ), '[]'::jsonb), updated_at = now()
  where baseline.trading_account_id = p_trading_account_id
  returning positions into result;
  return coalesce(result, '[]'::jsonb);
end;
$$;
revoke all on function public.clear_member_copy_baselines(uuid, text[]) from public, anon, authenticated;
grant execute on function public.clear_member_copy_baselines(uuid, text[]) to service_role;

comment on table private.member_copy_onboarding_baselines is
  'Master positions present when a new member first connects. Only later exposure beyond these sizes is copied.';

create or replace function public.get_my_dashboard_performance(p_days integer default 30)
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare result jsonb;
declare started_on date;
declare range_start date;
begin
  if not exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'MEMBER' and approval_status = 'APPROVED'
  ) then raise exception 'APPROVED_MEMBER_REQUIRED'; end if;
  select coalesce(copy_started_at::date, current_date) into started_on
  from public.profiles where id = auth.uid();
  range_start := greatest(started_on, current_date - (greatest(1, least(coalesce(p_days, 30), 180)) - 1));

  with daily as (
    select trading_date, opening_equity, closing_equity,
      realised_pnl - fees + funding_pnl as net_pnl,
      daily_return_pct, trade_count, winning_trade_count as wins,
      losing_trade_count as losses, source_snapshot_at,
      max(closing_equity) over (order by trading_date rows between unbounded preceding and current row) as equity_peak
    from public.member_daily_performance
    where user_id = auth.uid() and trading_date between range_start and current_date
  ), totals as (
    select coalesce(sum(net_pnl), 0) as net_pnl,
      coalesce(sum(trade_count), 0) as trades,
      coalesce(sum(wins), 0) as wins, coalesce(sum(losses), 0) as losses,
      case when count(daily_return_pct) = 0 then null
        when bool_or(daily_return_pct <= -100) then -100
        else (exp(sum(ln(1 + daily_return_pct / 100))) - 1) * 100 end as roi,
      coalesce(max(case when equity_peak > 0 then (equity_peak - closing_equity) * 100 / equity_peak else 0 end), 0) as mdd,
      max(source_snapshot_at) filter (where trade_count > 0) as last_trade_at
    from daily
  )
  select jsonb_build_object(
    'requested_days', greatest(1, least(coalesce(p_days, 30), 180)),
    'started_on', started_on, 'range_start', range_start, 'range_end', current_date,
    'totals', (select jsonb_build_object(
      'roi', roi, 'net_pnl', net_pnl, 'trades', trades, 'wins', wins, 'losses', losses,
      'win_rate', case when wins + losses > 0 then wins * 100.0 / (wins + losses) end,
      'mdd', mdd, 'average_daily_trades', trades::numeric / greatest(1, current_date - range_start + 1),
      'last_trade_at', last_trade_at
    ) from totals),
    'days', coalesce((select jsonb_agg(jsonb_build_object(
      'date', trading_date, 'net_pnl', net_pnl, 'daily_return_pct', daily_return_pct,
      'closing_equity', closing_equity
    ) order by trading_date) from daily), '[]'::jsonb)
  ) into result;
  return result;
end;
$$;
revoke all on function public.get_my_dashboard_performance(integer) from public, anon;
grant execute on function public.get_my_dashboard_performance(integer) to authenticated;

create or replace function public.get_my_live_trading_data()
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare account_id uuid;
declare latest_snapshot_id bigint;
declare result jsonb;
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED'; end if;
  select id into account_id from private.trading_accounts
  where user_id = auth.uid() and account_role = 'MEMBER' order by updated_at desc limit 1;
  select id into latest_snapshot_id from private.copy_account_snapshots
  where trading_account_id = account_id order by observed_at desc limit 1;
  select jsonb_build_object(
    'account', (select jsonb_build_object(
      'total_equity', s.total_equity, 'available_equity', s.available_equity,
      'used_margin', greatest(0, s.total_equity - s.available_equity),
      'margin_usage_pct', case when s.total_equity > 0 then greatest(0, s.total_equity - s.available_equity) * 100 / s.total_equity else 0 end,
      'unrealised_pnl', s.unrealised_pnl, 'observed_at', s.observed_at
    ) from private.copy_account_snapshots s where s.id = latest_snapshot_id),
    'open_positions', coalesce((select jsonb_agg(jsonb_build_object(
      'contract', p.contract, 'size', p.size, 'side', case when p.size > 0 then 'LONG' else 'SHORT' end,
      'entry_price', p.entry_price, 'mark_price', p.mark_price, 'leverage', p.leverage,
      'notional', abs(p.size * p.mark_price * p.quanto_multiplier),
      'margin', case when coalesce(p.leverage, 0) > 0 then abs(p.size * p.mark_price * p.quanto_multiplier) / p.leverage else null end,
      'unrealised_pnl', case when p.entry_price > 0 then (p.mark_price - p.entry_price) * p.size * p.quanto_multiplier else 0 end,
      'roe', case when p.entry_price > 0 and coalesce(p.leverage, 0) > 0 then
        (p.mark_price - p.entry_price) * sign(p.size) * p.leverage * 100 / p.entry_price else null end,
      'observed_at', p.observed_at
    ) order by abs(p.size * p.mark_price * p.quanto_multiplier) desc)
      from private.copy_position_snapshots p
      where p.account_snapshot_id = latest_snapshot_id and p.size <> 0), '[]'::jsonb),
    'positions', coalesce((select jsonb_agg(jsonb_build_object(
      'contract', s.contract, 'state', s.state, 'target_size', s.target_size,
      'actual_size', s.actual_size, 'delta_size', s.delta_size,
      'pause_reason', s.pause_reason, 'observed_at', s.last_observed_at
    ) order by s.contract) from public.copy_position_states s where s.user_id = auth.uid()), '[]'::jsonb),
    'events', coalesce((select jsonb_agg(jsonb_build_object(
      'contract', e.contract, 'type', e.event_type, 'severity', e.severity,
      'payload', e.safe_payload, 'occurred_at', e.occurred_at
    ) order by e.occurred_at desc) from (select * from public.copy_events
      where user_id = auth.uid() order by occurred_at desc limit 50) e), '[]'::jsonb)
  ) into result;
  return result;
end;
$$;
revoke all on function public.get_my_live_trading_data() from public;
grant execute on function public.get_my_live_trading_data() to authenticated;

-- Keep the legacy overload for rollback compatibility, but prevent clients from
-- calling it after the expanded risk settings API is introduced.
revoke all on function public.update_my_copy_settings(numeric, numeric) from public, anon, authenticated;
create function public.update_my_copy_settings(
  new_copy_ratio numeric,
  new_max_position_ratio numeric,
  new_daily_loss_limit_pct numeric,
  new_max_drawdown_pct numeric,
  new_max_leverage numeric
)
returns public.profiles
language plpgsql security definer set search_path = public, pg_temp
as $$
declare updated_profile public.profiles;
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED'; end if;
  if not exists (select 1 from public.profiles where id = auth.uid() and role = 'MEMBER' and approval_status = 'APPROVED') then
    raise exception 'APPROVAL_REQUIRED';
  end if;
  if new_copy_ratio not in (50, 100, 150, 200) then raise exception 'INVALID_COPY_RATIO'; end if;
  if new_max_position_ratio not in (20, 30, 40) then raise exception 'INVALID_MAX_POSITION_RATIO'; end if;
  if new_daily_loss_limit_pct < 1 or new_daily_loss_limit_pct > 10 then raise exception 'INVALID_DAILY_LOSS_LIMIT'; end if;
  if new_max_drawdown_pct < 5 or new_max_drawdown_pct > 30 then raise exception 'INVALID_DRAWDOWN_LIMIT'; end if;
  if new_max_leverage < 1 or new_max_leverage > 20 or trunc(new_max_leverage) <> new_max_leverage then raise exception 'INVALID_MAX_LEVERAGE'; end if;
  update public.profiles set
    copy_ratio = new_copy_ratio,
    max_position_ratio = new_max_position_ratio,
    daily_loss_limit_pct = new_daily_loss_limit_pct,
    max_drawdown_pct = new_max_drawdown_pct,
    max_leverage = new_max_leverage,
    updated_at = now()
  where id = auth.uid()
  returning * into updated_profile;
  return updated_profile;
end;
$$;
revoke all on function public.update_my_copy_settings(numeric, numeric, numeric, numeric, numeric) from public, anon;
grant execute on function public.update_my_copy_settings(numeric, numeric, numeric, numeric, numeric) to authenticated;
