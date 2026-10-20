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
const proof = () => one('select status,reason,protected_positions,copy_positions,pending_member_change from private.copy_ownership_checkpoints');
const anchors = async () => (await db.query(`select contract,position_side,resume_version,master_copyable_size::float8 master_copyable_size,
  target_size::float8 target_size,protected_member_size::float8 protected_member_size,lock_reason,observed_at
  from private.copy_target_anchors`)).rows;
const anchors2 = async () => (await db.query(`select contract,position_side,resume_version,master_copyable_size::float8 master_copyable_size,
  target_size::float8 target_size,protected_member_size::float8 protected_member_size,lock_reason from private.copy_target_anchors`)).rows;
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
// A member change is attributed after two reads >= 2 s apart; age the first sighting instead of sleeping.
async function settle(held, masterSize, previous) {
  const first = await cycle(held, masterSize, previous);
  const pending = await one('select pending_member_change,pending_member_change_at from private.copy_ownership_checkpoints');
  assert.ok(pending.pending_member_change, 'the first sighting is only remembered');
  await db.exec("update private.copy_ownership_checkpoints set pending_member_change_at=pending_member_change_at-interval '3 seconds', observed_at=observed_at-interval '3 seconds'");
  return { first, second: await cycle(held, masterSize, held) };
}
const setSession = (state) => db.query('update private.copy_resume_sessions set state=$1', [state]);
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

test('K4: a member sale of their own holding is absorbed after a second read; the account keeps copying', async () => {
  await start(20);
  await cycle(20, 0);
  const { first, second } = await settle(15, 0, 20);
  for (const plan of [first, second]) {
    assert.equal(plan.pause_reason, 'MEMBER_POSITION_RECONCILING', 'the unexplained leg is held');
    assert.equal(plan.intent, undefined);
  }
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

test('K4: one lagging read is never attributed (the second read shows the ledger again)', async () => {
  const { held, copy } = await ownPlusCopy();
  await cycle(held - 9, 40, held); // a stale read that would reach COPY
  let p = await proof();
  assert.deepEqual([p.status, btc(p.protected_positions), btc(p.copy_positions)], ['CONFIRMED', 5, copy]);
  await db.exec("update private.copy_ownership_checkpoints set pending_member_change_at=pending_member_change_at-interval '3 seconds', observed_at=observed_at-interval '3 seconds'");
  const plan = await cycle(held, 40, held - 9);
  p = await proof();
  assert.deepEqual([p.status, btc(p.protected_positions), btc(p.copy_positions), p.pending_member_change], ['CONFIRMED', 5, copy, null]);
  assert.equal((await anchors())[0].lock_reason === 'MEMBER_REDUCED_COPY_POSITION', false);
  assert.equal(plan.intent, undefined);
});

test('K4: after a member sells part of their own quantity the platform never buys it back', async () => {
  const { held, copy } = await ownPlusCopy();
  const { first, second } = await settle(held - 3, 40, held); // the member sells 3 of their own 5
  assert.equal(first.intent, undefined); assert.equal(second.intent, undefined);
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
  await settle(held + 7, 40, held);
  const p = await proof();
  assert.deepEqual([p.status, btc(p.protected_positions), btc(p.copy_positions)], ['CONFIRMED', 12, copy]);
  const next = await cycle(held + 7, 40);
  assert.equal(next.intent, undefined, 'the member\'s purchase is not sold off');
  assert.equal(next.target_size, held + 7);
});

// 2026-10-20 (operator decision): a sale that reaches COPY no longer locks the leg. The sold COPY is not
// bought back, and later Master changes on the leg are followed.
async function copySold() {
  const { held, copy } = await ownPlusCopy();
  const remaining = held - 5 - 2; // all 5 own + 2 COPY sold
  await settle(remaining, 40, held);
  const p = await proof();
  assert.deepEqual([p.status, btc(p.protected_positions), btc(p.copy_positions)], ['CONFIRMED', 0, copy - 2]);
  const [a] = await anchors();
  assert.deepEqual([a.lock_reason, a.target_size, a.protected_member_size], ['MEMBER_REDUCED_COPY_ACCEPTED', copy - 2, 0]);
  const event = await one("select severity,safe_payload from public.copy_events where safe_payload->>'reason'='MEMBER_REDUCED_COPY_ACCEPTED'");
  assert.equal(event.severity, 'WARNING');
  assert.equal(await one("select 1 x from public.copy_events where safe_payload->>'reason'='MEMBER_REDUCED_COPY_POSITION'"), undefined);
  return { remaining, copy };
}

test('K4 2026-10-20: a sale that reaches COPY keeps copying and never buys the sold COPY back', async () => {
  const { remaining, copy } = await copySold();
  for (let i = 0; i < 3; i++) {
    const plan = await cycle(remaining, 40);
    assert.notEqual(plan.state, 'MANUAL_OVERRIDE');
    assert.equal(plan.intent, undefined, 'no buy-back while the Master is unchanged');
    assert.equal(plan.target_size, copy - 2);
    assert.equal(plan.pause_reason, null);
  }
  assert.equal((await proof()).status, 'CONFIRMED');
});

test('K4 2026-10-20: after a COPY sale a Master increase on the leg is followed (increment only)', async () => {
  const { remaining, copy } = await copySold();
  await cycle(remaining, 40);
  const plan = await cycle(remaining, 80);
  assert.ok(plan.intent && plan.intent.delta_size > 0, 'the Master increase is copied');
  assert.ok(plan.intent.delta_size <= copy + 1, 'only the increment, not the sold COPY');
  assert.equal(plan.intent.reduce_only, false);
});

test('K4 2026-10-20: after a COPY sale a Master reduction on the leg reduces the remaining COPY', async () => {
  const { remaining } = await copySold();
  await cycle(remaining, 40);
  const plan = await cycle(remaining, 10);
  assert.ok(plan.intent && plan.intent.delta_size < 0, 'the Master reduction is copied');
  assert.equal(plan.intent.reduce_only, true);
  assert.ok(Math.abs(plan.target_size) < remaining);
  const close = await cycle(remaining, 0);
  assert.equal(close.target_size, 0, 'a Master close closes the remaining COPY');
});

test('K4 2026-10-20: a COPY sale drops a stored pre-cap decision so a relaxed cap cannot regrow it', async () => {
  const { held, copy } = await ownPlusCopy();
  await db.query(`update private.copy_target_anchors set desired_target_size=target_size+30,
    desired_basis_target_size=target_size, desired_basis_resume_version=resume_version, desired_basis_master_size=master_copyable_size`);
  await settle(held - 7, 40, held);
  const a = await one('select desired_target_size,desired_basis_target_size,target_size::float8 t from private.copy_target_anchors');
  assert.deepEqual([a.desired_target_size, a.desired_basis_target_size, a.t], [null, null, copy - 2]);
});

test('K4 2026-10-20: an own-quantity change keeps a stored pre-cap decision consistent with the new target', async () => {
  const { held } = await ownPlusCopy();
  await db.query(`update private.copy_target_anchors set desired_target_size=target_size+30,
    desired_basis_target_size=target_size, desired_basis_resume_version=resume_version, desired_basis_master_size=master_copyable_size`);
  const before = await one('select target_size::float8 t from private.copy_target_anchors');
  await settle(held - 3, 40, held); // 3 of the member's own 5 sold
  const a = await one('select desired_target_size::float8 d,desired_basis_target_size::float8 b,target_size::float8 t from private.copy_target_anchors');
  assert.deepEqual([a.t, a.b, a.d], [before.t - 3, before.t - 3, before.t + 27]);
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

// Worker 0.5.0 (no ledger) caps own growth against COPY and targets anchors as stored: while the member is
// copying, its changes keep the old account-wide UNKNOWN latch.
const legacyCycle = async (actual, previous, own, state = 'SYNCED', masterSize = 0) => {
  await sleep(15);
  const payload = cyclePayload({ masterSize, actualSize: actual, member: { resume_required: state === 'PAUSED',
    member_position_baselines: own ? [{ contract: 'BTC_USDT', position_side: 'LONG', size: own }] : [],
    target_anchors: await anchors2(),
    previous_states: [{ contract: 'BTC_USDT', position_side: 'LONG', actual_size: previous, state }] } });
  await record(db, payload);
  return payload.members[0].planned_positions[0];
};

test('K4: with worker 0.5.0 an ACTIVE member\'s change keeps the UNKNOWN latch (no attribution it cannot honour)', async () => {
  await start(20);
  await cycle(20, 0);
  await legacyCycle(12, 20, 20);
  assert.equal((await proof()).status, 'UNKNOWN');
});

test('K4: while the member is not copying their own changes are recorded (any worker)', async () => {
  const { held, copy } = await ownPlusCopy();
  await setSession('PAUSED');
  const plan = await legacyCycle(held - 3, held, 5, 'PAUSED', 40);
  assert.equal((await proof()).status, 'CONFIRMED');
  await db.exec("update private.copy_ownership_checkpoints set pending_member_change_at=pending_member_change_at-interval '3 seconds', observed_at=observed_at-interval '3 seconds'");
  await legacyCycle(held - 3, held - 3, 5, 'PAUSED', 40);
  const p = await proof();
  assert.deepEqual([p.status, btc(p.protected_positions), btc(p.copy_positions)], ['CONFIRMED', 2, copy]);
  assert.equal(Number((await one("select count(*) n from private.copy_order_intents where status in ('PLANNED','QUEUED')")).n), 0);
  const [a] = await anchors2();
  assert.deepEqual([a.target_size, a.protected_member_size], [copy + 2, 2], 'the anchor carries the new own quantity');
  assert.equal(plan.intent, undefined);
});

test('K4: a member trade right after a platform fill on the same leg is settled once the fill is 30 s old', async () => {
  await start(5);
  await cycle(5, 40);
  const delta = await fillNext();
  await db.exec("update private.copy_order_intents set observation_confirmed_at=null, position_match_at=null");
  // The member sells 2 of their own before the fill was confirmed: the exact confirmation never matches.
  await cycle(5 + delta - 2, 40, 5);
  assert.equal((await proof()).status, 'CONFIRMED');
  await db.exec("update private.copy_order_intents set resolved_at=now()-interval '31 seconds' where filled_size<>0");
  await settle(5 + delta - 2, 40, 5 + delta - 2);
  const p = await proof();
  assert.deepEqual([p.status, btc(p.protected_positions), btc(p.copy_positions)], ['CONFIRMED', 3, delta]);
});
