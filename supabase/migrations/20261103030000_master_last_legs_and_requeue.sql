-- 2026-11-03 pre-go-live QA, review of Q1 (F2, F3). Apply after 20261030010000 (ordered copy start) and before the
-- 0.6.0 worker.
--
-- F3: public.get_copy_last_master_legs() - service_role only. The Master legs the DB last recorded
--     (private.copy_current_positions / copy_current_accounts of the ACTIVE Master account, the same selection as the
--     worker context): { trading_account_id, observed_at, legs: [{ contract, position_side, size }] }. The 0.6.0
--     worker reads it once per process before its first cycle record (it replaces the anon-facing
--     get_public_master_positions, which stays unchanged for the public monitor).
-- F2: an ordered copy start whose resume ended on RESUME_MASTER_SNAPSHOT_UNCONFIRMED (the worker could not confirm
--     the Master's positions: Master-side, not the member's fault) goes back to QUEUED (reason kept, at most 3
--     requests per member as for the other Master-caused reasons) instead of FAILED.
--     private.copy_start_requeue_master_reason(text) = is_master_pause_reason(text) or that code; the two calls of
--     private.is_master_pause_reason(why) in private.advance_copy_start_queue(boolean,boolean) are replaced by it
--     (anchored patch of the live definition; nothing else in the function changes). is_master_pause_reason itself
--     is unchanged (it is also used for Master-change pauses).
-- Reverse: drop get_copy_last_master_legs(); replace private.copy_start_requeue_master_reason(why) by
--     private.is_master_pause_reason(why) in advance_copy_start_queue; drop the helper.
-- Idempotent. No table or row is changed.
set lock_timeout = '5s';

create or replace function public.get_copy_last_master_legs()
returns jsonb language plpgsql stable security definer set search_path = pg_catalog
as $$
declare master_id uuid; result jsonb;
begin
  perform private.require_copy_worker_role();
  select a.id into master_id from private.trading_accounts a
    where a.account_role = 'MASTER' and a.status = 'ACTIVE' order by a.updated_at desc limit 1;
  select jsonb_build_object(
    'trading_account_id', master_id,
    'observed_at', (select c.observed_at from private.copy_current_accounts c where c.trading_account_id = master_id),
    'legs', coalesce((select jsonb_agg(jsonb_build_object('contract', p.contract, 'position_side', p.position_side,
        'size', p.size) order by p.contract, p.position_side)
      from private.copy_current_positions p where p.trading_account_id = master_id and p.size <> 0), '[]'::jsonb))
    into result;
  return result;
end;
$$;
revoke all on function public.get_copy_last_master_legs() from public, anon, authenticated;
grant execute on function public.get_copy_last_master_legs() to service_role;

create or replace function private.copy_start_requeue_master_reason(p_reason text)
returns boolean language sql immutable set search_path = pg_catalog
as $$
  select private.is_master_pause_reason(p_reason) or coalesce(p_reason, '') = 'RESUME_MASTER_SNAPSHOT_UNCONFIRMED'
$$;
revoke all on function private.copy_start_requeue_master_reason(text) from public, anon, authenticated;

do $patch$
declare
  target regprocedure := to_regprocedure('private.advance_copy_start_queue(boolean,boolean)');
  definition text;
  anchor constant text := 'private.is_master_pause_reason(why)';
  replacement constant text := 'private.copy_start_requeue_master_reason(why)';
  occurrences integer;
begin
  if target is null then
    raise exception 'ORDERED_COPY_START_MISSING: apply 20261030010000_admin_ordered_copy_start.sql first';
  end if;
  definition := pg_get_functiondef(target);
  if position(replacement in definition) > 0 then
    raise notice 'advance_copy_start_queue already requeues RESUME_MASTER_SNAPSHOT_UNCONFIRMED';
    return;
  end if;
  occurrences := (length(definition) - length(replace(definition, anchor, ''))) / length(anchor);
  if occurrences <> 2 then
    raise exception 'ORDERED_COPY_REQUEUE_ANCHOR_MISMATCH: found %, expected 2', occurrences;
  end if;
  execute replace(definition, anchor, replacement);
end;
$patch$;

notify pgrst, 'reload schema';
