import test, { before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createVerifiedDatabase, seedVerifiedAccount, ids, position } from './fixtures/verified-runtime.js';
import { reversalRuntime } from './fixtures/reversal-runtime.js';

let db;
before(async () => { db = await createVerifiedDatabase(); });
after(async () => { await db?.close(); });
beforeEach(async () => { await db.exec('begin'); await seedVerifiedAccount(db); });
afterEach(async () => { await db.exec('rollback'); });
const one = async (q, p = []) => (await db.query(q, p)).rows[0];
const entryCount = async () => Number((await one("select count(*) n from private.copy_order_intents where not reduce_only and submit_attempts>0")).n);

for (const sign of [1, -1]) for (const entryFirst of [true, false]) test(`${sign}: simultaneous legacy candidates, entry UUID ${entryFirst ? 'first' : 'last'}, claim limit 1 closes COPY first`, async () => {
  const f = reversalRuntime(db, sign); await f.initialize(); f.exchange.masterSize = -sign * 40;
  const runner = f.makeRunner({}, true); await runner.syncOnce(); await f.orderCandidates(entryFirst);
  assert.equal(Number((await one("select count(*) n from private.copy_order_intents where status='PLANNED'")).n), 2);
  const direct = await db.query("update private.copy_order_intents set status='SUBMITTING',submit_attempts=1 where status='PLANNED' and not reduce_only returning id");
  assert.equal(direct.rows.length, 0, 'trigger prevents bypassing the claim filter');
  await runner.submitOrders(1);
  assert.equal(f.submissions[1].reduce_only, true); assert.equal(f.submissions[1].size, -sign * 10);
  assert.equal(f.legs[f.oldSide], 0); assert.equal(f.legs[f.newSide], 0);
  await runner.submitOrders(1); assert.equal(await entryCount(), 1, 'flat but unconfirmed close cannot release entry');
  await f.confirm(runner); await runner.syncOnce(); await runner.submitOrders(1);
  assert.equal(f.legs[f.newSide], -sign * 10); assert.equal(f.submissions.length, 3);
  await f.confirm(runner); await runner.syncOnce(); await runner.submitOrders();
  assert.equal(f.submissions.length, 3, 'retry/sync must not duplicate entry');
});

for (const sign of [1, -1]) for (const fault of ['timeout', 'disconnect', 500, 429, 'malformed', 'beforeRpc', 'afterRpc']) test(`${sign}: reversal close ${fault}, restart waits for observed fill`, async () => {
  const f = reversalRuntime(db, sign); await f.initialize(); f.exchange.masterSize = -sign * 40;
  const flags = ['beforeRpc','afterRpc'].includes(fault) ? { [fault]: 'complete_copy_order_attempt' } : { exchange: fault };
  const first = f.makeRunner(flags); await first.syncOnce();
  if (flags.exchange) await first.submitOrders(); else await assert.rejects(first.submitOrders(), /SIMULATED/);
  assert.equal(f.legs[f.oldSide], 0); assert.equal(f.legs[f.newSide], 0);
  const status = (await one('select status from private.copy_order_intents where reduce_only')).status;
  assert.equal(status, fault === 'beforeRpc' ? 'SUBMITTING' : fault === 'afterRpc' ? 'FILLED' : 'UNKNOWN');
  const restarted = f.makeRunner({}, true); await f.expire(); await restarted.syncOnce();
  await restarted.submitOrders(); assert.equal(f.submissions.length, 2);
  await restarted.reconcileOrders(); await restarted.submitOrders(); assert.equal(f.submissions.length, 2);
  await f.confirm(restarted); await restarted.syncOnce(); await restarted.submitOrders();
  assert.equal(f.legs[f.oldSide], 0); assert.equal(f.legs[f.newSide], -sign * 10);
  assert.equal(f.submissions.length, 3);
});

for (const sign of [1, -1]) test(`${sign}: terminal partial close must finish and be observed before entry`, async () => {
  const f = reversalRuntime(db, sign); const runner = await f.initialize(); f.exchange.masterSize = -sign * 40;
  f.exchange.fillFraction = 0.5; await runner.syncOnce(); await runner.submitOrders();
  assert.equal(f.legs[f.oldSide], sign * 5); await runner.syncOnce(); await runner.submitOrders();
  assert.equal(await entryCount(), 1);
  await f.confirm(runner); f.exchange.fillFraction = 1; await runner.syncOnce(); await runner.submitOrders();
  assert.equal(f.submissions[2].reduce_only, true); assert.equal(f.submissions[2].size, -sign * 5);
  assert.equal(f.legs[f.oldSide], 0); assert.equal(f.legs[f.newSide], 0);
  await f.confirm(runner); await runner.syncOnce(); await runner.submitOrders();
  assert.equal(f.legs[f.newSide], -sign * 10); assert.equal(f.submissions.length, 4);
});

for (const sign of [1, -1]) test(`${sign}: nonterminal partial/UNKNOWN close never releases an opposite entry`, async () => {
  const f = reversalRuntime(db, sign); await f.initialize(); f.exchange.masterSize = -sign * 40;
  f.exchange.fillFraction = 0.5; f.exchange.nonterminal = true;
  const runner = f.makeRunner({ exchange: 'timeout' }, true); await runner.syncOnce(); await runner.submitOrders();
  const restarted = f.makeRunner({}, true); await f.expire(); await restarted.reconcileOrders();
  assert.equal((await one('select status from private.copy_order_intents where reduce_only')).status, 'PARTIALLY_FILLED');
  await f.confirm(restarted); await restarted.submitOrders();
  assert.equal(f.legs[f.oldSide], sign * 5); assert.equal(f.legs[f.newSide], 0); assert.equal(f.submissions.length, 2);
});

for (const sign of [1, -1]) test(`${sign}: protected residual hedge remains while only COPY closes`, async () => {
  const f = reversalRuntime(db, sign, sign * 3); const runner = await f.initialize();
  assert.equal(f.legs[f.oldSide], sign * 13); f.exchange.masterSize = -sign * 40;
  await runner.syncOnce(); await runner.submitOrders();
  assert.equal(f.submissions[1].size, -sign * 10); assert.equal(f.legs[f.oldSide], sign * 3);
  await f.confirm(runner); await runner.syncOnce(); await runner.submitOrders();
  assert.equal(f.legs[f.oldSide], sign * 3); assert.equal(f.legs[f.newSide], -sign * 10);
  assert.equal(f.submissions.length, 3);
});

for (const sign of [1, -1]) test(`${sign}: a Master keeping both COPY legs is normal dual operation`, async () => {
  const f = reversalRuntime(db, sign); const runner = await f.initialize();
  f.exchange.masterPositions = [position(sign * 40), position(-sign * 40)];
  await runner.syncOnce(); await runner.submitOrders();
  assert.equal(f.legs[f.oldSide], sign * 10); assert.equal(f.legs[f.newSide], -sign * 10);
  assert.equal(f.submissions.length, 2); assert.equal(f.submissions[1].reduce_only, false);
});

test('Master opposite leg disappearing after claim cannot turn a normal hedge plan into an unsafe reversal', async () => {
  const f = reversalRuntime(db); const runner = await f.initialize();
  f.exchange.masterPositions = [position(40), position(-40)]; await runner.syncOnce();
  f.exchange.masterPositions = [position(-40)]; await runner.submitOrders();
  assert.equal(f.submissions.length, 1);
  assert.match((await one("select last_error_code from private.copy_order_intents where position_side='SHORT'")).last_error_code, /COPY_REVERSAL_CLOSE_REQUIRED/);
});

test('final SQL authorization rechecks retiring COPY even when an older claim admitted a normal hedge', async () => {
  const f = reversalRuntime(db); const runner = await f.initialize();
  f.exchange.masterPositions = [position(40), position(-40)]; await runner.syncOnce();
  const [job] = (await db.query('select * from public.claim_copy_order_intents(1)')).rows;
  assert.equal(job.reduce_only, false);
  // Isolated fixture change: the final authorization must not trust the earlier claim.
  await db.query("update private.copy_current_positions set size=0 where trading_account_id=$1 and position_side='LONG'", [ids.master]);
  assert.equal((await one('select public.authorize_copy_order_submission($1,$2) allowed', [job.intent_id, ids.version])).allowed, false);
  assert.equal(f.submissions.length, 1);
});

test('reversal proof RPC is server-only and private admission cannot be invoked by service role directly', async () => {
  for (const role of ['anon', 'authenticated']) assert.equal((await one("select has_function_privilege($1,'public.get_copy_reversal_entry_context(uuid,uuid)','EXECUTE') allowed", [role])).allowed, false);
  assert.equal((await one("select has_function_privilege('service_role','private.copy_reversal_entry_context(private.copy_order_intents)','EXECUTE') allowed")).allowed, false);
});

for (const sign of [1, -1]) for (const authorized of [false, true]) test(`${sign}: worker dies ${authorized ? 'after' : 'before'} close authorization, no speculative opposite entry`, async () => {
  const f = reversalRuntime(db, sign); const runner = await f.initialize(); f.exchange.masterSize = -sign * 40;
  await runner.syncOnce();
  const [job] = (await db.query('select * from public.claim_copy_order_intents(1)')).rows;
  assert.equal(job.reduce_only, true);
  if (authorized) assert.equal((await one('select public.authorize_copy_order_submission($1,$2) allowed', [job.intent_id, ids.version])).allowed, true);
  const restarted = f.makeRunner({}, true); await f.expire(); await restarted.reconcileOrders();
  await restarted.syncOnce(); await restarted.submitOrders();
  assert.equal(f.legs[f.newSide], 0);
  if (authorized) {
    assert.equal(f.submissions.length, 1); assert.equal(f.legs[f.oldSide], sign * 10);
    assert.equal((await one('select status from private.copy_order_intents where id=$1', [job.intent_id])).status, 'UNKNOWN');
  } else {
    assert.equal(f.submissions.length, 2); assert.equal(f.submissions[1].reduce_only, true);
  }
});

for (const sign of [1, -1]) test(`${sign}: pure protected opposite hedge and member-only symbol are never adopted or closed`, async () => {
  const f = reversalRuntime(db, sign, sign * 3); f.exchange.masterSize = -sign * 40;
  const protectedPositions = [{ contract: 'BTC_USDT', position_side: f.oldSide, size: sign * 3 },
    { contract: 'SOXL_USDT', position_side: 'LONG', size: 7 }];
  await db.query('update private.member_copy_onboarding_baselines set member_positions=$1', [protectedPositions]);
  const runner = f.makeRunner(); const read = runner.readAccount;
  runner.readAccount = async account => {
    const result = await read(account);
    if (account.trading_account_id === ids.member) result.positions.push({ ...position(7, 'SOXL_USDT'), markPrice: 50 });
    return result;
  };
  await runner.syncOnce(); await runner.submitOrders(); await f.confirm(runner); await runner.submitOrders();
  assert.equal(f.submissions.length, 1); assert.equal(f.submissions[0].reduce_only, false);
  assert.equal(f.submissions[0].side, f.newSide); assert.equal(f.legs[f.oldSide], sign * 3);
  assert.equal(Number((await one("select actual_size from public.copy_position_states where contract='SOXL_USDT'")).actual_size), 7);
  assert.equal(Number((await one("select count(*) n from private.copy_order_intents where contract='SOXL_USDT'")).n), 0);
});
