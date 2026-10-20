-- 2026-10-19: copy_events noise stopped history pruning.
-- Measured on production (7 days): 120,438 ERROR events (one member's invalid API key, one per
-- 5-second cycle), 11,618 SYMBOL_PAUSED + 11,447 POSITION_SYNCED (one-cycle snapshot-skew holds).
-- Every one of those rows referenced a cycle, and prune_copy_history keeps any cycle an event
-- references, so copy_cycles grew to 268k rows (steady state ~20k) and pinned the Master snapshots
-- those cycles point to. Database 339 MB -> 490 MB in two weeks.
--
-- 1. A repeated ERROR (same user, same code) within 10 minutes is not stored again. The first
--    occurrence and any new code are stored immediately.
-- 2. Noise events (ERROR, SYMBOL_PAUSED, POSITION_SYNCED, TARGET_POSITION_CALCULATED) no longer
--    keep a cycle alive. Deleting such a cycle sets the event's cycle_id to NULL (existing FK
--    ON DELETE SET NULL); the event itself stays.
-- 3. Noise events older than 14 days are deleted in batches. Order, fill,
--    manual-override, halt, reduce-only and cancel events are never deleted here.
-- 4. cron.job_run_details older than 3 days is deleted daily.

set lock_timeout = '5s';

create index if not exists copy_events_occurred_at_idx on public.copy_events(occurred_at);

create or replace function private.throttle_repeated_copy_error_event()
returns trigger
language plpgsql
set search_path to 'pg_catalog'
as $$
begin
  if new.event_type = 'ERROR' and exists (
    select 1 from public.copy_events e
    where e.user_id is not distinct from new.user_id
      and e.event_type = 'ERROR'
      and e.occurred_at > coalesce(new.occurred_at, now()) - interval '10 minutes'
      and (e.safe_payload->>'code') is not distinct from (new.safe_payload->>'code')
  ) then
    return null;
  end if;
  return new;
end;
$$;

create or replace trigger copy_events_throttle_repeated_error
  before insert on public.copy_events
  for each row when (new.event_type = 'ERROR')
  execute function private.throttle_repeated_copy_error_event();

-- Same signature as 20260926075458 (the cron job keeps calling it unchanged); events keep 14 days.
create or replace function private.prune_copy_history(
  p_keep interval default '1 day'::interval,
  p_batch integer default 1000,
  p_dry_run boolean default true,
  p_snapshot_keep interval default '3 days'::interval
)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog'
as $function$
declare
  cycle_cutoff timestamptz := clock_timestamp() - greatest(coalesce(p_keep, interval '1 day'), interval '1 day');
  snapshot_cutoff timestamptz := clock_timestamp()
    - greatest(coalesce(p_snapshot_keep, interval '3 days'), interval '2 days');
  event_cutoff timestamptz := clock_timestamp() - interval '14 days';
  noise text[] := array['ERROR', 'SYMBOL_PAUSED', 'POSITION_SYNCED', 'TARGET_POSITION_CALCULATED'];
  lim integer := least(greatest(coalesce(p_batch, 1000), 1), 20000);
  n_cycles bigint := 0;
  n_snaps bigint := 0;
  n_events bigint := 0;
  k bigint;
  acct record;
begin
  perform set_config('lock_timeout', '5s', true);

  -- A. copy_cycles: old AND unreferenced by any ledger / audit / current-state table.
  --    Noise events do not keep a cycle (their cycle_id becomes NULL on delete).
  if p_dry_run then
    select count(*) into n_cycles from private.copy_cycles c
    where c.created_at < cycle_cutoff
      and not exists (select 1 from private.copy_order_intents x where x.cycle_id = c.id)
      and not exists (select 1 from public.copy_events x where x.cycle_id = c.id and x.event_type <> all(noise))
      and not exists (select 1 from public.copy_position_states x where x.last_cycle_id = c.id)
      and not exists (select 1 from private.copy_current_accounts x where x.copy_cycle_id = c.id)
      and not exists (select 1 from private.copy_current_positions x where x.copy_cycle_id = c.id)
      and not exists (select 1 from private.copy_current_verifications x where x.cycle_id = c.id)
      and not exists (select 1 from private.copy_ownership_checkpoints x where x.source_cycle_id = c.id);
  else
    delete from private.copy_cycles c
    where c.id in (
      select c2.id from private.copy_cycles c2
      where c2.created_at < cycle_cutoff
        and not exists (select 1 from private.copy_order_intents x where x.cycle_id = c2.id)
        and not exists (select 1 from public.copy_events x where x.cycle_id = c2.id and x.event_type <> all(noise))
        and not exists (select 1 from public.copy_position_states x where x.last_cycle_id = c2.id)
        and not exists (select 1 from private.copy_current_accounts x where x.copy_cycle_id = c2.id)
        and not exists (select 1 from private.copy_current_positions x where x.copy_cycle_id = c2.id)
        and not exists (select 1 from private.copy_current_verifications x where x.cycle_id = c2.id)
        and not exists (select 1 from private.copy_ownership_checkpoints x where x.source_cycle_id = c2.id)
      order by c2.created_at
      limit lim);
    get diagnostics n_cycles = row_count;
  end if;

  -- B. copy_account_snapshots: old AND not referenced by a remaining cycle AND not the latest per account.
  for acct in select a.id from private.trading_accounts a loop
    if p_dry_run then
      select count(*) into k from private.copy_account_snapshots s
      where s.trading_account_id = acct.id and s.observed_at < snapshot_cutoff
        and s.id <> coalesce((select l.id from private.copy_account_snapshots l
                              where l.trading_account_id = acct.id order by l.observed_at desc limit 1), -1)
        and not exists (select 1 from private.copy_cycles c where c.master_snapshot_id = s.id);
    else
      delete from private.copy_account_snapshots s
      where s.id in (
        select s2.id from private.copy_account_snapshots s2
        where s2.trading_account_id = acct.id and s2.observed_at < snapshot_cutoff
          and s2.id <> coalesce((select l.id from private.copy_account_snapshots l
                                 where l.trading_account_id = acct.id order by l.observed_at desc limit 1), -1)
          and not exists (select 1 from private.copy_cycles c where c.master_snapshot_id = s2.id)
        order by s2.observed_at
        limit lim);
      get diagnostics k = row_count;
    end if;
    n_snaps := n_snaps + k;
  end loop;

  -- C. Noise events older than the event window.
  if p_dry_run then
    select count(*) into n_events from public.copy_events e
    where e.occurred_at < event_cutoff and e.event_type = any(noise);
  else
    delete from public.copy_events e
    where e.id in (
      select e2.id from public.copy_events e2
      where e2.occurred_at < event_cutoff and e2.event_type = any(noise)
      order by e2.occurred_at
      limit lim);
    get diagnostics n_events = row_count;
  end if;

  return jsonb_build_object('dry_run', p_dry_run, 'cycle_cutoff', cycle_cutoff,
    'snapshot_cutoff', snapshot_cutoff, 'event_cutoff', event_cutoff, 'batch', lim,
    'cycles', n_cycles, 'account_snapshots', n_snaps, 'events', n_events);
end;
$function$;

revoke all on function private.prune_copy_history(interval, integer, boolean, interval) from public, anon, authenticated;

create or replace function private.prune_cron_run_details(p_keep interval default '3 days')
returns bigint
language plpgsql
security definer
set search_path to 'pg_catalog'
as $$
declare n bigint;
begin
  delete from cron.job_run_details where end_time < now() - greatest(coalesce(p_keep, interval '3 days'), interval '1 day');
  get diagnostics n = row_count;
  return n;
end;
$$;
revoke all on function private.prune_cron_run_details(interval) from public, anon, authenticated;
revoke all on function private.throttle_repeated_copy_error_event() from public, anon, authenticated;

do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('maetajak-prune-cron-run-details', '17 3 * * *',
      $job$select private.prune_cron_run_details(interval '3 days')$job$);
  end if;
end $$;
