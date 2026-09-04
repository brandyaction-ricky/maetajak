-- Phase 4: keep the five-second exchange polling and copy decision cadence,
-- while sampling account analytics at one-minute intervals and recording
-- position history only when the actual open-position structure changes.
-- Order intents, fills, retries, state transitions, and audit events remain
-- event-driven and are not sampled.

create table if not exists private.copy_snapshot_checkpoints (
  trading_account_id uuid primary key references private.trading_accounts(id) on delete cascade,
  account_snapshot_at timestamptz,
  position_snapshot_at timestamptz,
  position_structure_hash text not null,
  updated_at timestamptz not null default now()
);
alter table private.copy_snapshot_checkpoints enable row level security;
revoke all on private.copy_snapshot_checkpoints from public, anon, authenticated;

create or replace function public.record_copy_worker_cycle(p_payload jsonb)
returns uuid
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  cycle_id uuid := (p_payload->>'cycle_id')::uuid;
  observed_at timestamptz := coalesce((p_payload->>'observed_at')::timestamptz, now());
  master jsonb := p_payload->'master';
  member jsonb;
  position jsonb;
  account_positions jsonb;
  account_id uuid;
  account_snapshot_id bigint;
  latest_account_snapshot_id bigint;
  previous_state text;
  v_position_side text;
  intent_count integer := 0;
  source_hash text := encode(digest(p_payload::text, 'sha256'), 'hex');
  position_structure_hash text;
  previous_position_structure_hash text;
  previous_account_snapshot_at timestamptz;
  position_changed boolean;
  account_sample_due boolean;
begin
  if auth.role() <> 'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  if master is null or master->>'trading_account_id' is null then raise exception 'MASTER_REQUIRED'; end if;

  insert into private.copy_cycles(id, master_account_id, status, source_version, started_at)
  values (
    cycle_id,
    (master->>'trading_account_id')::uuid,
    'RECONCILING',
    left(p_payload->>'source_version', 160),
    observed_at
  )
  on conflict (id) do nothing;

  account_id := (master->>'trading_account_id')::uuid;
  account_positions := coalesce(master->'positions', '[]'::jsonb);
  select md5(coalesce(string_agg(concat_ws('|',
    item->>'contract',
    coalesce(nullif(item->>'positionSide', ''), case when coalesce((item->>'size')::numeric, 0) < 0 then 'SHORT' else 'LONG' end),
    coalesce((item->>'size')::numeric, 0)::text,
    coalesce(nullif(item->>'entryPrice', '')::numeric, 0)::text,
    coalesce(nullif(item->>'leverage', '')::numeric, 0)::text,
    coalesce(nullif(item->>'quanto_multiplier', '')::numeric, 1)::text
  ), '||' order by item->>'contract', coalesce(nullif(item->>'positionSide', ''), '')), 'EMPTY'))
  into position_structure_hash
  from jsonb_array_elements(account_positions) item
  where coalesce((item->>'size')::numeric, 0) <> 0;

  select checkpoint.position_structure_hash, checkpoint.account_snapshot_at
  into previous_position_structure_hash, previous_account_snapshot_at
  from private.copy_snapshot_checkpoints checkpoint
  where checkpoint.trading_account_id = account_id;

  position_changed := previous_position_structure_hash is distinct from position_structure_hash;
  account_sample_due := previous_account_snapshot_at is null
    or previous_account_snapshot_at <= observed_at - interval '1 minute';
  account_snapshot_id := null;

  if account_sample_due or position_changed then
    insert into private.copy_account_snapshots(
      trading_account_id, total_equity, available_equity, unrealised_pnl, observed_at, source_hash
    ) values (
      account_id,
      greatest(0, (master->>'total')::numeric),
      greatest(0, (master->>'available')::numeric),
      (master->>'unrealisedPnl')::numeric,
      observed_at,
      source_hash
    ) returning id into account_snapshot_id;
  end if;

  if position_changed then
    for position in select value from jsonb_array_elements(account_positions) loop
      if coalesce((position->>'size')::numeric, 0) <> 0
        and coalesce((position->>'markPrice')::numeric, 0) > 0 then
        insert into private.copy_position_snapshots(
          account_snapshot_id, trading_account_id, contract, size, mark_price,
          entry_price, leverage, quanto_multiplier, observed_at, position_side
        ) values (
          account_snapshot_id,
          account_id,
          position->>'contract',
          (position->>'size')::numeric,
          (position->>'markPrice')::numeric,
          nullif(position->>'entryPrice', '')::numeric,
          nullif(position->>'leverage', '')::numeric,
          coalesce(nullif(position->>'quanto_multiplier', '')::numeric, 1),
          observed_at,
          coalesce(nullif(position->>'positionSide', ''),
            case when (position->>'size')::numeric < 0 then 'SHORT' else 'LONG' end)
        );
      end if;
    end loop;
  end if;

  insert into private.copy_snapshot_checkpoints(
    trading_account_id, account_snapshot_at, position_snapshot_at,
    position_structure_hash, updated_at
  ) values (
    account_id,
    case when account_snapshot_id is not null then observed_at end,
    case when position_changed then observed_at end,
    position_structure_hash,
    now()
  ) on conflict (trading_account_id) do update set
    account_snapshot_at = case when account_snapshot_id is not null
      then excluded.account_snapshot_at
      else private.copy_snapshot_checkpoints.account_snapshot_at end,
    position_snapshot_at = case when position_changed
      then excluded.position_snapshot_at
      else private.copy_snapshot_checkpoints.position_snapshot_at end,
    position_structure_hash = excluded.position_structure_hash,
    updated_at = now();

  if account_snapshot_id is null then
    select snapshot.id
    into latest_account_snapshot_id
    from private.copy_account_snapshots snapshot
    where snapshot.trading_account_id = account_id
    order by snapshot.observed_at desc
    limit 1;
  else
    latest_account_snapshot_id := account_snapshot_id;
  end if;

  update private.copy_cycles
  set master_snapshot_id = latest_account_snapshot_id
  where id = cycle_id;

  for member in
    select value from jsonb_array_elements(coalesce(p_payload->'members', '[]'::jsonb))
  loop
    if member->>'error_code' is not null then
      insert into public.copy_events(user_id, event_type, severity, cycle_id, safe_payload)
      values (
        (member->>'user_id')::uuid,
        'ERROR',
        'CRITICAL',
        cycle_id,
        jsonb_build_object('code', left(member->>'error_code', 80))
      );
      continue;
    end if;

    if member->>'risk_halt_reason' in ('DAILY_LOSS_LIMIT', 'MAX_DRAWDOWN_LIMIT') then
      update public.profiles
      set member_halted = true, updated_at = now()
      where id = (member->>'user_id')::uuid;
    end if;

    account_id := (member->>'trading_account_id')::uuid;
    account_positions := coalesce(member->'planned_positions', '[]'::jsonb);
    select md5(coalesce(string_agg(concat_ws('|',
      item->>'contract',
      coalesce(nullif(item->>'position_side', ''), case when coalesce((item->>'size')::numeric, 0) < 0 then 'SHORT' else 'LONG' end),
      coalesce((item->>'size')::numeric, 0)::text,
      coalesce(nullif(item->>'entry_price', '')::numeric, 0)::text,
      coalesce(nullif(item->>'leverage', '')::numeric, 0)::text,
      coalesce(nullif(item->>'quanto_multiplier', '')::numeric, 1)::text
    ), '||' order by item->>'contract', coalesce(nullif(item->>'position_side', ''), '')), 'EMPTY'))
    into position_structure_hash
    from jsonb_array_elements(account_positions) item
    where coalesce((item->>'size')::numeric, 0) <> 0;

    previous_position_structure_hash := null;
    previous_account_snapshot_at := null;
    select checkpoint.position_structure_hash, checkpoint.account_snapshot_at
    into previous_position_structure_hash, previous_account_snapshot_at
    from private.copy_snapshot_checkpoints checkpoint
    where checkpoint.trading_account_id = account_id;

    position_changed := previous_position_structure_hash is distinct from position_structure_hash;
    account_sample_due := previous_account_snapshot_at is null
      or previous_account_snapshot_at <= observed_at - interval '1 minute';
    account_snapshot_id := null;

    if account_sample_due or position_changed then
      insert into private.copy_account_snapshots(
        trading_account_id, total_equity, available_equity, unrealised_pnl, observed_at, source_hash
      ) values (
        account_id,
        greatest(0, (member->>'total')::numeric),
        greatest(0, (member->>'available')::numeric),
        (member->>'unrealisedPnl')::numeric,
        observed_at,
        source_hash
      ) returning id into account_snapshot_id;
    end if;

    for position in select value from jsonb_array_elements(account_positions) loop
      v_position_side := coalesce(nullif(position->>'position_side', ''),
        case when coalesce((position->>'size')::numeric, 0) < 0 then 'SHORT' else 'LONG' end);
      select state.state
      into previous_state
      from public.copy_position_states state
      where state.trading_account_id = account_id
        and state.contract = position->>'contract'
        and state.position_side = v_position_side;

      if position_changed
        and coalesce((position->>'size')::numeric, 0) <> 0
        and coalesce((position->>'mark_price')::numeric, 0) > 0 then
        insert into private.copy_position_snapshots(
          account_snapshot_id, trading_account_id, contract, size, mark_price,
          entry_price, leverage, quanto_multiplier, observed_at, position_side
        ) values (
          account_snapshot_id,
          account_id,
          position->>'contract',
          (position->>'size')::numeric,
          (position->>'mark_price')::numeric,
          nullif(position->>'entry_price', '')::numeric,
          nullif(position->>'leverage', '')::numeric,
          (position->>'quanto_multiplier')::numeric,
          observed_at,
          v_position_side
        );
      end if;

      insert into public.copy_position_states(
        user_id, trading_account_id, contract, state, target_size, actual_size, delta_size,
        previous_actual_size, unexplained_delta, copy_ratio, max_position_ratio,
        drift_tolerance_size, pause_reason, manual_override_confirmed_at,
        last_cycle_id, last_observed_at, updated_at, position_side,
        target_leverage, margin_mode, position_mode
      ) values (
        (member->>'user_id')::uuid,
        account_id,
        position->>'contract',
        position->>'state',
        (position->>'target_size')::numeric,
        (position->>'size')::numeric,
        (position->>'delta_size')::numeric,
        nullif(position->>'previous_actual_size', '')::numeric,
        coalesce((position->>'unexplained_delta')::numeric, 0),
        (member->>'copy_ratio')::numeric,
        (member->>'max_position_ratio')::numeric,
        1,
        nullif(position->>'pause_reason', ''),
        case when position->>'state' = 'MANUAL_OVERRIDE' then now() end,
        cycle_id,
        observed_at,
        now(),
        v_position_side,
        nullif(position->>'target_leverage', '')::numeric,
        nullif(position->>'margin_mode', ''),
        nullif(position->>'position_mode', '')
      ) on conflict (trading_account_id, contract, position_side) do update set
        state = excluded.state,
        target_size = excluded.target_size,
        actual_size = excluded.actual_size,
        delta_size = excluded.delta_size,
        previous_actual_size = excluded.previous_actual_size,
        unexplained_delta = excluded.unexplained_delta,
        copy_ratio = excluded.copy_ratio,
        max_position_ratio = excluded.max_position_ratio,
        pause_reason = excluded.pause_reason,
        target_leverage = excluded.target_leverage,
        margin_mode = excluded.margin_mode,
        position_mode = excluded.position_mode,
        manual_override_confirmed_at = coalesce(
          public.copy_position_states.manual_override_confirmed_at,
          excluded.manual_override_confirmed_at
        ),
        last_cycle_id = excluded.last_cycle_id,
        last_observed_at = excluded.last_observed_at,
        updated_at = now();

      if previous_state is distinct from position->>'state' then
        insert into public.copy_events(user_id, contract, event_type, severity, cycle_id, safe_payload)
        values (
          (member->>'user_id')::uuid,
          position->>'contract',
          case position->>'state'
            when 'MANUAL_OVERRIDE' then 'MANUAL_OVERRIDE_DETECTED'
            when 'SYNCED' then 'POSITION_SYNCED'
            when 'PAUSED' then 'SYMBOL_PAUSED'
            when 'REDUCE_ONLY' then 'RISK_REDUCE_ONLY'
            when 'HALTED' then 'MEMBER_HALTED'
            else 'TARGET_POSITION_CALCULATED'
          end,
          case
            when position->>'state' in ('MANUAL_OVERRIDE', 'ERROR', 'HALTED') then 'CRITICAL'
            when position->>'state' in ('DRIFT', 'PAUSED', 'REDUCE_ONLY') then 'WARNING'
            else 'INFO'
          end,
          cycle_id,
          jsonb_build_object(
            'previous_state', previous_state,
            'state', position->>'state',
            'target_size', position->>'target_size',
            'actual_size', position->>'size'
          )
        );
      end if;

      if position->'intent' is not null then
        insert into private.copy_order_intents(
          cycle_id, user_id, trading_account_id, contract, target_size,
          actual_size_at_plan, delta_size, reduce_only, idempotency_key,
          gate_order_text, status, position_side, target_leverage,
          margin_mode, position_mode, pid
        ) values (
          cycle_id,
          (member->>'user_id')::uuid,
          account_id,
          position->>'contract',
          (position->>'target_size')::numeric,
          (position->>'size')::numeric,
          (position->'intent'->>'delta_size')::numeric,
          (position->'intent'->>'reduce_only')::boolean,
          position->'intent'->>'idempotency_key',
          position->'intent'->>'gate_order_text',
          'PLANNED',
          v_position_side,
          nullif(position->'intent'->>'target_leverage', '')::numeric,
          nullif(position->'intent'->>'margin_mode', ''),
          nullif(position->'intent'->>'position_mode', ''),
          nullif(position->'intent'->>'pid', '')
        ) on conflict (idempotency_key) do nothing;
        intent_count := intent_count + 1;
      end if;
    end loop;

    insert into private.copy_snapshot_checkpoints(
      trading_account_id, account_snapshot_at, position_snapshot_at,
      position_structure_hash, updated_at
    ) values (
      account_id,
      case when account_snapshot_id is not null then observed_at end,
      case when position_changed then observed_at end,
      position_structure_hash,
      now()
    ) on conflict (trading_account_id) do update set
      account_snapshot_at = case when account_snapshot_id is not null
        then excluded.account_snapshot_at
        else private.copy_snapshot_checkpoints.account_snapshot_at end,
      position_snapshot_at = case when position_changed
        then excluded.position_snapshot_at
        else private.copy_snapshot_checkpoints.position_snapshot_at end,
      position_structure_hash = excluded.position_structure_hash,
      updated_at = now();
  end loop;

  update private.copy_cycles
  set status = case when intent_count > 0 then 'PLANNED' else 'COMPLETED' end,
      completed_at = case when intent_count = 0 then now() end
  where id = cycle_id;

  return cycle_id;
end;
$$;

revoke all on function public.record_copy_worker_cycle(jsonb) from public, anon, authenticated;
grant execute on function public.record_copy_worker_cycle(jsonb) to service_role;

comment on function public.record_copy_worker_cycle(jsonb) is
  'Records every copy decision, intent, and state; samples account analytics every minute and position history on structural change.';
