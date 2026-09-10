import test, { before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createVerifiedDatabase, seedVerifiedAccount, ids } from './fixtures/verified-runtime.js';
import { faultRunner } from './fixtures/fault-runner.js';

let db; let exchange;
const one = async (q, params = []) => (await db.query(q, params)).rows[0];
before(async () => { db = await createVerifiedDatabase(); });
after(async () => { await db?.close(); });
beforeEach(async () => { await db.exec('begin'); await seedVerifiedAccount(db); exchange = { masterSize: 40, memberSize: 0, posts: 0, orders: [] }; });
afterEach(async () => { await db.exec('rollback'); });
const expireClaims = () => db.exec("update private.copy_order_intents set submitted_at=clock_timestamp()-interval '1 minute',updated_at=clock_timestamp()-interval '1 minute' where status='SUBMITTING'; update private.copy_reconciliation_jobs set run_after=clock_timestamp()-interval '1 second',claimed_at=null");

for (const fault of ['timeout','disconnect',500,429,'malformed']) test(`Gate accepted the order but returned ${fault}: restart reconciles without resubmission`, async () => {
  const first = faultRunner(db, exchange, { exchange: fault }).runner;
  await first.syncOnce(); await first.submitOrders();
  assert.equal(exchange.posts, 1); assert.equal(exchange.memberSize, 10);
  assert.equal((await one('select status from private.copy_order_intents')).status, 'UNKNOWN');
  const restarted = faultRunner(db, exchange).runner;
  await expireClaims(); await restarted.syncOnce(); await restarted.reconcileOrders();
  await restarted.submitOrders();
  assert.equal(exchange.posts, 1);
  const i = await one('select status,filled_size,observation_confirmed_at from private.copy_order_intents');
  assert.equal(i.status, 'FILLED'); assert.equal(Number(i.filled_size), 10); assert.equal(i.observation_confirmed_at, null);
  await restarted.syncOnce(); await restarted.submitOrders(); assert.equal(exchange.posts, 1);
});

for (const phase of ['beforeRpc','afterRpc']) test(`worker stops ${phase} completion: committed fills cannot be overwritten or duplicated`, async () => {
  const first = faultRunner(db, exchange, { [phase]: 'complete_copy_order_attempt' }).runner;
  await first.syncOnce(); await assert.rejects(first.submitOrders(), /SIMULATED/);
  assert.equal(exchange.posts, 1);
  assert.equal((await one('select status from private.copy_order_intents')).status, phase === 'afterRpc' ? 'FILLED' : 'SUBMITTING');
  const restarted = faultRunner(db, exchange).runner;
  await expireClaims(); await restarted.reconcileOrders(); await restarted.syncOnce(); await restarted.submitOrders();
  assert.equal(exchange.posts, 1); assert.equal((await one('select status from private.copy_order_intents')).status, 'FILLED');
});

test('a lost reconciliation commit acknowledgement does not write UNKNOWN over FILLED', async () => {
  const first = faultRunner(db, exchange, { exchange: 'timeout' }).runner;
  await first.syncOnce(); await first.submitOrders(); await expireClaims();
  const resumed = faultRunner(db, exchange, { afterRpc: 'complete_copy_reconciliation' });
  await assert.rejects(resumed.runner.reconcileOrders(), /SIMULATED_RPC_RESPONSE_LOST/);
  assert.equal(resumed.calls.filter((c) => c === 'complete_copy_reconciliation').length, 1);
  assert.equal((await one('select status from private.copy_order_intents')).status, 'FILLED');
});

test('worker dies after authorization but before POST: no speculative replay on restart', async () => {
  const r = faultRunner(db, exchange).runner; await r.syncOnce();
  const [job] = (await db.query('select * from public.claim_copy_order_intents(1)')).rows;
  assert.equal((await one('select public.authorize_copy_order_submission($1,$2) ok',[job.intent_id,ids.version])).ok, true);
  await expireClaims(); const restarted = faultRunner(db, exchange).runner;
  await restarted.reconcileOrders(); await restarted.syncOnce(); await restarted.submitOrders();
  assert.equal(exchange.posts, 0); assert.equal((await one('select status from private.copy_order_intents')).status, 'UNKNOWN');
});

test('worker dies before authorization: the unsent claim expires and a fresh verified cycle may order once', async () => {
  const r = faultRunner(db, exchange).runner; await r.syncOnce();
  await db.query('select * from public.claim_copy_order_intents(1)'); await expireClaims();
  const restarted = faultRunner(db, exchange).runner;
  await restarted.reconcileOrders(); await restarted.syncOnce(); await restarted.submitOrders();
  assert.equal(exchange.posts, 1); assert.equal(exchange.memberSize, 10);
});

test('Supabase fails before cycle commit: no intent, no exchange submission', async () => {
  const r = faultRunner(db, exchange, { beforeRpc: 'record_verified_copy_worker_cycle' }).runner;
  await assert.rejects(r.syncOnce(), /SIMULATED_DATABASE_UNAVAILABLE/);
  assert.equal((await one('select count(*)::int n from private.copy_order_intents')).n, 0);
  assert.equal(exchange.posts, 0);
});

test('lost cycle acknowledgement preserves the stable target instead of recalculating from new equity', async () => {
  const r = faultRunner(db, exchange, { afterRpc: 'record_verified_copy_worker_cycle' }).runner;
  await assert.rejects(r.syncOnce(), /SIMULATED_RPC_RESPONSE_LOST/);
  exchange.memberEquity = 7000;
  const restarted = faultRunner(db, exchange).runner; await restarted.syncOnce(); await restarted.submitOrders();
  assert.equal(exchange.posts, 1); assert.equal(exchange.memberSize, 10);
});

test('master closes between planning and submission: the stale entry is rejected before POST', async () => {
  const r = faultRunner(db, exchange).runner; await r.syncOnce(); exchange.masterSize = 0;
  await r.submitOrders(); assert.equal(exchange.posts, 0);
  assert.match((await one('select last_error_code from private.copy_order_intents')).last_error_code, /MASTER_POSITION_CHANGED/);
});

test('two real observations confirm an IOC partial fill before the remaining target can be copied', async () => {
  exchange.fillFraction = 0.5; const r = faultRunner(db, exchange).runner;
  await r.syncOnce(); await r.submitOrders(); assert.equal(exchange.memberSize, 5);
  await r.syncOnce(); await r.submitOrders(); assert.equal(exchange.posts, 1);
  await db.exec("update private.copy_order_intents set position_match_at=clock_timestamp()-interval '3 seconds'");
  await r.syncOnce(); await r.syncOnce(); exchange.fillFraction = 1; await r.submitOrders();
  assert.equal(exchange.posts, 2); assert.equal(exchange.memberSize, 10);
});

test('entry and full-close Telegram payloads come from exchange results including realized fill price', async () => {
  const r = faultRunner(db, exchange); await r.runner.syncOnce(); await r.runner.submitOrders();
  assert.equal(await r.runner.deliverEntryAlerts(), 1);
  assert.equal(r.alerts[0].details.fill_notional_usdt, 501); assert.equal(r.alerts[0].details.evidence, 'GATE_ORDER_QUERY');
  await r.runner.syncOnce(); await db.exec("update private.copy_order_intents set position_match_at=clock_timestamp()-interval '3 seconds'");
  await r.runner.syncOnce(); exchange.masterSize = 0;
  await r.runner.syncOnce(); await r.runner.submitOrders();
  assert.equal(exchange.memberSize, 0); assert.equal(await r.runner.deliverEntryAlerts(), 1);
  assert.equal(r.alerts[1].event, 'COPY_POSITION_REDUCTION_FILLED'); assert.equal(r.alerts[1].details.side, 'SELL');
  await r.runner.syncOnce();
  assert.equal(Number((await one('select actual_size from public.copy_position_states')).actual_size),0);
  assert.equal(Number((await one("select size from private.copy_current_positions where account_role='MEMBER'")).size),0);
});
