-- 2026-10-21 QA (area D, risk): risk limits on the sizing equity basis, unified-member policy.
--
-- D5: Gate's classic futures `total` is the wallet balance WITHOUT unrealised PnL (FuturesAccount.total:
-- "excluding unrealized profit and loss"), so a -40% open loss never reached daily_loss_limit_pct /
-- max_drawdown_pct. The worker now evaluates risk on its sizing equity (classic: total + unrealised_pnl;
-- unified: unified_account_total_equity, which already includes it) and sends it as `risk_equity` with
-- `risk_basis` = 'MTM_V1'. Peak and day-start are kept on that value. A row (or operation-risk row) stored on
-- another basis is never compared with it: the first observation on the new basis restarts peak/day-start from
-- the current transfer-adjusted equity (legacy rows, rows written by an older worker, a new operation whose
-- start value came from the raw wallet total). The row keeps risk_equity - total_equity (risk_equity_adjustment);
-- rows without it keep the old wallet basis ('WALLET_V0').
--
-- D6: Gate unified accounts include spot (and other) assets in equity, while deposits/withdrawals are tracked only
-- from the futures ledger (account_book type 'dnw'). The worker refuses MEMBER accounts in unified mode
-- (UNIFIED_ACCOUNT_UNSUPPORTED) unless the operator sets copy_system_control.allow_unified_members = true.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, CREATE OR REPLACE (latest definitions as of 20261021020000).

set lock_timeout = '5s';

alter table public.copy_system_control
  add column if not exists allow_unified_members boolean not null default false;
comment on column public.copy_system_control.allow_unified_members is
  'QA D6: allow MEMBER Gate accounts in unified-account mode. Their equity includes spot assets whose transfers are not tracked (risk limits and sizing may be wrong). Default false.';

alter table private.copy_current_accounts
  add column if not exists risk_equity_adjustment numeric,
  add column if not exists risk_basis text;
alter table private.copy_operation_risk
  add column if not exists risk_basis text;

-- Equity the risk limits use for a stored observation. The row keeps the difference to total_equity (classic:
-- the unrealised PnL; unified: 0) rather than an absolute value, so any later total_equity write stays consistent.
create or replace function private.copy_account_risk_equity(p_total_equity numeric, p_adjustment numeric, p_risk_basis text)
returns numeric
language sql
immutable
set search_path to 'pg_catalog'
as $$
  select case when p_risk_basis = 'MTM_V1' and p_adjustment is not null then greatest(0, p_total_equity + p_adjustment)
    else p_total_equity end
$$;
revoke all on function private.copy_account_risk_equity(numeric, numeric, text) from public, anon, authenticated;

-- Peak / day-start of copy_current_accounts on the row's risk basis, net of recorded transfers. A basis change
-- (or the first row) restarts both from the current value instead of comparing two bases.
create or replace function private.copy_current_account_adjusted_risk()
returns trigger
language plpgsql
security definer
set search_path to 'pg_catalog'
as $$
declare adjusted numeric; basis text;
begin
  if tg_op = 'UPDATE' and new.observed_at is not distinct from old.observed_at then return new; end if;
  basis := case when new.risk_basis = 'MTM_V1' and new.risk_equity_adjustment is not null then 'MTM_V1' else 'WALLET_V0' end;
  new.risk_basis := basis;
  if basis <> 'MTM_V1' then new.risk_equity_adjustment := null; end if;
  -- Never below zero (a deposit followed by a larger loss): the limits then read as fully used.
  adjusted := greatest(0, private.copy_account_risk_equity(new.total_equity, new.risk_equity_adjustment, basis)
    - private.copy_fund_flow_net(new.trading_account_id));
  if tg_op = 'INSERT' or old.risk_basis is distinct from basis then
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

-- Operation-period risk follows the same basis. A row stored on another basis (risk_basis null: legacy, or reset by
-- a new operation below) restarts from this observation.
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
  adjusted := greatest(0, private.copy_account_risk_equity(new.total_equity, new.risk_equity_adjustment, new.risk_basis)
    - private.copy_fund_flow_net(new.trading_account_id));
  update private.copy_operation_risk r set
    day_start_equity=adjusted, day_start_at=new.observed_at, equity_day=greatest(r.equity_day,observed_day),
    peak_equity=greatest(adjusted,0.000001), peak_raised_at=null, peak_raise_base=null,
    risk_basis=new.risk_basis, observed_at=new.observed_at
  where r.trading_account_id=new.trading_account_id and new.observed_at>r.observed_at
    and r.risk_basis is distinct from new.risk_basis;
  update private.copy_operation_risk r set
    day_start_equity=case when observed_day>r.equity_day then adjusted else r.day_start_equity end,
    day_start_at=case when observed_day>r.equity_day then new.observed_at else r.day_start_at end,
    equity_day=greatest(r.equity_day,observed_day),
    peak_raise_base=case when adjusted>r.peak_equity then
      case when r.peak_raised_at is null or r.peak_raised_at < new.observed_at - interval '15 minutes'
        then r.peak_equity else r.peak_raise_base end else r.peak_raise_base end,
    peak_raised_at=case when adjusted>r.peak_equity then new.observed_at else r.peak_raised_at end,
    peak_equity=greatest(r.peak_equity,adjusted),observed_at=new.observed_at
  where r.trading_account_id=new.trading_account_id and new.observed_at>r.observed_at
    and r.risk_basis is not distinct from new.risk_basis;
  return new;
end;
$function$;

-- A new operation stores its start from copy_current_accounts.total_equity (raw wallet value): mark its basis
-- unknown so the next observation restarts it on the risk basis instead of comparing.
create or replace function private.copy_operation_risk_basis_reset()
returns trigger
language plpgsql
set search_path to 'pg_catalog'
as $$
begin
  if tg_op = 'INSERT' or new.operation_id is distinct from old.operation_id then new.risk_basis := null; end if;
  return new;
end;
$$;
revoke all on function private.copy_operation_risk_basis_reset() from public, anon, authenticated;
create or replace trigger copy_operation_risk_basis_reset before insert or update on private.copy_operation_risk
  for each row execute function private.copy_operation_risk_basis_reset();

create or replace function private.correct_risk_for_late_flow(p_trading_account_id uuid, p_change numeric, p_at timestamptz)
returns void
language plpgsql
set search_path to 'pg_catalog'
as $$
declare adjusted numeric;
begin
  select greatest(0, private.copy_account_risk_equity(a.total_equity, a.risk_equity_adjustment, a.risk_basis)
      - private.copy_fund_flow_net(a.trading_account_id)) into adjusted
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

create or replace function private.reset_copy_risk_baseline(p_trading_account_id uuid)
returns numeric
language plpgsql
security definer
set search_path to 'pg_catalog'
as $$
declare base numeric; seen timestamptz; basis text;
begin
  select private.copy_account_risk_equity(a.total_equity, a.risk_equity_adjustment, a.risk_basis)
      - private.copy_fund_flow_net(a.trading_account_id), a.observed_at, a.risk_basis
  into base, seen, basis from private.copy_current_accounts a where a.trading_account_id = p_trading_account_id;
  if base is null then return null; end if;
  base := greatest(0, base);
  update private.copy_current_accounts set peak_equity = base, day_start_equity = base, day_start_at = seen,
    peak_raised_at = null, peak_raise_base = null, updated_at = now()
  where trading_account_id = p_trading_account_id;
  update private.copy_operation_risk set peak_equity = base, day_start_equity = base, day_start_at = seen,
    peak_raised_at = null, peak_raise_base = null, risk_basis = basis,
    equity_day = greatest(equity_day, (coalesce(seen, now()) at time zone 'Asia/Seoul')::date)
  where trading_account_id = p_trading_account_id and base > 0;
  return base;
end;
$$;

-- Latest definition (pg_get_functiondef after 20261020020000, KST equity_day patch included) plus
-- risk_equity_adjustment / risk_basis for MEMBER rows.
CREATE OR REPLACE FUNCTION public.upsert_copy_current_state(p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  cycle_id uuid := nullif(p_payload->>'copy_event_id', '')::uuid;
  observed_at timestamptz := coalesce(nullif(p_payload->>'observed_at', '')::timestamptz, now());
  account_payload jsonb;
  position_payload jsonb;
  account_id uuid;
  account_user_id uuid;
  account_role text;
  account_positions jsonb;
  total_equity numeric;
  available_equity numeric;
  unrealised_pnl numeric;
  risk_adjustment numeric;
  risk_basis text;
  side text;
  account_count integer := 0;
  position_count integer := 0;
begin
  if auth.role() <> 'service_role' then
    raise exception 'SERVICE_ROLE_REQUIRED';
  end if;

  if jsonb_typeof(p_payload->'master') = 'object' then
    account_payload := (p_payload->'master') || jsonb_build_object('account_role', 'MASTER');
    account_id := nullif(account_payload->>'trading_account_id', '')::uuid;
    if account_id is not null then
      account_user_id := nullif(account_payload->>'user_id', '')::uuid;
      account_role := 'MASTER';
      account_positions := coalesce(account_payload->'positions', '[]'::jsonb);
      total_equity := greatest(0, coalesce((account_payload->>'total_equity')::numeric, 0));
      available_equity := greatest(0, coalesce((account_payload->>'available_equity')::numeric, 0));
      unrealised_pnl := nullif(account_payload->>'unrealised_pnl', '')::numeric;

      insert into private.copy_current_accounts (
        trading_account_id, user_id, account_role, total_equity, available_equity,
        unrealised_pnl, equity_day, day_start_equity, peak_equity, source_hash,
        copy_cycle_id, observed_at, updated_at
      ) values (
        account_id, account_user_id, account_role, total_equity, available_equity,
        unrealised_pnl, (observed_at at time zone 'Asia/Seoul')::date, total_equity, total_equity,
        md5(jsonb_build_array(total_equity, available_equity, unrealised_pnl)::text),
        cycle_id, observed_at, now()
      ) on conflict (trading_account_id) do update set
        user_id = excluded.user_id,
        account_role = excluded.account_role,
        total_equity = excluded.total_equity,
        available_equity = excluded.available_equity,
        unrealised_pnl = excluded.unrealised_pnl,
        day_start_equity = case
          when private.copy_current_accounts.equity_day is distinct from excluded.equity_day
            then excluded.total_equity
          else private.copy_current_accounts.day_start_equity
        end,
        equity_day = excluded.equity_day,
        peak_equity = greatest(private.copy_current_accounts.peak_equity, excluded.total_equity),
        source_hash = excluded.source_hash,
        copy_cycle_id = excluded.copy_cycle_id,
        observed_at = excluded.observed_at,
        updated_at = now();
      account_count := account_count + 1;

      for position_payload in select value from jsonb_array_elements(account_positions) loop
        side := coalesce(nullif(position_payload->>'position_side', ''),
          case when coalesce((position_payload->>'size')::numeric, 0) < 0 then 'SHORT' else 'LONG' end);
        insert into private.copy_current_positions (
          trading_account_id, user_id, account_role, contract, position_side,
          size, mark_price, entry_price, leverage, quanto_multiplier, state,
          target_size, delta_size, source_hash, copy_cycle_id, observed_at, updated_at
        ) values (
          account_id, account_user_id, account_role, position_payload->>'contract', side,
          coalesce((position_payload->>'size')::numeric, 0),
          nullif(position_payload->>'mark_price', '')::numeric,
          nullif(position_payload->>'entry_price', '')::numeric,
          nullif(position_payload->>'leverage', '')::numeric,
          nullif(position_payload->>'quanto_multiplier', '')::numeric,
          null, null, null,
          md5(jsonb_build_array(position_payload->>'contract', side, position_payload->>'size',
            position_payload->>'mark_price', position_payload->>'entry_price',
            position_payload->>'leverage', position_payload->>'quanto_multiplier')::text),
          cycle_id, observed_at, now()
        ) on conflict (trading_account_id, contract, position_side) do update set
          user_id = excluded.user_id,
          account_role = excluded.account_role,
          size = excluded.size,
          mark_price = excluded.mark_price,
          entry_price = excluded.entry_price,
          leverage = excluded.leverage,
          quanto_multiplier = excluded.quanto_multiplier,
          state = excluded.state,
          target_size = excluded.target_size,
          delta_size = excluded.delta_size,
          source_hash = excluded.source_hash,
          copy_cycle_id = excluded.copy_cycle_id,
          observed_at = excluded.observed_at,
          updated_at = now();
        position_count := position_count + 1;
      end loop;

      delete from private.copy_current_positions current_position
      where current_position.trading_account_id = account_id
        and not exists (
          select 1
          from jsonb_array_elements(account_positions) incoming
          where incoming->>'contract' = current_position.contract
            and coalesce(nullif(incoming->>'position_side', ''),
              case when coalesce((incoming->>'size')::numeric, 0) < 0 then 'SHORT' else 'LONG' end)
              = current_position.position_side
        );
    end if;
  end if;

  for account_payload in
    select value || jsonb_build_object('account_role', 'MEMBER')
    from jsonb_array_elements(coalesce(p_payload->'members', '[]'::jsonb))
  loop
    account_id := nullif(account_payload->>'trading_account_id', '')::uuid;
    if account_id is null or account_payload->>'error_code' is not null then
      continue;
    end if;
    account_user_id := nullif(account_payload->>'user_id', '')::uuid;
    account_role := 'MEMBER';
    account_positions := coalesce(account_payload->'positions', '[]'::jsonb);
    total_equity := greatest(0, coalesce((account_payload->>'total_equity')::numeric, 0));
    available_equity := greatest(0, coalesce((account_payload->>'available_equity')::numeric, 0));
    unrealised_pnl := nullif(account_payload->>'unrealised_pnl', '')::numeric;
    -- QA D5: equity on the risk basis (sizing equity) and its marker; the trigger keeps peak/day-start on it.
    risk_adjustment := greatest(0, nullif(account_payload->>'risk_equity', '')::numeric) - total_equity;
    risk_basis := nullif(account_payload->>'risk_basis', '');

    insert into private.copy_current_accounts (
      trading_account_id, user_id, account_role, total_equity, available_equity,
      unrealised_pnl, risk_equity_adjustment, risk_basis, equity_day, day_start_equity, peak_equity, source_hash,
      copy_cycle_id, observed_at, updated_at
    ) values (
      account_id, account_user_id, account_role, total_equity, available_equity,
      unrealised_pnl, risk_adjustment, risk_basis, (observed_at at time zone 'Asia/Seoul')::date, total_equity, total_equity,
      md5(jsonb_build_array(total_equity, available_equity, unrealised_pnl)::text),
      cycle_id, observed_at, now()
    ) on conflict (trading_account_id) do update set
      user_id = excluded.user_id,
      account_role = excluded.account_role,
      total_equity = excluded.total_equity,
      available_equity = excluded.available_equity,
      unrealised_pnl = excluded.unrealised_pnl,
      risk_equity_adjustment = excluded.risk_equity_adjustment,
      risk_basis = excluded.risk_basis,
      day_start_equity = case
        when private.copy_current_accounts.equity_day is distinct from excluded.equity_day
          then excluded.total_equity
        else private.copy_current_accounts.day_start_equity
      end,
      equity_day = excluded.equity_day,
      peak_equity = greatest(private.copy_current_accounts.peak_equity, excluded.total_equity),
      source_hash = excluded.source_hash,
      copy_cycle_id = excluded.copy_cycle_id,
      observed_at = excluded.observed_at,
      updated_at = now();
    account_count := account_count + 1;

    for position_payload in select value from jsonb_array_elements(account_positions) loop
      side := coalesce(nullif(position_payload->>'position_side', ''),
        case when coalesce((position_payload->>'size')::numeric, 0) < 0 then 'SHORT' else 'LONG' end);
      insert into private.copy_current_positions (
        trading_account_id, user_id, account_role, contract, position_side,
        size, mark_price, entry_price, leverage, quanto_multiplier, state,
        target_size, delta_size, source_hash, copy_cycle_id, observed_at, updated_at
      ) values (
        account_id, account_user_id, account_role, position_payload->>'contract', side,
        coalesce((position_payload->>'size')::numeric, 0),
        nullif(position_payload->>'mark_price', '')::numeric,
        nullif(position_payload->>'entry_price', '')::numeric,
        nullif(position_payload->>'leverage', '')::numeric,
        nullif(position_payload->>'quanto_multiplier', '')::numeric,
        nullif(position_payload->>'state', ''),
        nullif(position_payload->>'target_size', '')::numeric,
        nullif(position_payload->>'delta_size', '')::numeric,
        md5(jsonb_build_array(position_payload->>'contract', side, position_payload->>'size',
          position_payload->>'mark_price', position_payload->>'entry_price',
          position_payload->>'leverage', position_payload->>'quanto_multiplier',
          position_payload->>'state', position_payload->>'target_size',
          position_payload->>'delta_size')::text),
        cycle_id, observed_at, now()
      ) on conflict (trading_account_id, contract, position_side) do update set
        user_id = excluded.user_id,
        account_role = excluded.account_role,
        size = excluded.size,
        mark_price = excluded.mark_price,
        entry_price = excluded.entry_price,
        leverage = excluded.leverage,
        quanto_multiplier = excluded.quanto_multiplier,
        state = excluded.state,
        target_size = excluded.target_size,
        delta_size = excluded.delta_size,
        source_hash = excluded.source_hash,
        copy_cycle_id = excluded.copy_cycle_id,
        observed_at = excluded.observed_at,
        updated_at = now();
      position_count := position_count + 1;
    end loop;

    delete from private.copy_current_positions current_position
    where current_position.trading_account_id = account_id
      and not exists (
        select 1
        from jsonb_array_elements(account_positions) incoming
        where incoming->>'contract' = current_position.contract
          and coalesce(nullif(incoming->>'position_side', ''),
            case when coalesce((incoming->>'size')::numeric, 0) < 0 then 'SHORT' else 'LONG' end)
            = current_position.position_side
      );
  end loop;

  return jsonb_build_object(
    'copy_event_id', cycle_id,
    'accounts', account_count,
    'positions', position_count,
    'observed_at', observed_at
  );
end;
$function$;

-- Worker: unified-member policy and the basis of the peak/day-start that get_copy_worker_context returns per member
-- (operation-period row when present, as there). A null risk_basis is not on a known basis: the worker makes no
-- risk decision for that member until its next observation has restarted peak/day-start.
create or replace function public.get_copy_risk_context()
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog'
as $$
begin
  perform private.require_copy_worker_role();
  return jsonb_build_object(
    'risk_basis', 'MTM_V1',
    'allow_unified_members', coalesce((select c.allow_unified_members from public.copy_system_control c limit 1), false),
    'accounts', coalesce((select jsonb_agg(jsonb_build_object('trading_account_id', a.trading_account_id,
        'risk_basis', case when r.trading_account_id is not null then r.risk_basis else a.risk_basis end))
      from private.copy_current_accounts a
      left join private.copy_operation_risk r on r.trading_account_id = a.trading_account_id
      where a.account_role = 'MEMBER'), '[]'::jsonb));
end;
$$;
revoke all on function public.get_copy_risk_context() from public, anon, authenticated;
grant execute on function public.get_copy_risk_context() to service_role;

-- Review R8: rows stored before this migration are on the wallet basis. Marking them so means the first write after
-- apply only restarts peak/day-start once, at the switch to MTM_V1 (not NULL -> WALLET_V0 -> MTM_V1 when an older
-- worker writes first). Operation-period rows first: the account update below fires observe_copy_operation_risk,
-- which must find them on the same basis. Neither update moves observed_at, so no trigger recomputes a value.
-- Idempotent (only null rows; a null set later by a new operation start is wallet-based too).
update private.copy_operation_risk set risk_basis = 'WALLET_V0' where risk_basis is null;
update private.copy_current_accounts set risk_basis = 'WALLET_V0' where risk_basis is null;
