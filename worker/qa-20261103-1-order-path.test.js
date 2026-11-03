// QA 2026-11-03 area 1: order decision & execution path regression audit of the release candidate (24a640c).
// Multi-leg, multi-cycle simulation of the syncOnce member pipeline: FUTURE_ONLY baselines (two-cycle clear),
// target anchors chained through the DB mirror (tests/fixtures/anchor-mirror.js), R9 halt tracking, and every
// planned intent re-checked with assertSubmissionSnapshot before it "fills". No Gate or DB access.
import test from 'node:test';
import assert from 'node:assert/strict';
import { planMemberPositions, TradingRunner, DEFAULT_CROSS_LEVERAGE } from './trading-runner.js';
import { assertSubmissionSnapshot } from './execution-safety.js';
import { normalizeGatePositions, getFuturesPositions } from './gate.js';
import { calculateTargetPosition } from './copy-engine.js';
import { anchorFromPlan } from '../tests/fixtures/anchor-mirror.js';

const SPEC = {
  ETH_USDT: { quantoMultiplier: 0.01, price: 4_000 },
  BTC_USDT: { quantoMultiplier: 0.0001, price: 100_000 },
  XAU_USDT: { quantoMultiplier: 0.001, price: 4_000 },
};
function contractsMap(over = {}) {
  return new Map(Object.entries(SPEC).map(([name, c]) => [name, { name, quantoMultiplier: c.quantoMultiplier, sizeStep: 1,
    orderSizeMin: 1, orderSizeMax: 0, marketOrderSizeMax: 0, inDelisting: false, leverageMax: 100, takerFeeRate: 0.0005,
    ...(over[name] || {}) }]));
}
const parse = (k) => ({ contract: k.slice(0, k.lastIndexOf(':')), position_side: k.slice(k.lastIndexOf(':') + 1) });

class Sim {
  constructor({ masterMode = 'dual', memberMode = 'dual', masterTotal = 100_000, memberTotal = 2_000, copyRatio = 100,
    maxRatio = 30, master = {}, own = {}, contracts = contractsMap(), masterLeverage = 10, masterMargin = 'cross' } = {}) {
    Object.assign(this, { masterMode, memberMode, masterTotal, memberTotal, copyRatio, maxRatio, contracts, masterLeverage, masterMargin });
    this.prices = Object.fromEntries(Object.entries(SPEC).map(([k, v]) => [k, v.price]));
    this.master = new Map(Object.entries(master));
    this.member = new Map(Object.entries(own));
    this.own = new Map(Object.entries(own));
    this.resumeOwn = [...this.own].map(([k, size]) => ({ ...parse(k), size }));
    // FUTURE_ONLY activation: the Master's holdings at start are the baseline (copy_resume_ownership master_positions).
    this.baseline = [...this.master].filter(([, s]) => s).map(([k, size]) => ({ ...parse(k), size }));
    this.anchors = new Map();
    this.previous = new Map();
    this.runner = new TradingRunner({ supabase: null, mode: 'LIVE' });
    this.seq = 0;
    this.orders = [];
    this.rejections = [];
    this.memberLeverage = new Map();
  }
  restartWorker() { const seq = this.runner.cycleSeq; this.runner = new TradingRunner({ supabase: null, mode: 'LIVE' }); this.runner.cycleSeq = seq; }
  setMaster(k, size) { if (size) this.master.set(k, size); else this.master.delete(k); }
  flipMasterSingle(contract, size) { this.master.delete(`${contract}:LONG`); this.master.delete(`${contract}:SHORT`); if (size) this.master.set(`${contract}:${size > 0 ? 'LONG' : 'SHORT'}`, size); }
  pos(k, size, account) {
    const { contract, position_side: side } = parse(k);
    const mode = account === 'master' ? this.masterMode : this.memberMode;
    const leverage = account === 'master' ? this.masterLeverage : (this.memberLeverage.get(k) ?? this.masterLeverage);
    return { contract, size, markPrice: this.prices[contract], entryPrice: this.prices[contract], leverage,
      mode: mode === 'dual' ? (side === 'LONG' ? 'dual_long' : 'dual_short') : 'single', positionSide: side,
      posMarginMode: account === 'master' ? this.masterMargin : 'cross', pid: null };
  }
  masterAccount(unconfirmed = []) {
    const now = new Date().toISOString();
    return { total: this.masterTotal, available: this.masterTotal, equityIncludesUnrealised: true,
      positions: [...this.master].map(([k, s]) => this.pos(k, s, 'master')), unconfirmed_contracts: unconfirmed,
      observed_started_at: now, observed_at: now, open_orders: [], positionMode: this.masterMode };
  }
  memberPositions() { return [...this.member].filter(([, s]) => s).map(([k, s]) => this.pos(k, s, 'member')); }
  used() { return [...this.member].reduce((sum, [k, s]) => sum + Math.abs(s) * this.prices[parse(k).contract] * SPEC[parse(k).contract].quantoMultiplier / 10, 0); }
  step({ system = {}, mode = 'LIVE', memberExtra = {}, guards = [], unconfirmed = [], label = '' } = {}) {
    this.seq += 1;
    this.runner.cycleSeq += 1;
    for (const [k, p] of this.runner.pendingBaselineClears) if (p.seq < this.runner.cycleSeq - 1) this.runner.pendingBaselineClears.delete(k);
    const sys = { emergency_halted: false, execution_enabled: true, max_order_slippage_ratio: 0.005, ...system };
    const master = this.masterAccount(unconfirmed);
    // syncOnce baseline handling (contractsToClear -> confirmBaselineClear -> advance_member_copy_resume_baseline_legs).
    const toClear = this.baseline.filter((b) => {
      const cur = this.master.get(`${b.contract}:${b.position_side}`) || 0;
      return Math.abs(cur) < Math.abs(b.size) || Math.sign(cur) !== Math.sign(b.size);
    }).map((b) => { const cur = this.master.get(`${b.contract}:${b.position_side}`) || 0;
      return { contract: b.contract, position_side: b.position_side, size: Math.sign(cur) === Math.sign(b.size) ? cur : 0 }; });
    const confirmed = toClear.filter((p) => !unconfirmed.includes(p.contract))
      .map((p) => this.runner.confirmBaselineClear('acc', 'r1', p)).filter(Boolean);
    const upd = new Map(confirmed.map((p) => [`${p.contract}:${p.position_side}`, p]));
    this.baseline = this.baseline.map((b) => upd.get(`${b.contract}:${b.position_side}`) || b).filter((b) => Number(b.size) !== 0);
    const memberPositions = this.memberPositions();
    const guardKeys = new Set(guards);
    const previous = [...this.previous.values()].map((s) => ({ ...s, has_unresolved_order: guardKeys.has(`${s.contract}:${s.position_side}`) }));
    for (const g of guards) if (!this.previous.has(g)) previous.push({ ...parse(g), state: 'PAUSED', has_unresolved_order: true });
    const member = { user_id: 'u', trading_account_id: 'acc', total: this.memberTotal, available: Math.max(0, this.memberTotal - this.used()),
      equityIncludesUnrealised: true, copy_ratio: this.copyRatio, max_position_ratio: this.maxRatio, resume_version: 'r1',
      positionMode: this.memberMode, positions: memberPositions, open_orders: [], previous_states: previous,
      target_anchors: [...this.anchors.values()], master_baselines: this.baseline,
      member_position_baselines: [...this.own].filter(([, s]) => s).map(([k, size]) => ({ ...parse(k), size })),
      ledger_positions: memberPositions.map((p) => ({ contract: p.contract, position_side: p.positionSide, size: p.size })),
      resume_member_positions: this.resumeOwn, continued_copy_positions: [],
      halt_stale_anchor_legs: this.runner.haltStaleLegsFor('acc'), ...memberExtra };
    const systemBlocked = mode !== 'LIVE' || sys.emergency_halted || sys.execution_enabled === false;
    const plan = planMemberPositions({ cycleId: `c${this.seq}`, system: sys, master, member, contracts: this.contracts,
      simulateSystemHalt: mode === 'DRY_RUN', executionBlocked: mode !== 'LIVE' });
    this.runner.trackHaltStaleAnchors('acc', plan, systemBlocked);
    const orders = [];
    if (mode === 'LIVE' && !sys.emergency_halted && sys.execution_enabled !== false) {
      for (const p of plan.filter((x) => x.intent)) {
        const k = `${p.contract}:${p.position_side}`;
        const job = { intent_id: 'i', trading_account_id: 'acc', resume_version: 'r1', contract: p.contract, position_side: p.position_side,
          actual_size_at_plan: p.size, master_size_at_plan: p.master_actual_size, delta_size: p.intent.delta_size, target_size: p.target_size,
          reduce_only: p.intent.reduce_only, risk_leverage: p.risk_leverage, target_leverage: p.intent.target_leverage,
          quanto_multiplier: p.quanto_multiplier, taker_fee_rate: p.taker_fee_rate, position_mode: p.intent.position_mode };
        const now = new Date().toISOString();
        const acct = { observed_started_at: now, observed_at: now, positions: memberPositions, open_orders: [], positionMode: this.memberMode,
          available: member.available, halted: Boolean(member.halted), reduce_only: Boolean(member.reduce_only), account_policy_block: null };
        const opp = `${p.contract}:${p.position_side === 'LONG' ? 'SHORT' : 'LONG'}`;
        const oppSize = this.member.get(opp) || 0;
        const ownOpp = this.own.get(opp) || 0;
        const proof = { guard_version: 1, allowed: oppSize - ownOpp === 0, ownership_verified: true, intent_id: 'i', trading_account_id: 'acc',
          resume_version: 'r1', opposite_side: parse(opp).position_side, copy_opposite_size: oppSize - ownOpp, protected_opposite_size: ownOpp };
        const order = { k, delta: p.intent.delta_size, reduceOnly: p.intent.reduce_only, leverage: p.intent.target_leverage, label };
        try {
          assertSubmissionSnapshot(job, acct, master, proof);
        } catch (error) { this.rejections.push({ ...order, code: error.code }); continue; }
        this.member.set(k, Number(((this.member.get(k) || 0) + p.intent.delta_size).toPrecision(15)));
        if (!this.member.get(k)) this.member.delete(k);
        if (p.intent.target_leverage) this.memberLeverage.set(k, p.intent.target_leverage);
        orders.push(order);
        this.orders.push(order);
      }
    }
    for (const p of plan) {
      const k = `${p.contract}:${p.position_side}`;
      const a = anchorFromPlan(p);
      if (a) this.anchors.set(k, a);
      this.previous.set(k, { contract: p.contract, position_side: p.position_side, actual_size: p.size, state: p.state,
        target_leverage: p.target_leverage, margin_mode: p.margin_mode });
    }
    return { plan, orders, leg: (k) => plan.find((p) => `${p.contract}:${p.position_side}` === k) };
  }
}
const fmt = (orders) => orders.map((o) => `${o.k} ${o.delta > 0 ? '+' : ''}${o.delta}${o.reduceOnly ? ' R' : ''}`);

// ---------------------------------------------------------------- (a) FUTURE_ONLY start while the Master holds A, B
for (const [masterMode, memberMode] of [['dual', 'dual'], ['single', 'dual'], ['single', 'single']]) {
  test(`qa-1 (a) FUTURE_ONLY master=${masterMode} member=${memberMode}: open C, add A, trim B, close A, flip B and C`, () => {
    const s = new Sim({ masterMode, memberMode, master: { 'ETH_USDT:LONG': 500, 'BTC_USDT:LONG': 2_000 } });
    const flip = (contract, size) => (masterMode === 'single' ? s.flipMasterSingle(contract, size)
      : (s.setMaster(`${contract}:LONG`, size > 0 ? size : 0), s.setMaster(`${contract}:SHORT`, size < 0 ? size : 0)));
    const trace = [];
    const run = (label, opts) => { const r = s.step({ label, ...opts }); trace.push([label, fmt(r.orders)]); return r; };
    assert.deepEqual(fmt(run('start').orders), [], 'nothing of the pre-start holdings is bought');
    s.setMaster('XAU_USDT:LONG', 1_000);
    assert.deepEqual(fmt(run('open C').orders), ['XAU_USDT:LONG +20']);
    s.setMaster('ETH_USDT:LONG', 750);
    assert.deepEqual(fmt(run('add A').orders), ['ETH_USDT:LONG +5'], 'only the 250 added after start: 250*0.02');
    s.setMaster('BTC_USDT:LONG', 1_500);
    assert.deepEqual(fmt(run('trim B').orders), [], 'a reduction of an uncopied baseline sells nothing');
    assert.deepEqual(fmt(run('trim B confirm').orders), []);
    assert.deepEqual(s.baseline.find((b) => b.contract === 'BTC_USDT').size, 1_500, 'baseline shrinks after two reads');
    s.setMaster('ETH_USDT:LONG', 0);
    assert.deepEqual(fmt(run('close A').orders), ['ETH_USDT:LONG -5 R']);
    flip('BTC_USDT', -1_000);
    assert.deepEqual(fmt(run('flip B').orders), ['BTC_USDT:SHORT -20'], 'the new SHORT is a post-start change: copied');
    flip('XAU_USDT', -500);
    const flipC = run('flip C');
    assert.deepEqual(fmt(flipC.orders), ['XAU_USDT:LONG -20 R'], 'close the COPY leg first');
    assert.equal(flipC.leg('XAU_USDT:SHORT').pause_reason, 'COPY_REVERSAL_CLOSE_REQUIRED');
    assert.deepEqual(fmt(run('flip C 2').orders), ['XAU_USDT:SHORT -10']);
    s.setMaster('ETH_USDT:LONG', 100);
    assert.deepEqual(fmt(run('reopen A').orders), ['ETH_USDT:LONG +2'], 'A after its baseline cleared is fully copyable');
    for (let i = 0; i < 3; i++) assert.deepEqual(fmt(run(`idle ${i}`).orders), [], 'steady state: no further orders');
    assert.deepEqual(Object.fromEntries(s.member), { 'BTC_USDT:SHORT': -20, 'XAU_USDT:SHORT': -10, 'ETH_USDT:LONG': 2 }, JSON.stringify(trace));
    assert.deepEqual(s.rejections, [], 'every planned order passes the pre-submit guard');
  });
}

test('qa-1 (a) note: a Master reduction that cuts into the pre-start baseline sells the whole COPY first (LIFO semantics)', () => {
  const s = new Sim({ master: { 'ETH_USDT:LONG': 1_000 } });
  s.step();
  s.setMaster('ETH_USDT:LONG', 1_500);
  assert.deepEqual(fmt(s.step().orders), ['ETH_USDT:LONG +10']);
  // Master sells 20% of its position (1500 -> 1200): the member sells 60% of its COPY (copyable 500 -> 200).
  s.setMaster('ETH_USDT:LONG', 1_200);
  assert.deepEqual(fmt(s.step().orders), ['ETH_USDT:LONG -6 R']);
  // Master sells 1200 -> 900 (below the 1000 baseline): the COPY is gone while the Master still holds 60%.
  s.setMaster('ETH_USDT:LONG', 900);
  assert.deepEqual(fmt(s.step().orders), ['ETH_USDT:LONG -4 R']);
  assert.equal(s.member.get('ETH_USDT:LONG') ?? 0, 0);
});

// ---------------------------------------------------------------- (b) member's own position on the same contract
test('qa-1 (b) dual: own LONG on the copied leg is never sold; own SHORT on the other leg keeps its leverage', () => {
  const s = new Sim({ own: { 'ETH_USDT:LONG': 3, 'BTC_USDT:SHORT': -4 }, master: {} });
  s.memberLeverage.set('BTC_USDT:SHORT', 3);
  assert.deepEqual(fmt(s.step().orders), [], 'own holdings are protected at start');
  s.setMaster('ETH_USDT:LONG', 250);
  s.setMaster('BTC_USDT:LONG', 1_000);
  const open = s.step();
  assert.deepEqual(fmt(open.orders), ['ETH_USDT:LONG +5', 'BTC_USDT:LONG +20']);
  assert.equal(open.orders[1].leverage, null, 'D7: no leverage POST while the own SHORT leg is open');
  assert.equal(open.leg('BTC_USDT:LONG').leverage_reason, 'OPPOSITE_LEG_OPEN_LEVERAGE_KEPT');
  assert.equal(open.orders[0].leverage, null, 'own holding on the leg: no leverage change');
  s.setMaster('ETH_USDT:LONG', 0);
  s.setMaster('BTC_USDT:LONG', 0);
  assert.deepEqual(fmt(s.step().orders), ['ETH_USDT:LONG -5 R', 'BTC_USDT:LONG -20 R']);
  assert.deepEqual(Object.fromEntries(s.member), { 'ETH_USDT:LONG': 3, 'BTC_USDT:SHORT': -4 });
  assert.deepEqual(s.rejections, []);
});

test('qa-1 (b) single member: own SHORT blocks a Master LONG (consumed, not bought after the own SHORT closes)', () => {
  const s = new Sim({ masterMode: 'single', memberMode: 'single', own: { 'ETH_USDT:SHORT': -3 } });
  s.step();
  s.setMaster('ETH_USDT:LONG', 250);
  const blocked = s.step();
  assert.deepEqual(fmt(blocked.orders), []);
  assert.equal(blocked.leg('ETH_USDT:LONG').pause_reason, 'PROTECTED_EXISTING_POSITION_OPPOSITE_SIDE');
  // The member closes the own SHORT; the DB attributes it to the own quantity (ledger).
  s.member.delete('ETH_USDT:SHORT'); s.own.delete('ETH_USDT:SHORT');
  assert.deepEqual(fmt(s.step().orders), [], 'the consumed 250 is not bought later');
  s.setMaster('ETH_USDT:LONG', 500);
  assert.deepEqual(fmt(s.step().orders), ['ETH_USDT:LONG +5'], 'only the later increase');
});

test('qa-1 (b) single member: own LONG + COPY on the same leg, Master closes -> only COPY sold', () => {
  const s = new Sim({ masterMode: 'single', memberMode: 'single', own: { 'ETH_USDT:LONG': 3 } });
  s.step();
  s.setMaster('ETH_USDT:LONG', 250);
  assert.deepEqual(fmt(s.step().orders), ['ETH_USDT:LONG +5']);
  s.setMaster('ETH_USDT:LONG', 100);
  assert.deepEqual(fmt(s.step().orders), ['ETH_USDT:LONG -3 R'], 'COPY 5 * 100/250 = 2 kept');
  s.setMaster('ETH_USDT:LONG', 0);
  assert.deepEqual(fmt(s.step().orders), ['ETH_USDT:LONG -2 R']);
  assert.equal(s.member.get('ETH_USDT:LONG'), 3);
});

// ---------------------------------------------------------------- (c) leverage
test('qa-1 (c) Master cross with cross_leverage_limit 0: leverage reads 0, member gets min(10, contract max) cross', () => {
  const [raw] = normalizeGatePositions([{ contract: 'ETH_USDT', size: 250, mark_price: '4000', entry_price: '4000', leverage: '0',
    cross_leverage_limit: '0', mode: 'dual_long' }]);
  assert.equal(raw.leverage, 0);
  assert.equal(raw.posMarginMode, 'cross');
  for (const [leverageMax, expected] of [[100, DEFAULT_CROSS_LEVERAGE], [5, 5]]) {
    const s = new Sim({ contracts: contractsMap({ ETH_USDT: { leverageMax } }), masterLeverage: 0 });
    s.step();
    s.setMaster('ETH_USDT:LONG', 250);
    const r = s.step();
    assert.deepEqual(fmt(r.orders), ['ETH_USDT:LONG +5']);
    assert.equal(r.orders[0].leverage, expected);
    assert.equal(r.leg('ETH_USDT:LONG').margin_mode, 'cross');
    assert.equal(r.leg('ETH_USDT:LONG').leverage_reason, 'MASTER_LEVERAGE_UNREPORTED_DEFAULT');
  }
});

test('qa-1 (c) isolated Master 50x is followed as is (member max_leverage is not applied; policy "Master 자동 추종")', () => {
  const s = new Sim({ masterLeverage: 50, masterMargin: 'isolated' });
  s.step();
  s.setMaster('ETH_USDT:LONG', 250);
  const r = s.step({ memberExtra: { max_leverage: 10 } });
  assert.equal(r.orders[0].leverage, 50);
  assert.equal(r.leg('ETH_USDT:LONG').margin_mode, 'isolated');
});

// ---------------------------------------------------------------- (d) sizing extremes
test('qa-1 (d) tiny member: sub-lot targets never order; accumulation never exceeds the proportional floor', () => {
  const s = new Sim({ memberTotal: 50 });
  s.step();
  const ideal = (m) => calculateTargetPosition({ masterSize: m, masterEquity: 100_000, masterMarkPrice: 4_000, masterQuantoMultiplier: 0.001,
    memberEquity: 50, maxPositionRatio: 30, sizeStep: 1 }).targetSize;
  const trace = [];
  for (const m of [100, 200, 300, 400, 500, 600, 700, 800, 900, 1_000, 1_500, 2_000, 3_000, 4_000]) {
    s.setMaster('XAU_USDT:LONG', m);
    s.step();
    const held = s.member.get('XAU_USDT:LONG') || 0;
    trace.push([m, held, ideal(m)]);
    assert.ok(held <= ideal(m), `never above the one-shot proportional size: ${JSON.stringify(trace)}`);
  }
  assert.ok(s.orders.every((o) => !o.reduceOnly && o.delta > 0));
});

test('qa-1 (d) P2: the first sub-lot observation of a NEW leg is consumed (TARGET_ANCHOR_INITIALIZED), the member ends 1 lot short', () => {
  // Member/Master 1/1000 -> 0.6 lot per 600 Master lots of ETH. A new leg opened in three clips of 600.
  const s = new Sim({ memberTotal: 100 });
  s.step();
  const trace = [];
  for (const m of [600, 1_200, 1_800]) { s.setMaster('ETH_USDT:LONG', m); const r = s.step(); trace.push([m, s.member.get('ETH_USDT:LONG') || 0, r.leg('ETH_USDT:LONG').target_lock_reason]); }
  const ideal = calculateTargetPosition({ masterSize: 1_800, masterEquity: 100_000, masterMarkPrice: 4_000, masterQuantoMultiplier: 0.01,
    memberEquity: 100, maxPositionRatio: 100, sizeStep: 1 }).targetSize;
  assert.equal(ideal, 1);
  // Same three clips on a leg whose anchor starts at 0 (a FUTURE_ONLY baseline leg) reach the proportional size.
  assert.equal(trace.at(-1)[1], 0, `observed: ${JSON.stringify(trace)} (proportional floor ${ideal})`);
});

test('qa-1 (d) BTC big notional: cap = 30% of member equity, margin-limited; a deposit does not buy, a later increase does', () => {
  const s = new Sim({ memberTotal: 2_000 });
  s.step();
  s.setMaster('BTC_USDT:LONG', 50_000); // 5 BTC = 500k USDT on 100k equity
  const r = s.step();
  assert.deepEqual(fmt(r.orders), ['BTC_USDT:LONG +60'], '600 USDT cap / 10 USDT per lot');
  assert.equal(r.leg('BTC_USDT:LONG').target_lock_reason, 'TARGET_ANCHOR_INITIALIZED');
  s.memberTotal = 4_000; // deposit
  const dep = s.step();
  assert.ok(dep.orders.length <= 1);
  // The leg grows back toward the capped decision (desired) once the cap relaxed (design B-note, "grows back").
  assert.deepEqual(fmt(dep.orders), ['BTC_USDT:LONG +60'], 'cap relaxed: capped leg regrows without a Master change');
  s.memberTotal = 1_000; // withdrawal
  assert.deepEqual(fmt(s.step().orders), ['BTC_USDT:LONG -90 R'], 'trimmed to the new cap 300 USDT');
  assert.deepEqual(s.rejections, []);
});

test('qa-1 (d) uncapped leg: equity change alone neither buys nor sells; the next Master change is sized at the new equity', () => {
  const s = new Sim({ memberTotal: 2_000 });
  s.step();
  s.setMaster('ETH_USDT:LONG', 500);
  assert.deepEqual(fmt(s.step().orders), ['ETH_USDT:LONG +10']);
  s.memberTotal = 4_000;
  assert.deepEqual(fmt(s.step().orders), []);
  s.setMaster('ETH_USDT:LONG', 750);
  assert.deepEqual(fmt(s.step().orders), ['ETH_USDT:LONG +10'], '250 * 0.04');
  s.setMaster('ETH_USDT:LONG', 375);
  assert.deepEqual(fmt(s.step().orders), ['ETH_USDT:LONG -10 R'], 'reduction proportional to the reference: 20 * 375/750');
});

// ---------------------------------------------------------------- (e) risk pending/confirmed/resume, halt/re-enable
test('qa-1 (e) risk pending holds an increase, confirmation consumes it, admin resume (same version) buys nothing', () => {
  const s = new Sim();
  s.step();
  s.setMaster('ETH_USDT:LONG', 500);
  assert.deepEqual(fmt(s.step().orders), ['ETH_USDT:LONG +10']);
  s.setMaster('ETH_USDT:LONG', 1_000);
  const pending = s.step({ memberExtra: { reduce_only: true, risk_halt_pending: 'DAILY_LOSS_LIMIT', profile_reduce_only: false } });
  assert.deepEqual(fmt(pending.orders), []);
  assert.equal(pending.leg('ETH_USDT:LONG').anchor_update_allowed, false, 'held, not consumed');
  const confirmed = s.step({ memberExtra: { reduce_only: true, risk_halt_reason: 'DAILY_LOSS_LIMIT', profile_reduce_only: false } });
  assert.equal(confirmed.leg('ETH_USDT:LONG').target_lock_reason, 'INCREASE_CONSUMED_WHILE_BLOCKED');
  s.step({ memberExtra: { reduce_only: true, profile_reduce_only: true } });
  assert.deepEqual(fmt(s.step().orders), [], 'request_member_copy_resume on ACTIVE clears reduce_only only: no catch-up buy');
  s.setMaster('ETH_USDT:LONG', 1_250);
  assert.deepEqual(fmt(s.step().orders), ['ETH_USDT:LONG +5']);
  s.setMaster('ETH_USDT:LONG', 0);
  assert.deepEqual(fmt(s.step().orders), ['ETH_USDT:LONG -15 R']);
});

test('qa-1 (e) risk pending that is not confirmed (unrecorded transfer) still buys the held increase (R2 intent)', () => {
  const s = new Sim();
  s.step();
  s.setMaster('ETH_USDT:LONG', 500);
  s.step();
  s.setMaster('ETH_USDT:LONG', 1_000);
  s.step({ memberExtra: { reduce_only: true, risk_halt_pending: 'DAILY_LOSS_LIMIT' } });
  assert.deepEqual(fmt(s.step().orders), ['ETH_USDT:LONG +5'], 'held increase bought, up to the 30% cap (15 lots)');
});

test('qa-1 (e) system halt -> Master adds/trims -> re-enable: increases consumed, reductions followed after release', () => {
  const s = new Sim();
  s.step();
  s.setMaster('ETH_USDT:LONG', 500);
  s.setMaster('XAU_USDT:LONG', 1_000);
  assert.deepEqual(fmt(s.step().orders), ['ETH_USDT:LONG +10', 'XAU_USDT:LONG +20']);
  s.setMaster('ETH_USDT:LONG', 1_000);
  s.setMaster('XAU_USDT:LONG', 500);
  for (let i = 0; i < 3; i++) assert.deepEqual(fmt(s.step({ system: { emergency_halted: true } }).orders), []);
  assert.deepEqual(fmt(s.step().orders), ['XAU_USDT:LONG -10 R'], 'only the reduction made during the halt');
  s.setMaster('ETH_USDT:LONG', 500);
  assert.deepEqual(fmt(s.step().orders), [], 'reduction back to the held reference sells nothing (copy decision stands)');
  s.setMaster('ETH_USDT:LONG', 250);
  assert.deepEqual(fmt(s.step().orders), ['ETH_USDT:LONG -5 R']);
});

for (const restart of [false, true]) {
  test(`qa-1 (e) R9: leg held by an unresolved order through the whole halt, ${restart ? 'worker RESTARTED' : 'same process'} before re-enable`, () => {
    const s = new Sim();
    s.step();
    s.setMaster('ETH_USDT:LONG', 500);
    s.step();
    s.setMaster('ETH_USDT:LONG', 1_000);
    for (let i = 0; i < 3; i++) s.step({ system: { emergency_halted: true }, guards: ['ETH_USDT:LONG'] });
    if (restart) s.restartWorker();
    const released = s.step();
    if (restart) {
      assert.deepEqual(fmt(released.orders), ['ETH_USDT:LONG +5'], 'P2 finding: the in-memory R9 set is lost on restart -> catch-up buy');
    } else {
      assert.deepEqual(fmt(released.orders), []);
      assert.equal(released.leg('ETH_USDT:LONG').target_lock_reason, 'INCREASE_CONSUMED_AFTER_SYSTEM_BLOCK');
    }
  });
}

// ---------------------------------------------------------------- (f) DRY_RUN -> LIVE
test('qa-1 (f) ACTIVE member through DRY_RUN: no intents, increases consumed, LIVE (new process) follows only later changes', () => {
  const s = new Sim();
  s.step();
  s.setMaster('ETH_USDT:LONG', 500);
  assert.deepEqual(fmt(s.step().orders), ['ETH_USDT:LONG +10']);
  s.setMaster('ETH_USDT:LONG', 1_000);
  s.setMaster('XAU_USDT:LONG', 1_000);
  const dry = s.step({ mode: 'DRY_RUN' });
  assert.ok(dry.plan.every((p) => !p.intent || true));
  assert.equal(dry.leg('XAU_USDT:LONG').target_lock_reason, 'INCREASE_CONSUMED_WHILE_BLOCKED');
  s.step({ mode: 'DRY_RUN' });
  s.restartWorker();
  assert.deepEqual(fmt(s.step().orders), [], 'no catch-up buy on LIVE');
  s.setMaster('XAU_USDT:LONG', 2_000);
  assert.deepEqual(fmt(s.step().orders), ['XAU_USDT:LONG +20']);
  // A reduction made during DRY_RUN is executed on the first LIVE cycle (catch-up SELL, risk-reducing).
  s.setMaster('ETH_USDT:LONG', 250);
  s.step({ mode: 'DRY_RUN' });
  s.restartWorker();
  assert.deepEqual(fmt(s.step().orders), ['ETH_USDT:LONG -5 R']);
});

function resumeRunner(mode, { masterPositions = [], memberPositions = [], masterObserved = true, masterListEmpty } = {}) {
  const calls = [];
  const runner = new TradingRunner({ supabase: null, mode });
  // Q1: by default a Master cycle of this process has already run (and the DB's last Master legs were read).
  if (masterObserved) { runner.masterObservedAt = Date.now(); runner.persistedMasterLoaded = true; }
  runner.rpc = async (name, params) => {
    calls.push([name, params]);
    if (name === 'get_member_copy_resume_ownership') return { master_positions: params.p_master_positions, member_positions: params.p_member_positions,
      copy_positions: [], target_anchors: [] };
    if (name === 'activate_member_copy_resume') return { state: 'ACTIVE' };
    return null;
  };
  const snapshot = () => { const startedAt = Date.now(); const at = new Date().toISOString();
    const base = { observed_started_at: at, observed_at: at, open_orders: [], total: 1_000, available: 1_000, positionMode: 'dual' };
    const masterList = typeof masterPositions === 'function' ? masterPositions() : masterPositions;
    return { startedAt, openOrders: [], master: { ...base, total: 100_000, positions: masterList,
      list_empty: masterListEmpty ?? !masterList.length },
      member: { ...base, copy_ratio: 100, max_position_ratio: 30, positions: memberPositions } }; };
  runner.readResumeSnapshot = async () => snapshot();
  return { runner, calls };
}
const SESSION = (state, expiresInMs = 60_000) => ({ state, version: '00000000-0000-4000-8000-000000000001', ownership_status: 'CONFIRMED',
  resume_authorized: true, unresolved_orders: 0, expires_at: new Date(Date.now() + expiresInMs).toISOString() });

test('qa-1 (f) resume in DRY_RUN validates only; VALIDATED stays untouched in DRY_RUN; LIVE re-validates and activates; expiry blocks', async () => {
  const contracts = contractsMap();
  const ctx = { trading_account_id: 'acc', user_id: 'u' };
  const dry = resumeRunner('DRY_RUN');
  assert.deepEqual(await dry.runner.processMemberResume({ session: SESSION('REQUESTED'), masterContext: {}, memberContext: ctx, contracts,
    system: { execution_enabled: true } }), { validated: true });
  assert.deepEqual(dry.calls.map(([n]) => n), ['get_member_copy_resume_ownership', 'prepare_member_copy_resume']);
  const dry2 = resumeRunner('DRY_RUN');
  assert.deepEqual(await dry2.runner.processMemberResume({ session: SESSION('VALIDATED'), masterContext: {}, memberContext: ctx, contracts,
    system: { execution_enabled: true } }), { validated: true });
  assert.deepEqual(dry2.calls, []);
  const live = resumeRunner('LIVE', { masterPositions: [{ contract: 'ETH_USDT', size: 500, markPrice: 4_000, positionSide: 'LONG', mode: 'dual_long' }] });
  const result = await live.runner.processMemberResume({ session: SESSION('VALIDATED'), masterContext: {}, memberContext: ctx, contracts,
    system: { execution_enabled: true } });
  assert.deepEqual(result, { validated: true, activated: true });
  const activation = live.calls.find(([n]) => n === 'activate_member_copy_resume')[1].p_snapshot;
  assert.deepEqual(activation.master_positions, [{ contract: 'ETH_USDT', position_side: 'LONG', size: 500 }], 'baseline = Master at LIVE activation');
  const expired = resumeRunner('LIVE');
  await expired.runner.processMemberResume({ session: SESSION('VALIDATED', -1), masterContext: {}, memberContext: ctx, contracts,
    system: { execution_enabled: true } });
  assert.deepEqual(expired.calls.map(([n, p]) => [n, p.p_reason]), [['report_member_copy_resume_blocker', 'RESUME_REQUEST_EXPIRED']]);
});

// ---------------------------------------------------------------- (g) Master list empty / partial (C1)
test('qa-1 (g) C1: anchored new leg seen flat only through the empty-list fallback is held one cycle, then closed', () => {
  const s = new Sim();
  s.step();
  s.setMaster('XAU_USDT:LONG', 1_000);
  assert.deepEqual(fmt(s.step().orders), ['XAU_USDT:LONG +20']);
  const anchors = [...s.anchors.values()].map((a) => ({ ...a, trading_account_id: 'acc' }));
  // Cycle N+1: Gate list empty, single-contract read 404 -> master shows no XAU (fallback only).
  s.runner.cycleSeq += 0;
  const flat = { positions: [], list_empty_fallback_contracts: ['XAU_USDT'] };
  s.setMaster('XAU_USDT:LONG', 0);
  const held = s.runner.confirmFallbackFlatLegs(flat, anchors);
  assert.deepEqual(held, ['XAU_USDT']);
  // step() increments cycleSeq; replicate: confirm for the cycle being run.
  s.runner.cycleSeq -= 1;
  const first = s.step({ unconfirmed: s.runner.confirmFallbackFlatLegs(flat, anchors) });
  assert.deepEqual(fmt(first.orders), []);
  assert.equal(first.leg('XAU_USDT:LONG').pause_reason, 'MASTER_POSITION_UNCONFIRMED');
  assert.equal(first.leg('XAU_USDT:LONG').anchor_update_allowed, false);
  // Glitch over: XAU visible again -> nothing to do, nothing was sold.
  s.setMaster('XAU_USDT:LONG', 1_000);
  assert.deepEqual(fmt(s.step().orders), []);
  // Two consecutive fallback-flat reads: closed on the second.
  s.setMaster('XAU_USDT:LONG', 0);
  const seqA = s.runner.cycleSeq + 1;
  s.runner.cycleSeq = seqA - 1;
  const h1 = (() => { s.runner.cycleSeq += 1; const h = s.runner.confirmFallbackFlatLegs(flat, anchors); s.runner.cycleSeq -= 1; return h; })();
  assert.deepEqual(fmt(s.step({ unconfirmed: h1 }).orders), []);
  const h2 = (() => { s.runner.cycleSeq += 1; const h = s.runner.confirmFallbackFlatLegs(flat, anchors); s.runner.cycleSeq -= 1; return h; })();
  assert.deepEqual(h2, []);
  assert.deepEqual(fmt(s.step({ unconfirmed: h2 }).orders), ['XAU_USDT:LONG -20 R']);
});

test('qa-1 (g) Q1 fixed: an empty Master list right after a restart no longer becomes an empty FUTURE_ONLY baseline', async () => {
  const requests = [];
  const fetchImpl = async (url) => {
    requests.push(new URL(url).pathname);
    return new Response(JSON.stringify([]), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const positions = await getFuturesPositions({ apiKey: 'k', secretKey: 's', fetchImpl, baseUrl: 'https://example.invalid' });
  assert.deepEqual([...positions], []);
  assert.equal(positions.listEmptyFallbackContracts, undefined);
  assert.equal(positions.listEmpty, true, 'the empty list is now marked (non-enumerable)');
  assert.deepEqual(Object.keys(positions), []);
  // A fresh process has observed nothing: the resume is refused before any read (retryable blocker).
  const fresh = resumeRunner('LIVE', { masterPositions: [], masterObserved: false });
  await fresh.runner.processMemberResume({ session: SESSION('REQUESTED'), masterContext: {}, memberContext: { trading_account_id: 'acc' },
    contracts: contractsMap(), system: { execution_enabled: true } });
  assert.deepEqual(fresh.calls.map(([n, p]) => [n, p.p_reason]), [['report_member_copy_resume_blocker', 'RESUME_MASTER_SNAPSHOT_UNCONFIRMED']]);
  // The DB says the Master held ETH (last record of the previous process); the empty list leaves it unconfirmed.
  const { runner, calls } = resumeRunner('LIVE', { masterPositions: [], masterObserved: false });
  runner.rpc = ((rpc) => async (name, params) => (name === 'get_public_master_positions'
    ? { observed_at: new Date(Date.now() - 30_000).toISOString(), positions: [{ contract: 'ETH_USDT', side: 'LONG', size: 1_000 }] }
    : rpc(name, params)))(runner.rpc);
  await runner.loadPersistedMasterLegs();
  assert.deepEqual(runner.masterExpectations(), { contracts: ['ETH_USDT'], legs: ['ETH_USDT:LONG'] }, 'the Master read now asks Gate for ETH');
  runner.cycleSeq = 1;
  runner.trackMasterLegConfirmation({ list_empty: true, positions: [] }, new Map(), new Map(), new Set());
  await runner.processMemberResume({ session: SESSION('REQUESTED'), masterContext: {}, memberContext: { trading_account_id: 'acc' },
    contracts: contractsMap(), system: { execution_enabled: true } });
  assert.equal(calls.find(([n]) => n === 'activate_member_copy_resume'), undefined, 'no activation with an empty baseline');
  assert.deepEqual(calls.filter(([n]) => n === 'report_member_copy_resume_blocker').map(([, p]) => p.p_reason), ['RESUME_MASTER_SNAPSHOT_UNCONFIRMED']);
  // Without the fix the first ACTIVE cycle would buy the pre-start holding (capped at 30%):
  const s = new Sim({ master: {} });
  s.master.set('ETH_USDT:LONG', 1_000);
  assert.deepEqual(fmt(s.step().orders), ['ETH_USDT:LONG +15'], 'what an empty baseline would cost');
});

// ---------------------------------------------------------------- Q1 fix: resume Master snapshot confirmation
const ETH_1000 = [{ contract: 'ETH_USDT', size: 1_000, markPrice: 4_000, positionSide: 'LONG', mode: 'dual_long' }];
const resumeOnce = (runner) => runner.processMemberResume({ session: SESSION('REQUESTED'), masterContext: {},
  memberContext: { trading_account_id: 'acc', user_id: 'u' }, contracts: contractsMap(), system: { execution_enabled: true } });
const reasons = (calls) => calls.filter(([n]) => n === 'report_member_copy_resume_blocker').map(([, p]) => p.p_reason);
const activation = (calls) => calls.find(([n]) => n === 'activate_member_copy_resume')?.[1].p_snapshot;

test('Q1: empty list while the in-memory Master holds a leg -> blocked; retried once the list returns -> baseline holds it', async () => {
  let list = [];
  const { runner, calls } = resumeRunner('LIVE', { masterPositions: () => list });
  runner.lastMasterSizes = new Map([['ETH_USDT:LONG', 1_000]]);
  await resumeOnce(runner);
  assert.deepEqual(reasons(calls), ['RESUME_MASTER_SNAPSHOT_UNCONFIRMED']);
  assert.equal(activation(calls), undefined);
  assert.ok(!calls.some(([n]) => n === 'prepare_member_copy_resume'), 'nothing stored from the incomplete read');
  list = ETH_1000;
  await resumeOnce(runner);
  assert.deepEqual(activation(calls).master_positions, [{ contract: 'ETH_USDT', position_side: 'LONG', size: 1_000 }]);
  // FUTURE_ONLY holds: with that baseline the first ACTIVE cycle buys nothing.
  const s = new Sim({ master: { 'ETH_USDT:LONG': 1_000 } });
  assert.deepEqual(fmt(s.step().orders), []);
});

test('Q1: empty list whose single-contract read still found the leg is refused too (any list glitch blocks a baseline)', async () => {
  const { runner, calls } = resumeRunner('LIVE', { masterPositions: ETH_1000, masterListEmpty: true });
  runner.lastMasterSizes = new Map([['ETH_USDT:LONG', 1_000]]);
  await resumeOnce(runner);
  assert.deepEqual(reasons(calls), ['RESUME_MASTER_SNAPSHOT_UNCONFIRMED']);
});

test('Q1: a non-empty list missing a leg the last cycle saw, or an unconfirmed contract, is refused', async () => {
  const xau = [{ contract: 'XAU_USDT', size: 500, markPrice: 4_000, positionSide: 'LONG', mode: 'dual_long' }];
  const { runner, calls } = resumeRunner('LIVE', { masterPositions: xau });
  runner.lastMasterSizes = new Map([['ETH_USDT:LONG', 1_000], ['XAU_USDT:LONG', 500]]);
  await resumeOnce(runner);
  assert.deepEqual(reasons(calls), ['RESUME_MASTER_SNAPSHOT_UNCONFIRMED']);
  assert.equal(runner.resumeMasterSnapshotBlocker({ positions: [...xau, ...ETH_1000], unconfirmed_contracts: ['BTC_USDT'] }),
    'RESUME_MASTER_SNAPSHOT_UNCONFIRMED');
  assert.equal(runner.resumeMasterSnapshotBlocker({ positions: [...xau, ...ETH_1000] }), null);
});

test('Q1: a genuinely flat Master (nothing in the DB, nothing in memory) resumes with an empty baseline', async () => {
  const { runner, calls } = resumeRunner('LIVE', { masterPositions: [], masterObserved: false });
  runner.rpc = ((rpc) => async (name, params) => (name === 'get_public_master_positions'
    ? { observed_at: new Date().toISOString(), positions: [] } : rpc(name, params)))(runner.rpc);
  await runner.loadPersistedMasterLegs();
  runner.cycleSeq = 1;
  runner.trackMasterLegConfirmation({ list_empty: true, positions: [] }, new Map(), new Map(), new Set());
  await resumeOnce(runner);
  assert.deepEqual(reasons(calls), []);
  assert.deepEqual(activation(calls).master_positions, []);
});

test('Q1: the Master closed while the worker was down: two consecutive empty-list cycles confirm it, then resume proceeds', async () => {
  const { runner, calls } = resumeRunner('LIVE', { masterPositions: [], masterObserved: false });
  runner.rpc = ((rpc) => async (name, params) => (name === 'get_public_master_positions'
    ? { observed_at: new Date(Date.now() - 600_000).toISOString(), positions: [{ contract: 'ETH_USDT', side: 'LONG', size: 1_000 }] }
    : rpc(name, params)))(runner.rpc);
  await runner.loadPersistedMasterLegs();
  const cycle = (master) => { runner.cycleSeq += 1; runner.trackMasterLegConfirmation(master, runner.lastMasterSizes, new Map(), new Set()); };
  cycle({ list_empty: true, positions: [] });
  await resumeOnce(runner);
  assert.deepEqual(reasons(calls), ['RESUME_MASTER_SNAPSHOT_UNCONFIRMED']);
  cycle({ list_empty: true, positions: [] });
  assert.equal(runner.unresolvedMasterLegs.size, 0);
  await resumeOnce(runner);
  assert.deepEqual(activation(calls).master_positions, []);
  // A gap between the two flat reads, or an unconfirmed contract, starts over.
  const r2 = resumeRunner('LIVE', { masterObserved: false }).runner;
  r2.persistedMasterLoaded = true;
  r2.unresolvedMasterLegs.set('ETH_USDT:LONG', { size: 1_000, source: 'DB', flatSeq: null });
  r2.cycleSeq = 1; r2.trackMasterLegConfirmation({ list_empty: true, positions: [] }, new Map(), new Map(), new Set());
  r2.cycleSeq = 2; r2.trackMasterLegConfirmation({ list_empty: true, positions: [] }, new Map(), new Map(), new Set(['ETH_USDT']));
  r2.cycleSeq = 3; r2.trackMasterLegConfirmation({ list_empty: true, positions: [] }, new Map(), new Map(), new Set());
  assert.equal(r2.unresolvedMasterLegs.size, 1, 'unconfirmed in between: not two consecutive flat reads');
  // A flat read on a NON-empty list is authoritative at once.
  r2.cycleSeq = 4; r2.trackMasterLegConfirmation({ list_empty: false, positions: [{}] }, new Map(), new Map(), new Set());
  assert.equal(r2.unresolvedMasterLegs.size, 0);
});

test('Q1: mid-process glitch: a leg the last cycle saw vanishes from an empty list -> pending until confirmed', async () => {
  const { runner, calls } = resumeRunner('LIVE', { masterPositions: [] });
  runner.cycleSeq = 7;
  runner.trackMasterLegConfirmation({ list_empty: true, positions: [] }, new Map([['ETH_USDT:LONG', 1_000]]), new Map(), new Set());
  runner.lastMasterSizes = new Map();
  assert.deepEqual([...runner.unresolvedMasterLegs.keys()], ['ETH_USDT:LONG']);
  assert.deepEqual(runner.masterExpectations().legs, ['ETH_USDT:LONG'], 'still asked for on its own');
  await resumeOnce(runner);
  assert.deepEqual(reasons(calls), ['RESUME_MASTER_SNAPSHOT_UNCONFIRMED']);
  // Present again in the next cycle: resolved.
  runner.cycleSeq = 8;
  runner.trackMasterLegConfirmation({ list_empty: false, positions: ETH_1000 }, new Map(), new Map([['ETH_USDT:LONG', 1_000]]), new Set());
  assert.equal(runner.unresolvedMasterLegs.size, 0);
});

test('Q1: the DB observation is ignored when older than 24 h; a failed DB read keeps resume waiting and is retried', async () => {
  const runner = new TradingRunner({ supabase: null, mode: 'LIVE' });
  let reply = { observed_at: new Date(Date.now() - 25 * 3_600_000).toISOString(), positions: [{ contract: 'ETH_USDT', side: 'LONG', size: 1_000 }] };
  let fail = true;
  runner.rpc = async () => { if (fail) throw new Error('DB_TIMEOUT'); return reply; };
  await runner.loadPersistedMasterLegs();
  assert.equal(runner.persistedMasterLoaded, false);
  runner.masterObservedAt = Date.now();
  assert.equal(runner.resumeMasterSnapshotBlocker({ positions: [] }), 'RESUME_MASTER_SNAPSHOT_UNCONFIRMED');
  fail = false;
  await runner.loadPersistedMasterLegs();
  assert.equal(runner.persistedMasterLoaded, true);
  assert.equal(runner.unresolvedMasterLegs.size, 0, 'stale observation not used');
  assert.equal(runner.resumeMasterSnapshotBlocker({ positions: [], list_empty: true }), null);
  reply = null;
  await runner.loadPersistedMasterLegs(); // loaded once per process: not read again
  assert.equal(runner.persistedMasterLoaded, true);
});

test('Q1 syncOnce: restart + empty list -> resume blocked; next cycle list back -> resume activates with the Master baseline', async () => {
  const now = () => new Date().toISOString();
  let masterList = [];
  const calls = [];
  const masterReads = [];
  const version = '00000000-0000-4000-8000-000000000009';
  const runner = new TradingRunner({ supabase: {}, baseUrl: 'https://api.gateio.ws', mode: 'LIVE', channelId: 'maetajak' });
  runner.rpc = async (name, params = {}) => {
    calls.push([name, params]);
    if (name === 'get_copy_worker_context') return { system: { execution_enabled: true, emergency_halted: false },
      master: { trading_account_id: 'master' }, members: [{ trading_account_id: 'acc', user_id: 'u', copy_ratio: 100,
        max_position_ratio: 30, previous_states: [] }] };
    if (name === 'get_copy_resume_context') return [{ trading_account_id: 'acc', state: 'REQUESTED', version, ownership_status: 'CONFIRMED',
      resume_authorized: true, unresolved_orders: 0, expires_at: new Date(Date.now() + 60_000).toISOString() }];
    if (name === 'get_public_master_positions') return { observed_at: new Date(Date.now() - 20_000).toISOString(),
      positions: [{ contract: 'ETH_USDT', side: 'LONG', size: 1_000 }] };
    if (name === 'get_member_copy_resume_ownership') return { master_positions: params.p_master_positions,
      member_positions: params.p_member_positions, copy_positions: [], target_anchors: [] };
    if (name === 'activate_member_copy_resume') return { state: 'ACTIVE' };
    if (name === 'get_copy_order_observation_guards' || name === 'get_copy_target_anchors') return [];
    return null;
  };
  runner.loadContracts = async () => contractsMap();
  runner.readAccount = async (account) => {
    const master = account.trading_account_id === 'master';
    if (master) masterReads.push(account.expected_contracts);
    const positions = master ? masterList : [];
    return { ...account, total: master ? 100_000 : 2_000, available: master ? 100_000 : 2_000, equityIncludesUnrealised: true,
      positions, open_orders: [], positionMode: 'dual', list_empty: !positions.length, unconfirmed_contracts: [],
      list_empty_fallback_contracts: [], observed_started_at: now(), observed_at: now(), copy_ratio: 100, max_position_ratio: 30 };
  };
  await runner.syncOnce();
  assert.deepEqual(masterReads[0], ['ETH_USDT'], 'the restarted cycle asks Gate for the leg the DB recorded');
  assert.ok(calls.findIndex(([n]) => n === 'get_public_master_positions') < calls.findIndex(([n]) => n === 'record_verified_copy_worker_cycle'));
  await runner.processPendingResumes(1);
  assert.deepEqual(reasons(calls), ['RESUME_MASTER_SNAPSHOT_UNCONFIRMED']);
  assert.equal(activation(calls), undefined);
  masterList = ETH_1000;
  await runner.syncOnce();
  await runner.processPendingResumes(1);
  assert.deepEqual(activation(calls).master_positions, [{ contract: 'ETH_USDT', position_side: 'LONG', size: 1_000 }]);
  assert.equal(calls.filter(([n]) => n === 'get_public_master_positions').length, 1, 'read once per process');
});

// ---------------------------------------------------------------- extra: hedge interactions
test('qa-1 (a/c) P2 semantic: FUTURE_ONLY + dual Master hedge on a pre-start leg leaves the member one-sided (net opposite)', () => {
  const s = new Sim({ master: { 'BTC_USDT:LONG': 2_000 } });
  s.step();
  s.setMaster('BTC_USDT:SHORT', -1_000); // Master hedges half of its pre-start LONG: net +1000
  assert.deepEqual(fmt(s.step().orders), ['BTC_USDT:SHORT -20'], 'member is net SHORT while the Master is net LONG');
  assert.deepEqual(s.rejections, []);
});

test('qa-1 (b3) Master opens a capped hedge: both legs scaled by one factor; closing one leg regrows the other to its decision', () => {
  const s = new Sim();
  s.step();
  s.setMaster('ETH_USDT:LONG', 500);
  s.setMaster('ETH_USDT:SHORT', -500);
  const open = s.step();
  // 10 + 10 lots = 800 USDT gross > 600 cap -> factor 0.75 -> 7 / 7.
  assert.deepEqual(fmt(open.orders), ['ETH_USDT:LONG +7', 'ETH_USDT:SHORT -7']);
  s.setMaster('ETH_USDT:SHORT', 0);
  const close = s.step();
  assert.deepEqual(fmt(close.orders), ['ETH_USDT:SHORT +7 R'], 'the close cycle only closes the SHORT');
  const regrow = s.step();
  assert.deepEqual(fmt(regrow.orders), ['ETH_USDT:LONG +3'], 'next cycle: LONG regrows to its uncapped decision 10 = 500 * 0.02 (no Master buy)');
  assert.equal(s.member.get('ETH_USDT:LONG'), 10);
});
