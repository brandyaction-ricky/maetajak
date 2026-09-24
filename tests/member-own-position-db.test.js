import test, { before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createVerifiedDatabase, seedVerifiedAccount, cyclePayload, record, ids, position } from './fixtures/verified-runtime.js';

// K4 (operator decision 2026-09-25): members manage their own pre-copy holdings by hand while copying continues.
let db;
before(async () => { db = await createVerifiedDatabase(); });
after(async () => { await db?.close(); });
beforeEach(async () => { await db.exec('begin'); await seedVerifiedAccount(db); });
afterEach(async () => { await db.exec('rollback'); });
const one = async (sql, args = []) => (await db.query(sql, args)).rows[0];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const btc = (list) => Number((list || []).find((p) => p.contract === 'BTC_USDT')?.size || 0);
const proof = () => one('select status,reason,protected_positions,copy_positions from private.copy_ownership_checkpoints');
const anchors = async () => (await db.query(`select contract,position_side,resume_version,master_copyable_size::float8 master_copyable_size,
  target_size::float8 target_size,protected_member_size::float8 protected_member_size,lock_reason,observed_at
  from private.copy_target_anchors`)).rows;
const session = async () => (await one('select public.get_copy_resume_context() c')).c
  .find((s) => s.trading_account_id === ids.member);

// The member already held `own` BTC before copying; the ledger starts with it as the member's own.
async function start(own) {
  const legs = own ? JSON.stringify([{ contract: 'BTC_USDT', position_side: 'LONG', size: own }]) : '[]';
  await db.query('update private.member_copy_onboarding_baselines set member_positions=$1::jsonb', [legs]);
  await db.query(`insert into private.copy_ownership_checkpoints(trading_account_id,resume_version,status,protected_positions,copy_positions,observed_at)
    values($1,$2,'CONFIRMED',$3::jsonb,'[]',now()-interval '1 minute')`, [ids.member, ids.version, legs]);
}
// One worker cycle as the new worker runs it: ledger + own quantity from the DB context.
async function cycle(held, masterSize, previous = held) {
  await sleep(15);
  const s = await session();
  const payload = cyclePayload({ masterSize, actualSize: held, member: {
    ledger_positions: s.ledger_positions, member_position_baselines: s.ledger_protected_positions || s.member_positions,
    target_anchors: await anchors(),
    previous_states: [{ contract: 'BTC_USDT', position_side: 'LONG', actual_size: previous, state: 'SYNCED' }] } });
  await record(db, payload);
  return payload.members[0].planned_positions.find((p) => p.contract === 'BTC_USDT');
}
async function fillNext() {
  const [job] = (await db.query('select * from public.claim_copy_order_intents(10)')).rows;
  if (!job) return 0;
  assert.equal((await one('select public.authorize_copy_order_submission($1,$2) ok', [job.intent_id, ids.version])).ok, true);
  await db.query("select public.complete_copy_order_attempt($1,'FILLED','g-'||$2,$3,50000,201,'filled',null,'{\"terminal\":true}')",
    [job.intent_id, String(Math.random()), Number(job.delta_size)]);
  await db.query("update private.copy_order_intents set position_match_at=now()-interval '3 seconds', observation_confirmed_at=now() where id=$1", [job.intent_id]);
  return Number(job.delta_size);
}
// Own 5 BTC, then the Master (40 BTC) is copied: returns the held size (own + COPY).
async function ownPlusCopy() {
  await start(5);
  let held = 5;
  for (let i = 0; i < 3; i++) { await cycle(held, 40); held += await fillNext(); }
  await cycle(held, 40);
  const p = await proof();
  assert.equal(p.status, 'CONFIRMED');
  assert.equal(btc(p.protected_positions), 5);
  assert.ok(btc(p.copy_positions) > 0);
  return { held, copy: btc(p.copy_positions) };
}

test('K4: a member sale of their own holding is absorbed; the account stays CONFIRMED and keeps copying', async () => {
  await start(20);
  await cycle(20, 0);
  const plan = await cycle(15, 0, 20);
  assert.equal(plan.pause_reason, 'MEMBER_POSITION_RECONCILING', 'the unexplained leg is held for the cycle');
  assert.equal(plan.intent, undefined);
  const p = await proof();
  assert.deepEqual([p.status, p.reason, btc(p.protected_positions), btc(p.copy_positions)], ['CONFIRMED', 'MEMBER_CHANGE_ABSORBED', 15, 0]);
  assert.equal(btc((await one('select member_positions from private.member_copy_onboarding_baselines')).member_positions), 15);
  const event = await one("select severity,safe_payload from public.copy_events where event_type='MANUAL_OVERRIDE_DETECTED'");
  assert.equal(event.severity, 'INFO');
  assert.equal(event.safe_payload.reason, 'MEMBER_OWN_POSITION_CHANGED');
  const next = await cycle(15, 0);
  assert.notEqual(next.state, 'MANUAL_OVERRIDE');
  assert.equal(next.pause_reason, null);
});

test('K4: after a member sells part of their own quantity the platform never buys it back', async () => {
  const { held, copy } = await ownPlusCopy();
  const plan = await cycle(held - 3, 40, held); // the member sells 3 of their own 5
  assert.equal(plan.intent, undefined);
  let p = await proof();
  assert.deepEqual([p.status, btc(p.protected_positions), btc(p.copy_positions)], ['CONFIRMED', 2, copy]);
  const after = await cycle(held - 3, 40);
  assert.equal(after.intent, undefined, 'no buy-back of the member\'s own sale');
  assert.equal(after.target_size, held - 3);
  assert.equal(after.pause_reason, null);
  p = await proof();
  assert.equal(p.status, 'CONFIRMED');
});

test('K4: a member purchase is recorded as their own and copying continues', async () => {
  const { held, copy } = await ownPlusCopy();
  await cycle(held + 7, 40, held);
  const p = await proof();
  assert.deepEqual([p.status, btc(p.protected_positions), btc(p.copy_positions)], ['CONFIRMED', 12, copy]);
  const next = await cycle(held + 7, 40);
  assert.equal(next.intent, undefined, 'the member\'s purchase is not sold off');
  assert.equal(next.target_size, held + 7);
});

test('K4: a sale that reaches COPY locks only that leg (no buy-back) and warns', async () => {
  const { held, copy } = await ownPlusCopy();
  const remaining = held - 5 - 2; // all 5 own + 2 COPY sold
  await cycle(remaining, 40, held);
  const p = await proof();
  assert.deepEqual([p.status, btc(p.protected_positions), btc(p.copy_positions)], ['CONFIRMED', 0, copy - 2]);
  const [a] = await anchors();
  assert.deepEqual([a.lock_reason, a.target_size, a.protected_member_size], ['MEMBER_REDUCED_COPY_POSITION', copy - 2, 0]);
  const event = await one("select severity,safe_payload from public.copy_events where safe_payload->>'reason'='MEMBER_REDUCED_COPY_POSITION'");
  assert.equal(event.severity, 'WARNING');
  for (const masterSize of [40, 80, 10]) {
    const plan = await cycle(remaining, masterSize);
    assert.equal(plan.state, 'MANUAL_OVERRIDE');
    assert.equal(plan.pause_reason, 'MEMBER_REDUCED_COPY_POSITION');
    assert.equal(plan.intent, undefined, `no order at Master ${masterSize}`);
  }
  assert.equal((await anchors())[0].lock_reason, 'MEMBER_REDUCED_COPY_POSITION', 'the lock persists');
});

test('K4: a COPY reduction without an anchor of this generation cannot be locked, so the old UNKNOWN latch applies', async () => {
  const { held } = await ownPlusCopy();
  await db.exec('delete from private.copy_target_anchors');
  await cycle(held - 8, 40, held);
  assert.equal((await proof()).status, 'UNKNOWN');
});

test('K4: the ledger in the worker context includes confirmed fills not yet journaled', async () => {
  await start(5);
  await cycle(5, 40);
  const delta = await fillNext();
  assert.ok(delta > 0);
  const s = await session();
  assert.equal(btc(s.ledger_positions), 5 + delta);
  assert.equal(btc(s.ledger_protected_positions), 5);
});

test('K4: an unexplained leg held by an older worker (MANUAL_OVERRIDE) is still absorbed without UNKNOWN', async () => {
  await start(20);
  await cycle(20, 0);
  await sleep(15);
  // Worker 0.5.0 has no ledger: it latches MANUAL_OVERRIDE; the DB still attributes the change.
  await record(db, cyclePayload({ masterSize: 0, actualSize: 12, member: {
    member_position_baselines: [{ contract: 'BTC_USDT', position_side: 'LONG', size: 20 }],
    previous_states: [{ contract: 'BTC_USDT', position_side: 'LONG', actual_size: 20, state: 'SYNCED' }] } }));
  const p = await proof();
  assert.deepEqual([p.status, btc(p.protected_positions)], ['CONFIRMED', 12]);
});

test('K4: a change an older worker did not latch (it could still trade the leg) keeps the UNKNOWN latch', async () => {
  await start(20);
  await cycle(20, 0);
  await sleep(15);
  // Worker 0.5.0 after a PAUSED cycle skips change detection: the leg is not latched and could be bought back.
  await record(db, cyclePayload({ masterSize: 0, actualSize: 12, member: {
    member_position_baselines: [{ contract: 'BTC_USDT', position_side: 'LONG', size: 12 }],
    previous_states: [{ contract: 'BTC_USDT', position_side: 'LONG', actual_size: 20, state: 'PAUSED' }] } }));
  assert.equal((await proof()).status, 'UNKNOWN');
});

test('K4: while the member is not copying (resume required) their own changes are recorded', async () => {
  await start(20);
  await cycle(20, 0);
  await sleep(15);
  await record(db, cyclePayload({ masterSize: 0, actualSize: 9, member: { resume_required: true,
    member_position_baselines: [{ contract: 'BTC_USDT', position_side: 'LONG', size: 20 }],
    previous_states: [{ contract: 'BTC_USDT', position_side: 'LONG', actual_size: 20, state: 'PAUSED' }] } }));
  const p = await proof();
  assert.deepEqual([p.status, btc(p.protected_positions)], ['CONFIRMED', 9]);
});
