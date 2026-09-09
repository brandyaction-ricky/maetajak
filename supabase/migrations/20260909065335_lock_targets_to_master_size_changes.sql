-- Copy targets are execution decisions. Persist the Master quantity that made
-- each decision so mark price and account equity drift cannot create trades.
create table private.copy_target_anchors (
  trading_account_id uuid not null references private.trading_accounts(id) on delete cascade,
  contract text not null,
  position_side text not null check (position_side in ('LONG','SHORT')),
  resume_version uuid not null,
  master_copyable_size numeric not null,
  target_size numeric not null,
  protected_member_size numeric not null default 0,
  lock_reason text not null,
  observed_at timestamptz not null,
  updated_at timestamptz not null default now(),
  primary key (trading_account_id, contract, position_side)
);

alter table private.copy_target_anchors enable row level security;
revoke all on private.copy_target_anchors from public, anon, authenticated;

create or replace function public.get_copy_target_anchors()
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
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
      'observed_at', anchor.observed_at
    ) order by anchor.trading_account_id, anchor.contract, anchor.position_side), '[]'::jsonb)
    from private.copy_target_anchors anchor
  );
end;
$$;

revoke all on function public.get_copy_target_anchors() from public, anon, authenticated;
grant execute on function public.get_copy_target_anchors() to service_role;

-- Wrap the existing authoritative cycle write so the position state, order
-- intent, and target anchor commit or roll back together.
create or replace function public.record_copy_worker_cycle_with_target_anchors(p_payload jsonb)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  cycle_id uuid;
  member jsonb;
  position jsonb;
  account_id uuid;
  observed_at timestamptz := coalesce((p_payload->>'observed_at')::timestamptz, clock_timestamp());
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
      if position->>'target_resume_version' is null
        or position->>'master_copyable_size' is null
        or (position->>'target_resume_version')::uuid is distinct from (member->>'resume_version')::uuid then
        continue;
      end if;
      insert into private.copy_target_anchors(
        trading_account_id, contract, position_side, resume_version,
        master_copyable_size, target_size, protected_member_size,
        lock_reason, observed_at, updated_at
      ) values (
        account_id,
        position->>'contract',
        coalesce(nullif(position->>'position_side',''),
          case when (position->>'master_copyable_size')::numeric < 0 then 'SHORT' else 'LONG' end),
        (position->>'target_resume_version')::uuid,
        (position->>'master_copyable_size')::numeric,
        (position->>'target_size')::numeric,
        coalesce((position->>'member_baseline_size')::numeric, 0),
        left(coalesce(nullif(position->>'target_lock_reason',''), 'TARGET_ANCHOR_INITIALIZED'), 80),
        observed_at,
        now()
      )
      on conflict (trading_account_id, contract, position_side) do update set
        resume_version = excluded.resume_version,
        master_copyable_size = excluded.master_copyable_size,
        target_size = excluded.target_size,
        protected_member_size = excluded.protected_member_size,
        lock_reason = excluded.lock_reason,
        observed_at = excluded.observed_at,
        updated_at = now()
      where excluded.observed_at > private.copy_target_anchors.observed_at;
    end loop;
  end loop;
  return cycle_id;
end;
$$;

revoke all on function public.record_copy_worker_cycle_with_target_anchors(jsonb)
  from public, anon, authenticated;
grant execute on function public.record_copy_worker_cycle_with_target_anchors(jsonb)
  to service_role;

comment on table private.copy_target_anchors is
  'One target decision per member position leg. Equity/price drift may reduce risk but cannot increase exposure until Master quantity changes.';
