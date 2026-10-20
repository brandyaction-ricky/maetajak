import test from 'node:test';
import assert from 'node:assert/strict';
import { planMemberPositions, evaluateMemberRisk, fundFlowEntries, withFundFlowNet, CAP_TOLERANCE_RATIO,
  TradingRunner, SNAPSHOT_SKEW_SKIP_LIMIT } from './trading-runner.js';

// 2026-10-19: capped legs no longer churn on every price tick, regrow after a cap relaxes, and member
// risk limits ignore deposits/withdrawals.
const contracts = new Map([['XAU_USDT', { quantoMultiplier: 0.001, sizeStep: 1, orderSizeMin: 1, orderSizeMax: 0,
  marketOrderSizeMax: 0, inDelisting: false, takerFeeRate: 0.0005 }]]);
const pos = (size, markPrice) => ({ contract: 'XAU_USDT', size, markPrice, leverage: 10, posMarginMode: 'cross',
  positionSide: size < 0 ? 'SHORT' : 'LONG' });
const anchor = (master, target, desired) => [{ contract: 'XAU_USDT', position_side: 'LONG', resume_version: 'r1',
  master_copyable_size: master, target_size: target, ...(desired == null ? {} : { desired_target_size: desired }) }];
// Member 10,000 equity, cap 40% = 4,000 notional. At price 4,000: cap = 1,000 contracts (0.001 each).
function plan({ masterSize = 14_000, actual, anchors, price = 4_000, memberTotal = 10_000, available = 10_000 }) {
  return planMemberPositions({
    cycleId: 'c', system: { emergency_halted: false }, contracts,
    master: { total: 10_000, positions: masterSize ? [pos(masterSize, price)] : [] },
    member: { user_id: 'u', total: memberTotal, available, copy_ratio: 100, max_position_ratio: 40, resume_version: 'r1',
      positions: actual ? [pos(actual, price)] : [],
      previous_states: [{ contract: 'XAU_USDT', position_side: 'LONG', actual_size: actual || 0, state: 'SYNCED' }],
      target_anchors: anchors },
  })[0];
}

test('a capped leg is not trimmed by one lot when the price ticks up (within the 3% band)', () => {
  // Price 4,000 -> 4,010 lowers the cap from 1,000 to 997 contracts. Before: sell 3.
  const p = plan({ actual: 1_000, anchors: anchor(14_000, 1_000, 14_000), price: 4_010 });
  assert.equal(p.target_size, 1_000);
  assert.equal(p.intent, undefined);
  assert.equal(p.target_lock_reason, 'CAP_TOLERANCE_HOLD');
  assert.equal(p.anchor_desired_target_size, 14_000, 'the uncapped decision is carried');
});

test('beyond the band the leg is trimmed to the cap in one order', () => {
  // +4% price: cap 961; excess 39 lots * 4.16 = 162 > band 0.03*4,000 = 120.
  const p = plan({ actual: 1_000, anchors: anchor(14_000, 1_000, 14_000), price: 4_160 });
  assert.equal(p.target_size, 961);
  assert.equal(p.intent.delta_size, -39);
  assert.equal(p.intent.reduce_only, true);
  assert.equal(p.target_lock_reason, 'CURRENT_RISK_CAP_REDUCTION');
});

test('after the price falls back the leg regrows towards the desired size, but only beyond the band', () => {
  // Stored target 961 (trimmed earlier), desired 14,000. Price 4,100: cap 975 -> room 14 lots * 4.1 = 57 < 120: hold.
  let p = plan({ actual: 961, anchors: anchor(14_000, 961, 14_000), price: 4_100 });
  assert.equal(p.target_size, 961);
  assert.equal(p.intent, undefined);
  // Price 3,900: cap 1,025 -> room 64 lots * 3.9 = 250 > 120: regrow to the cap.
  p = plan({ actual: 961, anchors: anchor(14_000, 961, 14_000), price: 3_900 });
  assert.equal(p.target_size, 1_025);
  assert.equal(p.intent.delta_size, 64);
  assert.equal(p.intent.reduce_only, false);
});

test('without a desired size (worker 0.5.0 anchors) a capped leg never regrows (previous behaviour)', () => {
  const p = plan({ actual: 961, anchors: anchor(14_000, 961), price: 3_900 });
  assert.equal(p.target_size, 961);
  assert.equal(p.intent, undefined);
});

test('a Master reduction is followed immediately and never turns into a buy, even with room under the cap', () => {
  const p = plan({ masterSize: 7_000, actual: 961, anchors: anchor(14_000, 961, 14_000), price: 3_900 });
  assert.ok(p.target_size <= 961);
  assert.ok(p.intent && p.intent.delta_size < 0 && p.intent.reduce_only === true);
});

test('a Master increase is not delayed by the band', () => {
  const p = plan({ masterSize: 14_100, actual: 500, anchors: anchor(14_000, 500, 500), price: 4_000 });
  assert.ok(p.intent && p.intent.delta_size > 0);
});

test('band constant', () => { assert.equal(CAP_TOLERANCE_RATIO, 0.03); });

test('member risk compares transfer-adjusted equity; net 0 equals the previous formula', () => {
  const base = { peak_equity: 6_851, day_start_equity: 6_479, max_drawdown_pct: 20, daily_loss_limit_pct: 15 };
  assert.notEqual(evaluateMemberRisk({ account: base, total: 2_193 }).risk_halt_reason, null, 'raw: the withdrawal trips a limit');
  const adjusted = evaluateMemberRisk({ account: { ...base, fund_flow_net: -4_286 }, total: 2_193 });
  assert.equal(adjusted.risk_halt_reason, null);
  assert.ok(Math.abs(adjusted.drawdown_pct - 5.43) < 0.05);
  const deposit = evaluateMemberRisk({ account: { ...base, peak_equity: 1_000, day_start_equity: 1_000, fund_flow_net: 5_000 }, total: 5_100 });
  assert.equal(deposit.risk_halt_reason, 'DAILY_LOSS_LIMIT', 'a real loss behind a deposit still trips');
  assert.equal(deposit.risk_equity, 100);
  assert.equal(deposit.drawdown_pct, 90, 'a deposit does not hide a real loss');
});

test('fund flow entries keep only non-zero dnw rows with a stable key', () => {
  const rows = fundFlowEntries([
    { id: '11', type: 'dnw', change: '-500', time: 1, balance: '1' },
    { type: 'DNW', change: '200', time: 2, balance: '3' },
    { id: '12', type: 'pnl', change: '50', time: 3 },
    { id: '13', type: 'dnw', change: '0', time: 4 },
  ]);
  assert.deepEqual(rows, [{ key: '11', change: '-500', time: 1 }, { key: '2:200:3', change: '200', time: 2 }]);
  const ctx = withFundFlowNet({ members: [{ trading_account_id: 'a' }, { trading_account_id: 'b' }] }, [{ trading_account_id: 'a', net: -10 }]);
  assert.deepEqual(ctx.members.map((m) => m.fund_flow_net), [-10, 0]);
});

test('a skewed member snapshot is skipped silently for a few cycles, then held', async () => {
  assert.equal(SNAPSHOT_SKEW_SKIP_LIMIT, 3);
  const runner = new TradingRunner({ supabase: {}, mode: 'LIVE', channelId: 'maetajak', baseUrl: 'https://api.gateio.ws' });
  const recorded = [];
  runner.rpc = async (name, params) => {
    if (name === 'get_copy_worker_context') return { system: { execution_enabled: true }, master: { trading_account_id: 'm' },
      members: [{ trading_account_id: 'a', user_id: 'u', copy_ratio: 100, max_position_ratio: 40 }] };
    if (name === 'get_copy_resume_context') return [{ trading_account_id: 'a', state: 'ACTIVE', version: 'r1', baseline_version: 'r1', positions: [], member_positions: [] }];
    if (name === 'record_verified_copy_worker_cycle') { recorded.push(params.p_payload); return null; }
    if (name === 'get_copy_fund_flow_totals') return [];
    return [];
  };
  runner.loadContracts = async () => contracts;
  runner.readAccount = async (account) => {
    const end = account.trading_account_id === 'm' ? Date.now() : Date.now() - 5_000;
    return { ...account, total: 10_000, available: 10_000, positions: [], open_orders: [], positionMode: 'dual',
      observed_started_at: new Date(end - 500).toISOString(), observed_at: new Date(end).toISOString() };
  };
  for (let i = 0; i < SNAPSHOT_SKEW_SKIP_LIMIT; i += 1) await runner.syncOnce();
  assert.equal(recorded.length, SNAPSHOT_SKEW_SKIP_LIMIT);
  assert.ok(recorded.every((payload) => payload.members.length === 0), 'skipped members write nothing');
  await runner.syncOnce();
  assert.equal(recorded.at(-1).members.length, 1, 'a persistent skew is held as before');
});

test('a Master increase sizes only the increment on the stored target (no regrow inside an increase)', () => {
  const p = plan({ masterSize: 14_050, actual: 961, anchors: anchor(14_000, 961, 14_000), price: 3_900 });
  assert.equal(p.target_size, 1_011);
  assert.equal(p.intent.delta_size, 50);
  assert.equal(p.anchor_desired_target_size, 14_050, 'desired carries the increment');
});
