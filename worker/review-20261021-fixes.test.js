import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TradingRunner, planMemberPositions, buildCurrentStatePayload, withRiskContext, evaluateAccountRisk,
  RISK_EQUITY_BASIS, CREDENTIAL_ALERT_REPEAT_MS } from './trading-runner.js';
import { aggregateMemberPerformance, closingEquityFor } from './performance.js';
import { observedAccount, position, contracts } from '../tests/fixtures/verified-runtime.js';
import { anchorFromPlan } from '../tests/fixtures/anchor-mirror.js';

// Review 2026-10-21 fixes (R1-R4, R7, R9, R10) on the worker side. DB side: tests/review-20261021-fixes-db.test.js.

const version = '30000000-0000-4000-8000-000000000004';
const runner = (fields = {}) => Object.assign(new TradingRunner({ supabase: {}, baseUrl: 'https://api.gateio.ws',
  workerId: 'qa', workerVersion: 'qa', mode: 'LIVE' }), fields);
const member = (fields = {}) => observedAccount({ trading_account_id: 'member', user_id: 'user', resume_version: version,
  copy_ratio: 100, max_position_ratio: 30, target_anchors: [], profile_reduce_only: false, ...fields });
const master = (positions) => observedAccount({ trading_account_id: 'master', total: 20000, available: 18000, positions });
const plan = (m, positions, system = {}) => planMemberPositions({ cycleId: 'c-' + Math.random(),
  system: { emergency_halted: false, execution_enabled: true, ...system }, master: master(positions), member: m, contracts })
  .find((leg) => leg.contract === 'BTC_USDT' && leg.position_side === 'LONG');

// ---- R1 ----
test('R1 closing equity follows the opening basis: MTM with an MTM day start, wallet with a wallet one or the ledger', () => {
  const classic = { total: 1000, unrealisedPnl: -400, equityIncludesUnrealised: false };
  assert.equal(closingEquityFor(classic), 600);
  assert.equal(closingEquityFor({ ...classic, stored_risk_basis: 'MTM_V1' }), 600);
  assert.equal(closingEquityFor({ ...classic, stored_risk_basis: 'WALLET_V0' }), 1000);
  assert.equal(closingEquityFor({ ...classic, risk_context_unavailable: true }), 1000);
  assert.equal(closingEquityFor({ total: 900, unrealisedPnl: -50, equityIncludesUnrealised: true }), 900, 'unified includes it');
  const at = new Date().toISOString();
  // Opening from the MTM day start (600), an open loss that grew by 60 today: -10 %.
  let { daily } = aggregateMemberPerformance({ observedAt: at,
    member: { ...classic, unrealisedPnl: -460, day_start_equity: 600, fund_flow_net: 0 } });
  assert.deepEqual([daily.openingEquity, daily.closingEquity, daily.dailyReturnPct], [600, 540, -10]);
  // The same account whose stored day start is still on the wallet basis: wallet to wallet, 0 %.
  ({ daily } = aggregateMemberPerformance({ observedAt: at,
    member: { ...classic, day_start_equity: 1000, fund_flow_net: 0, stored_risk_basis: 'WALLET_V0' } }));
  assert.deepEqual([daily.openingEquity, daily.closingEquity, daily.dailyReturnPct], [1000, 1000, 0]);
  // Opening rebuilt from the ledger (a transfer today without a fresh net): wallet movements -> wallet closing.
  ({ daily } = aggregateMemberPerformance({ observedAt: at, member: { ...classic, total: 1310, day_start_equity: 600, fund_flow_net: 0 },
    ledger: [{ type: 'dnw', change: '300' }, { type: 'pnl', change: '10' }] }));
  assert.deepEqual([daily.openingEquity, daily.closingEquity], [1000, 1310]);
  assert.equal(daily.dailyReturnPct, 10 / 13);
  // A previous-day resync passes both recorded values; the closing is not re-adjusted.
  ({ daily } = aggregateMemberPerformance({ observedAt: at,
    member: { ...classic, opening_equity: 600, closing_equity: 540, total: 540, unrealisedPnl: -460 } }));
  assert.deepEqual([daily.openingEquity, daily.closingEquity, daily.dailyReturnPct], [600, 540, -10]);
});

// ---- R2 ----
function pendingMember(fields = {}) {
  const r = runner({ cycleSeq: 1 });
  return r.confirmRiskHalt(member({ risk_halt_reason: 'DAILY_LOSS_LIMIT', reduce_only: true, ...fields }));
}

test('R2 a confirmed (sticky) risk halt still consumes the Master increase; a pending one holds it', () => {
  const confirmed = plan(member({ reduce_only: true, profile_reduce_only: true, risk_halt_reason: 'DAILY_LOSS_LIMIT' }), [position(40)]);
  assert.equal(confirmed.target_lock_reason, 'INCREASE_CONSUMED_WHILE_BLOCKED');
  assert.equal(confirmed.anchor_update_allowed, true);
  const pending = plan(pendingMember(), [position(40)]);
  assert.equal(pending.intent, undefined);
  assert.equal(pending.anchor_update_allowed, false, 'held: no anchor move');
  assert.equal(pending.pause_reason, 'RISK_LIMIT_CONFIRMING');
});

test('R2 a pending risk violation still follows a Master reduction (and moves the anchor)', () => {
  const anchor = anchorFromPlan(plan(member(), [position(40)]), version);
  assert.equal(anchor.target_size, 10);
  const reduced = plan(pendingMember({ target_anchors: [anchor], positions: [position(10)] }), [position(20)]);
  assert.equal(reduced.intent?.delta_size, -5);
  assert.equal(reduced.intent?.reduce_only, true);
  assert.equal(reduced.anchor_update_allowed, true);
});

test('R2 pending -> confirmed counter: consecutive cycles confirm (then consume); a gap restarts the count', () => {
  const r = runner();
  const violating = () => member({ risk_halt_reason: 'DAILY_LOSS_LIMIT', reduce_only: true, fund_flow_rechecked: false });
  r.cycleSeq = 1; assert.equal(r.confirmRiskHalt(violating()).risk_halt_pending, 'DAILY_LOSS_LIMIT');
  r.cycleSeq = 2; assert.equal(r.confirmRiskHalt(violating()).risk_halt_pending, 'DAILY_LOSS_LIMIT');
  r.cycleSeq = 3;
  const confirmed = r.confirmRiskHalt(violating());
  assert.equal(confirmed.risk_halt_reason, 'DAILY_LOSS_LIMIT', 'RISK_HALT_CONFIRM_MAX_CYCLES without a re-check');
  // A failed cycle (no evaluation in seq 5) restarts the count: still pending, still holding (never consuming).
  r.cycleSeq = 4; r.confirmRiskHalt(violating());
  r.cycleSeq = 6;
  const restarted = r.confirmRiskHalt(violating());
  assert.equal(restarted.risk_halt_pending, 'DAILY_LOSS_LIMIT');
  assert.equal(plan(restarted, [position(40)]).anchor_update_allowed, false);
});

// ---- R3 ----
test('R3 until get_copy_risk_context has loaded, risk is on the wallet basis and no risk_equity is sent', async () => {
  const context = withRiskContext({ members: [{ trading_account_id: 'm1', day_start_equity: 1000, peak_equity: 1000 }] }, null);
  assert.equal(context.members[0].risk_context_unavailable, true);
  // A real wallet loss is still caught on the wallet basis.
  const loss = evaluateAccountRisk({ ...context.members[0], total: 940, unrealisedPnl: -80, equityIncludesUnrealised: false });
  assert.equal(loss.risk_halt_reason, 'DAILY_LOSS_LIMIT');
  assert.equal(loss.risk_basis_fallback, 'WALLET_V0');
  const account = { trading_account_id: 'm1', total: 1000, available: 600, unrealisedPnl: -80, equityIncludesUnrealised: false, positions: [] };
  const legacy = buildCurrentStatePayload({ cycleId: 'c', observedAt: new Date().toISOString(), master: account, members: [account], riskBasis: null });
  assert.equal(legacy.members[0].risk_basis, undefined);
  assert.equal(legacy.members[0].risk_equity, undefined);
  const current = buildCurrentStatePayload({ cycleId: 'c', observedAt: new Date().toISOString(), master: account, members: [account] });
  assert.deepEqual([current.members[0].risk_basis, current.members[0].risk_equity], [RISK_EQUITY_BASIS, 920]);
  // The runner keeps the last loaded context: once loaded, a later failure does not fall back.
  const r = runner();
  r.rpc = async () => { throw new Error('missing'); };
  assert.equal(await r.loadRiskContext(), null);
  r.rpc = async () => ({ risk_basis: 'MTM_V1', allow_unified_members: false, accounts: [] });
  assert.ok(await r.loadRiskContext());
  r.rpc = async () => { throw new Error('timeout'); };
  assert.ok(await r.loadRiskContext());
});

// ---- R4 ----
test('R4 a unified member is reported to the administrator status and alerted once (repeat after 6 h)', async () => {
  const events = [];
  const rpcs = [];
  const r = runner({ onSafetyEvent: async (event) => { events.push(event); return { sent: true }; } });
  r.rpc = async (name, params) => { rpcs.push([name, params]); return true; };
  const account = { trading_account_id: 'm1', user_id: 'u1', nickname: '회원A' };
  const now = Date.now();
  r.alertAccountPolicy(account, 'UNIFIED_ACCOUNT_UNSUPPORTED', now);
  r.alertAccountPolicy(account, 'UNIFIED_ACCOUNT_UNSUPPORTED', now + 60_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events.length, 1);
  assert.equal(events[0].event, 'MEMBER_ACCOUNT_POLICY_BLOCKED');
  assert.equal(events[0].details.error_code, 'UNIFIED_ACCOUNT_UNSUPPORTED');
  r.alertAccountPolicy(account, 'UNIFIED_ACCOUNT_UNSUPPORTED', now + CREDENTIAL_ALERT_REPEAT_MS + 1);
  assert.equal(events.length, 2, 'repeated after 6 hours');
  r.alertAccountPolicy(account, null, now + CREDENTIAL_ALERT_REPEAT_MS + 2);
  r.alertAccountPolicy(account, 'UNIFIED_ACCOUNT_UNSUPPORTED', now + CREDENTIAL_ALERT_REPEAT_MS + 3);
  assert.equal(events.length, 3, 'a cleared policy re-arms the alert');

  await r.reportAccountPolicies([{ trading_account_id: 'm1', account_policy_block: 'UNIFIED_ACCOUNT_UNSUPPORTED' },
    { trading_account_id: 'm2', account_policy_block: null }, { trading_account_id: 'm3', error_code: 'X' }], now);
  assert.deepEqual(rpcs, [['report_copy_account_policy', { p_trading_account_id: 'm1', p_policy_code: 'UNIFIED_ACCOUNT_UNSUPPORTED' }],
    ['report_copy_account_policy', { p_trading_account_id: 'm2', p_policy_code: null }]]);
  await r.reportAccountPolicies([{ trading_account_id: 'm1', account_policy_block: 'UNIFIED_ACCOUNT_UNSUPPORTED' }], now + 5_000);
  assert.equal(rpcs.length, 2, 'only changes are sent');
  await r.reportAccountPolicies([{ trading_account_id: 'm1', account_policy_block: null }], now + 10_000);
  assert.deepEqual(rpcs.at(-1), ['report_copy_account_policy', { p_trading_account_id: 'm1', p_policy_code: null }]);
  // A database without the RPC: retried after 5 minutes, never fails the caller.
  r.rpc = async (name, params) => { rpcs.push([name, params]); throw new Error('missing'); };
  await r.reportAccountPolicies([{ trading_account_id: 'm4', account_policy_block: 'UNIFIED_ACCOUNT_UNSUPPORTED' }], now);
  await r.reportAccountPolicies([{ trading_account_id: 'm4', account_policy_block: 'UNIFIED_ACCOUNT_UNSUPPORTED' }], now + 60_000);
  assert.equal(rpcs.filter(([, p]) => p.p_trading_account_id === 'm4').length, 1);
  await r.reportAccountPolicies([{ trading_account_id: 'm4', account_policy_block: 'UNIFIED_ACCOUNT_UNSUPPORTED' }], now + 300_001);
  assert.equal(rpcs.filter(([, p]) => p.p_trading_account_id === 'm4').length, 2);
});

// ---- R9 ----
test('R9 a leg whose anchor could not move during a system halt does not catch up the halt-time Master increase', () => {
  const anchor = anchorFromPlan(plan(member(), [position(40)]), version);
  assert.deepEqual([anchor.master_copyable_size, anchor.target_size], [40, 10]);
  const unresolved = [{ contract: 'BTC_USDT', position_side: 'LONG', actual_size: 10, state: 'SYNCED', has_unresolved_order: true }];
  const held = (fields = {}) => member({ target_anchors: [anchor], positions: [position(10)], ...fields });
  const r = runner();
  // Halted: the Master doubles while this leg has an unresolved order -> its anchor stays at 40/10.
  const halted = plan(held({ previous_states: unresolved }), [position(80)], { emergency_halted: true, execution_enabled: false });
  assert.equal(halted.anchor_update_allowed, false);
  r.trackHaltStaleAnchors('member', [halted], true);
  // Re-enabled, the order resolved. Without the guard the leg buys the halt-time increase now.
  const unguarded = plan(held(), [position(80)]);
  assert.equal(unguarded.intent?.delta_size, 10, 'the pre-fix catch-up BUY');
  const released = plan(held({ halt_stale_anchor_legs: r.haltStaleLegsFor('member') }), [position(80)]);
  assert.equal(released.intent, undefined, 'no catch-up BUY');
  assert.equal(released.target_lock_reason, 'INCREASE_CONSUMED_AFTER_SYSTEM_BLOCK');
  assert.equal(released.anchor_update_allowed, true);
  r.trackHaltStaleAnchors('member', [released], false);
  assert.deepEqual(r.haltStaleLegsFor('member'), []);
  const consumed = anchorFromPlan(released, version);
  assert.deepEqual([consumed.master_copyable_size, consumed.target_size], [80, 10]);
  // Later Master changes are followed as usual.
  const next = plan(held({ target_anchors: [consumed] }), [position(120)]);
  assert.equal(next.intent?.delta_size, 10);
  // A leg held through the halt without a Master increase is not marked (a later increase is bought normally).
  const quiet = plan(held({ previous_states: unresolved }), [position(40)], { emergency_halted: true, execution_enabled: false });
  r.trackHaltStaleAnchors('member', [quiet], true);
  assert.deepEqual(r.haltStaleLegsFor('member'), []);
  // A reduction after the halt is never held by the guard.
  r.trackHaltStaleAnchors('member', [halted], true);
  assert.deepEqual(r.haltStaleLegsFor('member'), ['BTC_USDT:LONG']);
  const reduced = plan(held({ halt_stale_anchor_legs: r.haltStaleLegsFor('member') }), [position(20)]);
  assert.equal(reduced.intent?.delta_size, -5);
});

// ---- R7 / R10 (worker/index.js) ----
test('R7 the verification result carries its claim; R10 the deferred reconciliation runs even when the order phase fails', () => {
  const source = readFileSync(new URL('./index.js', import.meta.url), 'utf8');
  assert.match(source, /p_claimed_at: job\.claimed_at/);
  assert.match(source, /VERIFICATION_JOB_CLAIM_STALE/);
  const cycle = source.slice(source.indexOf('const submitStartedAt'), source.indexOf('// P1-8: resume validation after the order phase'));
  assert.match(cycle, /try \{ submitted = await runner\.submitOrders\(\); \} catch \(error\) \{ submitError = error; \}/);
  assert.ok(cycle.indexOf('reconcileDeferredOrders') < cycle.indexOf('if (submitError) throw submitError'));
});
