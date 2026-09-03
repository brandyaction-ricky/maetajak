-- Repair the production RPC's service-role check. PostgREST exposes the JWT
-- role through auth.role(); the legacy per-claim GUC is not populated for this
-- request path.

create or replace function public.upsert_copy_current_state(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
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
        unrealised_pnl, observed_at::date, total_equity, total_equity,
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

    insert into private.copy_current_accounts (
      trading_account_id, user_id, account_role, total_equity, available_equity,
      unrealised_pnl, equity_day, day_start_equity, peak_equity, source_hash,
      copy_cycle_id, observed_at, updated_at
    ) values (
      account_id, account_user_id, account_role, total_equity, available_equity,
      unrealised_pnl, observed_at::date, total_equity, total_equity,
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
$$;

revoke all on function public.upsert_copy_current_state(jsonb) from public, anon, authenticated;
grant execute on function public.upsert_copy_current_state(jsonb) to service_role;
