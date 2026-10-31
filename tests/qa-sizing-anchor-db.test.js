import test, { before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createVerifiedDatabase, seedVerifiedAccount, cyclePayload, record, ids } from './fixtures/verified-runtime.js';

// 2026-10-21 QA sizing (supabase/migrations/20261021030000_qa_sizing_anchor.sql): anchors keep the worker's
// FUTURE_ONLY sizing fields, validate them, and drop them when another writer changes the anchor.
let db;
const one = async (q, p) => (await db.query(q, p)).rows[0];
const asWorker = () => db.query("select set_config('request.jwt.claim.role','service_role',false),set_config('test.admin','false',false)");
const anchors = async () => { await asWorker(); return (await one('select public.get_copy_target_anchors() a')).a; };
before(async () => { db = await createVerifiedDatabase(); });
after(async () => { await db?.close(); });
beforeEach(async () => { await db.exec('begin'); await seedVerifiedAccount(db); });
afterEach(async () => { await db.exec('rollback'); });

// Records one cycle whose single planned BTC leg is patched with `fields` (the worker's own fields otherwise).
async function recordWith(fields, options = {}) {
  const payload = cyclePayload(options);
  Object.assign(payload.members[0].planned_positions[0], fields);
  await record(db, payload);
  return (await anchors())[0];
}

test('qa sizing: the migration is idempotent', async () => {
  await db.exec(readFileSync('supabase/migrations/20261021030000_qa_sizing_anchor.sql', 'utf8'));
  await db.exec(readFileSync('supabase/migrations/20261021030000_qa_sizing_anchor.sql', 'utf8'));
  assert.ok(Array.isArray(await anchors()));
});

test('qa sizing: a worker write stores the consumed target, reference, observed Master and ratio', async () => {
  // Reduce-only member, Master opens 40: the plan targets 10 but the anchor records the 0 held.
  const a = await recordWith({}, { masterSize: 40, member: { reduce_only: true } });
  assert.deepEqual([Number(a.master_copyable_size), Number(a.target_size), Number(a.reference_master_size),
    Number(a.observed_master_size), Number(a.max_position_ratio)], [40, 0, 0, 40, 30]);
  assert.equal(a.lock_reason, 'INCREASE_CONSUMED_WHILE_BLOCKED');
});

test('qa sizing: invalid worker fields are ignored (target, desired, reference, ratio)', async () => {
  // Larger than the target / opposite side: the plan target is anchored instead.
  let a = await recordWith({ anchor_target_size: 11, anchor_desired_target_size: 12 }, { masterSize: 40 });
  assert.equal(Number(a.target_size), 10);
  assert.equal(Number(a.desired_target_size), 12, 'desired is validated against the anchored target');
  a = await recordWith({ anchor_target_size: -1, anchor_desired_target_size: 5, anchor_reference_master_size: 41,
    anchor_max_position_ratio: 0 }, { masterSize: 40 });
  assert.equal(Number(a.target_size), 10);
  assert.equal(a.desired_target_size, null, 'smaller than the anchored target');
  assert.equal(a.reference_master_size, null, 'above the stored Master quantity');
  assert.equal(a.max_position_ratio, null);
  a = await recordWith({ anchor_reference_master_size: -5, anchor_max_position_ratio: 101 }, { masterSize: 40 });
  assert.equal(a.reference_master_size, null, 'opposite side');
  assert.equal(a.max_position_ratio, null);
});

test('qa sizing: another anchor writer invalidates the sizing fields; an own-quantity rebase keeps them', async () => {
  await recordWith({ anchor_reference_master_size: 20, anchor_max_position_ratio: 50 }, { masterSize: 40 });
  // observe_copy_ownership moves target_size with the member's own quantity, never the Master quantity.
  await db.query('update private.copy_target_anchors set target_size = target_size + 2, protected_member_size = 2');
  let a = (await anchors())[0];
  assert.deepEqual([Number(a.reference_master_size), Number(a.observed_master_size), Number(a.max_position_ratio)], [20, 40, 50]);
  // Resume preparation / an administrative resync writes a new Master quantity or generation.
  await db.query('update private.copy_target_anchors set master_copyable_size = 30');
  a = (await anchors())[0];
  assert.deepEqual([a.reference_master_size, a.observed_master_size, a.max_position_ratio], [null, null, null]);
  await db.query('update private.copy_target_anchors set master_copyable_size = 40, resume_version = gen_random_uuid()');
  a = (await anchors())[0];
  assert.equal(a.reference_master_size, null);
});

test('qa sizing B5: after the ratio is lowered the next cycles keep the held quantity and buy nothing beyond it', async () => {
  // Member holds 10 lots of BTC (500 USDT = 10% of 5,000) anchored under 30%.
  await record(db, cyclePayload({ masterSize: 40, actualSize: 10, member: { target_anchors: [{ contract: 'BTC_USDT',
    position_side: 'LONG', resume_version: ids.version, master_copyable_size: 40, target_size: 10, protected_member_size: 0 }] } }));
  // The ratio is lowered far below the holding (5% of 5,000 = 250 USDT = 5 lots).
  let stored = await anchors();
  await record(db, cyclePayload({ masterSize: 40, actualSize: 10, member: { max_position_ratio: 5, target_anchors: stored } }));
  stored = await anchors();
  assert.equal(Number(stored[0].target_size), 10);
  assert.equal(Number(stored[0].max_position_ratio), 30, 'the ratio of the held quantity is kept');
  assert.equal(Number((await one('select count(*) n from private.copy_order_intents')).n), 0, 'nothing sold');
  // The Master doubles: nothing is bought above the new cap.
  await record(db, cyclePayload({ masterSize: 80, actualSize: 10, member: { max_position_ratio: 5, target_anchors: stored } }));
  assert.equal(Number((await one('select count(*) n from private.copy_order_intents')).n), 0, 'nothing bought');
});
