-- 2026-10-19: a risk cap no longer permanently consumes copied quantity.
--
-- An anchor stored only the capped target. When a member's position cap (max_position_ratio of
-- equity) bound - for example while a contract's price rose - the stored target shrank one or two
-- contracts at a time (XAU_USDT: ~60 one-lot sells per member per day on 2026-10-12/13) and never grew
-- back after the price fell, because the next cycle started from the already-capped anchor.
--
-- The worker now also sends the target it would hold without the current cap
-- (`anchor_desired_target_size`). It is stored together with the target it belongs to
-- (`desired_basis_*`: target_size, resume_version and master_copyable_size of that write). It is
-- returned only while all three are unchanged, so any other anchor writer (resume preparation,
-- ownership absorption, a member-reduced lock, an administrative resync) automatically invalidates it. Worker 0.5.0 sends no desired size:
-- the columns stay null and behaviour is unchanged.

set lock_timeout = '5s';

alter table private.copy_target_anchors
  add column if not exists desired_target_size numeric,
  add column if not exists desired_basis_target_size numeric,
  add column if not exists desired_basis_resume_version uuid,
  add column if not exists desired_basis_master_size numeric;

create or replace function public.record_copy_worker_cycle_with_target_anchors(p_payload jsonb)
returns uuid
language plpgsql
security definer
set search_path to 'pg_catalog'
as $function$
declare
  cycle_id uuid;
  member jsonb;
  position jsonb;
  account_id uuid;
  observed_at timestamptz := coalesce((p_payload->>'observed_at')::timestamptz, clock_timestamp());
  desired numeric;
  anchor_master numeric;
begin
  perform private.require_copy_worker_role();
  cycle_id := public.record_copy_worker_cycle(p_payload);

  for member in
    select value from jsonb_array_elements(coalesce(p_payload->'members', '[]'::jsonb))
  loop
    if member->>'error_code' is not null or member->>'resume_version' is null then
      continue;
    end if;
    account_id := (member->>'trading_account_id')::uuid;
    for position in
      select value from jsonb_array_elements(coalesce(member->'planned_positions', '[]'::jsonb))
    loop
      if position->>'anchor_update_allowed'='false'
        or position->>'target_resume_version' is null
        or position->>'master_copyable_size' is null
        or (position->>'target_resume_version')::uuid is distinct from (member->>'resume_version')::uuid then
        continue;
      end if;
      -- A desired size must be on the target's side (or zero) and never smaller than the target.
      desired := nullif(position->>'anchor_desired_target_size', '')::numeric;
      if desired is not null and not (
        sign(desired) in (0, sign((position->>'target_size')::numeric))
        and abs(desired) >= abs((position->>'target_size')::numeric)) then
        desired := null;
      end if;
      -- The consumed quantity must lie between zero and the observed copyable size, on its side.
      anchor_master := case when nullif(position->>'anchor_master_copyable_size','') is not null
          and sign((position->>'anchor_master_copyable_size')::numeric)
            in (0, sign((position->>'master_copyable_size')::numeric))
          and abs((position->>'anchor_master_copyable_size')::numeric)
            <= abs((position->>'master_copyable_size')::numeric)
          then (position->>'anchor_master_copyable_size')::numeric
          else (position->>'master_copyable_size')::numeric end;
      insert into private.copy_target_anchors(
        trading_account_id, contract, position_side, resume_version,
        master_copyable_size, target_size, protected_member_size,
        lock_reason, observed_at, updated_at, desired_target_size, desired_basis_target_size,
        desired_basis_resume_version, desired_basis_master_size
      ) values (
        account_id,
        position->>'contract',
        coalesce(nullif(position->>'position_side',''),
          case when (position->>'master_copyable_size')::numeric < 0 then 'SHORT' else 'LONG' end),
        (position->>'target_resume_version')::uuid,
        anchor_master,
        (position->>'target_size')::numeric,
        coalesce((position->>'member_baseline_size')::numeric, 0),
        left(coalesce(nullif(position->>'target_lock_reason',''), 'TARGET_ANCHOR_INITIALIZED'), 80),
        observed_at,
        now(),
        desired,
        case when desired is null then null else (position->>'target_size')::numeric end,
        case when desired is null then null else (position->>'target_resume_version')::uuid end,
        case when desired is null then null else anchor_master end
      )
      on conflict (trading_account_id, contract, position_side) do update set
        resume_version = excluded.resume_version,
        master_copyable_size = excluded.master_copyable_size,
        target_size = excluded.target_size,
        protected_member_size = excluded.protected_member_size,
        lock_reason = excluded.lock_reason,
        observed_at = excluded.observed_at,
        updated_at = now(),
        desired_target_size = excluded.desired_target_size,
        desired_basis_target_size = excluded.desired_basis_target_size,
        desired_basis_resume_version = excluded.desired_basis_resume_version,
        -- The stored Master quantity of this same write (after the consumed-quantity rule above).
        desired_basis_master_size = excluded.desired_basis_master_size
      where excluded.observed_at > private.copy_target_anchors.observed_at;
    end loop;
  end loop;
  return cycle_id;
end;
$function$;

create or replace function public.get_copy_target_anchors()
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog'
as $function$
begin
  perform private.require_copy_worker_role();
  return (
    select coalesce(jsonb_agg(jsonb_build_object(
      'trading_account_id', anchor.trading_account_id,
      'contract', anchor.contract,
      'position_side', anchor.position_side,
      'resume_version', anchor.resume_version,
      'master_copyable_size', anchor.master_copyable_size,
      'target_size', anchor.target_size,
      'protected_member_size', anchor.protected_member_size,
      'lock_reason', anchor.lock_reason,
      'observed_at', anchor.observed_at,
      -- Valid only while target_size is still the value it was stored with.
      'desired_target_size', case when anchor.desired_basis_target_size = anchor.target_size
          and anchor.desired_basis_resume_version = anchor.resume_version
          and anchor.desired_basis_master_size = anchor.master_copyable_size
        then anchor.desired_target_size end
    ) order by anchor.trading_account_id, anchor.contract, anchor.position_side), '[]'::jsonb)
    from private.copy_target_anchors anchor
  );
end;
$function$;
