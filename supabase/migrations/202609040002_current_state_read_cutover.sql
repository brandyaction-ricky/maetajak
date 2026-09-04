-- Phase 3: serve current operational reads from bounded Current State tables.
-- Historical PNL and audit APIs remain on their event/daily aggregate tables.

create or replace function public.get_my_live_trading_data()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  account_id uuid;
  result jsonb;
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED'; end if;

  select account.id
  into account_id
  from private.trading_accounts account
  where account.user_id = auth.uid()
    and account.account_role = 'MEMBER'
  order by account.updated_at desc
  limit 1;

  select jsonb_build_object(
    'account', (
      select jsonb_build_object(
        'total_equity', account.total_equity,
        'available_equity', account.available_equity,
        'used_margin', greatest(0, account.total_equity - account.available_equity),
        'margin_usage_pct', case when account.total_equity > 0
          then greatest(0, account.total_equity - account.available_equity) * 100 / account.total_equity
          else 0 end,
        'unrealised_pnl', account.unrealised_pnl,
        'observed_at', account.observed_at
      )
      from private.copy_current_accounts account
      where account.trading_account_id = account_id
    ),
    'open_positions', coalesce((
      select jsonb_agg(jsonb_build_object(
        'contract', position.contract,
        'size', position.size,
        'side', position.position_side,
        'entry_price', position.entry_price,
        'mark_price', position.mark_price,
        'leverage', position.leverage,
        'notional', abs(position.size * position.mark_price * position.quanto_multiplier),
        'margin', case when coalesce(position.leverage, 0) > 0
          then abs(position.size * position.mark_price * position.quanto_multiplier) / position.leverage
          else null end,
        'unrealised_pnl', case when position.entry_price > 0
          then (position.mark_price - position.entry_price) * position.size * position.quanto_multiplier
          else 0 end,
        'roe', case when position.entry_price > 0 and coalesce(position.leverage, 0) > 0
          then (position.mark_price - position.entry_price) * sign(position.size) * position.leverage * 100 / position.entry_price
          else null end,
        'observed_at', position.observed_at
      ) order by abs(position.size * position.mark_price * position.quanto_multiplier) desc)
      from private.copy_current_positions position
      where position.trading_account_id = account_id
        and position.size <> 0
    ), '[]'::jsonb),
    'positions', coalesce((
      select jsonb_agg(jsonb_build_object(
        'contract', state.contract,
        'state', state.state,
        'target_size', state.target_size,
        'actual_size', state.actual_size,
        'delta_size', state.delta_size,
        'pause_reason', state.pause_reason,
        'observed_at', state.last_observed_at
      ) order by state.contract)
      from public.copy_position_states state
      where state.user_id = auth.uid()
    ), '[]'::jsonb),
    'events', coalesce((
      select jsonb_agg(jsonb_build_object(
        'contract', event.contract,
        'type', event.event_type,
        'severity', event.severity,
        'payload', event.safe_payload,
        'occurred_at', event.occurred_at
      ) order by event.occurred_at desc)
      from (
        select *
        from public.copy_events
        where user_id = auth.uid()
        order by occurred_at desc
        limit 50
      ) event
    ), '[]'::jsonb)
  ) into result;

  return result;
end;
$$;

revoke all on function public.get_my_live_trading_data() from public, anon;
grant execute on function public.get_my_live_trading_data() to authenticated;

create or replace function public.get_admin_live_trading_data()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  result jsonb;
begin
  if not public.is_approved_admin() then raise exception 'ADMIN_REQUIRED'; end if;

  select jsonb_build_object(
    'master_positions', coalesce((
      select jsonb_agg(jsonb_build_object(
        'contract', position.contract,
        'size', position.size,
        'mark_price', position.mark_price,
        'entry_price', position.entry_price,
        'leverage', position.leverage,
        'quanto_multiplier', position.quanto_multiplier,
        'unrealised_pnl', case when position.entry_price > 0
          then (position.mark_price - position.entry_price) * position.size * position.quanto_multiplier
          else 0 end,
        'observed_at', position.observed_at
      ) order by position.contract)
      from private.copy_current_positions position
      where position.account_role = 'MASTER'
        and position.size <> 0
    ), '[]'::jsonb),
    'position_members', coalesce((
      select jsonb_agg(jsonb_build_object(
        'user_id', profile.id,
        'name', profile.full_name,
        'email', profile.email
      ) order by coalesce(profile.full_name, profile.email))
      from public.profiles profile
      where profile.role = 'MEMBER'
        and profile.approval_status = 'APPROVED'
    ), '[]'::jsonb),
    'member_positions', coalesce((
      select jsonb_agg(jsonb_build_object(
        'user_id', account.user_id,
        'name', profile.full_name,
        'email', profile.email,
        'contract', position.contract,
        'size', position.size,
        'side', position.position_side,
        'entry_price', position.entry_price,
        'mark_price', position.mark_price,
        'leverage', position.leverage,
        'quanto_multiplier', position.quanto_multiplier,
        'notional', abs(position.size * position.mark_price * position.quanto_multiplier),
        'margin', case when coalesce(position.leverage, 0) > 0
          then abs(position.size * position.mark_price * position.quanto_multiplier) / position.leverage
          else null end,
        'unrealised_pnl', case when position.entry_price > 0
          then (position.mark_price - position.entry_price) * position.size * position.quanto_multiplier
          else 0 end,
        'roe', case when position.entry_price > 0 and coalesce(position.leverage, 0) > 0
          then (position.mark_price - position.entry_price) * sign(position.size) * position.leverage * 100 / position.entry_price
          else null end,
        'observed_at', position.observed_at
      ) order by coalesce(profile.full_name, profile.email),
        abs(position.size * position.mark_price * position.quanto_multiplier) desc)
      from private.trading_accounts account
      join public.profiles profile on profile.id = account.user_id
      join private.copy_current_positions position
        on position.trading_account_id = account.id
       and position.size <> 0
      where account.account_role = 'MEMBER'
        and account.status = 'ACTIVE'
    ), '[]'::jsonb),
    'member_states', coalesce((
      select jsonb_agg(jsonb_build_object(
        'name', profile.full_name,
        'email', profile.email,
        'contract', state.contract,
        'state', state.state,
        'target_size', state.target_size,
        'actual_size', state.actual_size,
        'actual_notional', abs(state.actual_size * latest.mark_price * latest.quanto_multiplier),
        'delta_size', state.delta_size,
        'pause_reason', state.pause_reason,
        'observed_at', state.last_observed_at
      ) order by state.updated_at desc)
      from public.copy_position_states state
      join public.profiles profile on profile.id = state.user_id
      left join lateral (
        select position.mark_price, position.quanto_multiplier
        from private.copy_current_positions position
        where position.trading_account_id = state.trading_account_id
          and position.contract = state.contract
        order by
          case when sign(position.size) = sign(state.actual_size) then 0 else 1 end,
          abs(position.size) desc
        limit 1
      ) latest on true
    ), '[]'::jsonb),
    'orders', coalesce((
      select jsonb_agg(jsonb_build_object(
        'name', profile.full_name,
        'email', profile.email,
        'contract', intent.contract,
        'delta_size', intent.delta_size,
        'filled_size', intent.filled_size,
        'status', intent.status,
        'gate_order_id', intent.gate_order_id,
        'error_code', intent.last_error_code,
        'created_at', intent.created_at,
        'updated_at', intent.updated_at
      ) order by intent.created_at desc)
      from (
        select *
        from private.copy_order_intents
        order by created_at desc
        limit 100
      ) intent
      join public.profiles profile on profile.id = intent.user_id
    ), '[]'::jsonb)
  ) into result;

  return result;
end;
$$;

revoke all on function public.get_admin_live_trading_data() from public, anon;
grant execute on function public.get_admin_live_trading_data() to authenticated;

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
    where profile.role = 'MEMBER'
      and profile.approval_status = 'APPROVED'
  ), latest_accounts as (
    select member.id as user_id,
      current_account.total_equity,
      current_account.available_equity,
      current_account.unrealised_pnl,
      current_account.observed_at
    from approved_members member
    left join private.trading_accounts account
      on account.user_id = member.id
     and account.account_role = 'MEMBER'
     and account.settle = 'usdt'
    left join private.copy_current_accounts current_account
      on current_account.trading_account_id = account.id
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
      'id', id,
      'full_name', full_name,
      'email', email,
      'copy_status', copy_status,
      'copy_ratio', copy_ratio,
      'max_position_ratio', max_position_ratio,
      'total_equity', total_equity,
      'today_pnl', today_pnl,
      'margin_usage_pct', margin_usage_pct,
      'api_status', coalesce(api_status, 'NOT_CONNECTED'),
      'last_observed_at', last_observed_at
    ) order by full_name, email) from member_rows), '[]'::jsonb),
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
$$;

revoke all on function public.get_admin_operations_metrics(date, date) from public, anon;
grant execute on function public.get_admin_operations_metrics(date, date) to authenticated;

create or replace function public.get_public_master_positions()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with settings as (
    select date '2026-07-01' as start_date, 10000::numeric as start_equity, 0::numeric as net_deposits
  ), master_account as (
    select account.id
    from private.trading_accounts account
    where account.account_role = 'MASTER'
      and account.status = 'ACTIVE'
    order by account.updated_at desc
    limit 1
  ), current_account as (
    select account.*
    from private.copy_current_accounts account
    join master_account master on master.id = account.trading_account_id
  ), open_positions as (
    select position.*,
      abs(position.size * position.mark_price * position.quanto_multiplier) as notional,
      case when position.entry_price > 0
        then (position.mark_price - position.entry_price) * position.size * position.quanto_multiplier
        else 0 end as calculated_unrealised_pnl,
      case when position.entry_price > 0 and coalesce(position.leverage, 0) > 0
        then (position.mark_price - position.entry_price) * sign(position.size) * position.leverage * 100 / position.entry_price
        else 0 end as roe
    from private.copy_current_positions position
    join master_account master on master.id = position.trading_account_id
    where position.size <> 0
  )
  select jsonb_build_object(
    'observed_at', (select observed_at from current_account),
    'account', (
      select jsonb_build_object(
        'total_equity', account.total_equity,
        'available_equity', account.available_equity,
        'used_equity', greatest(account.total_equity - account.available_equity, 0),
        'pnl_since_start', account.total_equity - settings.start_equity - settings.net_deposits,
        'start_date', settings.start_date,
        'start_equity', settings.start_equity,
        'net_deposits', settings.net_deposits,
        'day_number', greatest(1, timezone('Asia/Seoul', now())::date - settings.start_date + 1)
      )
      from current_account account
      cross join settings
    ),
    'positions', coalesce((
      select jsonb_agg(jsonb_build_object(
        'contract', position.contract,
        'side', position.position_side,
        'size', position.size,
        'entry_price', position.entry_price,
        'mark_price', position.mark_price,
        'leverage', position.leverage,
        'notional', position.notional,
        'unrealised_pnl', position.calculated_unrealised_pnl,
        'roe', position.roe,
        'observed_at', position.observed_at
      ) order by position.notional desc)
      from open_positions position
    ), '[]'::jsonb)
  );
$$;

revoke all on function public.get_public_master_positions() from public, anon, authenticated;
grant execute on function public.get_public_master_positions() to anon, authenticated;

comment on function public.get_public_master_positions() is
  'Sanitized Master Current State and limited account summary for the public monitor.';
