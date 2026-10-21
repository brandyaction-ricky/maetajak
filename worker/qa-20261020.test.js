import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import {
  CREDENTIAL_ALERT_AFTER_MS, CREDENTIAL_ALERT_REPEAT_MS, TradingRunner, intentNeverSentToGate, planMemberPositions,
  rpcFailure, safeError, unfilledFinishCode, withoutCredentials,
} from './trading-runner.js';
import {
  GateApiError, getFuturesAccountBook, getMyFuturesTradesInRange, mapGateError, roundOrderSize, summarizeGateOrder,
} from './gate.js';
import { sameSize } from './execution-safety.js';
import { previousKstDayRange, kstDayRange } from './performance.js';
import {
  createShutdown, createSupabaseFetch, cycleFailureCode, normalizeTradingMode, readIntervalMs, supabaseRequestTimeoutMs,
} from './runtime.js';
import { sendWorkerAlert } from './alerts.js';
import { getBrokerCommissionHistory } from './broker-metrics.js';
import { validatePreflightEnvironment } from '../scripts/worker-preflight.js';
import { observedAccount, position } from '../tests/fixtures/verified-runtime.js';

// Regression tests for the 2026-10-20 worker QA findings (items 1-15). Probes write only under /tmp/qa-worker-fix/.
const PROBE_ROOT = '/tmp/qa-worker-fix';
const flush = () => new Promise((resolve) => setImmediate(resolve));

const baseJob = {
  intent_id: 'intent-1', user_id: 'member', api_key: 'job-key', secret_key: 'job-secret',
  contract: 'BTC_USDT', position_side: 'LONG', position_mode: 'dual', delta_size: 20,
  reduce_only: false, target_leverage: null, gate_order_text: 't-mtj-12345678901234567890',
  slippage_ratio: 0.005, resume_version: 'test-resume', source_observed_at: new Date().toISOString(),
  trading_account_id: 'account', actual_size_at_plan: 0, target_size: 20, master_size_at_plan: 20,
  quanto_multiplier: 0.001, risk_leverage: 10,
};

function submitRunner({ jobs = [baseJob], member = {}, orderBody, authorize = async () => true, contracts = null } = {}) {
  const completions = [];
  const calls = [];
  let orderRequests = 0;
  const runner = new TradingRunner({
    supabase: {}, baseUrl: 'https://api.gateio.ws', mode: 'LIVE', channelId: 'maetajak',
    fetchImpl: async () => {
      orderRequests++;
      return new Response(orderBody ?? JSON.stringify({ id: 'order-1', contract: 'BTC_USDT', text: baseJob.gate_order_text,
        size: 20, left: 0, status: 'finished', finish_as: 'filled' }), { status: 201 });
    },
  });
  if (contracts) runner.contracts = contracts;
  runner.rpc = async (name, parameters) => {
    calls.push(name);
    if (name === 'get_copy_worker_context') return { master: { trading_account_id: 'master' },
      members: [{ trading_account_id: 'account', api_key: 'ctx-key', secret_key: 'ctx-secret', ...member }] };
    if (name === 'get_copy_fund_flow_totals') return [];
    if (name === 'claim_copy_order_intents') return jobs;
    if (name === 'authorize_copy_order_submission') return authorize(parameters);
    if (name === 'complete_copy_order_attempt') { completions.push(parameters); return null; }
    throw new Error(`unexpected RPC: ${name}`);
  };
  const reads = [];
  runner.readAccount = async (account) => {
    reads.push(account);
    return observedAccount({ ...account, positions: account.trading_account_id === 'master' ? [position(20)] : [] });
  };
  return { runner, completions, calls, reads, orderRequests: () => orderRequests };
}

// --- 1. Supabase request timeouts -------------------------------------------------------------------------------

test('1: every Supabase request gets a client-side timeout; post-exchange completions get a longer one', async () => {
  assert.equal(supabaseRequestTimeoutMs('https://p.supabase.co/rest/v1/rpc/copy_worker_heartbeat'), 15_000);
  assert.equal(supabaseRequestTimeoutMs('https://p.supabase.co/rest/v1/rpc/authorize_copy_order_submission'), 15_000);
  assert.equal(supabaseRequestTimeoutMs('https://p.supabase.co/rest/v1/rpc/complete_copy_order_attempt'), 30_000);
  assert.equal(supabaseRequestTimeoutMs('https://p.supabase.co/rest/v1/rpc/complete_copy_reconciliation'), 30_000);
  // A stuck PostgREST call (never answers) now fails fast through the real supabase-js client.
  const hanging = (url, init) => new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
  });
  const supabase = createClient('https://qa-probe.supabase.co', 'service-role-test', {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: createSupabaseFetch({ fetchImpl: hanging, timeoutFor: () => 30 }) },
  });
  const startedAt = Date.now();
  // AbortSignal.timeout's timer does not keep the process alive (a real socket does); hold the loop meanwhile.
  const keepAlive = setTimeout(() => {}, 5_000);
  const { error } = await supabase.rpc('copy_worker_heartbeat', {});
  clearTimeout(keepAlive);
  assert.ok(Date.now() - startedAt < 2_000);
  assert.match(error.message, /TimeoutError/);
  const failure = rpcFailure('copy_worker_heartbeat', error);
  assert.equal(failure.code, 'copy_worker_heartbeat:TIMEOUT');
});

test('1: an authorize timeout (even after a server commit) completes the intent as REJECTED and never POSTs', async () => {
  const fixture = submitRunner({ authorize: async () => { throw rpcFailure('authorize_copy_order_submission',
    { message: 'TimeoutError: The operation was aborted due to timeout' }); } });
  assert.equal(await fixture.runner.submitOrders(), 0);
  assert.equal(fixture.orderRequests(), 0);
  assert.equal(fixture.completions[0].p_result_status, 'REJECTED');
});

// --- 2. never-sent alerts, one context per batch ---------------------------------------------------------------

test('2: intents that never reached Gate are logged as 미전송, not alerted as 카피 주문 미체결', async () => {
  const never = [
    ['CANCELLED', 'SUPERSEDED_BY_FRESH_PLAN'], ['CANCELLED', 'SUBMISSION_AUTHORIZATION_REVOKED'],
    ['CANCELLED', 'UNSENT_CLAIM_EXPIRED'], ['CANCELLED', 'UNSENT_UNKNOWN_RESOLVED'], ['CANCELLED', 'COPY_OWNERSHIP_UNKNOWN'],
    ['CANCELLED', 'GATE_ACCOUNT_CHANGED'],
    ...['MASTER_POSITION_CHANGED_BEFORE_SUBMIT', 'MEMBER_POSITION_CHANGED_BEFORE_SUBMIT',
      'OPEN_EXCHANGE_ORDER', 'ORDER_PLAN_STALE', 'GATE_TIMEOUT']
      .map((code) => ['REJECTED', safeError(new GateApiError('x', { code }))]),
  ];
  const sent = [
    ['REJECTED', 'WORKER_GATE_BALANCE_NOT_ENOUGH'], ['CANCELLED', 'NOT_FOUND_AFTER_EXPIRY'], ['REJECTED', 'WORKER_FAILED'],
  ];
  const jobs = [...never, ...sent].map(([status, code], index) => ({ alert_id: index + 1, event_type: 'COPY_ORDER_FAILED',
    gate_order_id: null, result_status: status, filled_size: 0, error_code: code, contract: 'BTC_USDT', details: {} }));
  for (const job of jobs.slice(0, never.length)) assert.equal(intentNeverSentToGate(job), true, job.error_code);
  assert.equal(intentNeverSentToGate({ ...jobs[0], gate_order_id: '1' }), false, 'an order id means Gate saw it');
  const alerts = []; const logs = [];
  const runner = new TradingRunner({ supabase: {}, mode: 'LIVE', logger: (event, details) => logs.push({ event, details }),
    onSafetyEvent: async (alert) => { alerts.push(alert); return { sent: true }; } });
  runner.rpc = async (name) => (name === 'claim_copy_entry_alerts' ? jobs : null);
  assert.equal(await runner.deliverEntryAlerts(50), sent.length);
  assert.deepEqual(alerts.map((a) => a.details.error_code), sent.map(([, code]) => code));
  const suppressed = logs.filter((l) => l.event === 'entry_alert_suppressed');
  assert.equal(suppressed.length, never.length);
  assert.match(suppressed[0].details.note, /미전송/);
});

test('2: the worker context and fund-flow totals are read once per submit batch', async () => {
  const fixture = submitRunner({ jobs: [baseJob, { ...baseJob, intent_id: 'intent-2' }, { ...baseJob, intent_id: 'intent-3' }] });
  assert.equal(await fixture.runner.submitOrders(), 3);
  assert.equal(fixture.calls.filter((name) => name === 'get_copy_worker_context').length, 1);
  assert.equal(fixture.calls.filter((name) => name === 'get_copy_fund_flow_totals').length, 1);
});

// --- 3. the job no longer overrides member settings -------------------------------------------------------------

test('3: an entry intent (reduce_only=false) cannot override the profile reduce_only: MEMBER_RISK_LIMIT, no POST', async () => {
  const fixture = submitRunner({ member: { reduce_only: true } });
  assert.equal(await fixture.runner.submitOrders(), 0);
  assert.equal(fixture.orderRequests(), 0);
  assert.equal(fixture.completions[0].p_result_status, 'REJECTED');
  assert.equal(fixture.completions[0].p_error_code, 'WORKER_MEMBER_RISK_LIMIT');
  const memberRead = fixture.reads.find((account) => account.trading_account_id === 'account');
  assert.equal(memberRead.reduce_only, true);
  assert.equal(memberRead.api_key, 'job-key', 'the order credentials still come from the claimed job');
  assert.equal('intent_id' in memberRead, false);
});

// --- 4/5. cycle failure code, env parsing, trading mode ---------------------------------------------------------

test('4: a cycle failure stores a machine code, never a Korean message', () => {
  assert.equal(cycleFailureCode(new GateApiError('최신 계좌 상태를 확인할 수 없습니다.', { code: 'ACCOUNT_SNAPSHOT_STALE' })),
    'ACCOUNT_SNAPSHOT_STALE');
  assert.equal(cycleFailureCode(new Error('회원 설정을 확인할 수 없습니다.')), 'WORKER_FAILED');
  assert.equal(cycleFailureCode(rpcFailure('record_verified_copy_worker_cycle', { message: 'CURRENT_STATE_SNAPSHOT_INVALID' })),
    'record_verified_copy_worker_cycle:CURRENT_STATE_SNAPSHOT_INVALID');
  assert.equal(rpcFailure('get_copy_resume_context', { message: 'canceling statement due to statement timeout', code: '57014' }).code,
    'get_copy_resume_context:57014');
  // The lease check matches the message, which keeps the database text.
  assert.match(rpcFailure('copy_worker_heartbeat', { message: 'WORKER_LEASE_HELD' }).message, /WORKER_LEASE_HELD/);
});

test('5: non-numeric intervals fall back to defaults and TRADING_MODE is normalised like preflight', () => {
  assert.equal(readIntervalMs('abc', 5_000, 2_000), 5_000);
  assert.equal(readIntervalMs('', 5_000, 2_000), 5_000);
  assert.equal(readIntervalMs(undefined, 60_000, 30_000), 60_000);
  assert.equal(readIntervalMs('500', 5_000, 2_000), 2_000);
  assert.equal(readIntervalMs(' 7000 ', 5_000, 2_000), 7_000);
  assert.equal(readIntervalMs('Infinity', 5_000, 2_000), 5_000);
  assert.equal(normalizeTradingMode(' live\r'), 'LIVE');
  assert.equal(normalizeTradingMode(''), 'OBSERVE');
  assert.equal(normalizeTradingMode(undefined), 'OBSERVE');
  const env = { SUPABASE_URL: 'https://abcdefghijk.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_x',
    GATE_CHANNEL_ID: 'maetajak', WORKER_PUBLIC_IP: '3.37.231.51', TRADING_MODE: ' dry_run ' };
  assert.equal(validatePreflightEnvironment(env).mode, 'DRY_RUN');
});

// --- 6. KST day boundary + pagination ---------------------------------------------------------------------------

function gateHistoryFetch(handler) {
  const calls = [];
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    const query = Object.fromEntries(parsed.searchParams);
    calls.push({ path: parsed.pathname, query });
    return new Response(JSON.stringify(handler(parsed.pathname, query)), { status: 200 });
  };
  return { fetchImpl, calls };
}

test('6: ledger and trade history are paginated past 1000 rows and fail closed beyond the page bound', async () => {
  const { fetchImpl, calls } = gateHistoryFetch((path, query) => {
    const offset = Number(query.offset);
    const size = offset === 0 ? 1000 : 3;
    return Array.from({ length: size }, (_, index) => ({ id: offset + index, type: 'pnl', change: '1', time: 1 }));
  });
  const rows = await getFuturesAccountBook({ apiKey: 'k', secretKey: 's', from: 1, to: 2, fetchImpl });
  assert.equal(rows.length, 1003);
  assert.deepEqual(calls.map((c) => c.query.offset), ['0', '1000']);
  const full = gateHistoryFetch((path, query) => Array.from({ length: 1000 }, (_, index) => ({ id: `${query.offset}-${index}` })));
  await assert.rejects(getMyFuturesTradesInRange({ apiKey: 'k', secretKey: 's', from: 1, to: 2, fetchImpl: full.fetchImpl, maxPages: 3 }),
    (error) => error.code === 'TRADES_PAGINATION_LIMIT');
});

test('6: the first sync after the KST date changes re-aggregates the previous KST day once', async () => {
  const beforeMidnight = new Date('2026-10-20T14:57:00.000Z'); // 23:57 KST
  const afterMidnight = new Date('2026-10-20T15:03:00.000Z'); // 00:03 KST next day
  assert.deepEqual(previousKstDayRange(afterMidnight).tradingDate, '2026-10-20');
  assert.equal(previousKstDayRange(afterMidnight).to, kstDayRange(afterMidnight).from);
  // One fill at 23:58 KST, after the last sync of the day.
  const lateFill = Math.floor(Date.parse('2026-10-20T14:58:00.000Z') / 1000);
  const { fetchImpl } = gateHistoryFetch((path, query) => {
    const from = Number(query.from); const to = Number(query.to);
    if (query.type === 'dnw') return [];
    const ledger = [{ id: 'early', type: 'pnl', change: '10', time: from + 60, contract: 'BTC_USDT' },
      { id: 'late', type: 'pnl', change: '5', time: lateFill, contract: 'BTC_USDT' }];
    if (path.endsWith('/account_book')) return ledger.filter((row) => row.time >= from && row.time <= to);
    return [];
  });
  const upserts = [];
  const runner = new TradingRunner({ supabase: {}, baseUrl: 'https://api.gateio.ws', mode: 'LIVE', fetchImpl });
  runner.rpc = async (name, parameters) => {
    if (name === 'upsert_member_daily_performance') upserts.push(parameters);
    return 0;
  };
  const member = { user_id: 'u1', trading_account_id: 'a1', api_key: 'k', secret_key: 's', total: 1000, day_start_equity: 990,
    unrealisedPnl: 3 };
  const contracts = new Map([['BTC_USDT', { quantoMultiplier: 0.001 }]]);
  // 23:57 KST sync: only the early row exists yet (the late fill comes after).
  const lateFillAt = lateFill;
  runner.fetchImpl = gateHistoryFetch((path, query) => {
    if (query.type === 'dnw' || !path.endsWith('/account_book')) return [];
    return [{ id: 'early', type: 'pnl', change: '10', time: Number(query.from) + 60, contract: 'BTC_USDT' }]
      .filter((row) => row.time < lateFillAt);
  }).fetchImpl;
  await runner.syncMemberPerformance(member, contracts, beforeMidnight.toISOString());
  assert.equal(upserts.at(-1).p_trading_date, '2026-10-20');
  assert.equal(upserts.at(-1).p_realised_pnl, 10);
  // 00:03 KST: the previous day is completed with the late fill, then the new day is written.
  runner.fetchImpl = fetchImpl;
  runner.performanceSyncedAt.clear();
  await runner.syncMemberPerformance({ ...member, total: 1005, day_start_equity: 1005 }, contracts, afterMidnight.toISOString());
  const previous = upserts.find((row, index) => index > 0 && row.p_trading_date === '2026-10-20');
  assert.ok(previous, 'previous KST day re-aggregated');
  assert.equal(previous.p_realised_pnl, 15);
  assert.equal(previous.p_opening_equity, 990, 'the previous day keeps the equity recorded for it');
  assert.equal(previous.p_closing_equity, 1000);
  assert.equal(upserts.at(-1).p_trading_date, '2026-10-21');
  // Only once.
  runner.performanceSyncedAt.clear();
  const count = upserts.length;
  await runner.syncMemberPerformance({ ...member, total: 1005, day_start_equity: 1005 }, contracts, afterMidnight.toISOString());
  assert.equal(upserts.length, count + 1);
  assert.equal(upserts.at(-1).p_trading_date, '2026-10-21');
});

// --- 7. size residue ------------------------------------------------------------------------------------------

test('7: derived fill sizes are rounded at the source and ledger comparisons tolerate binary residue', () => {
  assert.equal(0.3 - 0.1, 0.19999999999999998);
  const order = { id: '1', size: '0.3', left: '0.1', status: 'finished', finish_as: 'ioc' };
  assert.equal(summarizeGateOrder(order).filledSize, 0.2);
  assert.equal(summarizeGateOrder({ ...order, size: '-0.3', left: '-0.1' }, [], { sizeStep: 0.1 }).filledSize, -0.2);
  assert.equal(roundOrderSize(0.30000000000000004, 0.01), 0.3);
  assert.equal(sameSize(0.2, 0.19999999999999998), true);
  assert.equal(sameSize(0.2, 0.21), false);
  // A ledger sum with residue no longer reads as an unexplained member change (MEMBER_POSITION_RECONCILING).
  const contracts = new Map([['ETH_USDT', { quantoMultiplier: 0.01, sizeStep: 0.1, orderSizeMin: 0.1, orderSizeMax: 0,
    marketOrderSizeMax: 0, inDelisting: false, takerFeeRate: 0.0005 }]]);
  const leg = (size) => ({ contract: 'ETH_USDT', size, markPrice: 2_000, leverage: 10, posMarginMode: 'cross', positionSide: 'LONG' });
  const [planned] = planMemberPositions({ cycleId: 'c', system: { emergency_halted: false }, contracts,
    master: { total: 10_000, positions: [leg(0.4)] },
    member: { user_id: 'u', total: 5_000, available: 5_000, copy_ratio: 100, max_position_ratio: 100, resume_version: 'r1',
      positions: [leg(0.2)], previous_states: [{ contract: 'ETH_USDT', position_side: 'LONG', actual_size: 0.2, state: 'SYNCED' }],
      ledger_positions: [{ contract: 'ETH_USDT', position_side: 'LONG', size: 0.3 - 0.1 }],
      target_anchors: [{ contract: 'ETH_USDT', position_side: 'LONG', resume_version: 'r1', master_copyable_size: 0.4, target_size: 0.2 }] } });
  assert.notEqual(planned.pause_reason, 'MEMBER_POSITION_RECONCILING');
  assert.equal(planned.state, 'SYNCED');
});

// --- 8. shutdown -------------------------------------------------------------------------------------------------

test('8: shutdown waits for the in-flight trading step, and gives up after the wait bound', async () => {
  const state = { trading: true, stopping: false };
  const exits = [];
  const stop = createShutdown({ state, exit: (code) => exits.push(code), waitMs: 2_000, pollMs: 5 });
  const done = stop('SIGTERM');
  assert.equal(state.stopping, true);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(exits, [], 'not while an order step is running');
  state.trading = false;
  await done;
  assert.deepEqual(exits, [0]);
  const stuck = { trading: true, stopping: false };
  const stuckExits = [];
  const startedAt = Date.now();
  await createShutdown({ state: stuck, exit: (code) => stuckExits.push(code), waitMs: 40, pollMs: 5 })('SIGTERM');
  assert.deepEqual(stuckExits, [0]);
  assert.ok(Date.now() - startedAt >= 35);
  const source = readFileSync(new URL('./index.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /process\.exit\(0\), 1_000/);
  assert.match(source, /createShutdown\(\{ state, log \}\)/);
});

// --- 9. execution_reason -----------------------------------------------------------------------------------------

test('9: BELOW_MINIMUM_ORDER_SIZE labels only a leg that would have submitted', () => {
  const contracts = new Map([['BTC_USDT', { quantoMultiplier: 0.001, sizeStep: 1, orderSizeMin: 5, orderSizeMax: 0,
    marketOrderSizeMax: 0, inDelisting: false, takerFeeRate: 0.0005 }]]);
  const plan = (masterSize, actual) => planMemberPositions({ cycleId: 'c', system: { emergency_halted: false }, contracts,
    master: { total: 10_000, positions: [{ contract: 'BTC_USDT', size: masterSize, markPrice: 50_000, leverage: 10, positionSide: 'LONG' }] },
    member: { user_id: 'u', total: 5_000, available: 5_000, copy_ratio: 100, max_position_ratio: 100, resume_version: 'r1',
      positions: actual ? [{ contract: 'BTC_USDT', size: actual, markPrice: 50_000, leverage: 10, positionSide: 'LONG' }] : [],
      previous_states: [{ contract: 'BTC_USDT', position_side: 'LONG', actual_size: actual, state: 'SYNCED' }],
      target_anchors: [] } })[0];
  const synced = plan(20, 10);
  assert.equal(synced.state, 'SYNCED');
  assert.equal(synced.execution_reason, 'SYNCED');
  const small = plan(26, 10); // target 13: delta 3 < minimum 5
  assert.equal(small.intent, undefined);
  assert.equal(small.execution_reason, 'BELOW_MINIMUM_ORDER_SIZE');
});

// --- 10. no credentials in the cycle payload ----------------------------------------------------------------------

test('10: the verified cycle payload carries no decrypted credentials', async () => {
  let recorded = null;
  const runner = new TradingRunner({ supabase: {}, baseUrl: 'https://api.gateio.ws', mode: 'DRY_RUN', channelId: 'maetajak' });
  runner.rpc = async (name, parameters = {}) => {
    if (name === 'get_copy_worker_context') return { system: { emergency_halted: true },
      master: { trading_account_id: 'master-1', api_key: 'master-private-key', secret_key: 'master-private-secret' },
      members: [{ trading_account_id: 'member-account-1', user_id: 'member-1', api_key: 'member-private-key',
        secret_key: 'member-private-secret', copy_ratio: 100, max_position_ratio: 30 }] };
    if (name === 'get_copy_resume_context') return [{ trading_account_id: 'member-account-1', state: 'ACTIVE', version: 'v1',
      baseline_version: 'v1', positions: [], member_positions: [] }];
    if (['get_copy_order_observation_guards', 'get_copy_target_anchors'].includes(name)) return [];
    if (name === 'record_verified_copy_worker_cycle') { recorded = parameters.p_payload; return 'cycle-1'; }
    if (name === 'confirm_copy_order_observation') return 0;
    throw new Error(`unexpected rpc: ${name}`);
  };
  runner.loadContracts = async () => new Map([['BTC_USDT', { quantoMultiplier: 0.001, sizeStep: 1, orderSizeMin: 1 }]]);
  runner.readAccount = async (account) => observedAccount({ ...account, total: 10_000, available: 9_000, positions: [] });
  await runner.syncOnce();
  const text = JSON.stringify(recorded);
  assert.ok(recorded.members.length === 1);
  for (const secret of ['master-private-key', 'master-private-secret', 'member-private-key', 'member-private-secret']) {
    assert.equal(text.includes(secret), false, secret);
  }
  assert.equal(runner.latestPerformanceMembers[0].api_key, 'member-private-key', 'the performance sync still has its keys');
  assert.deepEqual(withoutCredentials({ a: 1, api_key: 'x', secret_key: 'y' }), { a: 1 });
});

// --- 11. ACCEPTED anchors, legacy lock text, mojibake --------------------------------------------------------------

test('11: MEMBER_REDUCED_COPY_ACCEPTED sends one INFO alert per anchor; the legacy lock alert says it is legacy', async () => {
  const alerts = [];
  const runner = new TradingRunner({ supabase: {}, mode: 'LIVE', onSafetyEvent: async (alert) => { alerts.push(alert); return { sent: true }; } });
  const sessions = new Map([['a1', { state: 'ACTIVE', version: 'v1' }]]);
  const members = [{ trading_account_id: 'a1', user_id: 'u1', nickname: '테스트 회원' }];
  const accepted = { trading_account_id: 'a1', contract: 'BTC_USDT', position_side: 'LONG', resume_version: 'v1',
    target_size: 5, lock_reason: 'MEMBER_REDUCED_COPY_ACCEPTED', observed_at: 't1' };
  runner.alertCopyReducedByMember([accepted], sessions, members);
  runner.alertCopyReducedByMember([{ ...accepted, observed_at: 't2' }], sessions, members);
  await flush();
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].event, 'MEMBER_REDUCED_COPY_ACCEPTED');
  assert.equal(alerts[0].severity, 'INFO');
  assert.equal(alerts[0].details.member, '테스트 회원');
  runner.alertCopyReducedByMember([{ ...accepted, target_size: 3 }], sessions, members); // a further sale
  runner.alertCopyReducedByMember([{ ...accepted, lock_reason: 'MEMBER_REDUCED_COPY_POSITION' }], sessions, members);
  await flush();
  assert.deepEqual(alerts.map((a) => [a.event, a.severity]), [['MEMBER_REDUCED_COPY_ACCEPTED', 'INFO'],
    ['MEMBER_REDUCED_COPY_ACCEPTED', 'INFO'], ['MEMBER_REDUCED_COPY_POSITION', 'WARNING']]);
  assert.match(alerts[2].details.action, /이전 방식 잠금/);
  let body;
  await sendWorkerAlert({ telegramBotToken: '123456:abcdefghijklmnopqrstuvwxyz', telegramChatId: '-100123', ...alerts[0],
    fetchImpl: async (url, options) => { body = JSON.parse(options.body); return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } })); } });
  assert.match(body.text, /회원이 카피분까지 매도/);
  assert.match(body.text, /상태: 카피 계속 \(판 수량 재매수 안 함\)/);
  await sendWorkerAlert({ telegramBotToken: '123456:abcdefghijklmnopqrstuvwxyz', telegramChatId: '-100123', ...alerts[2],
    fetchImpl: async (url, options) => { body = JSON.parse(options.body); return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } })); } });
  assert.match(body.text, /이전 방식 잠금/);
  const source = readFileSync(new URL('./trading-runner.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /[\u0080-¦¨-¶¸-ÿ]/, 'no Latin-1 mojibake left');
  assert.match(source, /회원 계정을 양방향 모드로 전환해야 합니다\./);
});

// --- 12. persistent credential failures ----------------------------------------------------------------------------

test('12: a member read failing with a credential error alerts after 5 minutes, every 6 hours, and once on recovery', async () => {
  const alerts = [];
  const runner = new TradingRunner({ supabase: {}, mode: 'LIVE', onSafetyEvent: async (alert) => { alerts.push(alert); return { sent: true }; } });
  const account = { trading_account_id: 'a1', user_id: 'u1', nickname: '테스트 회원' };
  const invalid = new GateApiError('API Key 또는 Secret Key가 올바르지 않습니다.', { code: 'INVALID_CREDENTIALS', status: 401 });
  const t0 = 1_000_000;
  runner.trackMemberCredentialRead(account, invalid, t0);
  runner.trackMemberCredentialRead(account, new GateApiError('timeout', { code: 'GATE_TIMEOUT' }), t0 + 60_000);
  runner.trackMemberCredentialRead(account, invalid, t0 + CREDENTIAL_ALERT_AFTER_MS - 1);
  await flush();
  assert.equal(alerts.length, 0);
  runner.trackMemberCredentialRead(account, invalid, t0 + CREDENTIAL_ALERT_AFTER_MS);
  runner.trackMemberCredentialRead(account, invalid, t0 + CREDENTIAL_ALERT_AFTER_MS + 60_000);
  await flush();
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].event, 'MEMBER_API_CREDENTIAL_FAILING');
  assert.equal(alerts[0].details.error_code, 'INVALID_CREDENTIALS');
  assert.equal(alerts[0].details.failing_minutes, 5);
  runner.trackMemberCredentialRead(account, invalid, t0 + CREDENTIAL_ALERT_AFTER_MS + CREDENTIAL_ALERT_REPEAT_MS - 1);
  runner.trackMemberCredentialRead(account, invalid, t0 + CREDENTIAL_ALERT_AFTER_MS + CREDENTIAL_ALERT_REPEAT_MS);
  await flush();
  assert.equal(alerts.length, 2);
  runner.trackMemberCredentialRead(account, null, t0 + CREDENTIAL_ALERT_REPEAT_MS * 2);
  runner.trackMemberCredentialRead(account, null, t0 + CREDENTIAL_ALERT_REPEAT_MS * 2 + 5_000);
  await flush();
  assert.deepEqual(alerts.map((a) => a.event), ['MEMBER_API_CREDENTIAL_FAILING', 'MEMBER_API_CREDENTIAL_FAILING',
    'MEMBER_API_CREDENTIAL_RECOVERED']);
  // A short credential blip that never alerted clears silently; a non-credential failure never starts a streak.
  runner.trackMemberCredentialRead(account, invalid, t0);
  runner.trackMemberCredentialRead(account, null, t0 + 1_000);
  runner.trackMemberCredentialRead({ trading_account_id: 'a2' }, new GateApiError('x', { code: 'GATE_TIMEOUT' }), t0);
  runner.trackMemberCredentialRead({ trading_account_id: 'a2' }, new GateApiError('x', { code: 'GATE_TIMEOUT' }), t0 + CREDENTIAL_ALERT_REPEAT_MS);
  await flush();
  assert.equal(alerts.length, 3);
});

test('12: an undelivered credential alert is retried after 5 minutes, not after 6 hours', async () => {
  let deliver = false;
  const alerts = [];
  const runner = new TradingRunner({ supabase: {}, mode: 'LIVE', onSafetyEvent: async (alert) => { alerts.push(alert); return { sent: deliver }; } });
  const account = { trading_account_id: 'a1' };
  const error = new GateApiError('x', { code: 'FUTURES_READ_REQUIRED', status: 403 });
  runner.trackMemberCredentialRead(account, error, 0);
  runner.trackMemberCredentialRead(account, error, CREDENTIAL_ALERT_AFTER_MS);
  await flush();
  deliver = true;
  runner.trackMemberCredentialRead(account, error, CREDENTIAL_ALERT_AFTER_MS + 299_000);
  runner.trackMemberCredentialRead(account, error, CREDENTIAL_ALERT_AFTER_MS + 300_000);
  await flush();
  assert.equal(alerts.length, 2);
});

// --- 13. Gate label as the error code of an unfilled order -----------------------------------------------------------

test('13: an accepted order that finished unfilled stores the Gate finish label as its error code', async () => {
  const body = JSON.stringify({ id: 'order-9', contract: 'BTC_USDT', text: baseJob.gate_order_text, size: 20, left: 20,
    status: 'finished', finish_as: 'price_rate_protected' });
  const fixture = submitRunner({ orderBody: body });
  await fixture.runner.submitOrders();
  assert.equal(fixture.completions[0].p_result_status, 'REJECTED');
  assert.equal(fixture.completions[0].p_gate_label, 'price_rate_protected');
  assert.equal(fixture.completions[0].p_error_code, 'GATE_PRICE_RATE_PROTECTED');
  assert.equal(unfilledFinishCode({ terminal: true, filledSize: 5, finalStatus: 'PARTIALLY_FILLED', finishAs: 'ioc' }), null);
  assert.equal(unfilledFinishCode({ terminal: true, filledSize: 0, finalStatus: 'CANCELLED', finishAs: 'cancelled' }), 'GATE_CANCELLED');
  // An order/price label that merely contains the letters "IP" is not an IP-whitelist failure.
  assert.equal(mapGateError(400, { label: 'ORDER_SLIPPAGE_TOO_LARGE' }).code, 'GATE_ORDER_SLIPPAGE_TOO_LARGE');
  assert.equal(mapGateError(400, { label: 'MULTIPLE_ORDERS' }).code, 'GATE_MULTIPLE_ORDERS');
  assert.equal(mapGateError(403, { label: 'IP_FORBIDDEN' }).code, 'IP_NOT_ALLOWED');
  assert.equal(mapGateError(403, { label: 'FORBIDDEN_IP' }).code, 'IP_NOT_ALLOWED');
});

// --- 14. deploy health check + broker pagination bound ---------------------------------------------------------------

test('14: auto-deploy treats a dead copy-worker container as inactive although the oneshot unit stays active', () => {
  const script = readFileSync(new URL('../deploy/lightsail-auto-deploy.sh', import.meta.url), 'utf8');
  execFileSync('bash', ['-n', 'deploy/lightsail-auto-deploy.sh']);
  assert.match(readFileSync(new URL('../deploy/maetajak-worker.service', import.meta.url), 'utf8'), /Type=oneshot\nRemainAfterExit=yes/);
  const start = script.indexOf('worker_container_running() {');
  const functions = script.slice(start, script.indexOf('\n}\n', script.indexOf('worker_healthy() {', start)) + 3);
  mkdirSync(PROBE_ROOT, { recursive: true });
  const dir = mkdtempSync(join(PROBE_ROOT, 'auto-deploy-'));
  try {
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'systemctl'), '#!/usr/bin/env bash\necho "${UNIT_STATE}"\n[[ "${UNIT_STATE}" == active ]]\n');
    writeFileSync(join(bin, 'docker'), `#!/usr/bin/env bash
if [[ "$1" == compose ]]; then [[ -n "\${CONTAINER_ID}" ]] && echo "\${CONTAINER_ID}"; exit 0; fi
if [[ "$1" == inspect ]]; then echo "\${CONTAINER_STATE}"; exit 0; fi
exit 1
`);
    chmodSync(join(bin, 'systemctl'), 0o755);
    chmodSync(join(bin, 'docker'), 0o755);
    const healthy = (env) => spawnSync('bash', ['-c', `ENV_FILE=/dev/null\n${functions}\nworker_healthy`],
      { env: { PATH: `${bin}:${process.env.PATH}`, ...env } }).status === 0;
    assert.equal(healthy({ UNIT_STATE: 'active', CONTAINER_ID: 'abc', CONTAINER_STATE: 'running none' }), true);
    assert.equal(healthy({ UNIT_STATE: 'active', CONTAINER_ID: 'abc', CONTAINER_STATE: 'running healthy' }), true);
    assert.equal(healthy({ UNIT_STATE: 'active', CONTAINER_ID: '', CONTAINER_STATE: '' }), false, 'container gone');
    assert.equal(healthy({ UNIT_STATE: 'active', CONTAINER_ID: 'abc', CONTAINER_STATE: 'exited none' }), false);
    assert.equal(healthy({ UNIT_STATE: 'active', CONTAINER_ID: 'abc', CONTAINER_STATE: 'restarting none' }), false);
    assert.equal(healthy({ UNIT_STATE: 'active', CONTAINER_ID: 'abc', CONTAINER_STATE: 'running unhealthy' }), false);
    assert.equal(healthy({ UNIT_STATE: 'inactive', CONTAINER_ID: 'abc', CONTAINER_STATE: 'running none' }), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
  // The recovery branch uses the container-aware check (twice), and LIVE detection matches the worker's normalisation.
  assert.match(script, /if ! worker_healthy && \{ sleep "\$\{HEALTH_RECHECK_SECONDS\}"; ! worker_healthy; \}; then/);
  assert.match(script, /grep -Eiq/);
});

test('14: broker history pagination is bounded', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return new Response(JSON.stringify(Array.from({ length: 100 }, () => ({ user_id: '1' })))); };
  await assert.rejects(getBrokerCommissionHistory({ apiKey: 'k', secretKey: 's', from: 1, to: 2, fetchImpl, maxPages: 4 }),
    (error) => error.code === 'BROKER_HISTORY_PAGINATION_LIMIT');
  assert.equal(calls, 4);
});

test('review 10-20: admin API disconnect cancellations are never-sent; risk/margin rejections still alert', async () => {
  const { intentNeverSentToGate } = await import('./trading-runner.js');
  assert.equal(intentNeverSentToGate({ result_status: 'CANCELLED', filled_size: 0, error_code: 'MEMBER_API_DISCONNECTED_BY_ADMIN' }), true);
  assert.equal(intentNeverSentToGate({ result_status: 'REJECTED', filled_size: 0, error_code: 'WORKER_MEMBER_RISK_LIMIT' }), false);
  assert.equal(intentNeverSentToGate({ result_status: 'REJECTED', filled_size: 0, error_code: 'WORKER_INSUFFICIENT_AVAILABLE_MARGIN' }), false);
  assert.equal(intentNeverSentToGate({ result_status: 'REJECTED', filled_size: 0, error_code: 'WORKER_MASTER_POSITION_CHANGED_BEFORE_SUBM' }), true);
});

test('review 10-20: a stop request ends the submit batch before any further POST', async () => {
  const { TradingRunner } = await import('./trading-runner.js');
  const runner = new TradingRunner({ supabase: {}, mode: 'LIVE' });
  runner.stopRequested = () => true;
  runner.rpc = async (name) => { if (name === 'claim_copy_order_intents') return [{ intent_id: 'a', resume_version: 'v' }]; throw new Error(`unexpected ${name}`); };
  assert.equal(await runner.submitOrders(5), 0);
});

test('10-21: plans cancelled by a member withdrawal are never-sent (no failure alert)', async () => {
  const { intentNeverSentToGate } = await import('./trading-runner.js');
  assert.equal(intentNeverSentToGate({ result_status: 'CANCELLED', filled_size: 0, error_code: 'MEMBER_WITHDRAWN' }), true);
});
