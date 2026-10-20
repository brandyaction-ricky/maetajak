import test, { before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createVerifiedDatabase, seedVerifiedAccount, cyclePayload, record, ids, position } from './fixtures/verified-runtime.js';

// 2026-10-20 DB QA fixes (supabase/migrations/20261020020000_qa_fixes.sql).
const MIGRATION = 'supabase/migrations/20261020020000_qa_fixes.sql';
const admin = '20000000-0000-4000-8000-0000000000aa';
let db;
const one = async (sql, args = []) => (await db.query(sql, args)).rows[0];
const n = async (sql, args = []) => Number((await one(sql, args)).n);
async function rejects(sql, args, pattern) {
  await db.exec('savepoint qa_expect');
  try { await assert.rejects(db.query(sql, args), pattern); }
  finally { await db.exec('rollback to savepoint qa_expect'); }
}
const rerunMigration = () => db.exec(readFileSync(MIGRATION, 'utf8'));

before(async () => {
  db = await createVerifiedDatabase();
  // Objects production has but the structural fixture does not (test-only stubs, no data).
  await db.exec(`create table if not exists private.gate_api_verification_jobs (
      id bigint generated always as identity primary key, user_id uuid not null unique,
      attempts integer not null default 0, run_after timestamptz not null default now(), claimed_at timestamptz,
      created_at timestamptz not null default now(), updated_at timestamptz not null default now());
    create or replace function extensions.pgp_sym_encrypt(text,text,text) returns bytea language sql as $$ select convert_to('TEST_ONLY','UTF8') $$;
    create or replace function extensions.gen_random_bytes(integer) returns bytea language sql as $$ select decode(repeat('00',$1),'hex') $$;`);
});
after(async () => { await db?.close(); });
beforeEach(async () => { await db.exec('begin'); await seedVerifiedAccount(db); });
afterEach(async () => { await db.exec('rollback'); });

// ---- 1. KST business days ----
test('KST: current-state equity_day is the Asia/Seoul date of the observation', async () => {
  // 2026-10-19 16:30 UTC is 2026-10-20 01:30 KST.
  await db.query('select public.upsert_copy_current_state($1)', [{ observed_at: '2026-10-19T16:30:00Z',
    members: [{ trading_account_id: ids.member, user_id: ids.user, total_equity: 1000, available_equity: 1000, positions: [] }] }]);
  const row = await one("select equity_day::text d from private.copy_current_accounts where trading_account_id=$1", [ids.member]);
  assert.equal(row.d, '2026-10-20');
});

// Production text of get_my_dashboard_performance_range before this migration (pg_get_functiondef).
const productionDashboardRange = `CREATE OR REPLACE FUNCTION public.get_my_dashboard_performance_range(p_start_date date, p_end_date date)
 RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
declare result jsonb;
declare started_on date;
declare range_start date;
declare range_end date;
begin
  if not exists (select 1 from public.profiles where id = auth.uid() and role = 'MEMBER' and approval_status = 'APPROVED') then
    raise exception 'APPROVED_MEMBER_REQUIRED';
  end if;
  select coalesce(copy_started_at::date, current_date) into started_on from public.profiles where id = auth.uid();
  range_start := greatest(started_on, coalesce(p_start_date, started_on));
  range_end := least(current_date, coalesce(p_end_date, current_date));
  if range_start > range_end then raise exception 'INVALID_DATE_RANGE'; end if;
  if range_end - range_start > 365 then raise exception 'DATE_RANGE_TOO_LARGE'; end if;
  with daily as (
    select trading_date, closing_equity, realised_pnl - fees + funding_pnl as net_pnl, daily_return_pct
    from public.member_daily_performance
    where user_id = auth.uid() and trading_date between range_start and range_end
  )
  select jsonb_build_object('started_on', started_on, 'range_start', range_start, 'range_end', range_end,
    'days', coalesce((select jsonb_agg(jsonb_build_object('date', trading_date, 'net_pnl', net_pnl) order by trading_date) from daily), '[]'::jsonb)
  ) into result;
  return result;
end;
$function$`;

test('KST: dashboard "today" follows Asia/Seoul, not the session time zone (00:00-09:00 KST case)', async () => {
  await db.exec(`create table public.member_daily_performance (user_id uuid, trading_date date, closing_equity numeric,
    realised_pnl numeric default 0, fees numeric default 0, funding_pnl numeric default 0, daily_return_pct numeric)`);
  await db.exec(productionDashboardRange);
  // A session time zone whose date differs from the KST date right now (UTC-12 or UTC+14 always covers it).
  const { tz } = await one(`select case when (now() at time zone 'Etc/GMT+12')::date <> (now() at time zone 'Asia/Seoul')::date
    then 'Etc/GMT+12' else 'Etc/GMT-14' end tz`);
  await db.exec(`set local timezone = '${tz}'`);
  const kst = (await one("select (now() at time zone 'Asia/Seoul')::date::text d")).d;
  await db.query("insert into public.member_daily_performance(user_id,trading_date,closing_equity,realised_pnl) values($1,$2::date,1000,5)", [ids.user, kst]);
  await db.exec(`select set_config('request.jwt.claim.sub','${ids.user}',true)`);
  const call = async () => (await one('select public.get_my_dashboard_performance_range(null,null) r')).r;
  const beforeFix = await call();
  assert.notEqual(beforeFix.range_end, kst, 'the old text cuts "today" in the session time zone');
  await rerunMigration();
  const afterFix = await call();
  assert.equal(afterFix.range_end, kst);
  assert.equal(afterFix.started_on, kst);
  assert.equal(afterFix.days.length, 1, 'the KST trading_date row written by the worker is today');
  const def = (await one("select pg_get_functiondef('public.get_my_dashboard_performance_range(date,date)'::regprocedure) d")).d;
  assert.doesNotMatch(def, /current_date/i);
  assert.match(def, /\(copy_started_at at time zone 'Asia\/Seoul'\)::date/);
});

test('KST: no patched function keeps a UTC day cut; broker metrics (UTC days by design) are excluded', () => {
  const sql = readFileSync(MIGRATION, 'utf8');
  for (const fn of ['get_my_dashboard_performance(integer)', 'get_my_dashboard_performance_range(date,date)', 'get_my_trading_analysis()',
    'get_admin_member_trading_analysis(uuid)', 'get_admin_member_trading_analysis_range(uuid,date,date)',
    'get_admin_member_monthly_performance(uuid,integer)', 'get_admin_operations_metrics(date,date)']) {
    assert.ok(sql.includes(`'public.${fn}'`), fn);
  }
  assert.doesNotMatch(sql, /qa_kst_dates\('public\.get_admin_gate_broker_metrics/);
});

// ---- 2. admin disconnects a member's Gate API ----
const disconnect = (user = ids.user, confirmation = 'ADMIN_DISCONNECT_MEMBER_GATE_API') =>
  db.query('select public.admin_disable_member_gate_api_connection($1,$2)', [user, confirmation]);
const asAdmin = (on = true) => db.exec(`select set_config('test.admin','${on}',true), set_config('request.jwt.claim.sub','${admin}',true)`);

test('admin member disconnect: pauses and halts the member, disables the account and key, audited with the actor', async () => {
  await record(db, cyclePayload());
  assert.equal(await n("select count(*) n from private.copy_order_intents where status='PLANNED'"), 1);
  await asAdmin();
  await disconnect();
  const p = await one('select copy_paused,member_halted from public.profiles where id=$1', [ids.user]);
  assert.deepEqual([p.copy_paused, p.member_halted], [true, true]);
  assert.equal((await one('select status from private.trading_accounts where id=$1', [ids.member])).status, 'DISABLED');
  const g = await one('select status,gate_uid,api_key_last4,futures_trade from private.gate_api_credentials where user_id=$1', [ids.user]);
  assert.deepEqual([g.status, g.gate_uid, g.api_key_last4, g.futures_trade], ['DISABLED', 'DISABLED', 'NONE', false]);
  assert.equal((await one('select status from private.copy_order_intents')).status, 'CANCELLED');
  const log = await one("select actor_id,target_user_id,previous_value,next_value from public.admin_audit_logs where action='MEMBER_GATE_API_DISCONNECTED'");
  assert.equal(log.actor_id, admin);
  assert.equal(log.target_user_id, ids.user);
  assert.equal(log.previous_value.api_status, 'VERIFIED');
  assert.equal(log.next_value.api_status, 'DISABLED');
  assert.equal(await n("select count(*) n from public.copy_events where event_type='MEMBER_HALTED' and safe_payload->>'reason'='API_DISCONNECTED_BY_ADMIN'"), 1);
});

test('admin member disconnect: refuses non-admins, a wrong confirmation and unknown members; authenticated-only', async () => {
  await asAdmin(false);
  await rejects('select public.admin_disable_member_gate_api_connection($1,$2)', [ids.user, 'ADMIN_DISCONNECT_MEMBER_GATE_API'], /ADMIN_REQUIRED/);
  await asAdmin();
  await rejects('select public.admin_disable_member_gate_api_connection($1,$2)', [ids.user, 'DISCONNECT_GATE_API'], /CONFIRMATION_REQUIRED/);
  await rejects('select public.admin_disable_member_gate_api_connection($1,$2)', [randomUUID(), 'ADMIN_DISCONNECT_MEMBER_GATE_API'], /MEMBER_NOT_FOUND/);
  assert.equal((await one('select status from private.gate_api_credentials where user_id=$1', [ids.user])).status, 'VERIFIED');
  const acl = await one(`select has_function_privilege('anon','public.admin_disable_member_gate_api_connection(uuid,text)','EXECUTE') anon,
    has_function_privilege('authenticated','public.admin_disable_member_gate_api_connection(uuid,text)','EXECUTE') auth,
    has_function_privilege('service_role','public.admin_disable_member_gate_api_connection(uuid,text)','EXECUTE') worker`);
  assert.deepEqual(acl, { anon: false, auth: true, worker: false });
});

// ---- 3. least privilege ----
test('least privilege: anon cannot execute a revoked function, authenticated still can', async () => {
  const acl = await one(`select has_function_privilege('anon','public.is_approved_admin()','EXECUTE') anon,
    has_function_privilege('authenticated','public.is_approved_admin()','EXECUTE') auth`);
  assert.deepEqual(acl, { anon: false, auth: true });
  await db.exec('savepoint qa_role');
  await db.exec('set local role anon');
  await assert.rejects(db.query('select public.is_approved_admin() v'), /permission denied/);
  await db.exec('rollback to savepoint qa_role');
  await db.exec('set local role authenticated');
  assert.equal((await one('select public.is_approved_admin() v')).v, false);
  await db.exec('reset role');
});

test('least privilege: no public function except get_public_master_positions is executable by anon', async () => {
  const rows = (await db.query(`select p.oid::regprocedure::text f from pg_proc p where p.pronamespace='public'::regnamespace
    and p.proname<>'get_public_master_positions' and has_function_privilege('anon',p.oid,'EXECUTE')`)).rows;
  assert.deepEqual(rows, []);
  // New functions no longer inherit anon EXECUTE through the global PUBLIC default.
  await db.exec('create function public.qa_new_function() returns int language sql as $$ select 1 $$');
  assert.equal((await one("select has_function_privilege('anon','public.qa_new_function()','EXECUTE') v")).v, false);
});

test('least privilege: anon/authenticated cannot write public tables directly; authenticated still reads', async () => {
  for (const table of ['public.profiles', 'public.copy_events', 'public.copy_position_states', 'public.copy_system_control', 'public.admin_audit_logs']) {
    for (const role of ['anon', 'authenticated']) {
      for (const privilege of ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) {
        assert.equal((await one('select has_table_privilege($1,$2,$3) v', [role, table, privilege])).v, false, `${role} ${privilege} ${table}`);
      }
    }
  }
  // SELECT (the only direct table access of the frontend) is not touched by the migration.
  await db.exec('grant select on public.profiles to authenticated');
  await rerunMigration();
  assert.equal((await one("select has_table_privilege('authenticated','public.profiles','SELECT') v")).v, true);
});

// ---- 6. entry alert retry cap ----
test('entry alerts: an alert is claimed at most 20 times, then marked exhausted and never decrypted again', async () => {
  await record(db, cyclePayload());
  const intent = (await one('select id from private.copy_order_intents')).id;
  const alert = (await one("insert into private.copy_entry_alert_outbox(intent_id,safe_payload,attempts) values($1,'{}',19) returning id", [intent])).id;
  const first = (await db.query('select * from public.claim_copy_entry_alerts(10)')).rows;
  assert.equal(first.length, 1, 'the 20th claim is still allowed');
  assert.equal((await one('select attempts from private.copy_entry_alert_outbox where id=$1', [alert])).attempts, 20);
  await db.query("select public.complete_copy_entry_alert($1,false,'TELEGRAM_DOWN')", [alert]);
  await db.query("update private.copy_entry_alert_outbox set next_attempt_at=now()-interval '1 second' where id=$1", [alert]);
  assert.equal((await db.query('select * from public.claim_copy_entry_alerts(10)')).rows.length, 0);
  const row = await one("select attempts,delivered_at,last_error_code,next_attempt_at='infinity'::timestamptz dead from private.copy_entry_alert_outbox where id=$1", [alert]);
  assert.deepEqual([row.attempts, row.delivered_at, row.last_error_code, row.dead], [20, null, 'ALERT_RETRY_EXHAUSTED', true]);
  assert.equal((await db.query('select * from public.claim_copy_entry_alerts(10)')).rows.length, 0);
});

// ---- 7/8. record_copy_worker_cycle ----
const rawCycle = (member = {}) => db.query('select public.record_copy_worker_cycle($1)', [{
  cycle_id: randomUUID(), source_version: randomUUID(), observed_at: new Date().toISOString(),
  master: { trading_account_id: ids.master, total: 20000, available: 18000, positions: [] },
  members: [{ user_id: ids.user, trading_account_id: ids.member, total: 5000, available: 4500, copy_ratio: 100, max_position_ratio: 30, planned_positions: [], ...member }] }]);

test('profiles: a member already in reduce_only is not rewritten every cycle', async () => {
  await rawCycle({ risk_halt_reason: 'DAILY_LOSS_LIMIT' });
  assert.equal((await one('select reduce_only from public.profiles where id=$1', [ids.user])).reduce_only, true);
  await db.query("update public.profiles set updated_at='2000-01-01T00:00:00Z' where id=$1", [ids.user]);
  await rawCycle({ risk_halt_reason: 'DAILY_LOSS_LIMIT' });
  await rawCycle({ risk_halt_reason: 'MAX_DRAWDOWN_LIMIT' });
  const p = await one("select reduce_only, updated_at='2000-01-01T00:00:00Z'::timestamptz untouched from public.profiles where id=$1", [ids.user]);
  assert.deepEqual([p.reduce_only, p.untouched], [true, true]);
});

test('events: SYMBOL_PAUSED and POSITION_SYNCED carry pause_reason and previous_state', async () => {
  const leg = (state, pause_reason) => ({ contract: 'BTC_USDT', position_side: 'LONG', state, pause_reason,
    size: 0, target_size: 0, delta_size: 0, mark_price: 50000, quanto_multiplier: 0.001 });
  await rawCycle({ planned_positions: [leg('PAUSED', 'MEMBER_POSITION_RECONCILING')] });
  await rawCycle({ planned_positions: [leg('SYNCED', null)] });
  const paused = await one("select safe_payload p from public.copy_events where event_type='SYMBOL_PAUSED'");
  assert.equal(paused.p.pause_reason, 'MEMBER_POSITION_RECONCILING');
  assert.ok('previous_state' in paused.p);
  const synced = await one("select safe_payload p from public.copy_events where event_type='POSITION_SYNCED'");
  assert.equal(synced.p.previous_state, 'PAUSED');
  assert.ok('pause_reason' in synced.p);
  assert.equal(synced.p.pause_reason, null);
});

// ---- 9. cycle lifecycle ----
test('cycles: a PLANNED cycle completes when its last intent becomes terminal', async () => {
  await record(db, cyclePayload({ master: { positions: [position(40), { ...position(40, 'SOXL_USDT'), markPrice: 50 }] } }));
  const cycle = await one("select c.id,c.status,c.completed_at from private.copy_cycles c join private.copy_order_intents i on i.cycle_id=c.id limit 1");
  assert.deepEqual([cycle.status, cycle.completed_at], ['PLANNED', null]);
  assert.equal(await n('select count(*) n from private.copy_order_intents where cycle_id=$1', [cycle.id]), 2);
  await db.query("update private.copy_order_intents set status='CANCELLED',resolved_at=now() where cycle_id=$1 and contract='BTC_USDT'", [cycle.id]);
  assert.equal((await one('select status from private.copy_cycles where id=$1', [cycle.id])).status, 'PLANNED');
  await db.query("update private.copy_order_intents set status='REJECTED',resolved_at=now() where cycle_id=$1 and contract='SOXL_USDT'", [cycle.id]);
  const done = await one('select status,completed_at is not null done from private.copy_cycles where id=$1', [cycle.id]);
  assert.deepEqual([done.status, done.done], ['COMPLETED', true]);
});

test('cycles: the catch-up marks legacy all-terminal PLANNED cycles COMPLETED; the migration is re-runnable', async () => {
  await record(db, cyclePayload());
  const cycle = (await one('select cycle_id id from private.copy_order_intents')).id;
  await db.query("update private.copy_order_intents set status='CANCELLED',resolved_at='2026-10-01T00:00:00Z' where cycle_id=$1", [cycle]);
  await db.query("update private.copy_cycles set status='PLANNED',completed_at=null where id=$1", [cycle]);
  const defs = "select md5(string_agg(pg_get_functiondef(p.oid),'' order by p.oid)) h from pg_proc p where p.pronamespace in ('public'::regnamespace,'private'::regnamespace)";
  const beforeRun = (await one(defs)).h;
  await rerunMigration();
  assert.equal((await one(defs)).h, beforeRun, 'a second run changes no function');
  const c = await one('select status,completed_at::text t from private.copy_cycles where id=$1', [cycle]);
  assert.equal(c.status, 'COMPLETED');
  assert.match(c.t, /^2026-10-01/);
});
