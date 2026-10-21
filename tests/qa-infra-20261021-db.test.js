import test, { before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createVerifiedDatabase, seedVerifiedAccount } from './fixtures/verified-runtime.js';

// QA 2026-10-21 area C, DB half (20261021031000_qa_infra_alerts.sql): C-2 heartbeat-gap halt, C-3 dead-man switch.
const migration = readFileSync('supabase/migrations/20261021031000_qa_infra_alerts.sql', 'utf8');
let db;
const one = async (sql, args = []) => (await db.query(sql, args)).rows[0];
const n = async (sql, args = []) => Number((await one(sql, args)).n);

before(async () => { db = await createVerifiedDatabase(); await db.exec(migration); });
after(async () => { await db?.close(); });
beforeEach(async () => { await db.exec('begin'); await seedVerifiedAccount(db); });
afterEach(async () => { await db.exec('rollback'); });

const heartbeat = async (workerId = 'worker-new', mode = 'LIVE') => (await one(
  "select public.copy_worker_heartbeat($1,'0.5.0','https://api.gateio.ws','192.0.2.1','maetajak',$2,false) r", [workerId, mode])).r;
// The previous worker's last contact: heartbeat and last cycle report (updated_at) `seconds` ago.
const lastContact = (seconds, { reportSeconds = seconds, workerId = 'worker-old' } = {}) => db.query(
  `update private.copy_worker_runtime set worker_id=$1, heartbeat_at=clock_timestamp()-make_interval(secs=>$2),
     updated_at=clock_timestamp()-make_interval(secs=>$3)`, [workerId, seconds, reportSeconds]);
const control = () => one('select execution_enabled,emergency_halted,halt_reason from public.copy_system_control');
const gapEvents = () => n("select count(*) n from public.copy_events where event_type='SYSTEM_HALTED' and safe_payload->>'reason'='WORKER_HEARTBEAT_GAP'");

test('C-2: a restart after a >180 s outage halts LIVE once, with an event and an audit row', async () => {
  await lastContact(240);
  const beat = await heartbeat();
  assert.equal(beat.newly_halted, true);
  assert.ok(beat.gap_seconds >= 240 && beat.gap_seconds < 250, String(beat.gap_seconds));
  assert.equal(beat.gap_halt_seconds, 180);
  assert.deepEqual(await control(), { execution_enabled: false, emergency_halted: true, halt_reason: 'WORKER_HEARTBEAT_GAP' });
  assert.equal(await gapEvents(), 1);
  const audit = await one("select next_value from public.admin_audit_logs where action='LIVE_COPY_HALTED'");
  assert.equal(audit.next_value.reason, 'WORKER_HEARTBEAT_GAP');
  // Later heartbeats keep the halt and do not repeat it; nothing can be claimed until an admin re-enables LIVE.
  const next = await heartbeat();
  assert.equal(next.newly_halted, false);
  assert.equal(await gapEvents(), 1);
  assert.equal((await db.query('select * from public.claim_copy_order_intents(10)')).rows.length, 0);
});

test('C-2: the same worker coming back after a DB outage is halted too', async () => {
  await lastContact(200, { workerId: 'worker-same' });
  assert.equal((await heartbeat('worker-same')).newly_halted, true);
  assert.equal((await control()).halt_reason, 'WORKER_HEARTBEAT_GAP');
});

test('C-2: a deploy restart (about 60 s) and a slow cycle that still reported do not halt', async () => {
  await lastContact(60);
  let beat = await heartbeat();
  assert.equal(beat.newly_halted, false);
  assert.ok(beat.gap_seconds >= 60 && beat.gap_seconds < 70);
  await lastContact(400, { reportSeconds: 20, workerId: 'worker-new' });
  beat = await heartbeat();
  assert.equal(beat.newly_halted, false, 'a cycle report 20 s ago is contact');
  assert.deepEqual(await control(), { execution_enabled: true, emergency_halted: false, halt_reason: 'TRADING_WORKER_NOT_CONFIGURED' });
  assert.equal(await gapEvents(), 0);
});

test('C-2: an existing halt reason is never overwritten and a first-ever heartbeat never halts', async () => {
  await db.exec("update public.copy_system_control set execution_enabled=false,emergency_halted=true,halt_reason='DUPLICATE_ORDER_ANOMALY'");
  await lastContact(3600);
  assert.equal((await heartbeat()).newly_halted, false);
  assert.equal((await control()).halt_reason, 'DUPLICATE_ORDER_ANOMALY');
  await db.exec("update public.copy_system_control set execution_enabled=true,emergency_halted=false; update private.copy_worker_runtime set heartbeat_at=null,worker_id=null,updated_at=now()-interval '30 days'");
  const beat = await heartbeat();
  assert.equal(beat.newly_halted, false);
  assert.equal(beat.gap_seconds, null);
  assert.equal(await gapEvents(), 0);
});

test('C-2: the lease check still runs first and the migration is idempotent (drift guard accepts its own body)', async () => {
  await lastContact(5);
  await db.exec('savepoint lease');
  await assert.rejects(heartbeat(), /WORKER_LEASE_HELD/);
  await db.exec('rollback to savepoint lease');
  await db.exec(migration);
  await db.exec('savepoint drift');
  await assert.rejects(db.exec(migration.replace("'77c34b3b1d05b3cb3026af2390ea4f4a'", "'0'")), /ABORT_FUNCTION_DRIFT/);
  await db.exec('rollback to savepoint drift');
});

// ---- C-3 dead-man switch -------------------------------------------------------------------------------------
const BOT = '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdef';
async function stubPgNet() {
  await db.exec(`create schema if not exists net;
    create table if not exists net.sent(id bigint generated always as identity, url text, body jsonb);
    create or replace function net.http_post(url text, body jsonb default '{}'::jsonb, params jsonb default '{}'::jsonb,
      headers jsonb default '{}'::jsonb, timeout_milliseconds integer default 5000) returns bigint language sql as $$
      insert into net.sent(url, body) values (url, body) returning id $$;`);
}
const secrets = (prefix = 'master_alert') => db.query(`insert into vault.decrypted_secrets values ($1,$2),($3,'-1001234567890')`,
  [`${prefix}_bot_token`, BOT, `${prefix}_chat_id`]);
const check = async () => (await one('select private.worker_deadman_check() r')).r;
const sent = async () => (await db.query('select url, body from net.sent order by id')).rows;
const heartbeatAge = (seconds) => db.query("update private.copy_worker_runtime set heartbeat_at=clock_timestamp()-make_interval(secs=>$1)", [seconds]);

test('C-3: a fresh worker is OK; a stale LIVE worker alerts once, repeats after 30 min, and recovery is announced', async () => {
  await stubPgNet(); await secrets();
  assert.equal((await check()).result, 'OK');
  await heartbeatAge(120);
  let r = await check();
  assert.equal(r.stale, true);
  assert.match(r.result, /^QUEUED:/);
  let rows = await sent();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].url, `https://api.telegram.org/bot${BOT}/sendMessage`);
  assert.equal(rows[0].body.chat_id, '-1001234567890');
  assert.match(rows[0].body.text, /카피 워커 응답 없음/);
  assert.match(rows[0].body.text, /WORKER_HEARTBEAT_GAP/);
  assert.doesNotMatch(rows[0].body.text, new RegExp(BOT));
  for (let i = 0; i < 3; i++) assert.equal((await check()).result, 'STALE_ALERTED');
  assert.equal((await sent()).length, 1, 'rate limited while stale');
  await db.exec("update private.worker_deadman_state set last_alert_at=clock_timestamp()-interval '31 minutes'");
  r = await check();
  assert.match(r.result, /^QUEUED:/);
  assert.equal(r.alert_count, 2);
  assert.match((await sent())[1].body.text, /워커 중지 지속/);
  await heartbeatAge(0);
  r = await check();
  assert.match(r.result, /^QUEUED:/);
  rows = await sent();
  assert.equal(rows.length, 3);
  assert.match(rows[2].body.text, /응답 복구/);
  assert.deepEqual(await one('select stale_since,last_alert_at,alert_count from private.worker_deadman_state'),
    { stale_since: null, last_alert_at: null, alert_count: 0 });
  assert.equal((await check()).result, 'OK');
  assert.equal((await sent()).length, 3);
});

test('C-3: missing pg_net or secrets is a logged no-op that keeps retrying; recovery without an alert stays silent', async () => {
  await heartbeatAge(300);
  assert.equal((await check()).result, 'PG_NET_MISSING');
  await stubPgNet();
  assert.equal((await check()).result, 'SECRETS_MISSING');
  assert.equal((await check()).result, 'SECRETS_MISSING', 'retried every run, not rate limited');
  assert.equal((await one('select last_result from private.worker_deadman_state')).last_result, 'SECRETS_MISSING');
  await db.query("insert into vault.decrypted_secrets values ('master_alert_bot_token','not-a-token'),('master_alert_chat_id','-100')");
  assert.equal((await check()).result, 'SECRETS_INVALID');
  await heartbeatAge(0);
  assert.equal((await check()).result, 'RECOVERED_NOT_ALERTED');
  assert.equal((await sent()).length, 0);
});

test('C-3: dedicated dead-man secrets win; OBSERVE / never-started workers and the kill switch are not alerted', async () => {
  await stubPgNet(); await secrets('master_alert');
  await db.query("insert into vault.decrypted_secrets values ('worker_deadman_bot_token','987654321:ZYXWVUTSRQPONMLKJIHGFEDCBA_x'),('worker_deadman_chat_id','@ops_channel')");
  await heartbeatAge(500);
  assert.match((await check()).result, /^QUEUED:/);
  const [row] = await sent();
  assert.match(row.url, /bot987654321:/);
  assert.equal(row.body.chat_id, '@ops_channel');
  await db.exec("update private.worker_deadman_state set stale_since=null,last_alert_at=null; update private.copy_worker_runtime set mode='OBSERVE'");
  assert.equal((await check()).result, 'NOT_EXPECTED');
  await db.exec("update private.copy_worker_runtime set mode='DRY_RUN', heartbeat_at=null");
  assert.equal((await check()).result, 'NOT_EXPECTED');
  await db.exec("update private.copy_worker_runtime set heartbeat_at=clock_timestamp()-interval '10 minutes'; update private.worker_deadman_state set enabled=false");
  assert.deepEqual(await check(), { skipped: 'disabled' });
  assert.equal((await sent()).length, 1);
});

test('C-3: the cron job is scheduled once even when the migration is re-applied; functions are not callable by clients', async () => {
  await db.exec(`create schema cron;
    create table cron.job(jobid bigint generated always as identity, jobname text, schedule text, command text);
    create function cron.schedule(p_name text, p_schedule text, p_command text) returns bigint language sql as $$
      insert into cron.job(jobname, schedule, command) values (p_name, p_schedule, p_command) returning jobid $$;
    create function cron.unschedule(p_job bigint) returns boolean language sql as $$
      delete from cron.job where jobid = p_job returning true $$;`);
  await db.exec(migration);
  await db.exec(migration);
  const jobs = (await db.query("select schedule, command from cron.job where jobname='maetajak-worker-deadman'")).rows;
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].schedule, '* * * * *');
  assert.match(jobs[0].command, /select private\.worker_deadman_check\(\)/);
  for (const fn of ['private.worker_deadman_check()', 'private.worker_deadman_send(text)']) {
    for (const role of ['anon', 'authenticated']) {
      assert.equal((await one('select has_function_privilege($1,$2,\'execute\') ok', [role, fn])).ok, false, `${role} ${fn}`);
    }
  }
});
