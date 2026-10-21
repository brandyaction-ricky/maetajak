import test from 'node:test';
import assert from 'node:assert/strict';
import { planMemberPositions } from './trading-runner.js';
import { calculateTargetPosition } from './copy-engine.js';

// QA 2026-10-21 area B (order decision / sizing). These tests PROVE behaviour; a test named "BUG:" asserts the
// current (defective) behaviour so it passes today and documents the gap. No source file is modified.

const ETH = { quantoMultiplier: 0.01, sizeStep: 1, orderSizeMin: 1, orderSizeMax: 0, marketOrderSizeMax: 0,
  inDelisting: false, takerFeeRate: 0.0005 };
const contracts = new Map([['ETH_USDT', ETH]]);
const leg = (size, markPrice = 4_000, side = size < 0 ? 'SHORT' : 'LONG', mode) => ({ contract: 'ETH_USDT', size, markPrice,
  leverage: 10, posMarginMode: 'cross', positionSide: side, ...(mode ? { mode } : {}) });

// Mirrors record_copy_worker_cycle_with_target_anchors (20261019060200) for one planned leg.
function anchorFromPlan(p) {
  if (!p.anchor_update_allowed) return null;
  const desired = p.anchor_desired_target_size;
  const desiredValid = desired != null && (Math.sign(desired) === 0 || Math.sign(desired) === Math.sign(p.target_size))
    && Math.abs(desired) >= Math.abs(p.target_size);
  const anchorMaster = p.anchor_master_copyable_size != null
    && [0, Math.sign(p.master_copyable_size)].includes(Math.sign(p.anchor_master_copyable_size))
    && Math.abs(p.anchor_master_copyable_size) <= Math.abs(p.master_copyable_size)
    ? p.anchor_master_copyable_size : p.master_copyable_size;
  return { contract: p.contract, position_side: p.position_side, resume_version: 'r1', master_copyable_size: anchorMaster,
    target_size: p.target_size, protected_member_size: p.member_baseline_size || 0,
    lock_reason: p.target_lock_reason, ...(desiredValid ? { desired_target_size: desired } : {}) };
}

function cycle({ masterSize, actual, anchors, memberTotal = 1_590, masterTotal = 100_000, maxPositionRatio = 60, price = 4_000 }) {
  return planMemberPositions({
    cycleId: 'c', system: { emergency_halted: false, max_order_slippage_ratio: 0.005 }, contracts,
    master: { total: masterTotal, positions: masterSize ? [leg(masterSize, price)] : [] },
    member: { user_id: 'u', total: memberTotal, available: memberTotal, copy_ratio: 100, max_position_ratio: maxPositionRatio,
      resume_version: 'r1', positionMode: 'single', positions: actual ? [leg(actual, price)] : [],
      previous_states: [{ contract: 'ETH_USDT', position_side: 'LONG', actual_size: actual || 0, state: 'SYNCED' }],
      target_anchors: anchors },
  }).find((p) => p.position_side === 'LONG');
}

// Simulate: plan -> order fills exactly -> DB stores the anchor -> next cycle.
function runPath(masterPath, opts = {}) {
  let actual = 0;
  let anchors = [];
  const trace = [];
  for (const masterSize of masterPath) {
    const p = cycle({ masterSize, actual, anchors, ...opts });
    if (p.intent) actual = Number((actual + p.intent.delta_size).toPrecision(15));
    const a = anchorFromPlan(p);
    if (a) anchors = [a];
    trace.push({ masterSize, target: p.target_size, actual, reason: p.target_lock_reason });
  }
  return { actual, trace };
}

test('B1 BUG: a Master that scales out in small steps makes a small member over-reduce (floor compounds)', () => {
  // Member/Master equity 1,590/100,000 -> 15.9 lots per 1,000 Master lots. Master sells 1000 -> 500 in 10 cycles
  // (one TP ladder or one large close observed over several 5 s cycles).
  const path = [1_000, 950, 900, 850, 800, 750, 700, 650, 600, 550, 500];
  const { actual, trace } = runPath(path);
  assert.equal(trace[0].actual, 15, 'entry: floor(15.9)');
  const ideal = calculateTargetPosition({ masterSize: 500, masterEquity: 100_000, masterMarkPrice: 4_000,
    masterQuantoMultiplier: 0.01, memberEquity: 1_590, copyRatio: 100, maxPositionRatio: 60, sizeStep: 1 }).targetSize;
  assert.equal(ideal, 7, 'proportional at Master 500 = floor(7.95)');
  // Current behaviour: every partial reduction floors the already-floored holding again.
  assert.equal(actual, 5, `member ends at 5 lots (ideal 7): ${JSON.stringify(trace.map((t) => t.actual))}`);
  // The same Master change observed in ONE cycle gives the proportional answer (15 * 0.5 = 7.5 -> 7).
  assert.equal(runPath([1_000, 500]).actual, 7);
  // And the shortfall is never repaired: the Master buys back to 1000 and the member stays below proportional (15).
  const back = runPath([...path, 1_000]);
  assert.ok(back.actual < 15, `after Master returns to 1000 the member holds ${back.actual} (< 15)`);
});

test('B1 BUG: a 1-3 lot member is fully closed by a small Master partial close', () => {
  // Member 3 lots raw 3.0; Master trims 1000 -> 900 (-10%) then -> 800.
  const { trace } = runPath([1_000, 900, 800], { memberTotal: 300 });
  assert.deepEqual(trace.map((t) => t.actual), [3, 2, 1], 'proportional is 3, 2.7->2, 2.4->2');
});

test('B2 BUG: a capped member halves on a Master halving although the cap still binds, and never regrows', () => {
  // XAU-like: member 10,000 equity, cap 40% = 4,000 notional = 1,000 lots at 4,000 (0.001 multiplier); Master
  // exposure is far above the cap (desired 14,000 lots). Master takes 50% profit: proportional = 7,000 lots,
  // still far above the cap, so the member should keep the capped 1,000.
  const XAU = new Map([['XAU_USDT', { ...ETH, quantoMultiplier: 0.001 }]]);
  const pos = (size) => ({ contract: 'XAU_USDT', size, markPrice: 4_000, leverage: 10, posMarginMode: 'cross', positionSide: 'LONG' });
  const plan = (masterSize, actual, anchor) => planMemberPositions({
    cycleId: 'c', system: { emergency_halted: false }, contracts: XAU,
    master: { total: 10_000, positions: [pos(masterSize)] },
    member: { user_id: 'u', total: 10_000, available: 10_000, copy_ratio: 100, max_position_ratio: 40, resume_version: 'r1',
      positions: [pos(actual)], previous_states: [{ contract: 'XAU_USDT', position_side: 'LONG', actual_size: actual, state: 'SYNCED' }],
      target_anchors: [{ contract: 'XAU_USDT', position_side: 'LONG', resume_version: 'r1', ...anchor }] },
  })[0];
  const p = plan(7_000, 1_000, { master_copyable_size: 14_000, target_size: 1_000, desired_target_size: 14_000 });
  assert.equal(p.target_size, 500, 'sells 500 of 1,000 although min(cap 1,000, proportional 7,000) = 1,000');
  assert.equal(p.intent.delta_size, -500);
  assert.equal(p.anchor_desired_target_size, 500, 'the uncapped decision is overwritten with the halved holding');
  // Next cycle, nothing changes at the Master: the member never regrows to the cap.
  const next = plan(7_000, 500, { master_copyable_size: 7_000, target_size: 500, desired_target_size: 500 });
  assert.equal(next.target_size, 500);
  assert.equal(next.intent, undefined);
});

test('B3 BUG: a dual-mode Master hedge (LONG and SHORT of one contract) is copied as a one-sided position when the cap binds', () => {
  // Master 10,000 equity holds LONG 20 and SHORT -20 BTC (0.0001) at 50,000 = 100 USDT each... use larger:
  const BTC = new Map([['BTC_USDT', { quantoMultiplier: 0.0001, sizeStep: 1, orderSizeMin: 1, orderSizeMax: 0,
    marketOrderSizeMax: 0, inDelisting: false, takerFeeRate: 0.0005 }]]);
  const b = (size, side) => ({ contract: 'BTC_USDT', size, markPrice: 50_000, leverage: 10, posMarginMode: 'cross',
    positionSide: side, mode: side === 'LONG' ? 'dual_long' : 'dual_short' });
  // Each Master leg = 4,000 lots * 5 USDT = 20,000 notional on 10,000 equity (2x each, net 0).
  const planned = planMemberPositions({
    cycleId: 'c', system: { emergency_halted: false }, contracts: BTC,
    master: { total: 10_000, positions: [b(4_000, 'LONG'), b(-4_000, 'SHORT')] },
    member: { user_id: 'u', total: 1_000, available: 1_000, copy_ratio: 100, max_position_ratio: 30, positionMode: 'dual',
      positions: [], previous_states: [] },
  });
  const byside = Object.fromEntries(planned.map((p) => [p.position_side, p.target_size]));
  // Cap 30% of 1,000 = 300 notional = 60 lots for the CONTRACT (both legs share it).
  assert.equal(byside.LONG, 60, 'LONG takes the whole contract budget');
  assert.equal(Math.abs(byside.SHORT), 0, 'SHORT gets nothing: member is net LONG 300 USDT while the Master is flat net');
});

// ---- SAFE checks (pass = behaviour is correct) -------------------------------------------------------------------

test('SAFE: Master full close after many partial reductions closes the member to exactly 0 (reduce-only)', () => {
  const { actual, trace } = runPath([1_000, 950, 900, 0]);
  assert.equal(actual, 0);
  assert.equal(trace.at(-1).target, 0);
});

test('SAFE: Master increases in sub-lot steps accumulate (no lost remainder)', () => {
  // 1000 -> 1100 -> ... -> 2000 in steps of 100 (= 1.59 member lots each): member ends at floor(31.8) = 31.
  const path = [1_000];
  for (let m = 1_100; m <= 2_000; m += 100) path.push(m);
  // Cap raised so it does not bind (60% would cap at 23). Only the entry rounding (15.9 -> 15) may be lost.
  const { actual } = runPath(path, { maxPositionRatio: 100 });
  assert.ok(actual === 31 || actual === 30, `member ${actual}, proportional floor(31.8) = 31`);
});

test('SAFE: one-way Master flip LONG -> SHORT closes the member LONG first and holds the SHORT entry', () => {
  const planned = planMemberPositions({
    cycleId: 'c', system: { emergency_halted: false }, contracts,
    master: { total: 100_000, positions: [leg(-500)] },
    member: { user_id: 'u', total: 1_590, available: 1_590, copy_ratio: 100, max_position_ratio: 60, resume_version: 'r1',
      positionMode: 'single', positions: [leg(15)],
      previous_states: [{ contract: 'ETH_USDT', position_side: 'LONG', actual_size: 15, state: 'SYNCED' }],
      target_anchors: [{ contract: 'ETH_USDT', position_side: 'LONG', resume_version: 'r1', master_copyable_size: 1_000, target_size: 15 }] },
  });
  const long = planned.find((p) => p.position_side === 'LONG');
  const short = planned.find((p) => p.position_side === 'SHORT');
  assert.equal(long.intent.delta_size, -15);
  assert.equal(long.intent.reduce_only, true);
  assert.equal(short.intent, undefined);
  assert.equal(short.pause_reason, 'COPY_REVERSAL_CLOSE_REQUIRED');
});

test('B-note: a partially consumed anchor can turn a small Master SELL into a member BUY after the equity ratio grows', () => {
  // 1000 -> 1100 consumes 1 lot of 1.59 (anchor Master ~1062.89). Member equity then triples (deposit) and the Master
  // SELLS 1100 -> 1090: the leg reads as an increase over the partial anchor and buys.
  let p = cycle({ masterSize: 1_000, actual: 0, anchors: [] });
  let actual = p.intent.delta_size;
  let anchors = [anchorFromPlan(p)];
  p = cycle({ masterSize: 1_100, actual, anchors });
  actual += p.intent.delta_size;
  anchors = [anchorFromPlan(p)];
  assert.ok(anchors[0].master_copyable_size < 1_100 && anchors[0].master_copyable_size > 1_000);
  p = cycle({ masterSize: 1_090, actual, anchors, memberTotal: 4_770 });
  assert.ok(p.intent && p.intent.delta_size > 0, 'member buys while the Master sells');
});

test('B4: Master increases during a LIVE system halt move the anchor; re-enabling LIVE buys the whole backlog at once', () => {
  const plan = (masterSize, actual, anchors, halted) => planMemberPositions({
    cycleId: 'c', system: { emergency_halted: halted }, contracts,
    master: { total: 100_000, positions: [leg(masterSize)] },
    member: { user_id: 'u', total: 1_590, available: 1_590, copy_ratio: 100, max_position_ratio: 100, resume_version: 'r1',
      positionMode: 'single', positions: actual ? [leg(actual)] : [],
      previous_states: [{ contract: 'ETH_USDT', position_side: 'LONG', actual_size: actual, state: halted ? 'HALTED' : 'SYNCED' }],
      target_anchors: anchors },
  })[0];
  // Halted (LIVE mode: simulateSystemHalt=false). Master 1000 -> 3000 while halted.
  const halted = plan(3_000, 15, [{ contract: 'ETH_USDT', position_side: 'LONG', resume_version: 'r1', master_copyable_size: 1_000, target_size: 15, desired_target_size: 15 }], true);
  assert.equal(halted.state, 'HALTED');
  assert.equal(halted.intent, undefined);
  assert.equal(halted.anchor_update_allowed, true, 'anchor moves although nothing can be executed');
  assert.equal(halted.target_size, 39, 'capped at 100% of equity');
  // LIVE re-enabled later, Master unchanged at 3000: the member buys the whole backlog in one market order.
  const resumed = plan(3_000, 15, [anchorFromPlan(halted)], false);
  assert.ok(['MASTER_QUANTITY_UNCHANGED', 'CURRENT_RISK_CAP_REDUCTION'].includes(resumed.target_lock_reason), 'no Master change this cycle');
  assert.equal(resumed.intent.delta_size, 24);
});

test('B5: lowering max_position_ratio for an ACTIVE member sells down immediately (policy says "from later trades")', () => {
  // Member holds 23 lots = 920 USDT on 1,590 equity (58%). Admin lowers the cap 60% -> 30% (cap 477 = 11 lots).
  const p = cycle({ masterSize: 1_500, actual: 23, maxPositionRatio: 30,
    anchors: [{ contract: 'ETH_USDT', position_side: 'LONG', resume_version: 'r1', master_copyable_size: 1_500, target_size: 23, desired_target_size: 23 }] });
  assert.equal(p.target_lock_reason, 'CURRENT_RISK_CAP_REDUCTION');
  assert.equal(p.intent.delta_size, -12, 'sells 12 of 23 lots in the next cycle with no Master change');
  assert.equal(p.intent.reduce_only, true);
});
