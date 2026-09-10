import test, { before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createVerifiedDatabase, seedVerifiedAccount, ids } from './fixtures/verified-runtime.js';
import { faultRunner } from './fixtures/fault-runner.js';

let db; let exchange;
const one = async (sql, params = []) => (await db.query(sql, params)).rows[0];
before(async () => { db = await createVerifiedDatabase(); });
after(async () => { await db?.close(); });
beforeEach(async () => {
  await db.exec('begin');
  await seedVerifiedAccount(db);
  // Real production context RPC, with only local TEST_ONLY credentials.
  await db.query("insert into private.gate_api_credentials(user_id,gate_uid,api_key_ciphertext,secret_key_ciphertext,api_key_last4,status,futures_read,futures_trade) values($1,'MASTER_TEST_ONLY','x','y','TEST','VERIFIED',true,false)", [ids.master]);
  await db.query('update private.trading_accounts set credential_user_id=$1 where id=$1', [ids.master]);
  exchange = { masterSize: 24, memberSize: 0, posts: 0, orders: [] };
});
afterEach(async () => { await db.exec('rollback'); });

async function guards() {
  return (await one('select public.get_copy_order_observation_guards() value')).value;
}
async function previousStates() {
  const { value } = await one('select public.get_copy_worker_context() value');
  return value.members.find((m) => m.trading_account_id === ids.member).previous_states;
}
async function confirmFill(runner) {
  await runner.syncOnce();
  // Accelerate only the test clock interval; production still requires two
  // independent fresh Gate observations at least two seconds apart.
  await db.exec("update private.copy_order_intents set position_match_at=clock_timestamp()-interval '3 seconds' where position_match_at is not null and observation_confirmed_at is null");
  await runner.syncOnce();
  await runner.syncOnce();
  assert.equal((await one('select count(*)::int n from private.copy_order_intents where filled_size<>0 and observation_confirmed_at is null')).n, 0);
  assert.deepEqual(await guards(), []);
  for (const state of await previousStates()) assert.equal(state.has_unresolved_order, false);
}

for (const sign of [1, -1]) for (const partial of [false, true]) {
  test(`${sign > 0 ? 'LONG' : 'SHORT'} real SQL context: entry, scale-in, ${partial ? 'partial close, ' : ''}full close, re-entry`, async () => {
    const r = faultRunner(db, exchange, { sqlContext: true });
    const targets = partial ? [6, 9, 6, 0, 6] : [6, 9, 0, 6];
    let previous = 0;
    for (const target of targets) {
      exchange.masterSize = sign * target * 4;
      await r.runner.syncOnce();
      const before = exchange.posts;
      await r.runner.submitOrders();
      assert.equal(exchange.posts, before + 1);
      assert.equal(exchange.memberSize, target === 0 ? 0 : sign * target);
      const order = exchange.orders.at(-1);
      assert.equal(order.size, sign * (target - previous));
      assert.equal(order.is_reduce_only, target < previous);
      await confirmFill(r.runner);
      await r.runner.submitOrders();
      assert.equal(exchange.posts, before + 1, 'confirmed history must not create another order');
      assert.equal(await r.runner.deliverEntryAlerts(), 1);
      assert.equal(r.alerts.at(-1).details.evidence, 'GATE_ORDER_QUERY');
      if (target === 9) {
        // Incident reproduction: the obsolete predicate relocks 0->6 once
        // the later, independently confirmed 6->9 fill changes actual size.
        const legacy = await one("select exists(select 1 from private.copy_order_intents i join public.copy_position_states s on s.trading_account_id=i.trading_account_id and s.contract=i.contract and s.position_side=i.position_side where i.status='FILLED' and i.observation_confirmed_at is not null and abs(s.actual_size-(i.actual_size_at_plan+i.filled_size))>=greatest(s.drift_tolerance_size,1)) blocked");
        assert.equal(legacy.blocked, true);
        assert.deepEqual(await guards(), []);
      }
      previous = target;
    }
    assert.equal(exchange.posts, targets.length);
    assert.equal(new Set(exchange.orders.map((o) => o.text)).size, targets.length);
  });
}

test('hot migration releases the reproduced 6->9 stale lock and closes -9 exactly once', async () => {
  const migration = readFileSync('supabase/migrations/20260910094713_confirmed_order_observation_context.sql', 'utf8');
  const legacy = migration.replace(/observation_guards @> jsonb_build_array\([\s\S]*?\n            \)/,
    "exists(select 1 from private.copy_order_intents i where i.trading_account_id=account.id and i.contract=state.contract and i.position_side=state.position_side and (i.status in ('SUBMITTING','ACKNOWLEDGED','PARTIALLY_FILLED','UNKNOWN') or (i.status='FILLED' and i.filled_size<>0 and (state.last_observed_at<=i.resolved_at or abs(state.actual_size-(i.actual_size_at_plan+i.filled_size))>=greatest(state.drift_tolerance_size,1)))))");
  assert.notEqual(legacy, migration);
  await db.exec(legacy);
  const r = faultRunner(db, exchange, { sqlContext: true }).runner;
  await r.syncOnce(); await r.submitOrders(); await confirmFill(r);
  exchange.masterSize = 36;
  await r.syncOnce(); await r.submitOrders();
  await r.syncOnce();
  await db.exec("update private.copy_order_intents set position_match_at=clock_timestamp()-interval '3 seconds' where observation_confirmed_at is null");
  await r.syncOnce();
  assert.deepEqual(await guards(), []);
  assert.equal((await previousStates())[0].has_unresolved_order, true);
  exchange.masterSize = 0;
  await r.syncOnce(); await r.submitOrders();
  assert.equal(exchange.posts, 2);
  assert.equal(exchange.memberSize, 9);
  assert.equal((await one('select pause_reason from public.copy_position_states')).pause_reason, 'UNRESOLVED_PLATFORM_ORDER');
  // Apply only the production migration. No status/order/control edits.
  await db.exec(migration);
  await r.syncOnce(); await r.submitOrders();
  assert.equal(exchange.posts, 3);
  assert.equal(exchange.memberSize, 0);
  assert.equal(exchange.orders.at(-1).size, -9);
  assert.equal(exchange.orders.at(-1).is_reduce_only, true);
  await confirmFill(r); await r.submitOrders();
  assert.equal(exchange.posts, 3);
});

test('a FILLED order still blocks another plan until its two position observations confirm', async () => {
  const r = faultRunner(db, exchange, { sqlContext: true }).runner;
  await r.syncOnce(); await r.submitOrders();
  assert.equal(exchange.posts, 1);
  assert.equal((await guards()).length, 1);
  assert.equal((await previousStates())[0].has_unresolved_order, true);
  exchange.masterSize = 0;
  await r.syncOnce(); await r.submitOrders();
  assert.equal(exchange.posts, 1, 'do not reduce against an unconfirmed fill');
  await confirmFill(r);
  await r.submitOrders();
  assert.equal(exchange.posts, 2);
  assert.equal(exchange.memberSize, 0);
});

test('UNKNOWN orders remain blocked across a new LIVE activation timestamp', async () => {
  const r = faultRunner(db, exchange, { sqlContext: true, exchange: 'timeout' }).runner;
  await r.syncOnce(); await r.submitOrders();
  await db.exec("update public.copy_system_control set updated_at=clock_timestamp()+interval '1 second'");
  const restarted = faultRunner(db, exchange, { sqlContext: true }).runner;
  exchange.masterSize = 0;
  await restarted.syncOnce(); await restarted.submitOrders();
  assert.equal(exchange.posts, 1);
  assert.equal((await guards()).length, 1);
  assert.equal((await previousStates())[0].has_unresolved_order, true);
});

test('terminal IOC partial fill can continue after confirmation and later close without stale locks', async () => {
  exchange.fillFraction = 0.5;
  const r = faultRunner(db, exchange, { sqlContext: true }).runner;
  await r.syncOnce(); await r.submitOrders();
  assert.equal(exchange.memberSize, 3);
  await confirmFill(r);
  exchange.fillFraction = 1;
  await r.submitOrders();
  assert.equal(exchange.memberSize, 6);
  await confirmFill(r);
  exchange.masterSize = 0;
  await r.syncOnce(); await r.submitOrders();
  assert.equal(exchange.memberSize, 0);
  assert.equal(exchange.posts, 3);
});

test('open exchange orders still prevent a new reduction after historical fills confirm', async () => {
  const r = faultRunner(db, exchange, { sqlContext: true }).runner;
  await r.syncOnce(); await r.submitOrders(); await confirmFill(r);
  exchange.openOrders = [{ contract: 'BTC_USDT' }];
  exchange.masterSize = 0;
  await r.syncOnce(); await r.submitOrders();
  assert.equal(exchange.posts, 1);
  assert.equal((await one('select pause_reason from public.copy_position_states')).pause_reason, 'OPEN_EXCHANGE_ORDER');
});

test('manual member changes remain protected after historical fills confirm', async () => {
  const r = faultRunner(db, exchange, { sqlContext: true }).runner;
  await r.syncOnce(); await r.submitOrders(); await confirmFill(r);
  exchange.memberSize = 7;
  await r.syncOnce(); await r.submitOrders();
  assert.equal(exchange.posts, 1);
  assert.equal((await previousStates())[0].state, 'MANUAL_OVERRIDE');
});

test('context RPC remains server-only', async () => {
  assert.equal((await one("select has_function_privilege('anon','public.get_copy_worker_context()','EXECUTE') ok")).ok, false);
  assert.equal((await one("select has_function_privilege('authenticated','public.get_copy_worker_context()','EXECUTE') ok")).ok, false);
  await db.exec("select set_config('request.jwt.claim.role','authenticated',false)");
  await assert.rejects(db.query('select public.get_copy_worker_context()'), /SERVICE_ROLE_REQUIRED/);
});
