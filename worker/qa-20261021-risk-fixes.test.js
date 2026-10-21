import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import {
  getFuturesAccount, normalizeGatePositions, setFuturesLeverage, verifyGateAccount, GateApiError, UNIFIED_ACCOUNT_UNSUPPORTED,
} from './gate.js';
import {
  TradingRunner, buildCurrentStatePayload, evaluateAccountRisk, planMemberPositions, withRiskContext,
  DEFAULT_CROSS_LEVERAGE, RISK_EQUITY_BASIS, RISK_HALT_CONFIRM_MAX_CYCLES,
} from './trading-runner.js';
import { assertSubmissionSnapshot } from './execution-safety.js';
import { observedAccount, position, contracts } from '../tests/fixtures/verified-runtime.js';

// QA 2026-10-21 area D fixes (fix/qa-risk): D4 risk-halt confirmation, D5 risk equity basis, D6 unified members,
// D7 shared hedge-mode leverage, 5a single-mode leverage endpoint, 5b cross-margin leverage 0.

const json = (value, status = 200) => new Response(JSON.stringify(value), { status });

// ---- 5a: leverage endpoints (Gate API v4 FuturesApi update_position_leverage / update_dual_mode_position_leverage) ----
async function captureLeverage(args) {
  const calls = [];
  await setFuturesLeverage({ apiKey: 'key', secretKey: 'secret', channelId: 'maetajak', contract: 'BTC_USDT', ...args,
    fetchImpl: async (url, options) => { calls.push({ url, options }); return json({ contract: 'BTC_USDT' }); } });
  assert.equal(calls.length, 1);
  return calls[0];
}

test('5a single mode: cross leverage is POST /futures/usdt/positions/{contract}/leverage?leverage=0&cross_leverage_limit=N', async () => {
  const { url, options } = await captureLeverage({ leverage: 10, marginMode: 'cross' });
  assert.equal(url, 'https://api.gateio.ws/api/v4/futures/usdt/positions/BTC_USDT/leverage?leverage=0&cross_leverage_limit=10');
  assert.equal(options.method, 'POST');
  assert.equal(options.body, undefined, 'parameters are query parameters, no JSON body');
  assert.equal(options.headers['X-Gate-Channel-Id'], 'maetajak');
  assert.ok(Number(options.headers['X-Gate-Exptime']) > Date.now());
  // APIv4 signature: METHOD\nPATH\nQUERY\nSHA512(body)\nTIMESTAMP, signed with the secret.
  const source = ['POST', '/api/v4/futures/usdt/positions/BTC_USDT/leverage', 'leverage=0&cross_leverage_limit=10',
    createHash('sha512').update('').digest('hex'), options.headers.Timestamp].join('\n');
  assert.equal(options.headers.SIGN, createHmac('sha512', 'secret').update(source).digest('hex'));
});

test('5a single mode: isolated leverage sends only leverage=N; dual mode keeps the dual_comp path', async () => {
  assert.equal((await captureLeverage({ leverage: 5, marginMode: 'isolated' })).url,
    'https://api.gateio.ws/api/v4/futures/usdt/positions/BTC_USDT/leverage?leverage=5');
  assert.equal((await captureLeverage({ leverage: 7, marginMode: 'cross', positionSide: 'SHORT' })).url,
    'https://api.gateio.ws/api/v4/futures/usdt/dual_comp/positions/BTC_USDT/leverage?leverage=0&cross_leverage_limit=7');
});

// ---- 5b: cross-margin Master leg reporting leverage 0 ----
test('5b a cross Master leg with cross_leverage_limit 0 gets a valid target leverage instead of ORDER_RISK_METADATA_INVALID', () => {
  const [masterLeg] = normalizeGatePositions([{ contract: 'BTC_USDT', size: '40', mark_price: '50000', leverage: '0',
    cross_leverage_limit: '0', mode: 'dual_long', pos_margin_mode: 'cross' }]);
  assert.equal(masterLeg.leverage, 0, 'root cause: Gate reports 0 for cross without a limit');
  const master = observedAccount({ trading_account_id: 'master', total: 20000, available: 18000, positions: [masterLeg] });
  const member = observedAccount({ trading_account_id: 'member', user_id: 'u', resume_version: 'v', copy_ratio: 100,
    max_position_ratio: 30, target_anchors: [] });
  const [leg] = planMemberPositions({ cycleId: 'c', system: { emergency_halted: false }, master, member, contracts });
  assert.equal(leg.intent.target_leverage, DEFAULT_CROSS_LEVERAGE);
  assert.equal(leg.risk_leverage, DEFAULT_CROSS_LEVERAGE);
  assert.equal(leg.leverage_reason, 'MASTER_LEVERAGE_UNREPORTED_DEFAULT');
  const job = { intent_id: 'i', contract: 'BTC_USDT', position_side: 'LONG', delta_size: leg.intent.delta_size, reduce_only: false,
    target_size: leg.target_size, actual_size_at_plan: 0, master_size_at_plan: 40, quanto_multiplier: 0.001,
    target_leverage: leg.intent.target_leverage, risk_leverage: leg.risk_leverage, taker_fee_rate: 0.001, slippage_ratio: 0.005 };
  assert.doesNotThrow(() => assertSubmissionSnapshot(job, member, master));
  // A contract whose maximum is lower caps the default.
  const low = new Map([['BTC_USDT', { ...contracts.get('BTC_USDT'), leverageMax: 5 }]]);
  const [capped] = planMemberPositions({ cycleId: 'c2', system: { emergency_halted: false }, master, member, contracts: low });
  assert.equal(capped.intent.target_leverage, 5);
  // A reported cross limit still wins.
  const [reported] = planMemberPositions({ cycleId: 'c3', system: { emergency_halted: false }, contracts, member,
    master: { ...master, positions: [{ ...masterLeg, leverage: 20 }] } });
  assert.equal(reported.intent.target_leverage, 20);
  assert.equal(reported.leverage_reason, undefined);
});

// ---- D7: shared contract leverage in classic hedge mode ----
test('D7 an open opposite COPY or personal leg keeps the contract leverage; no opposite leg sets the Master leverage', () => {
  const master = observedAccount({ trading_account_id: 'master', total: 20000, available: 18000, positions: [position(-40)] });
  const member = (positions) => observedAccount({ trading_account_id: 'member', user_id: 'u', resume_version: 'v', copy_ratio: 100,
    max_position_ratio: 60, target_anchors: [], positions });
  const plan = (m) => planMemberPositions({ cycleId: 'c', system: { emergency_halted: false }, master, member: m, contracts })
    .find((p) => p.position_side === 'SHORT');
  const free = plan(member([]));
  assert.equal(free.intent.target_leverage, 10);
  const held = plan(member([{ ...position(5), leverage: 4 }]));
  assert.equal(held.intent?.target_leverage ?? null, null);
  assert.equal(held.risk_leverage, 4);
});

async function submitWithOpenOpposite(available) {
  const events = [];
  const requests = [];
  const runner = new TradingRunner({ supabase: {}, baseUrl: 'https://api.gateio.ws', workerId: 'qa', workerVersion: 'qa',
    channelId: 'maetajak', mode: 'LIVE', logger: (event, details) => events.push({ event, details }),
    fetchImpl: async (url) => {
      requests.push(url);
      return json({ id: '1', size: -10, left: 0, status: 'finished', finish_as: 'filled', contract: 'BTC_USDT', text: 't-mtj-1' }, 201);
    } });
  const job = { intent_id: 'i1', user_id: 'u', api_key: 'k', secret_key: 's', contract: 'BTC_USDT', position_side: 'SHORT',
    position_mode: 'dual', delta_size: -10, reduce_only: false, target_leverage: 10, margin_mode: 'cross', resume_version: 'v',
    gate_order_text: 't-mtj-1', slippage_ratio: 0.005, source_observed_at: new Date().toISOString(), trading_account_id: 'member',
    actual_size_at_plan: 0, target_size: -10, master_size_at_plan: -40, quanto_multiplier: 0.001, risk_leverage: 10 };
  const completed = [];
  runner.rpc = async (name, params) => {
    if (name === 'claim_copy_order_intents') return [job];
    if (name === 'get_copy_worker_context') return { master: { trading_account_id: 'master' }, members: [{ trading_account_id: 'member' }] };
    if (name === 'get_copy_reversal_entry_context') return { guard_version: 1, allowed: true, ownership_verified: true, intent_id: 'i1',
      trading_account_id: 'member', resume_version: 'v', opposite_side: 'LONG', copy_opposite_size: 0, protected_opposite_size: 5 };
    if (name === 'complete_copy_order_attempt') { completed.push(params); return null; }
    if (name === 'authorize_copy_order_submission') return true;
    return [];
  };
  // The job was planned (target_leverage 10) before the member opened a personal LONG at 1x.
  runner.readAccount = async (account) => observedAccount({ ...account, available,
    positions: account.trading_account_id === 'master' ? [position(-40)] : [{ ...position(5), leverage: 1, posMarginMode: 'isolated' }] });
  const attempts = await runner.submitOrders();
  return { attempts, requests, completed, events };
}

test('D7 submit: an opposite leg opened after planning skips the leverage POST and checks margin at the current leverage', async () => {
  // At 1x the 10-lot entry needs about 503 USDT: 300 available fails although it would fit at the job's 10x.
  const short = await submitWithOpenOpposite(300);
  assert.equal(short.attempts, 0);
  assert.equal(short.requests.length, 0, 'no leverage request, no order');
  assert.equal(short.completed[0].p_error_code, 'WORKER_INSUFFICIENT_AVAILABLE_MARGIN');
  const enough = await submitWithOpenOpposite(1000);
  assert.equal(enough.attempts, 1);
  assert.deepEqual(enough.requests, ['https://api.gateio.ws/api/v4/futures/usdt/orders']);
  assert.deepEqual(enough.events.find((e) => e.event === 'leverage_change_skipped')?.details,
    { intent_id: 'i1', contract: 'BTC_USDT', position_side: 'SHORT', reason: 'OPPOSITE_LEG_OPEN', target_leverage: 10, current_leverage: 1 });
});

// ---- D5: risk equity basis ----
test('D5 risk equity follows the sizing basis; the current-state payload carries it with its marker', () => {
  const classic = { trading_account_id: 'a', total: 1000, unrealisedPnl: -400, equityIncludesUnrealised: false,
    day_start_equity: 1000, peak_equity: 1000, daily_loss_limit_pct: 50, max_drawdown_pct: 30 };
  const risk = evaluateAccountRisk(classic);
  assert.equal(risk.risk_equity, 600);
  assert.equal(risk.risk_halt_reason, 'MAX_DRAWDOWN_LIMIT');
  // Unified equity already includes unrealised PnL: not added again.
  assert.equal(evaluateAccountRisk({ ...classic, total: 1000, equityIncludesUnrealised: true }).risk_equity, 1000);
  const payload = buildCurrentStatePayload({ cycleId: 'c', observedAt: new Date().toISOString(),
    master: { trading_account_id: 'm', total: 5000, positions: [] }, members: [{ ...classic, positions: [] }] });
  assert.equal(payload.members[0].risk_equity, 600);
  assert.equal(payload.members[0].risk_basis, RISK_EQUITY_BASIS);
  assert.equal(payload.members[0].total_equity, 1000, 'total_equity keeps the Gate wallet value');
});

test('D5 peak/day-start stored on another basis are never compared (one cycle without a risk decision)', () => {
  const context = withRiskContext({ members: [{ trading_account_id: 'a' }, { trading_account_id: 'b' }, { trading_account_id: 'c' }] },
    { risk_basis: RISK_EQUITY_BASIS, accounts: [{ trading_account_id: 'a', risk_basis: 'WALLET_V0' },
      { trading_account_id: 'b', risk_basis: null }, { trading_account_id: 'c', risk_basis: RISK_EQUITY_BASIS }] });
  assert.deepEqual(context.members.map((m) => m.stored_risk_basis), ['WALLET_V0', 'UNKNOWN', RISK_EQUITY_BASIS]);
  const losing = { total: 500, day_start_equity: 1000, peak_equity: 1000, daily_loss_limit_pct: 15, max_drawdown_pct: 20 };
  for (const member of context.members) {
    const risk = evaluateAccountRisk({ ...losing, ...member });
    assert.equal(risk.risk_halt_reason, member.stored_risk_basis === RISK_EQUITY_BASIS ? 'DAILY_LOSS_LIMIT' : null);
  }
  // Without the RPC (no basis known) the evaluation runs as usual.
  assert.equal(evaluateAccountRisk(losing).risk_halt_reason, 'DAILY_LOSS_LIMIT');
});

// ---- D6: unified accounts ----
function verificationFetch({ marginMode = 0, readOnly = false } = {}) {
  return async (url) => {
    if (url.endsWith('/futures/usdt/accounts')) return json({ user: 45997867, total: '100', margin_mode: marginMode });
    if (url.endsWith('/account/detail')) return json({ user_id: 45997867, ip_whitelist: ['203.0.113.10'] });
    if (url.endsWith('/account/main_keys')) return json({ state: 1, key: { mode: 1 }, perms: [{ name: 'futures', read_only: readOnly }] });
    throw new Error(`unexpected URL: ${url}`);
  };
}
const verify = (options) => verifyGateAccount({ gateUid: '45997867', apiKey: 'k', secretKey: 's', expectedPublicIp: '203.0.113.10', ...options });

test('D6 verification refuses a MEMBER in unified mode unless allowed; the Master is never refused', async () => {
  const member = await verify({ fetchImpl: verificationFetch({ marginMode: 1 }) });
  assert.equal(member.success, false);
  assert.equal(member.errorCode, UNIFIED_ACCOUNT_UNSUPPORTED);
  assert.match(member.errorMessage, /통합계정/);
  assert.equal((await verify({ fetchImpl: verificationFetch({ marginMode: 1 }), rejectUnifiedAccount: false })).success, true);
  assert.equal((await verify({ fetchImpl: verificationFetch({ marginMode: 0 }) })).success, true, 'classic member accepted');
  const master = await verify({ fetchImpl: verificationFetch({ marginMode: 2, readOnly: true }), requiresTradingPermission: false });
  assert.equal(master.success, true);
});

const accountFetch = (unified) => async (url) => {
  if (url.includes('/futures/usdt/accounts')) return json(unified
    ? { user: 1, total: '0', available: '900', unrealised_pnl: '0', margin_mode: 1, position_mode: 'dual' }
    : { user: 1, total: '1000', available: '900', unrealised_pnl: '0', margin_mode: 0, position_mode: 'dual' });
  if (url.includes('/unified/accounts')) return json({ unified_account_total_equity: '1500' });
  return json([]);
};

test('D6 getFuturesAccount reports the account mode', async () => {
  assert.equal((await getFuturesAccount({ apiKey: 'k', secretKey: 's', fetchImpl: accountFetch(false) })).accountMode, 'classic');
  assert.equal((await getFuturesAccount({ apiKey: 'k', secretKey: 's', fetchImpl: accountFetch(true) })).accountMode, 'unified');
});

test('D6 a unified MEMBER read is held reduce-only (no risk evaluation) unless the operator allows unified members', async () => {
  const runner = new TradingRunner({ supabase: {}, baseUrl: 'https://api.gateio.ws', mode: 'LIVE', fetchImpl: accountFetch(true) });
  const context = { trading_account_id: 'a', api_key: 'k', secret_key: 's', day_start_equity: 3000, peak_equity: 3000,
    daily_loss_limit_pct: 15, max_drawdown_pct: 20 };
  const blocked = await runner.readAccount(context, { member: true });
  assert.equal(blocked.account_policy_block, UNIFIED_ACCOUNT_UNSUPPORTED);
  assert.equal(blocked.reduce_only, true);
  assert.equal(blocked.risk_halt_reason, null, 'nothing sticky is recorded');
  assert.throws(() => assertSubmissionSnapshot({ contract: 'BTC_USDT', position_side: 'LONG', delta_size: 1, target_size: 1,
    actual_size_at_plan: 0, master_size_at_plan: 40, reduce_only: false }, blocked,
  observedAccount({ positions: [position(40)] })), (error) => error instanceof GateApiError && error.code === UNIFIED_ACCOUNT_UNSUPPORTED);
  // The Master is read without the member policy.
  assert.equal((await runner.readAccount(context)).account_policy_block, null);
  runner.riskContext = { allow_unified_members: true };
  const allowed = await runner.readAccount(context, { member: true });
  assert.equal(allowed.account_policy_block, null);
  assert.equal(allowed.risk_halt_reason, 'DAILY_LOSS_LIMIT', 'risk is evaluated when allowed');
});

test('D6 resume of a unified member stops with RESUME_UNIFIED_ACCOUNT_UNSUPPORTED', async () => {
  const runner = new TradingRunner({ supabase: {}, baseUrl: 'https://api.gateio.ws', mode: 'LIVE', fetchImpl: accountFetch(true) });
  const blockers = [];
  runner.rpc = async (name, params) => { if (name === 'report_member_copy_resume_blocker') blockers.push(params.p_reason); return null; };
  await runner.processMemberResume({ session: { state: 'REQUESTED', version: 'v', expires_at: new Date(Date.now() + 60_000).toISOString(),
    unresolved_orders: 0 }, masterContext: { trading_account_id: 'm', api_key: 'mk', secret_key: 'ms' },
  memberContext: { trading_account_id: 'a', api_key: 'k', secret_key: 's' }, contracts, system: {} });
  assert.deepEqual(blockers, ['RESUME_UNIFIED_ACCOUNT_UNSUPPORTED']);
});

// ---- D4: a new risk halt is persisted only when confirmed ----
function riskCycleRunner({ ledger, total = 800 }) {
  const state = { ledgerReads: 0, payloads: [], flows: new Map() };
  const fetchImpl = async (url, options) => {
    const master = options.headers.KEY === 'master-key';
    if (url.includes('/futures/usdt/account_book')) { state.ledgerReads += 1; return ledger(state.ledgerReads); }
    if (url.includes('/futures/usdt/accounts')) return json({ user: master ? 1 : 2, total: master ? '20000' : String(total),
      available: master ? '18000' : String(total), unrealised_pnl: '0', margin_mode: 0, position_mode: 'dual' });
    return json([]);
  };
  const runner = new TradingRunner({ supabase: {}, baseUrl: 'https://api.gateio.ws', mode: 'LIVE', channelId: 'maetajak', fetchImpl });
  runner.loadContracts = async () => contracts;
  runner.rpc = async (name, params) => {
    if (name === 'get_copy_worker_context') return { system: { execution_enabled: true, emergency_halted: false },
      master: { trading_account_id: 'm', api_key: 'master-key', secret_key: 'ms' },
      members: [{ trading_account_id: 'a', user_id: 'u', api_key: 'member-key', secret_key: 's', copy_ratio: 100, max_position_ratio: 30,
        day_start_equity: 1000, peak_equity: 1000, daily_loss_limit_pct: 15, max_drawdown_pct: 30, reduce_only: false }] };
    if (name === 'get_copy_resume_context') return [{ trading_account_id: 'a', state: 'ACTIVE', version: 'v', baseline_version: 'v',
      positions: [], member_positions: [] }];
    if (name === 'record_copy_fund_flows') {
      for (const entry of params.p_entries) state.flows.set(entry.key, Number(entry.change));
      return [...state.flows.values()].reduce((sum, change) => sum + change, 0);
    }
    if (name === 'record_verified_copy_worker_cycle') { state.payloads.push(params.p_payload.members[0]); return null; }
    if (name === 'get_copy_risk_context') return { risk_basis: RISK_EQUITY_BASIS, allow_unified_members: false, accounts: [] };
    return [];
  };
  return { runner, state };
}

test('D4 a genuine loss is persisted on the second consecutive cycle after a confirming (unthrottled) ledger re-check', async () => {
  const { runner, state } = riskCycleRunner({ ledger: () => json([]) });
  await runner.syncOnce();
  assert.equal(state.payloads[0].risk_halt_reason, null, 'cycle 1: not persisted');
  assert.equal(state.payloads[0].risk_halt_pending, 'DAILY_LOSS_LIMIT');
  assert.equal(state.payloads[0].reduce_only, true, 'cycle 1: new entries already held');
  await runner.syncOnce();
  assert.equal(state.ledgerReads, 2, 'the confirming cycle re-reads the ledger within 60 s');
  assert.equal(state.payloads[1].risk_halt_reason, 'DAILY_LOSS_LIMIT', 'cycle 2: persisted (sticky reduce-only)');
});

test('D4 a second withdrawal seen by the confirming re-check never reaches the database as a risk halt', async () => {
  const now = Math.floor(Date.now() / 1000);
  // Equity 1000 -> 700 after two withdrawals (-100, then -200 seconds later). Cycle 1: only the first is in the
  // ledger (lag), so 700 + 100 = 800 reads as -20%.
  const { runner, state } = riskCycleRunner({ total: 700, ledger: (read) => json(read === 1
    ? [{ id: 'w1', type: 'dnw', change: '-100', time: now - 10 }]
    : [{ id: 'w1', type: 'dnw', change: '-100', time: now - 10 }, { id: 'w2', type: 'dnw', change: '-200', time: now }]) });
  await runner.syncOnce();
  assert.equal(state.payloads[0].risk_halt_reason, null);
  assert.equal(state.payloads[0].risk_halt_pending, 'DAILY_LOSS_LIMIT');
  await runner.syncOnce();
  assert.equal(state.payloads[1].risk_halt_reason, null);
  assert.equal(state.payloads[1].risk_halt_pending ?? null, null);
  assert.equal(state.payloads[1].reduce_only, false, 'entries resume');
  assert.equal(runner.pendingRiskHalts.size, 0);
});

test('D4 without a working ledger the halt is still persisted after RISK_HALT_CONFIRM_MAX_CYCLES cycles', async () => {
  const { runner, state } = riskCycleRunner({ ledger: () => json({ label: 'SERVER_ERROR' }, 500) });
  for (let i = 0; i < RISK_HALT_CONFIRM_MAX_CYCLES; i += 1) await runner.syncOnce();
  assert.deepEqual(state.payloads.map((p) => p.risk_halt_reason), [null, null, 'DAILY_LOSS_LIMIT']);
});
