-- 2026-10-19: member risk limits measure trading results, not deposits and withdrawals.
--
-- Before: peak_equity = max(total_equity) and day_start_equity = first total of the day. A withdrawal
-- therefore read as a loss (2026-09-28 and 2026-10-04: a member's withdrawal tripped
-- MAX_DRAWDOWN_LIMIT, reduce-only is sticky), and a deposit raised the peak.
--
-- After: the worker records Gate futures ledger transfers (account_book type 'dnw') per account.
-- `net` = sum of transfers recorded since tracking started for that account. Peak and day-start are
-- kept on transfer-adjusted equity (total_equity - net), and the worker compares them with the same
-- adjusted equity. With no transfers recorded (net = 0) every value is exactly as before.
-- Transfers that happened before tracking started are ignored: the stored peak already reflects them.

set lock_timeout = '5s';

-- When peak/day-start were last set by an observation, so a transfer recorded late (the 5-minute
-- ledger sync) can correct a value that was computed without it.
alter table private.copy_current_accounts
  add column if not exists day_start_at timestamptz,
  add column if not exists peak_raised_at timestamptz,
  add column if not exists peak_raise_base numeric;
alter table private.copy_operation_risk
  add column if not exists day_start_at timestamptz,
  add column if not exists peak_raised_at timestamptz,
  add column if not exists peak_raise_base numeric;

create table if not exists private.copy_fund_flow_tracking (
  trading_account_id uuid primary key references private.trading_accounts(id) on delete cascade,
  started_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default now()
);

create table if not exists private.copy_fund_flows (
  trading_account_id uuid not null references private.trading_accounts(id) on delete cascade,
  flow_key text not null,
  change numeric not null,
  occurred_at timestamptz not null,
  recorded_at timestamptz not null default clock_timestamp(),
  primary key (trading_account_id, flow_key)
);
alter table private.copy_fund_flow_tracking enable row level security;
alter table private.copy_fund_flows enable row level security;

create or replace function private.copy_fund_flow_net(p_trading_account_id uuid)
returns numeric
language sql
stable
set search_path to 'pg_catalog'
as $$
  select coalesce(sum(f.change), 0)
  from private.copy_fund_flows f
  join private.copy_fund_flow_tracking t on t.trading_account_id = f.trading_account_id
  where f.trading_account_id = p_trading_account_id and f.occurred_at >= t.started_at
$$;

-- A transfer recorded after observations that did not know it: day-start set at/after the transfer
-- excluded it (exact correction), and a peak raised at/after a deposit included the deposit (lowered
-- back, never below the peak before that raise streak nor below current adjusted equity).
create or replace function private.correct_risk_for_late_flow(p_trading_account_id uuid, p_change numeric, p_at timestamptz)
returns void
language plpgsql
set search_path to 'pg_catalog'
as $$
declare adjusted numeric;
begin
  select greatest(0, a.total_equity - private.copy_fund_flow_net(a.trading_account_id)) into adjusted
  from private.copy_current_accounts a where a.trading_account_id = p_trading_account_id;
  update private.copy_current_accounts set day_start_equity = greatest(0, day_start_equity - p_change)
  where trading_account_id = p_trading_account_id and day_start_at is not null and day_start_at >= p_at;
  update private.copy_operation_risk set day_start_equity = greatest(0, day_start_equity - p_change)
  where trading_account_id = p_trading_account_id and day_start_at is not null and day_start_at >= p_at;
  if p_change > 0 then
    update private.copy_current_accounts set peak_equity = greatest(coalesce(peak_raise_base, 0),
        peak_equity - p_change, coalesce(adjusted, 0))
    where trading_account_id = p_trading_account_id and peak_raised_at is not null and peak_raised_at >= p_at;
    update private.copy_operation_risk set peak_equity = greatest(coalesce(peak_raise_base, 0),
        peak_equity - p_change, coalesce(adjusted, 0), 0.000001)
    where trading_account_id = p_trading_account_id and peak_raised_at is not null and peak_raised_at >= p_at;
  end if;
end;
$$;
revoke all on function private.correct_risk_for_late_flow(uuid, numeric, timestamptz) from public, anon, authenticated;

-- Worker: record ledger transfer rows. Entries: [{key, change, time}] (time = unix seconds or ISO).
-- Returns the account's net after recording. Idempotent per (account, key).
create or replace function public.record_copy_fund_flows(p_trading_account_id uuid, p_entries jsonb)
returns numeric
language plpgsql
security definer
set search_path to 'pg_catalog'
as $$
declare e jsonb; t timestamptz; inserted int; tracking_start timestamptz;
begin
  perform private.require_copy_worker_role();
  if not exists (select 1 from private.trading_accounts where id = p_trading_account_id) then
    raise exception 'TRADING_ACCOUNT_NOT_FOUND';
  end if;
  insert into private.copy_fund_flow_tracking(trading_account_id) values (p_trading_account_id)
  on conflict (trading_account_id) do nothing;
  select started_at into tracking_start from private.copy_fund_flow_tracking where trading_account_id = p_trading_account_id;
  for e in select value from jsonb_array_elements(coalesce(p_entries, '[]'::jsonb)) loop
    if nullif(e->>'key', '') is null or nullif(e->>'change', '') is null then continue; end if;
    if (e->>'change')::numeric = 0 then continue; end if;
    t := case when (e->>'time') ~ '^[0-9]+(\.[0-9]+)?$' then to_timestamp((e->>'time')::double precision)
              else (e->>'time')::timestamptz end;
    if t is null then continue; end if;
    insert into private.copy_fund_flows(trading_account_id, flow_key, change, occurred_at)
    values (p_trading_account_id, left(e->>'key', 160), (e->>'change')::numeric, t)
    on conflict (trading_account_id, flow_key) do nothing;
    get diagnostics inserted = row_count;
    if inserted > 0 and t >= tracking_start then
      perform private.correct_risk_for_late_flow(p_trading_account_id, (e->>'change')::numeric, t);
    end if;
  end loop;
  update private.copy_fund_flow_tracking set updated_at = now() where trading_account_id = p_trading_account_id;
  return private.copy_fund_flow_net(p_trading_account_id);
end;
$$;

create or replace function public.get_copy_fund_flow_totals()
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog'
as $$
begin
  perform private.require_copy_worker_role();
  return (select coalesce(jsonb_agg(jsonb_build_object(
      'trading_account_id', t.trading_account_id,
      'net', private.copy_fund_flow_net(t.trading_account_id),
      'started_at', t.started_at)), '[]'::jsonb)
    from private.copy_fund_flow_tracking t);
end;
$$;

revoke all on function public.record_copy_fund_flows(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.get_copy_fund_flow_totals() from public, anon, authenticated;
grant execute on function public.record_copy_fund_flows(uuid, jsonb) to service_role;
grant execute on function public.get_copy_fund_flow_totals() to service_role;

-- Peak / day-start of copy_current_accounts on adjusted equity. Only observation writes (observed_at
-- moves forward) are recomputed; an explicit administrative reset keeps the value it sets.
create or replace function private.copy_current_account_adjusted_risk()
returns trigger
language plpgsql
security definer
set search_path to 'pg_catalog'
as $$
declare adjusted numeric;
begin
  if tg_op = 'UPDATE' and new.observed_at is not distinct from old.observed_at then return new; end if;
  -- Never below zero (a deposit followed by a larger loss): the limits then read as fully used.
  adjusted := greatest(0, new.total_equity - private.copy_fund_flow_net(new.trading_account_id));
  if tg_op = 'INSERT' then
    new.peak_equity := adjusted;
    new.day_start_equity := adjusted;
    new.day_start_at := new.observed_at;
    new.peak_raised_at := null;
    new.peak_raise_base := null;
  else
    if old.equity_day is distinct from new.equity_day then
      new.day_start_equity := adjusted;
      new.day_start_at := new.observed_at;
    else
      new.day_start_equity := old.day_start_equity;
      new.day_start_at := old.day_start_at;
    end if;
    if adjusted > old.peak_equity then
      new.peak_equity := adjusted;
      new.peak_raise_base := case when old.peak_raised_at is null or old.peak_raised_at < new.observed_at - interval '15 minutes'
        then old.peak_equity else old.peak_raise_base end;
      new.peak_raised_at := new.observed_at;
    else
      new.peak_equity := old.peak_equity;
      new.peak_raised_at := old.peak_raised_at;
      new.peak_raise_base := old.peak_raise_base;
    end if;
  end if;
  return new;
end;
$$;

create or replace trigger copy_current_accounts_adjusted_risk
  before insert or update on private.copy_current_accounts
  for each row execute function private.copy_current_account_adjusted_risk();

create or replace function private.observe_copy_operation_risk()
returns trigger
language plpgsql
security definer
set search_path to 'pg_catalog'
as $function$
declare
  observed_day date := (new.observed_at at time zone 'Asia/Seoul')::date;
  adjusted numeric;
begin
  if new.total_equity::text in ('NaN','Infinity','-Infinity') then raise exception 'INVALID_EQUITY'; end if;
  adjusted := greatest(0, new.total_equity - private.copy_fund_flow_net(new.trading_account_id));
  update private.copy_operation_risk r set
    day_start_equity=case when observed_day>r.equity_day then adjusted else r.day_start_equity end,
    day_start_at=case when observed_day>r.equity_day then new.observed_at else r.day_start_at end,
    equity_day=greatest(r.equity_day,observed_day),
    peak_raise_base=case when adjusted>r.peak_equity then
      case when r.peak_raised_at is null or r.peak_raised_at < new.observed_at - interval '15 minutes'
        then r.peak_equity else r.peak_raise_base end else r.peak_raise_base end,
    peak_raised_at=case when adjusted>r.peak_equity then new.observed_at else r.peak_raised_at end,
    peak_equity=greatest(r.peak_equity,adjusted),observed_at=new.observed_at
  where r.trading_account_id=new.trading_account_id and new.observed_at>r.observed_at;
  return new;
end;
$function$;

-- Resets a member account's risk baseline to its current adjusted equity (used by RESUME and by a
-- Gate account change). Returns the new baseline, or null when no observation exists yet.
create or replace function private.reset_copy_risk_baseline(p_trading_account_id uuid)
returns numeric
language plpgsql
security definer
set search_path to 'pg_catalog'
as $$
declare base numeric; seen timestamptz;
begin
  select a.total_equity - private.copy_fund_flow_net(a.trading_account_id), a.observed_at
  into base, seen from private.copy_current_accounts a where a.trading_account_id = p_trading_account_id;
  if base is null then return null; end if;
  base := greatest(0, base);
  update private.copy_current_accounts set peak_equity = base, day_start_equity = base, day_start_at = seen,
    peak_raised_at = null, peak_raise_base = null, updated_at = now()
  where trading_account_id = p_trading_account_id;
  update private.copy_operation_risk set peak_equity = base, day_start_equity = base, day_start_at = seen,
    peak_raised_at = null, peak_raise_base = null,
    equity_day = greatest(equity_day, (coalesce(seen, now()) at time zone 'Asia/Seoul')::date)
  where trading_account_id = p_trading_account_id and base > 0;
  return base;
end;
$$;
revoke all on function private.reset_copy_risk_baseline(uuid) from public, anon, authenticated;
revoke all on function private.copy_fund_flow_net(uuid) from public, anon, authenticated;
revoke all on function private.copy_current_account_adjusted_risk() from public, anon, authenticated;
