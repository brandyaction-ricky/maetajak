-- [03_BUGFIX] Retention (TTL) for write-only telemetry — 대표 승인: 보존 3일, 10분 주기 자동 삭제.
-- Deletes ONLY copy_cycles / copy_account_snapshots (copy_position_snapshots cascades via FK).
-- NEVER deletes ledger/audit tables. Protected cycles (7 references, verified in prod catalog):
--   copy_order_intents.cycle_id, copy_events.cycle_id, copy_position_states.last_cycle_id,
--   copy_current_accounts.copy_cycle_id, copy_current_positions.copy_cycle_id,
--   copy_current_verifications.cycle_id, copy_ownership_checkpoints.source_cycle_id.
-- Protected account snapshots: referenced by any remaining cycle (FK RESTRICT) + latest per account
--   (record_copy_worker_cycle reads it). Retention floor: 2 days (hard). Default: 3 days, dry-run.
create or replace function private.prune_copy_history(
  p_keep interval default interval '3 days',
  p_batch integer default 5000,
  p_dry_run boolean default true
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  cutoff timestamptz := clock_timestamp() - greatest(coalesce(p_keep, interval '3 days'), interval '2 days');
  lim integer := least(greatest(coalesce(p_batch, 5000), 1), 20000);
  n_cycles bigint := 0;
  n_snaps bigint := 0;
  k bigint;
  acct record;
begin
  perform set_config('lock_timeout', '5s', true);

  -- A. copy_cycles: old AND unreferenced by any ledger / audit / current-state table.
  if p_dry_run then
    select count(*) into n_cycles from private.copy_cycles c
    where c.created_at < cutoff
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
      where c2.created_at < cutoff
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
      where s.trading_account_id = acct.id and s.observed_at < cutoff
        and s.id <> coalesce((select l.id from private.copy_account_snapshots l
                              where l.trading_account_id = acct.id order by l.observed_at desc limit 1), -1)
        and not exists (select 1 from private.copy_cycles c where c.master_snapshot_id = s.id);
    else
      delete from private.copy_account_snapshots s
      where s.id in (
        select s2.id from private.copy_account_snapshots s2
        where s2.trading_account_id = acct.id and s2.observed_at < cutoff
          and s2.id <> coalesce((select l.id from private.copy_account_snapshots l
                                 where l.trading_account_id = acct.id order by l.observed_at desc limit 1), -1)
          and not exists (select 1 from private.copy_cycles c where c.master_snapshot_id = s2.id)
        order by s2.observed_at
        limit lim);
      get diagnostics k = row_count;
    end if;
    n_snaps := n_snaps + k;
  end loop;

  return jsonb_build_object('dry_run', p_dry_run, 'cutoff', cutoff, 'batch', lim,
    'cycles', n_cycles, 'account_snapshots', n_snaps);
end;
$$;
revoke all on function private.prune_copy_history(interval, integer, boolean)
  from public, anon, authenticated, service_role;