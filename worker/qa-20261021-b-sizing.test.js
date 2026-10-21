import test from 'node:test';
import assert from 'node:assert/strict';
import { planMemberPositions, TradingRunner } from './trading-runner.js';
import { calculateTargetPosition } from './copy-engine.js';
import { anchorFromPlan } from '../tests/fixtures/anchor-mirror.js';

// QA 2026-10-21 area B (order decision / sizing). The reproductions of 0c39e77 now assert the fixed behaviour
// (fix/qa-sizing); anchors are chained through the mirror of the 20261021030000 database functions.

const ETH = { quantoMultiplier: 0.01, sizeStep: 1, orderSizeMin: 1, orderSizeMax: 0, marketOrderSizeMax: 0,
  inDelisting: false, takerFeeRate: 0.0005 };
const contracts = new Map([['ETH_USDT', ETH]]);
const leg = (size, markPrice = 4_000, side = size < 0 ? 'SHORT' : 'LONG', mode) => ({ contract: 'ETH_USDT', size, markPrice,
  leverage: 10, posMarginMode: 'cross', positionSide: side, ...(mode ? { mode } : {}) });

function cycle({ masterSize, actual, anchors, memberTotal = 1_590, masterTotal = 100_000, maxPositionRatio = 60, price = 4_000,
  system = {}, member = {} }) {
  return planMemberPositions({
    cycleId: 'c', system: { emergency_halted: false, max_order_slippage_ratio: 0.005, ...system }, contracts,
    master: { total: masterTotal, positions: masterSize ? [leg(masterSize, price)] : [] },
    member: { user_id: 'u', total: memberTotal, available: memberTotal, copy_ratio: 100, max_position_ratio: maxPositionRatio,
      resume_version: 'r1', positionMode: 'single', positions: actual ? [leg(actual, price)] : [],
      previous_states: [{ contract: 'ETH_USDT', position_side: 'LONG', actual_size: actual || 0, state: 'SYNCED' }],
      target_anchors: anchors, ...member },
  }).find((p) => p.position_side === 'LONG');
}

// Simulate: plan -> order fills exactly -> DB stores the anchor -> next cycle. A step may be [masterSize, options].
function runPath(masterPath, opts = {}) {
  let actual = 0;
  let anchors = [];
  const trace = [];
  for (const step of masterPath) {
    const [masterSize, stepOpts] = Array.isArray(step) ? step : [step, {}];
    const p = cycle({ masterSize, actual, anchors, ...opts, ...stepOpts });
    const executes = !(stepOpts.system?.emergency_halted || opts.system?.emergency_halted);
    if (p.intent && executes) actual = Number((actual + p.intent.delta_size).toPrecision(15));
    const a = anchorFromPlan(p);
    if (a) anchors = [a];
    trace.push({ masterSize, target: p.target_size, actual, reason: p.target_lock_reason, intent: p.intent });
  }
  return { actual, trace, anchors };
}

test('B1: a Master that scales out in small steps ends where the same reduction at once would (no compounding floor)', () => {
  // Member/Master equity 1,590/100,000 -> 15.9 lots per 1,000 Master lots. Master sells 1000 -> 500 in 10 cycles
  // (one TP ladder or one large close observed over several 5 s cycles).
  const path = [1_000, 950, 900, 850, 800, 750, 700, 650, 600, 550, 500];
  const { actual, trace } = runPath(path);
  assert.equal(trace[0].actual, 15, 'entry: floor(15.9)');
  const ideal = calculateTargetPosition({ masterSize: 500, masterEquity: 100_000, masterMarkPrice: 4_000,
    masterQuantoMultiplier: 0.01, memberEquity: 1_590, copyRatio: 100, maxPositionRatio: 60, sizeStep: 1 }).targetSize;
  assert.equal(ideal, 7, 'proportional at Master 500 = floor(7.95)');
  assert.equal(actual, 7, `member ends at 7 lots: ${JSON.stringify(trace.map((t) => t.actual))}`);
  assert.equal(runPath([1_000, 500]).actual, 7, 'one-shot result');
  // Every step is the one-shot result of the original anchor: floor(15 * m / 1000).
  assert.deepEqual(trace.map((t) => t.actual), path.map((m) => Math.floor(15 * m / 1_000)));
  assert.ok(trace.slice(1).every((t) => !t.intent || t.intent.reduce_only), 'never a buy on the way down');
});

test('B1: a 1-3 lot member is not closed out by small Master partial closes', () => {
  // Member 3 lots raw 3.0; Master trims 1000 -> 900 (-10%) then -> 800: proportional 2.7 -> 2, 2.4 -> 2.
  const { trace } = runPath([1_000, 900, 800], { memberTotal: 300 });
  assert.deepEqual(trace.map((t) => t.actual), [3, 2, 2]);
  assert.equal(trace[2].reason, 'MASTER_REDUCED_UNCOPIED_QUANTITY', 'the second trim only sells the rounded-away remainder');
});

test('B1: a full Master close after stepped reductions still closes to exactly 0', () => {
  const { actual, trace } = runPath([1_000, 950, 900, 850, 0]);
  assert.equal(actual, 0);
  assert.equal(trace.at(-1).intent.reduce_only, true);
});

const XAU = new Map([['XAU_USDT', { ...ETH, quantoMultiplier: 0.001 }]]);
const xau = (size) => ({ contract: 'XAU_USDT', size, markPrice: 4_000, leverage: 10, posMarginMode: 'cross', positionSide: 'LONG' });
const planXau = (masterSize, actual, anchor, extra = {}) => planMemberPositions({
  cycleId: 'c', system: { emergency_halted: false }, contracts: XAU,
  master: { total: 10_000, positions: [xau(masterSize)] },
  member: { user_id: 'u', total: 10_000, available: 10_000, copy_ratio: 100, max_position_ratio: 40, resume_version: 'r1',
    positions: [xau(actual)], previous_states: [{ contract: 'XAU_USDT', position_side: 'LONG', actual_size: actual, state: 'SYNCED' }],
    target_anchors: [{ contract: 'XAU_USDT', position_side: 'LONG', resume_version: 'r1', ...anchor }], ...extra },
})[0];

test('B2: a capped member keeps the cap on a Master reduction while the reduced decision still exceeds it', () => {
  // XAU-like: member 10,000 equity, cap 40% = 4,000 notional = 1,000 lots at 4,000 (0.001 multiplier); Master
  // exposure is far above the cap (desired 14,000 lots). Master takes 50% profit: proportional = 7,000 lots,
  // still far above the cap, so the member keeps the capped 1,000.
  const p = planXau(7_000, 1_000, { master_copyable_size: 14_000, target_size: 1_000, desired_target_size: 14_000 });
  assert.equal(p.target_size, 1_000, 'min(cap 1,000, proportional 7,000) = 1,000');
  assert.equal(p.intent, undefined);
  assert.equal(p.anchor_desired_target_size, 7_000, 'the uncapped decision is reduced proportionally (desired x ratio)');
  // Next cycle, nothing changes at the Master: still at the cap, nothing traded.
  const next = planXau(7_000, 1_000, anchorFromPlan(p));
  assert.equal(next.target_size, 1_000);
  assert.equal(next.intent, undefined);
  // Once the reduced decision falls below the holding, the member sells down to it.
  const deep = planXau(500, 1_000, anchorFromPlan(next));
  assert.equal(deep.target_size, 500);
  assert.equal(deep.intent.delta_size, -500);
  assert.equal(deep.intent.reduce_only, true);
});

test('B3: a dual-mode Master hedge (LONG and SHORT of one contract) is copied on both legs when the cap binds', () => {
  const BTC = new Map([['BTC_USDT', { quantoMultiplier: 0.0001, sizeStep: 1, orderSizeMin: 1, orderSizeMax: 0,
    marketOrderSizeMax: 0, inDelisting: false, takerFeeRate: 0.0005 }]]);
  const b = (size, side) => ({ contract: 'BTC_USDT', size, markPrice: 50_000, leverage: 10, posMarginMode: 'cross',
    positionSide: side, mode: side === 'LONG' ? 'dual_long' : 'dual_short' });
  const plan = (masterLong, masterShort, held = {}) => Object.fromEntries(planMemberPositions({
    cycleId: 'c', system: { emergency_halted: false }, contracts: BTC,
    master: { total: 10_000, positions: [b(masterLong, 'LONG'), b(masterShort, 'SHORT')] },
    member: { user_id: 'u', total: 1_000, available: 1_000, copy_ratio: 100, max_position_ratio: 30, positionMode: 'dual',
      positions: Object.entries(held).map(([side, size]) => b(size, side)), previous_states: [] },
  }).map((p) => [p.position_side, p.target_size]));
  // Each Master leg = 4,000 lots * 5 USDT = 20,000 notional on 10,000 equity (2x each, net 0). Member cap 30% of
  // 1,000 = 300 notional = 60 lots for the CONTRACT (both legs share it): 30 lots each, net 0 like the Master.
  assert.deepEqual(plan(4_000, -4_000), { LONG: 30, SHORT: -30 });
  // Asymmetric hedge (net long 2,000): both legs scaled by one factor (80:40 -> 40:20), net never above proportional.
  const asym = plan(4_000, -2_000);
  assert.deepEqual(asym, { LONG: 40, SHORT: -20 });
  assert.ok(asym.LONG + asym.SHORT <= 80 - 40);
  // Steady state: once held, neither leg is trimmed or grown.
  assert.deepEqual(plan(4_000, -4_000, { LONG: 30, SHORT: -30 }), { LONG: 30, SHORT: -30 });
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

test('B-note: after a partially consumed anchor a small Master SELL never becomes a member BUY, even after the equity ratio grows', () => {
  // 1000 -> 1100 consumes 1 lot of 1.59 (anchor Master ~1062.89). Member equity then triples (deposit) and the Master
  // SELLS 1100 -> 1090: it is above the partial anchor but below the last observation, so it is not an increase.
  let p = cycle({ masterSize: 1_000, actual: 0, anchors: [] });
  let actual = p.intent.delta_size;
  let anchors = [anchorFromPlan(p)];
  p = cycle({ masterSize: 1_100, actual, anchors });
  actual += p.intent.delta_size;
  anchors = [anchorFromPlan(p)];
  assert.ok(anchors[0].master_copyable_size < 1_100 && anchors[0].master_copyable_size > 1_000);
  p = cycle({ masterSize: 1_090, actual, anchors, memberTotal: 4_770 });
  assert.equal(p.intent, undefined, 'no member buy while the Master sells');
  assert.equal(p.target_lock_reason, 'MASTER_QUANTITY_UNCHANGED');
  assert.equal(p.anchor_master_copyable_size, anchors[0].master_copyable_size, 'the uncopied remainder stays carried');
  // A later real Master increase is followed again.
  anchors = [anchorFromPlan(p)];
  p = cycle({ masterSize: 1_200, actual, anchors, memberTotal: 4_770 });
  assert.ok(p.intent && p.intent.delta_size > 0);
});

test('B4: Master increases during a LIVE system halt are consumed; re-enabling LIVE buys nothing missed', () => {
  // Halted (LIVE mode: simulateSystemHalt=false). Master 1000 -> 3000 while halted, then LIVE again.
  const { trace, anchors } = runPath([1_000, [3_000, { system: { emergency_halted: true } }], 3_000, 4_000], { maxPositionRatio: 100 });
  const [, halted, resumed, later] = trace;
  assert.equal(halted.intent, undefined, 'nothing executed while halted (state HALTED)');
  assert.equal(halted.target, 39, 'the plan still shows what a running system would hold');
  assert.equal(halted.reason, 'INCREASE_CONSUMED_WHILE_BLOCKED');
  assert.equal(resumed.intent, undefined, 'no backlog bought after LIVE resumes');
  assert.equal(resumed.actual, 15);
  // Only the later Master change (+1000 = 15.9 lots) is followed.
  assert.equal(later.actual, 30);
  assert.equal(anchors[0].target_size, 30);
});

test('B4: execution disabled and a non-LIVE worker consume Master increases the same way', () => {
  for (const blocked of [{ system: { execution_enabled: false } }, { executionBlocked: true }]) {
    const p = planMemberPositions({ cycleId: 'c', system: { emergency_halted: false, ...blocked.system }, contracts,
      executionBlocked: blocked.executionBlocked, master: { total: 100_000, positions: [leg(2_000)] },
      member: { user_id: 'u', total: 1_590, available: 1_590, copy_ratio: 100, max_position_ratio: 100, resume_version: 'r1',
        positionMode: 'single', positions: [leg(15)],
        previous_states: [{ contract: 'ETH_USDT', position_side: 'LONG', actual_size: 15, state: 'SYNCED' }],
        target_anchors: [{ contract: 'ETH_USDT', position_side: 'LONG', resume_version: 'r1', master_copyable_size: 1_000, target_size: 15 }] },
    })[0];
    assert.equal(p.anchor_target_size, 15);
    assert.equal(anchorFromPlan(p).master_copyable_size, 2_000);
    assert.equal(anchorFromPlan(p).reference_master_size, 1_000, 'the held 15 lots still correspond to Master 1,000');
  }
});

test('B5: lowering max_position_ratio keeps the existing holding; the new ratio limits only later increases', () => {
  // Member holds 23 lots = 920 USDT on 1,590 equity (58%), anchored under 60%. Admin lowers the cap 60% -> 30%
  // (cap 477 = 11 lots).
  const anchor = { contract: 'ETH_USDT', position_side: 'LONG', resume_version: 'r1', master_copyable_size: 1_500,
    target_size: 23, desired_target_size: 23, max_position_ratio: 60 };
  const p = cycle({ masterSize: 1_500, actual: 23, maxPositionRatio: 30, anchors: [anchor] });
  assert.equal(p.intent, undefined, 'nothing sold because of the new ratio');
  assert.equal(p.target_size, 23);
  assert.equal(p.anchor_max_position_ratio, 60, 'the ratio of the held quantity is remembered while it is needed');
  // A Master increase buys nothing beyond the new cap (and sells nothing either).
  const up = cycle({ masterSize: 1_800, actual: 23, maxPositionRatio: 30, anchors: [anchorFromPlan(p)] });
  assert.equal(up.target_size, 23);
  assert.equal(up.intent, undefined);
  // A Master reduction still reduces proportionally.
  const down = cycle({ masterSize: 750, actual: 23, maxPositionRatio: 30, anchors: [anchorFromPlan(up)] });
  assert.equal(down.intent.delta_size < 0, true);
  assert.equal(down.target_size, 11);
  assert.equal(down.anchor_max_position_ratio, 30, 'within the new cap the old ratio is no longer remembered');
  // An equity drop (withdrawal, D10) still trims the held quantity, against the ratio it was established under.
  const withdrawn = cycle({ masterSize: 1_500, actual: 23, maxPositionRatio: 30, memberTotal: 795, anchors: [anchor] });
  assert.equal(withdrawn.target_size, 11, 'cap 60% of 795 = 477 USDT = 11 lots');
  assert.equal(withdrawn.target_lock_reason, 'CURRENT_RISK_CAP_REDUCTION');
});

test('B5: raising max_position_ratio keeps refilling towards the decided size', () => {
  const anchor = { contract: 'ETH_USDT', position_side: 'LONG', resume_version: 'r1', master_copyable_size: 1_500,
    target_size: 11, desired_target_size: 23, max_position_ratio: 30 };
  const p = cycle({ masterSize: 1_500, actual: 11, maxPositionRatio: 60, anchors: [anchor] });
  assert.equal(p.target_size, 23);
  assert.equal(p.intent.delta_size, 12);
});

test('B4/D1: member halted or paused consumes a Master increase too; an unresolved order keeps the anchor still', () => {
  const anchor = { contract: 'ETH_USDT', position_side: 'LONG', resume_version: 'r1', master_copyable_size: 1_000, target_size: 15 };
  for (const member of [{ halted: true }, { copy_paused: true }]) {
    const p = cycle({ masterSize: 2_000, actual: 15, maxPositionRatio: 100, anchors: [anchor], member });
    assert.equal(p.intent, undefined);
    assert.equal(p.anchor_target_size, 15);
  }
  const unresolved = cycle({ masterSize: 2_000, actual: 15, maxPositionRatio: 100, anchors: [anchor], member: { previous_states: [
    { contract: 'ETH_USDT', position_side: 'LONG', actual_size: 15, state: 'SYNCED', has_unresolved_order: true }] } });
  assert.equal(unresolved.anchor_update_allowed, false);
  assert.equal(unresolved.anchor_target_size, undefined);
});

test('B4: a DRY_RUN worker plans with execution blocked, so its anchors consume Master increases', async () => {
  const recorded = [];
  const runner = new TradingRunner({ supabase: {}, baseUrl: 'https://api.gateio.ws', workerId: 'w', workerVersion: 'qa',
    channelId: 'maetajak', mode: 'DRY_RUN' });
  runner.rpc = async (name, params = {}) => {
    switch (name) {
      case 'get_copy_worker_context': return { system: { emergency_halted: false, execution_enabled: true }, master: { trading_account_id: 'm' },
        members: [{ trading_account_id: 'a', user_id: 'u', copy_ratio: 100, max_position_ratio: 60, previous_states: [] }] };
      case 'get_copy_resume_context': return [{ trading_account_id: 'a', state: 'ACTIVE', version: 'r1', baseline_version: 'r1',
        positions: [], member_positions: [], copy_positions: [] }];
      case 'record_verified_copy_worker_cycle': recorded.push(params.p_payload); return null;
      default: return [];
    }
  };
  runner.loadContracts = async () => contracts;
  runner.readAccount = async (account) => {
    const now = new Date().toISOString();
    return { ...account, total: account.trading_account_id === 'm' ? 100_000 : 1_590, available: 1_590, open_orders: [],
      positionMode: 'single', observed_started_at: now, observed_at: now,
      positions: account.trading_account_id === 'm' ? [leg(1_000)] : [] };
  };
  await runner.syncOnce();
  const [p] = recorded[0].members[0].planned_positions;
  assert.equal(p.target_size, 15, 'the dry-run plan still shows the order a LIVE worker would place');
  assert.equal(p.intent, undefined);
  assert.equal(p.anchor_target_size, 0, 'the anchor consumes it, so switching to LIVE buys no backlog');
});
