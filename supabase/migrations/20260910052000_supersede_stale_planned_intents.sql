-- A member account is intentionally allowed to submit only one unsettled order
-- at a time. Supersede an older, never-submitted plan before a fresh cycle
-- inserts its replacement so the duplicate anomaly guard remains fail-closed
-- without treating normal serial execution as a duplicate order loop.
do $$ begin
  if not exists(select 1 from public.copy_system_control
    where singleton and not execution_enabled and emergency_halted) then
    raise exception 'HALTED_DEPLOYMENT_REQUIRED';
  end if;
end $$;

create or replace function private.supersede_stale_planned_copy_intent()
returns trigger
language plpgsql
security definer
set search_path=pg_catalog
as $$
begin
  update private.copy_order_intents existing_intent
  set status='CANCELLED', exchange_terminal=true, resolved_at=clock_timestamp(),
      last_error_code='SUPERSEDED_BY_FRESH_PLAN', updated_at=now()
  where existing_intent.trading_account_id=new.trading_account_id
    and existing_intent.contract=new.contract
    and existing_intent.position_side=new.position_side
    and existing_intent.resume_version is not distinct from new.resume_version
    and existing_intent.cycle_id<>new.cycle_id
    and existing_intent.status in ('PLANNED','QUEUED')
    and existing_intent.submit_attempts=0
    and existing_intent.gate_order_id is null;
  return new;
end;
$$;
revoke all on function private.supersede_stale_planned_copy_intent() from public,anon,authenticated;

drop trigger if exists supersede_stale_planned_copy_intent on private.copy_order_intents;
create trigger supersede_stale_planned_copy_intent
before insert on private.copy_order_intents
for each row when (new.status in ('PLANNED','QUEUED') and new.submit_attempts=0)
execute function private.supersede_stale_planned_copy_intent();

-- The migration is applied only while globally halted, so none of these
-- never-submitted plans can be claimed. A fresh verified cycle recreates only
-- the still-needed plans after LIVE is explicitly enabled again.
update private.copy_order_intents
set status='CANCELLED', exchange_terminal=true, resolved_at=clock_timestamp(),
    last_error_code='SUPERSEDED_DURING_HALTED_MIGRATION', updated_at=now()
where status in ('PLANNED','QUEUED') and submit_attempts=0 and gate_order_id is null;

notify pgrst,'reload schema';
