-- [03_BUGFIX] 2026-09-24 incident mitigation (대표 승인: 정리 도입 — 삭제 없는 방식)
-- Move write-only position snapshot history (2.18M rows, 844MB incl. 571MB indexes) out of the
-- hot path WITHOUT deleting data. Evidence (prod, all schemas): only public.record_copy_worker_cycle
-- references this table (INSERT only); no views/rules/publications; no incoming FKs.
-- The archive keeps every row. Reversible: rename back.
set lock_timeout = '10s';

do $$ begin
  if to_regclass('private.copy_position_snapshots_arch_20260924') is not null then
    raise exception 'ARCHIVE_ALREADY_EXISTS';
  end if;
  if (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname not in ('pg_catalog','information_schema')
        and p.prosrc ~* '\mcopy_position_snapshots\M') <> 1 then
    raise exception 'UNEXPECTED_READERS_OF_COPY_POSITION_SNAPSHOTS';
  end if;
  if exists(select 1 from pg_constraint where confrelid = 'private.copy_position_snapshots'::regclass) then
    raise exception 'UNEXPECTED_INCOMING_FK';
  end if;
end $$;

alter table private.copy_position_snapshots rename to copy_position_snapshots_arch_20260924;
alter table private.copy_position_snapshots_arch_20260924 rename constraint copy_position_snapshots_pkey to cps_arch_20260924_pkey;
alter table private.copy_position_snapshots_arch_20260924 rename constraint copy_position_snapshots_account_contract_side_key to cps_arch_20260924_acs_key;
alter table private.copy_position_snapshots_arch_20260924 rename constraint copy_position_snapshots_mark_price_check to cps_arch_20260924_mark_price_check;
alter table private.copy_position_snapshots_arch_20260924 rename constraint copy_position_snapshots_quanto_multiplier_check to cps_arch_20260924_quanto_check;
alter table private.copy_position_snapshots_arch_20260924 rename constraint copy_position_snapshots_trading_account_id_fkey to cps_arch_20260924_trading_account_fkey;
-- decouple archive from account-snapshot lifecycle (no cascade into archive later)
alter table private.copy_position_snapshots_arch_20260924 drop constraint copy_position_snapshots_account_snapshot_id_fkey;
alter index private.copy_position_snapshots_latest_idx rename to cps_arch_20260924_latest_idx;
alter index private.copy_position_snapshots_leg_latest_idx rename to cps_arch_20260924_leg_latest_idx;
alter sequence private.copy_position_snapshots_id_seq rename to cps_arch_20260924_id_seq;

create table private.copy_position_snapshots (
  id bigint generated always as identity (start with 2177613),
  account_snapshot_id bigint not null,
  trading_account_id uuid not null,
  contract text not null,
  size numeric not null,
  mark_price numeric not null,
  entry_price numeric,
  leverage numeric,
  quanto_multiplier numeric not null,
  observed_at timestamptz not null,
  created_at timestamptz not null default now(),
  position_side text not null default 'LONG'::text,
  constraint copy_position_snapshots_pkey primary key (id),
  constraint copy_position_snapshots_account_contract_side_key unique (account_snapshot_id, contract, position_side),
  constraint copy_position_snapshots_mark_price_check check (mark_price > (0)::numeric),
  constraint copy_position_snapshots_quanto_multiplier_check check (quanto_multiplier > (0)::numeric),
  constraint copy_position_snapshots_trading_account_id_fkey foreign key (trading_account_id)
    references private.trading_accounts(id) on delete cascade,
  constraint copy_position_snapshots_account_snapshot_id_fkey foreign key (account_snapshot_id)
    references private.copy_account_snapshots(id) on delete cascade
);
alter table private.copy_position_snapshots enable row level security;
revoke all on private.copy_position_snapshots from public, anon, authenticated, service_role;

do $$ begin
  if (select count(*) from pg_constraint where conrelid = 'private.copy_position_snapshots'::regclass) <> 6 then
    raise exception 'POSTCHECK_CONSTRAINT_COUNT';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'private.copy_position_snapshots'::regclass) then
    raise exception 'POSTCHECK_RLS';
  end if;
  if (select count(*) from pg_attribute where attrelid = 'private.copy_position_snapshots'::regclass and attnum > 0 and not attisdropped) <> 12 then
    raise exception 'POSTCHECK_COLUMN_COUNT';
  end if;
  if to_regclass('private.copy_position_snapshots_arch_20260924') is null then
    raise exception 'POSTCHECK_ARCHIVE_MISSING';
  end if;
end $$;