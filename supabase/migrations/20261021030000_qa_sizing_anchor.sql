-- 2026-10-21 QA (areas B/D): copy target anchors carry what the worker needs for FUTURE_ONLY sizing.
--
-- The worker (planMemberPositions) may now send, per planned leg:
--   anchor_target_size            the quantity to anchor instead of target_size. Sent while the leg cannot
--                                 increase (member reduce-only/halted/paused, protected opposite holding,
--                                 system halt, execution disabled, non-LIVE worker): the Master increase the
--                                 member did not buy is consumed, so it is never bought later at another price.
--   anchor_reference_master_size  the Master quantity the anchored COPY decision corresponds to (<= the stored
--                                 Master quantity). A Master reduction first sells the uncopied part above it.
--   anchor_max_position_ratio     the position ratio the held quantity was established under; a ratio lowered
--                                 later limits only increases (operator policy "이후 거래부터 적용").
-- and the observed Master copyable quantity (master_copyable_size) is kept as observed_master_size.
--
-- The three values are returned by get_copy_target_anchors only while the anchor still has the resume version
-- and Master quantity of the worker write that stored them (sizing_basis_*), so every other anchor writer
-- (resume preparation, administrative resync) automatically invalidates them; the worker then falls back to the
-- previous behaviour. A member's own-quantity absorption (observe_copy_ownership) keeps both and so keeps them.
-- Worker 0.5.0 sends none of the new fields: anchors behave exactly as before. Idempotent; no data is removed.

set lock_timeout = '5s';

alter table private.copy_target_anchors
  add column if not exists reference_master_size numeric,
  add column if not exists observed_master_size numeric,
  add column if not exists max_position_ratio numeric,
  add column if not exists sizing_basis_master_size numeric,
  add column if not exists sizing_basis_resume_version uuid;

-- Based on 20261019060200_target_anchor_desired_size.sql; the new parts are marked "2026-10-21".
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
  anchor_target numeric;
  reference numeric;
  ratio numeric;
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
      -- 2026-10-21: a consumed increase anchors the held quantity: on the target's side (or zero), never larger.
      anchor_target := nullif(position->>'anchor_target_size', '')::numeric;
      if anchor_target is null or not (
        sign(anchor_target) in (0, sign((position->>'target_size')::numeric))
        and abs(anchor_target) <= abs((position->>'target_size')::numeric)) then
        anchor_target := (position->>'target_size')::numeric;
      end if;
      -- A desired size must be on the anchored target's side (or zero) and never smaller than it.
      desired := nullif(position->>'anchor_desired_target_size', '')::numeric;
      if desired is not null and not (
        sign(desired) in (0, sign(anchor_target))
        and abs(desired) >= abs(anchor_target)) then
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
      -- 2026-10-21: the reference lies between zero and the stored Master quantity, on its side.
      reference := nullif(position->>'anchor_reference_master_size', '')::numeric;
      if reference is not null and not (sign(reference) in (0, sign(anchor_master)) and abs(reference) <= abs(anchor_master)) then
        reference := null;
      end if;
      ratio := nullif(position->>'anchor_max_position_ratio', '')::numeric;
      if ratio is not null and not (ratio > 0 and ratio <= 100) then
        ratio := null;
      end if;
      insert into private.copy_target_anchors(
        trading_account_id, contract, position_side, resume_version,
        master_copyable_size, target_size, protected_member_size,
        lock_reason, observed_at, updated_at, desired_target_size, desired_basis_target_size,
        desired_basis_resume_version, desired_basis_master_size,
        reference_master_size, observed_master_size, max_position_ratio,
        sizing_basis_master_size, sizing_basis_resume_version
      ) values (
        account_id,
        position->>'contract',
        coalesce(nullif(position->>'position_side',''),
          case when (position->>'master_copyable_size')::numeric < 0 then 'SHORT' else 'LONG' end),
        (position->>'target_resume_version')::uuid,
        anchor_master,
        anchor_target,
        coalesce((position->>'member_baseline_size')::numeric, 0),
        left(coalesce(nullif(position->>'target_lock_reason',''), 'TARGET_ANCHOR_INITIALIZED'), 80),
        observed_at,
        now(),
        desired,
        case when desired is null then null else anchor_target end,
        case when desired is null then null else (position->>'target_resume_version')::uuid end,
        case when desired is null then null else anchor_master end,
        reference,
        (position->>'master_copyable_size')::numeric,
        ratio,
        anchor_master,
        (position->>'target_resume_version')::uuid
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
        desired_basis_master_size = excluded.desired_basis_master_size,
        reference_master_size = excluded.reference_master_size,
        observed_master_size = excluded.observed_master_size,
        max_position_ratio = excluded.max_position_ratio,
        sizing_basis_master_size = excluded.sizing_basis_master_size,
        sizing_basis_resume_version = excluded.sizing_basis_resume_version
      where excluded.observed_at > private.copy_target_anchors.observed_at;
    end loop;
  end loop;
  return cycle_id;
end;
$function$;

revoke all on function public.record_copy_worker_cycle_with_target_anchors(jsonb) from public, anon, authenticated;
grant execute on function public.record_copy_worker_cycle_with_target_anchors(jsonb) to service_role;

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
        then anchor.desired_target_size end,
      -- 2026-10-21: valid only while the Master quantity and resume version are those of the worker write.
      'reference_master_size', case when sizing.valid then anchor.reference_master_size end,
      'observed_master_size', case when sizing.valid then anchor.observed_master_size end,
      'max_position_ratio', case when sizing.valid then anchor.max_position_ratio end
    ) order by anchor.trading_account_id, anchor.contract, anchor.position_side), '[]'::jsonb)
    from private.copy_target_anchors anchor
    cross join lateral (select anchor.sizing_basis_master_size = anchor.master_copyable_size
      and anchor.sizing_basis_resume_version = anchor.resume_version as valid) sizing
  );
end;
$function$;

revoke all on function public.get_copy_target_anchors() from public, anon, authenticated;
grant execute on function public.get_copy_target_anchors() to service_role;
