-- [03_BUGFIX] 2026-09-24 incident mitigation — 대표 승인("데이터는 지워도 상관없음").
-- Drop the archived write-only position snapshot history (2.15M rows, 844MB) created by
-- 20260924054609_mitigate_archive_position_snapshots_hot_path. Nothing reads it (verified: 0 incoming FKs,
-- 0 functions reference the archive name, 0 view/rule deps). Reduces DB size and daily backup read volume.
set lock_timeout = '10s';
do $$ begin
  if to_regclass('private.copy_position_snapshots_arch_20260924') is null then
    raise exception 'ARCHIVE_NOT_FOUND';
  end if;
  if exists(select 1 from pg_constraint where confrelid = 'private.copy_position_snapshots_arch_20260924'::regclass) then
    raise exception 'ARCHIVE_HAS_INCOMING_FK';
  end if;
  if exists(select 1 from pg_depend d join pg_rewrite r on r.oid = d.objid
            where d.refobjid = 'private.copy_position_snapshots_arch_20260924'::regclass) then
    raise exception 'ARCHIVE_HAS_VIEW_DEPENDENCY';
  end if;
  if pg_get_serial_sequence('private.copy_position_snapshots','id') is distinct from 'private.copy_position_snapshots_id_seq' then
    raise exception 'LIVE_SEQUENCE_UNEXPECTED';
  end if;
end $$;
drop table private.copy_position_snapshots_arch_20260924;
do $$ begin
  if to_regclass('private.copy_position_snapshots_arch_20260924') is not null then
    raise exception 'POSTCHECK_ARCHIVE_STILL_EXISTS';
  end if;
  if to_regclass('private.copy_position_snapshots') is null then
    raise exception 'POSTCHECK_LIVE_TABLE_MISSING';
  end if;
end $$;