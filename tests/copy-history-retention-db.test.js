import test, { before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createVerifiedDatabase, seedVerifiedAccount, ids } from './fixtures/verified-runtime.js';

// 2026-09-26: unreferenced cycles keep 1 day, account snapshots keep their own window (3 days).
const MIGRATION = 'supabase/migrations/20260926075458_copy_history_footprint.sql';
let db;
before(async () => {
  db = await createVerifiedDatabase();
  await db.exec(readFileSync(MIGRATION, 'utf8'));
});
after(async () => { await db?.close(); });
beforeEach(async () => { await db.exec('begin'); await seedVerifiedAccount(db); });
afterEach(async () => { await db.exec('rollback'); });

const one = async (sql, args = []) => (await db.query(sql, args)).rows[0];
async function snapshot(account, age) {
  return (await one(`insert into private.copy_account_snapshots(trading_account_id,total_equity,available_equity,unrealised_pnl,observed_at,source_hash)
    values($1,100,90,0,now()-$2::interval,$3) returning id`, [account, age, randomUUID()])).id;
}
async function cycle(age, snapshotId = null) {
  const id = randomUUID();
  await db.query(`insert into private.copy_cycles(id,master_account_id,status,source_version,started_at,created_at,master_snapshot_id)
    values($1,$2,'COMPLETED',$3,now()-$4::interval,now()-$4::interval,$5)`, [id, ids.master, randomUUID(), age, snapshotId]);
  return id;
}
const exists = async (table, id) => Boolean(await one(`select 1 x from ${table} where id=$1`, [id]));
const prune = async (...args) => (await one(`select private.prune_copy_history(${args.join(',')}) r`)).r;

test('unreferenced cycles older than 1 day are deleted; younger ones stay', async () => {
  const old = await cycle('30 hours');
  const young = await cycle('20 hours');
  const r = await prune("interval '1 day'", 1000, false, "interval '3 days'");
  assert.equal(r.cycles, 1);
  assert.equal(await exists('private.copy_cycles', old), false);
  assert.equal(await exists('private.copy_cycles', young), true);
});

test('referenced cycles are kept regardless of age (intent, event, position state)', async () => {
  const withIntent = await cycle('5 days');
  const withEvent = await cycle('5 days');
  const withState = await cycle('5 days');
  await db.query(`insert into private.copy_order_intents(cycle_id,user_id,trading_account_id,contract,target_size,actual_size_at_plan,
    delta_size,reduce_only,idempotency_key,gate_order_text,status,position_side)
    values($1,$2,$3,'BTC_USDT',1,0,1,false,$4,'t-x','FILLED','LONG')`, [withIntent, ids.user, ids.member, randomUUID()]);
  await db.query(`insert into public.copy_events(user_id,event_type,severity,cycle_id,safe_payload) values($1,'ERROR','CRITICAL',$2,'{}')`,
    [ids.user, withEvent]);
  await db.query(`insert into public.copy_position_states(user_id,trading_account_id,contract,state,target_size,actual_size,delta_size,
    copy_ratio,max_position_ratio,drift_tolerance_size,last_cycle_id,position_side)
    values($1,$2,'BTC_USDT','SYNCED',0,0,0,100,40,1,$3,'LONG')`, [ids.user, ids.member, withState]);
  const r = await prune("interval '1 day'", 1000, false, "interval '3 days'");
  assert.equal(r.cycles, 0);
  for (const id of [withIntent, withEvent, withState]) assert.equal(await exists('private.copy_cycles', id), true);
});

test('snapshots follow their own 3-day window and the latest per account is always kept', async () => {
  const s4 = await snapshot(ids.member, '4 days');
  const s2 = await snapshot(ids.member, '2 days 1 hour');
  const lone = await snapshot(ids.master, '6 days'); // latest for the master account
  const r = await prune("interval '1 day'", 1000, false, "interval '3 days'");
  assert.equal(r.account_snapshots, 1);
  assert.equal(await exists('private.copy_account_snapshots', s4), false);
  assert.equal(await exists('private.copy_account_snapshots', s2), true);
  assert.equal(await exists('private.copy_account_snapshots', lone), true);
});

test('a snapshot referenced by a surviving cycle is kept; it goes once the cycle is pruned', async () => {
  await snapshot(ids.master, '1 minute'); // latest
  const s = await snapshot(ids.master, '5 days');
  const c = await cycle('5 days', s);
  await db.query(`insert into public.copy_events(user_id,event_type,severity,cycle_id,safe_payload) values($1,'ERROR','CRITICAL',$2,'{}')`,
    [ids.user, c]);
  let r = await prune("interval '1 day'", 1000, false, "interval '3 days'");
  assert.equal(r.account_snapshots, 0);
  await db.query('delete from public.copy_events where cycle_id=$1', [c]);
  r = await prune("interval '1 day'", 1000, false, "interval '3 days'");
  assert.equal(r.cycles, 1);
  assert.equal(r.account_snapshots, 1);
});

test('hard floors: cycles never below 1 day, snapshots never below 2 days; dry run deletes nothing', async () => {
  const c = await cycle('12 hours');
  await snapshot(ids.member, '1 minute');
  const s = await snapshot(ids.member, '36 hours');
  const dry = await prune("interval '1 hour'", 1000, true, "interval '1 hour'");
  assert.equal(dry.cycles, 0);
  assert.equal(dry.account_snapshots, 0);
  const old = await cycle('2 days');
  const dry2 = await prune("interval '1 hour'", 1000, true, "interval '1 hour'");
  assert.equal(dry2.cycles, 1);
  assert.equal(await exists('private.copy_cycles', old), true);
  await prune("interval '1 hour'", 1000, false, "interval '1 hour'");
  assert.equal(await exists('private.copy_cycles', c), true);
  assert.equal(await exists('private.copy_account_snapshots', s), true);
});

test('batch limit bounds one run', async () => {
  for (let i = 0; i < 5; i += 1) await cycle('2 days');
  const r = await prune("interval '1 day'", 2, false, "interval '3 days'");
  assert.equal(r.cycles, 2);
  assert.equal(Number((await one('select count(*) n from private.copy_cycles')).n), 3);
});

test('old 3-argument signature is gone; 4-argument call with defaults works', async () => {
  const n = Number((await one(`select count(*) n from pg_proc p join pg_namespace s on s.oid=p.pronamespace
    where s.nspname='private' and p.proname='prune_copy_history'`)).n);
  assert.equal(n, 1);
  const r = await prune("interval '1 day'", 1000, false);
  assert.equal(r.dry_run, false);
});

test('autovacuum thresholds are set on the churn tables', async () => {
  const rows = (await db.query(`select relname, reloptions from pg_class where relname in ('copy_cycles','copy_account_snapshots')`)).rows;
  for (const row of rows) assert.ok(row.reloptions.includes('autovacuum_vacuum_scale_factor=0.02'), row.relname);
});
