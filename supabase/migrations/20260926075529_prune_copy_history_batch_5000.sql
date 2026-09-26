-- Measured 2026-09-26 on SMALL: one 5000-row run took 1.1 s. Clears the 1-day backlog within hours;
-- in steady state each run deletes ~120 rows, so the larger cap only matters for backlogs.
do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('maetajak-prune-copy-history', '*/10 * * * *',
      $job$set statement_timeout = '2min'; select private.prune_copy_history(interval '1 day', 5000, false, interval '3 days')$job$);
  end if;
end $$;
