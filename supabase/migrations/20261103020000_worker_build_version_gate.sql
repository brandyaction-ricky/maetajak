-- 2026-11-03 pre-go-live QA Q4: identifiable worker builds.
--
-- Deploys now write WORKER_VERSION as "<package.json version>+<git short SHA>" (deploy/worker-version.sh), e.g.
-- "0.6.0+1a2b3c4d5e6f", so copy_worker_runtime.worker_version tells the old and the new worker apart. Two order-path
-- gates compared the heartbeat version with the literal '0.5.0' (production pg_get_functiondef 2026-11-03, one
-- occurrence each): public.claim_copy_order_intents(integer) and public.authorize_copy_order_submission(uuid,uuid).
-- Left as is, a 0.6.0 worker would heartbeat normally but never claim or authorize an order.
--
-- This migration
--   * adds private.copy_worker_version_supported(text): true for '0.5.0' (the worker running today, and a reviewed
--     rollback to it) and for '0.6.0' with an optional "+<build>" suffix ([0-9A-Za-z.-], at most 60 characters);
--   * replaces exactly that one comparison in each gate with the helper (anchored patch of the live definition,
--     nothing else in the functions changes; CREATE OR REPLACE keeps owner and grants);
--   * adds 'worker_build_version_gate',1 to get_copy_safety_version() (its other keys unchanged, worker_version
--     stays '0.5.0' = the DB contract the auto-deploy already checks), so deploy/lightsail-auto-deploy.sh can refuse to
--     deploy a 0.6.0 worker onto a database without this gate.
-- Deploy order: apply this migration BEFORE the 0.6.0 worker. If the worker were deployed first, the DB would refuse
-- its claims (no order, fail-closed), not accept wrong ones.
-- Reverse: replace private.copy_worker_version_supported(r.worker_version) by r.worker_version='0.5.0' in the two
-- functions (same anchored replace), restore get_copy_safety_version() from 20260925002511, drop the helper.
-- Idempotent: a function that already calls the helper is skipped.
set lock_timeout = '5s';

create or replace function private.copy_worker_version_supported(p_version text)
returns boolean language sql immutable set search_path = pg_catalog
as $$
  select coalesce(p_version = '0.5.0' or p_version ~ '^0\.6\.0(\+[0-9A-Za-z][0-9A-Za-z.-]{0,59})?$', false)
$$;
revoke all on function private.copy_worker_version_supported(text) from public, anon, authenticated;
comment on function private.copy_worker_version_supported(text) is
  'Worker builds allowed to claim/authorize orders: 0.5.0 and 0.6.0[+build] (2026-11-03 Q4). Extend for a new protocol release.';

do $patch$
declare
  target regprocedure;
  definition text;
  anchor constant text := $a$r.worker_version='0.5.0'$a$;
  replacement constant text := $r$private.copy_worker_version_supported(r.worker_version)$r$;
  occurrences integer;
begin
  foreach target in array array['public.claim_copy_order_intents(integer)'::regprocedure,
    'public.authorize_copy_order_submission(uuid,uuid)'::regprocedure]
  loop
    definition := pg_get_functiondef(target);
    if position(replacement in definition) > 0 then
      raise notice '% already uses copy_worker_version_supported', target;
      continue;
    end if;
    occurrences := (length(definition) - length(replace(definition, anchor, ''))) / length(anchor);
    if occurrences <> 1 then
      raise exception 'WORKER_VERSION_GATE_ANCHOR_MISMATCH: % (found %, expected 1)', target, occurrences;
    end if;
    execute replace(definition, anchor, replacement);
  end loop;
end;
$patch$;

create or replace function public.get_copy_safety_version()
returns jsonb language plpgsql security definer set search_path=pg_catalog
as $$
begin
  perform private.require_copy_worker_role();
  return jsonb_build_object('schema_version',3,'worker_version','0.5.0','resume_requires_validation',true,
    'current_state_atomic',true,'trade_alert_exchange_verification',true,'reliability_patch',1,
    'member_own_position_absorption',1,'worker_build_version_gate',1);
end;
$$;
revoke all on function public.get_copy_safety_version() from public,anon,authenticated;
grant execute on function public.get_copy_safety_version() to service_role;

notify pgrst, 'reload schema';
