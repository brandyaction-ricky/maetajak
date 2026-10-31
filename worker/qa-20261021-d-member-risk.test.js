import test from 'node:test';
import assert from 'node:assert/strict';
import { TradingRunner, evaluateMemberRisk, planMemberPositions } from './trading-runner.js';
import { aggregateMemberPerformance } from './performance.js';
import { observedAccount, position, contracts } from '../tests/fixtures/verified-runtime.js';
import { anchorFromPlan } from '../tests/fixtures/anchor-mirror.js';

// QA 2026-10-21 area D (member behaviour, risk limits, admin controls). Each REPRO test asserts the behaviour
// of 0c39e77; a passing "REPRO" test means the reported finding is reproduced (not that it is correct).
// D-FIXED tests assert the corrected behaviour (D1/D2 fix/qa-sizing, D4/D5/D7 fix/qa-risk, D11 fix/qa-admin).

const version = '30000000-0000-4000-8000-000000000004';
const baseMember = (fields = {}) => observedAccount({ trading_account_id: 'member', user_id: 'user', resume_version: version,
  copy_ratio: 100, max_position_ratio: 30, target_anchors: [], ...fields });
const baseMaster = (positions) => observedAccount({ trading_account_id: 'master', total: 20000, available: 18000, positions });
const plan = (member, master) => planMemberPositions({ cycleId: 'c-' + Math.random(), system: { emergency_halted: false },
  master, member, contracts });

// FIXED 2026-10-21 (fix/qa-risk): risk is evaluated on the sizing equity basis (wallet + unrealised PnL).
test('D-FIXED classic futures account: an unrealised loss counts for the risk limits', async () => {
  const runner = new TradingRunner({ supabase: {}, baseUrl: 'https://api.gateio.ws', workerId: 'qa', workerVersion: 'qa',
    mode: 'LIVE', fetchImpl: async (url) => {
      // Classic USDT futures account: `total` is the wallet balance, unrealised PnL is reported separately.
      if (url.includes('/futures/usdt/accounts')) return new Response(JSON.stringify({ user: 1, total: '1000', available: '600',
        unrealised_pnl: '-400', margin_mode: 0, position_mode: 'dual', in_dual_mode: true }));
      return new Response('[]');
    } });
  const account = await runner.readAccount({ trading_account_id: 'member', api_key: 'k', secret_key: 's',
    day_start_equity: 1000, peak_equity: 1000, daily_loss_limit_pct: 15, max_drawdown_pct: 20, fund_flow_net: 0 }, { member: true });
  // Mark-to-market equity is 600 (-40% today, -40% from peak), far beyond 15% / 20%.
  assert.equal(account.total, 1000);
  assert.equal(account.equityIncludesUnrealised, false);
  assert.equal(account.risk_equity, 600);
  assert.equal(account.risk_halt_reason, 'DAILY_LOSS_LIMIT');
  assert.equal(account.reduce_only, true, 'new entries (e.g. Master averaging down) are blocked');
});

test('D1: a Master entry made while reduce-only is consumed, not bought at the current price once reduce-only lifts', () => {
  const master = baseMaster([position(40)]);
  // Cycle 1: member is reduce-only (risk limit or admin). Master opened BTC LONG 40.
  const [blocked] = plan(baseMember({ reduce_only: true }), master);
  assert.equal(blocked.state, 'REDUCE_ONLY');
  assert.equal(blocked.intent, undefined);
  assert.equal(blocked.target_size, 10, 'the plan still shows the proportional size');
  assert.equal(blocked.anchor_update_allowed, true);
  assert.equal(blocked.anchor_target_size, 0, 'the anchor records what is held: the increase is consumed');
  // The DB stores that anchor (record_copy_worker_cycle_with_target_anchors, 20261021030000).
  const anchor = anchorFromPlan(blocked, version);
  assert.deepEqual([anchor.master_copyable_size, anchor.target_size, anchor.reference_master_size], [40, 0, 0]);
  // Hours later reduce-only is lifted (member "재개" on an ACTIVE session, or admin RESUME). Master unchanged.
  const [lifted] = plan(baseMember({ reduce_only: false, target_anchors: [anchor] }), master);
  assert.equal(lifted.target_lock_reason, 'MASTER_QUANTITY_UNCHANGED');
  assert.equal(lifted.intent, undefined, 'no catch-up BUY');
  // Only a later Master change is followed: +40 -> +10.
  const [later] = plan(baseMember({ target_anchors: [anchorFromPlan(lifted, version)] }), baseMaster([position(80)]));
  assert.equal(later.intent?.delta_size, 10);
});

test('D2: reduce-only, Master adds then trims back -> the member keeps the size it held for that Master quantity', () => {
  const anchor0 = { contract: 'BTC_USDT', position_side: 'LONG', resume_version: version, master_copyable_size: 40,
    target_size: 10, protected_member_size: 0, lock_reason: 'MASTER_QUANTITY_UNCHANGED' };
  // Member holds 10 (proportional to Master 40). Member becomes reduce-only. Master adds to 80.
  const [up] = plan(baseMember({ reduce_only: true, positions: [position(10)], target_anchors: [anchor0] }), baseMaster([position(80)]));
  assert.equal(up.state, 'REDUCE_ONLY');
  assert.equal(up.intent, undefined);
  assert.equal(up.target_size, 20);
  const anchor1 = anchorFromPlan(up, version);
  assert.deepEqual([anchor1.master_copyable_size, anchor1.target_size, anchor1.reference_master_size], [80, 10, 40]);
  // Master trims back to 40 (the size the member was already proportional to): nothing is sold.
  const [down] = plan(baseMember({ reduce_only: true, positions: [position(10)], target_anchors: [anchor1] }), baseMaster([position(40)]));
  assert.equal(down.target_lock_reason, 'MASTER_REDUCED_UNCOPIED_QUANTITY');
  assert.equal(down.intent, undefined, 'the member keeps 10 although reduce-only');
  assert.equal(down.target_size, 10);
  // A reduction below 40 is still executed while reduce-only, proportionally to the 10 held.
  const [deeper] = plan(baseMember({ reduce_only: true, positions: [position(10)], target_anchors: [anchorFromPlan(down, version)] }),
    baseMaster([position(20)]));
  assert.equal(deeper.state, 'REDUCE_ONLY');
  assert.equal(deeper.intent?.delta_size, -5);
  assert.equal(deeper.intent?.reduce_only, true);
  // Full close still reaches 0.
  const [closed] = plan(baseMember({ reduce_only: true, positions: [position(5)], target_anchors: [anchorFromPlan(deeper, version)] }),
    baseMaster([]));
  assert.equal(closed.intent?.delta_size, -5);
});

test('D-REPRO CLOSE closes a personal position on a contract the Master never traded', () => {
  // CLOSING: the worker passes an empty protected baseline (trading-runner.js syncOnce, session.state CLOSING).
  const [soxl] = plan(baseMember({ close_positions_requested: true, reduce_only: true, member_position_baselines: [],
    positions: [{ ...position(5, 'SOXL_USDT'), markPrice: 30 }] }), baseMaster([position(40)])).filter((p) => p.contract === 'SOXL_USDT');
  assert.equal(soxl.intent?.delta_size, -5);
  assert.equal(soxl.intent?.reduce_only, true);
});

// FIXED 2026-10-21 (fix/qa-risk): the shared contract leverage is left alone while the opposite leg is open.
test('D-FIXED dual mode: copy entry on SHORT keeps the contract leverage while the member holds a personal LONG', async () => {
  const own = { ...position(5), leverage: 3, posMarginMode: 'isolated' };
  const legs = plan(baseMember({ positions: [own], member_position_baselines: [{ contract: 'BTC_USDT', position_side: 'LONG', size: 5 }] }),
    baseMaster([position(-40)]));
  const short = legs.find((p) => p.position_side === 'SHORT');
  const long = legs.find((p) => p.position_side === 'LONG');
  assert.equal(long.target_size, 5, 'personal LONG kept');
  assert.equal(short.intent?.delta_size, -10);
  assert.equal(short.intent?.target_leverage, null, 'no leverage change while the opposite leg is open');
  assert.equal(short.risk_leverage, 3, 'margin is reserved at the current (shared) leverage');
  assert.equal(short.leverage_reason, 'OPPOSITE_LEG_OPEN_LEVERAGE_KEPT');

  const requests = [];
  const runner = new TradingRunner({ supabase: {}, baseUrl: 'https://api.gateio.ws', workerId: 'qa', workerVersion: 'qa',
    publicIp: '192.0.2.1', channelId: 'maetajak', mode: 'LIVE', fetchImpl: async (url, options) => {
      requests.push(url);
      if (url.includes('/leverage')) return new Response(JSON.stringify([{}]));
      return new Response(JSON.stringify({ id: '1', size: -10, left: 0, status: 'finished', finish_as: 'filled', contract: 'BTC_USDT',
        text: 't-mtj-12345678901234567890' }), { status: 201 });
    } });
  const job = { intent_id: 'i1', user_id: 'user', api_key: 'k', secret_key: 's', contract: 'BTC_USDT', position_side: 'SHORT',
    position_mode: 'dual', delta_size: -10, reduce_only: false, target_leverage: 10, margin_mode: 'cross',
    gate_order_text: 't-mtj-12345678901234567890', slippage_ratio: 0.005, resume_version: version,
    source_observed_at: new Date().toISOString(), trading_account_id: 'member', actual_size_at_plan: 0, target_size: -10,
    master_size_at_plan: -40, quanto_multiplier: 0.001, risk_leverage: 10 };
  runner.rpc = async (name) => {
    if (name === 'claim_copy_order_intents') return [job];
    if (name === 'get_copy_worker_context') return { master: { trading_account_id: 'master' }, members: [{ trading_account_id: 'member' }] };
    if (name === 'get_copy_fund_flow_totals') return [];
    if (name === 'get_copy_reversal_entry_context') return { guard_version: 1, allowed: true, ownership_verified: true, intent_id: 'i1',
      trading_account_id: 'member', resume_version: version, opposite_side: 'LONG', copy_opposite_size: 0, protected_opposite_size: 5 };
    if (name === 'authorize_copy_order_submission') return true;
    if (name === 'complete_copy_order_attempt') return null;
    throw new Error(`unexpected rpc ${name}`);
  };
  runner.readAccount = async (account) => observedAccount({ ...account,
    positions: account.trading_account_id === 'master' ? [position(-40)] : [own] });
  assert.equal(await runner.submitOrders(), 1);
  // A job planned before the personal LONG existed still carries target_leverage 10: the fresh snapshot shows the
  // open LONG, so no leverage request is sent (Gate classic hedge mode: one contract-level leverage for both legs).
  assert.equal(requests.some((url) => url.includes('/leverage')), false);
  assert.match(requests[0], /\/futures\/usdt\/orders$/);
});

test('D11 FIXED performance: opening and closing equity are both raw, so an earlier deposit is no gain', () => {
  // Member started tracking with 1000 and deposited 1000 earlier (net flows +1000). No trades today.
  // day_start_equity from get_copy_worker_context = total - net = 1000; Gate total = 2000.
  const { daily } = aggregateMemberPerformance({ member: { day_start_equity: 1000, total: 2000, unrealisedPnl: 0,
    fund_flow_net: 1000 }, ledger: [], trades: [], observedAt: new Date().toISOString() });
  assert.equal(daily.openingEquity, 2000, 'transfers before today are added back to the risk day-start');
  assert.equal(daily.closingEquity, 2000);
  assert.equal(daily.dailyReturnPct, 0);
});

// FIXED 2026-10-21 (fix/qa-risk): a violation pending confirmation is re-checked without the 60 s throttle, and a new
// halt is persisted only when confirmed on consecutive cycles (worker/qa-20261021-risk-fixes.test.js).
test('D-FIXED two withdrawals within 60 s: the confirming re-check records the second one and clears the halt', async () => {
  let ledger = [];
  const recorded = new Map();
  const runner = new TradingRunner({ supabase: {}, baseUrl: 'https://api.gateio.ws', workerId: 'qa', workerVersion: 'qa', mode: 'LIVE',
    fetchImpl: async () => new Response(JSON.stringify(ledger)) });
  runner.rpc = async (name, p) => {
    assert.equal(name, 'record_copy_fund_flows');
    for (const e of p.p_entries) recorded.set(e.key, Number(e.change));
    return [...recorded.values()].reduce((a, b) => a + b, 0);
  };
  const base = { trading_account_id: 'm', api_key: 'k', secret_key: 's', day_start_equity: 1000, peak_equity: 1000,
    daily_loss_limit_pct: 15, max_drawdown_pct: 20, profile_reduce_only: false };
  const now = Math.floor(Date.now() / 1000);
  // Withdrawal 1 (futures -> spot, 200): the forced re-check records it and clears the false limit.
  ledger = [{ id: 'w1', type: 'dnw', change: '-200', time: now - 5 }];
  let member = { ...base, total: 800, fund_flow_net: 0 };
  member = { ...member, ...evaluateMemberRisk({ account: member, total: 800 }) };
  assert.equal(member.risk_halt_reason, 'DAILY_LOSS_LIMIT');
  member = await runner.recheckRiskWithFundFlows(member, { force: true });
  assert.equal(member.risk_halt_reason, null);
  // Withdrawal 2 (another 200) a few seconds later: re-check is throttled for 60 s.
  ledger = [...ledger, { id: 'w2', type: 'dnw', change: '-200', time: now }];
  let next = { ...base, total: 600, fund_flow_net: -200 };
  next = { ...next, ...evaluateMemberRisk({ account: next, total: 600 }), reduce_only: true };
  assert.equal(next.risk_halt_reason, 'DAILY_LOSS_LIMIT');
  const throttled = await runner.recheckRiskWithFundFlows(next, { force: true });
  assert.equal(throttled.risk_halt_reason, 'DAILY_LOSS_LIMIT', 'an ordinary re-check is still throttled');
  const after = await runner.recheckRiskWithFundFlows(next, { confirming: true });
  assert.equal(after.risk_halt_reason, null, 'the confirming re-check is not throttled');
  assert.equal(after.fund_flow_net, -400);
  assert.equal(after.reduce_only, false);
});

test('D-REPRO withdrawal shrinks the position cap: existing copy is SOLD with the Master unchanged', () => {
  const anchor = { contract: 'BTC_USDT', position_side: 'LONG', resume_version: version, master_copyable_size: 120,
    target_size: 30, protected_member_size: 0, lock_reason: 'MASTER_QUANTITY_UNCHANGED' };
  const master = baseMaster([position(120)]);
  const [before] = plan(baseMember({ total: 5000, available: 3000, positions: [position(30)], target_anchors: [anchor] }), master);
  assert.equal(before.intent, undefined);
  // Member moves 2000 USDT out of futures (cap 30% of 3000 = 900 USDT = 18 lots).
  const [after] = plan(baseMember({ total: 3000, available: 1000, positions: [position(30)], target_anchors: [anchor] }), master);
  assert.equal(after.target_lock_reason, 'CURRENT_RISK_CAP_REDUCTION');
  assert.equal(after.intent?.delta_size, -12);
});

test('D1: single mode, a leg held for the member\'s opposite personal position is not caught up once that position is closed', () => {
  const master = baseMaster([position(40)]);
  const own = { ...position(-5), mode: 'single' };
  const [held] = plan(baseMember({ positionMode: 'single', positions: [own],
    member_position_baselines: [{ contract: 'BTC_USDT', position_side: 'SHORT', size: -5 }] }), master)
    .filter((p) => p.position_side === 'LONG');
  assert.equal(held.pause_reason, 'PROTECTED_EXISTING_POSITION_OPPOSITE_SIDE');
  assert.equal(held.intent, undefined);
  assert.equal(held.anchor_update_allowed, true);
  assert.equal(held.anchor_target_size, 0, 'the held Master entry is consumed');
  const anchor = anchorFromPlan(held, version);
  // Later the member closes the personal SHORT (ownership ledger absorbs it). Master never changed.
  const [caught] = plan(baseMember({ positionMode: 'single', positions: [], member_position_baselines: [], target_anchors: [anchor] }), master)
    .filter((p) => p.position_side === 'LONG');
  assert.equal(caught.intent, undefined, 'no full Master position bought at the current price');
  // A later Master increase is followed.
  const [next] = plan(baseMember({ positionMode: 'single', positions: [], member_position_baselines: [],
    target_anchors: [anchorFromPlan(caught, version)] }), baseMaster([position(80)])).filter((p) => p.position_side === 'LONG');
  assert.equal(next.intent?.delta_size, 10);
});
