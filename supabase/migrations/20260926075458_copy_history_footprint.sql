-- [03_BUGFIX / perf] Copy-history footprint (대표 승인 2026-09-26: "모두 진행").
-- Incident 2026-09-26 16:00 KST: the DB ran on NANO (0.5 GB), the TTL job's 8-minute delete
-- starved it and every RPC timed out (PGRST002) until the resize to SMALL at 16:38.
-- Measured before this change: copy_account_snapshots 217 MB for 7 MB of live rows,
-- copy_cycles 229 MB for 35 MB; the bulk was dead space and index bloat, not live data.
--
-- 1) Retention: cycles that no ledger/audit/current-state row references keep 1 day (was 3).
--    Referenced cycles are never deleted (same 7 references as before). Account snapshots keep
--    their own window (default 3 days) and the latest per account; admin metrics read only the
--    latest 30 per account. Hard floors: cycles 1 day, snapshots 2 days.
-- 2) Autovacuum on the two churn tables runs at 2% dead rows instead of the 20% default, so
--    space freed by the TTL job is reused instead of growing the files.
-- 3) The recurring job keeps 1 day of unreferenced cycles and runs each batch under 2 minutes.
-- No worker change: the worker still writes one cycle row per cycle (FK target for intents,
-- events and states), so this migration does not require a worker deploy or a LIVE restart.

drop function if exists private.prune_copy_history(interval, integer, boolean);

create or replace function private.prune_copy_history(
  p_keep interval default interval '1 day',
  p_batch integer default 1000,
  p_dry_run boolean default true,
  p_snapshot_keep interval default interval '3 days'
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  cycle_cutoff timestamptz := clock_timestamp() - greatest(coalesce(p_keep, interval '1 day'), interval '1 day');
  snapshot_cutoff timestamptz := clock_timestamp()
    - greatest(coalesce(p_snapshot_keep, interval '3 days'), interval '2 days');
  lim integer := least(greatest(coalesce(p_batch, 1000), 1), 20000);
  n_cycles bigint := 0;
  n_snaps bigint := 0;
  k bigint;
  acct record;
begin
  perform set_config('lock_timeout', '5s', true);

  -- A. copy_cycles: old AND unreferenced by any ledger / audit / current-state table.
  if p_dry_run then
    select count(*) into n_cycles from private.copy_cycles c
    where c.created_at < cycle_cutoff
      and not exists (select 1 from private.copy_order_intents x where x.cycle_id = c.id)
      and not exists (select 1 from public.copy_events x where x.cycle_id = c.id)
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
        and not exists (select 1 from public.copy_events x where x.cycle_id = c2.id)
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

  return jsonb_build_object('dry_run', p_dry_run, 'cycle_cutoff', cycle_cutoff,
    'snapshot_cutoff', snapshot_cutoff, 'batch', lim,
    'cycles', n_cycles, 'account_snapshots', n_snaps);
end;
$$;

revoke all on function private.prune_copy_history(interval, integer, boolean, interval)
  from public, anon, authenticated, service_role;

alter table private.copy_cycles set (
  autovacuum_vacuum_scale_factor = 0.02, autovacuum_vacuum_threshold = 1000,
  autovacuum_analyze_scale_factor = 0.02, autovacuum_analyze_threshold = 1000);
alter table private.copy_account_snapshots set (
  autovacuum_vacuum_scale_factor = 0.02, autovacuum_vacuum_threshold = 500,
  autovacuum_analyze_scale_factor = 0.02, autovacuum_analyze_threshold = 500);

-- Recurring TTL job (production jobid 2, same name → updated in place).
do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('maetajak-prune-copy-history', '*/10 * * * *',
      $job$set statement_timeout = '2min'; select private.prune_copy_history(interval '1 day', 1000, false, interval '3 days')$job$);
  end if;
end $$;
