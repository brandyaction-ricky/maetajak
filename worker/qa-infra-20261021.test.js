// QA 2026-10-21 area C fixes (fix/qa-infra), worker half: C-2 alert, C-4 read-failure alert, C-5 reconcile budget and
// claim-stall warning, C-6 liquidation/ADL detection, A5 Broker UID without a default.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { GateApiError, getFuturesForcedCloses } from './gate.js';
import {
  CLAIM_STALL_ALERT_CYCLES, CLAIM_STALL_ALERT_REPEAT_MS, CREDENTIAL_ALERT_AFTER_MS, CREDENTIAL_ALERT_REPEAT_MS,
  RECONCILE_BEFORE_SUBMIT_BUDGET_MS, TradingRunner,
} from './trading-runner.js';
import { sendWorkerAlert } from './alerts.js';
import { resolveBrokerCredentials } from './broker-metrics.js';

const flush = () => new Promise((resolve) => setImmediate(resolve));
const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
function makeRunner(options = {}) {
  const events = [];
  const runner = new TradingRunner({ supabase: {}, baseUrl: 'https://api.gateio.ws', mode: 'LIVE',
    onSafetyEvent: async (event) => { events.push(event); return { sent: true }; }, ...options });
  return { runner, events };
}
async function telegramText(alert) {
  let body;
  await sendWorkerAlert({ telegramBotToken: '123456:abcdefghijklmnopqrstuvwxyz', telegramChatId: '-100123', ...alert,
    fetchImpl: async (url, options) => { body = JSON.parse(options.body); return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } })); } });
  return body.text;
}

// ---- C-4 ------------------------------------------------------------------------------------------------------
test('C-4: a non-credential read failure alerts after 5 min, repeats every 6 h, and recovers once', async () => {
  const { runner, events } = makeRunner();
  const account = { trading_account_id: 'a1', user_id: 'u1', nickname: '회원A' };
  const t0 = 1_000_000;
  const fail = (at, code = 'GATE_TIMEOUT') => runner.trackMemberCredentialRead(account, new GateApiError('x', { code }), at);
  fail(t0); fail(t0 + CREDENTIAL_ALERT_AFTER_MS - 1);
  await flush();
  assert.equal(events.length, 0);
  fail(t0 + CREDENTIAL_ALERT_AFTER_MS);
  fail(t0 + CREDENTIAL_ALERT_AFTER_MS + 60_000);
  await flush();
  assert.deepEqual(events.map((e) => [e.event, e.severity, e.details.error_code, e.details.failing_minutes]),
    [['MEMBER_ACCOUNT_READ_FAILING', 'WARNING', 'GATE_TIMEOUT', 5]]);
  assert.equal(events[0].details.member, '회원A');
  // A credential failure in between neither restarts nor clears the generic streak.
  runner.trackMemberCredentialRead(account, new GateApiError('x', { code: 'INVALID_CREDENTIALS' }), t0 + 600_000);
  fail(t0 + CREDENTIAL_ALERT_AFTER_MS + CREDENTIAL_ALERT_REPEAT_MS, 'POSITIONS_INCONSISTENT');
  await flush();
  assert.equal(events.length, 2);
  assert.equal(events[1].details.error_code, 'POSITIONS_INCONSISTENT');
  runner.trackMemberCredentialRead(account, null, t0 + CREDENTIAL_ALERT_AFTER_MS + CREDENTIAL_ALERT_REPEAT_MS + 1);
  await flush();
  assert.deepEqual(events.slice(2).map((e) => e.event), ['MEMBER_ACCOUNT_READ_RECOVERED'],
    'one recovery (the credential streak never alerted)');
  assert.equal(runner.memberReadFailures.size, 0);
  assert.equal(runner.credentialFailures.size, 0);
});

test('C-4: credential codes keep their own alert; a non-Gate error counts as UNKNOWN', async () => {
  const { runner, events } = makeRunner();
  const account = { trading_account_id: 'a1', user_id: 'u1' };
  runner.trackMemberCredentialRead(account, new GateApiError('x', { code: 'IP_NOT_ALLOWED' }), 0);
  runner.trackMemberCredentialRead(account, new GateApiError('x', { code: 'IP_NOT_ALLOWED' }), CREDENTIAL_ALERT_AFTER_MS);
  const other = { trading_account_id: 'a2', user_id: 'u2' };
  runner.trackMemberCredentialRead(other, new TypeError('boom'), 0);
  runner.trackMemberCredentialRead(other, new TypeError('boom'), CREDENTIAL_ALERT_AFTER_MS);
  await flush();
  assert.deepEqual(events.map((e) => [e.event, e.details.error_code]),
    [['MEMBER_API_CREDENTIAL_FAILING', 'IP_NOT_ALLOWED'], ['MEMBER_ACCOUNT_READ_FAILING', 'UNKNOWN']]);
  assert.equal(runner.memberReadFailures.has('a1'), false);
});

test('C-4: the Telegram text carries Korean guidance per error code', async () => {
  for (const [code, pattern] of [['GATE_TIMEOUT', /응답이 계속 늦습니다/], ['GATE_API_ERROR', /요청 한도 초과\(429\)/],
    ['SPLIT_POSITION_UNSUPPORTED', /분할 포지션/], ['OPEN_ORDERS_LIMIT_REACHED', /미체결 주문이 100건/],
    ['POSITIONS_INCONSISTENT', /서로 다릅니다/], ['INVALID_ACCOUNT_EQUITY', /잔고를 확인할 수 없습니다/], ['SOMETHING_ELSE', /아래 오류 원인을 확인/]]) {
    const text = await telegramText({ event: 'MEMBER_ACCOUNT_READ_FAILING', severity: 'WARNING',
      details: { member: '회원A', error_code: code, failing_minutes: 5 } });
    assert.match(text, /회원 계정 조회 실패 지속/);
    assert.match(text, pattern, code);
  }
  assert.match(await telegramText({ event: 'MEMBER_ACCOUNT_READ_RECOVERED', severity: 'INFO', details: {} }), /회원 계정 조회 복구/);
});

// ---- C-5 ------------------------------------------------------------------------------------------------------
test('C-5: reconciliation stops at its budget before the claim and finishes the batch after submitting', async () => {
  const { runner } = makeRunner();
  const order = [];
  runner.rpc = async (name) => { order.push(name); return name === 'claim_copy_reconciliation_jobs' ? [{ job_id: 1 }, { job_id: 2 }, { job_id: 3 }] : []; };
  runner.reconcileJob = async (job) => { order.push(`job${job.job_id}`); await new Promise((resolve) => setTimeout(resolve, 15)); };
  assert.equal(await runner.reconcileOrders(10, { budgetMs: 10 }), 1, 'at least one job, then the budget is spent');
  assert.deepEqual(runner.deferredReconciliations.map((job) => job.job_id), [2, 3]);
  assert.equal(await runner.reconcileDeferredOrders(), 2);
  assert.deepEqual(order, ['claim_copy_reconciliation_jobs', 'job1', 'job2', 'job3']);
  assert.equal(await runner.reconcileDeferredOrders(), 0);
  order.length = 0;
  assert.equal(await runner.reconcileOrders(), 3, 'without a budget (tests, scripts) the whole batch runs as before');
  assert.equal(RECONCILE_BEFORE_SUBMIT_BUDGET_MS, 5_000);
  const worker = read('./index.js');
  const reconcile = worker.indexOf('await runner.reconcileOrders(10, { budgetMs: RECONCILE_BEFORE_SUBMIT_BUDGET_MS })');
  const submit = worker.indexOf('await runner.submitOrders()');
  const deferred = worker.indexOf('await runner.reconcileDeferredOrders()');
  assert.ok(reconcile > 0 && submit > reconcile && deferred > submit);
});

test('C-5: executable plans that are never claimed warn after N cycles, repeat after 30 min, reset on a claim', async () => {
  const { runner, events } = makeRunner();
  const member = { trading_account_id: 'a1', user_id: 'u1', nickname: '회원A' };
  const cycle = (jobs, at, plans = new Map([['a1', { count: 2, member }]])) => { runner.pendingClaimPlans = plans; runner.trackClaimStall(jobs, at); };
  for (let i = 1; i < CLAIM_STALL_ALERT_CYCLES; i++) cycle([], i);
  await flush();
  assert.equal(events.length, 0);
  cycle([], 100);
  cycle([], 101);
  await flush();
  assert.deepEqual(events.map((e) => [e.event, e.severity, e.details.stalled_cycles, e.details.planned_intents, e.details.member]),
    [['COPY_ORDER_CLAIM_STALLED', 'WARNING', CLAIM_STALL_ALERT_CYCLES, 2, '회원A']]);
  cycle([], 100 + CLAIM_STALL_ALERT_REPEAT_MS);
  await flush();
  assert.equal(events.length, 2);
  cycle([{ trading_account_id: 'a1' }], 200 + CLAIM_STALL_ALERT_REPEAT_MS);
  assert.equal(runner.claimStalls.size, 0, 'a claim clears the streak');
  for (let i = 0; i < CLAIM_STALL_ALERT_CYCLES - 1; i++) cycle([], i);
  runner.pendingClaimPlans = null; runner.trackClaimStall([], 0); // halted / not LIVE: not a stall
  assert.equal(runner.claimStalls.size, 0);
  for (let i = 0; i < CLAIM_STALL_ALERT_CYCLES - 1; i++) cycle([], i);
  cycle([], 50, new Map()); // no executable plan this cycle
  assert.equal(runner.claimStalls.size, 0);
  await flush();
  assert.equal(events.length, 2);
  assert.match(await telegramText(events[0]), /카피 주문 실행 지연[\s\S]*연속 미실행 회차: 6/);
});

test('C-5: syncOnce records executable plans only while LIVE execution is enabled; submitOrders consumes them', async () => {
  const contracts = new Map([['BTC_USDT', { quantoMultiplier: 0.001, sizeStep: 1, orderSizeMin: 1, orderSizeMax: 0,
    marketOrderSizeMax: 0, inDelisting: false, takerFeeRate: 0.0005 }]]);
  for (const [system, expectMap] of [[{ emergency_halted: false, execution_enabled: true }, true],
    [{ emergency_halted: true, execution_enabled: false }, false]]) {
    const { runner } = makeRunner();
    let claims = 0;
    runner.rpc = async (name, params = {}) => {
      switch (name) {
        case 'get_copy_worker_context': return { system, master: { trading_account_id: 'master' },
          members: [{ trading_account_id: 'acct', user_id: 'u', copy_ratio: 100, max_position_ratio: 50, previous_states: [] }] };
        case 'get_copy_resume_context': return [{ trading_account_id: 'acct', state: 'PAUSED', version: 'v1', baseline_version: 'v1',
          positions: [], member_positions: [], copy_positions: [], ownership_status: 'CONFIRMED', resume_authorized: true }];
        case 'record_verified_copy_worker_cycle': return params.p_payload.cycle_id;
        case 'claim_copy_order_intents': claims++; return [];
        default: return [];
      }
    };
    runner.loadContracts = async () => contracts;
    runner.readAccount = async (account) => { const now = new Date().toISOString();
      return { ...account, open_orders: [], observed_started_at: now, observed_at: now, total: 10_000, available: 9_000,
        unrealisedPnl: 0, positionMode: 'single', positions: [] }; };
    await runner.syncOnce();
    assert.equal(runner.pendingClaimPlans instanceof Map, expectMap);
    await runner.submitOrders();
    assert.equal(claims, 1);
    assert.equal(runner.pendingClaimPlans, null);
  }
});

// ---- C-6 ------------------------------------------------------------------------------------------------------
function forcedCloseFetch({ liquidates = [], deleverages = [], liquidatesStatus = 200, deleveragesStatus = 200 } = {}) {
  const requested = [];
  const fetchImpl = async (url) => {
    const { pathname, search } = new URL(url);
    requested.push(pathname + search);
    if (pathname.endsWith('/futures/usdt/liquidates')) return new Response(JSON.stringify(liquidates), { status: liquidatesStatus });
    if (pathname.endsWith('/futures/usdt/auto_deleverages')) return new Response(JSON.stringify(deleverages), { status: deleveragesStatus });
    throw new Error(`unexpected ${url}`);
  };
  return { fetchImpl, requested };
}

test('C-6: getFuturesForcedCloses reads liquidation and ADL history for one contract inside the window', async () => {
  const now = 1_790_000_000;
  const { fetchImpl, requested } = forcedCloseFetch({
    liquidates: [{ time: now - 60, contract: 'BTC_USDT', size: 30 }, { time: now - 7200, contract: 'BTC_USDT', size: 5 },
      { time: now - 30, contract: 'ETH_USDT', size: 3 }],
    deleverages: [{ time: (now - 10) * 1_000, contract: 'BTC_USDT', position_size: -4, trade_size: 4 }],
  });
  const rows = await getFuturesForcedCloses({ apiKey: 'k', secretKey: 's', fetchImpl, contract: 'BTC_USDT', fromSeconds: now - 1800 });
  assert.deepEqual(rows, [{ type: 'AUTO_DELEVERAGE', contract: 'BTC_USDT', time: now - 10, size: -4 },
    { type: 'LIQUIDATION', contract: 'BTC_USDT', time: now - 60, size: 30 }]);
  assert.deepEqual(requested.sort(), ['/api/v4/futures/usdt/auto_deleverages?contract=BTC_USDT&limit=100',
    '/api/v4/futures/usdt/liquidates?contract=BTC_USDT&limit=100']);
  // One endpoint failing still returns the other's rows; both failing throws.
  const partial = forcedCloseFetch({ liquidates: [{ time: now, contract: 'BTC_USDT', size: 1 }], deleveragesStatus: 404 });
  assert.equal((await getFuturesForcedCloses({ apiKey: 'k', secretKey: 's', fetchImpl: partial.fetchImpl, contract: 'BTC_USDT' })).length, 1);
  const broken = forcedCloseFetch({ liquidatesStatus: 500, deleveragesStatus: 500 });
  await assert.rejects(getFuturesForcedCloses({ apiKey: 'k', secretKey: 's', fetchImpl: broken.fetchImpl, contract: 'BTC_USDT' }), GateApiError);
});

test('C-6: a COPY reduction caused by a liquidation/ADL sends a distinct WARNING instead of the INFO notice', async () => {
  const now = Date.now();
  const anchor = { trading_account_id: 'a1', contract: 'BTC_USDT', position_side: 'LONG', resume_version: 'v1',
    target_size: 0, lock_reason: 'MEMBER_REDUCED_COPY_ACCEPTED', observed_at: 't1' };
  const sessions = new Map([['a1', { state: 'ACTIVE', version: 'v1' }]]);
  const members = [{ trading_account_id: 'a1', user_id: 'u1', nickname: '회원A', api_key: 'k', secret_key: 's' }];
  const cases = [
    [{ liquidates: [{ time: Math.floor(now / 1000) - 20, contract: 'BTC_USDT', size: 30 }] }, 'MEMBER_LIQUIDATION_DETECTED', 'WARNING'],
    [{ deleverages: [{ time: Math.floor(now / 1000) - 20, contract: 'BTC_USDT', position_size: 12 }] }, 'MEMBER_LIQUIDATION_DETECTED', 'WARNING'],
    [{ liquidates: [{ time: Math.floor(now / 1000) - 20, contract: 'BTC_USDT', size: -30 }] }, 'MEMBER_REDUCED_COPY_ACCEPTED', 'INFO'],
    [{}, 'MEMBER_REDUCED_COPY_ACCEPTED', 'INFO'],
    [{ liquidatesStatus: 500, deleveragesStatus: 500 }, 'MEMBER_REDUCED_COPY_ACCEPTED', 'INFO'],
  ];
  for (const [reply, event, severity] of cases) {
    const { fetchImpl } = forcedCloseFetch(reply);
    const { runner, events } = makeRunner({ fetchImpl });
    runner.alertCopyReducedByMember([anchor], sessions, members);
    for (let i = 0; i < 5; i++) await flush();
    assert.deepEqual(events.map((e) => [e.event, e.severity]), [[event, severity]], JSON.stringify(reply));
    if (event === 'MEMBER_LIQUIDATION_DETECTED') {
      assert.ok(['LIQUIDATION', 'AUTO_DELEVERAGE'].includes(events[0].details.liquidation_type));
      assert.equal(events[0].details.member, '회원A');
      assert.doesNotMatch(JSON.stringify(events[0]), /"k"|"s"/);
      const text = await telegramText(events[0]);
      assert.match(text, /⚠️ 매타작 · 강제청산\/ADL 감지/);
      assert.match(text, /청산 유형: (강제청산|자동 디레버리징 \(ADL\))/);
    }
  }
});

// ---- C-2 (worker half) ----------------------------------------------------------------------------------------
test('C-2: the worker alerts CRITICAL when its heartbeat reports a gap halt', async () => {
  const worker = read('./index.js');
  assert.match(worker, /const beat = await runner\.heartbeat\(false\);/);
  const gap = worker.slice(worker.indexOf('if (beat?.newly_halted)'), worker.indexOf("includes('WORKER_LEASE_HELD')"));
  assert.match(gap, /state\.haltAlertSent = true;[\s\S]*event: 'COPY_WORKER_GAP_AUTO_HALTED', severity: 'CRITICAL'/);
  const text = await telegramText({ event: 'COPY_WORKER_GAP_AUTO_HALTED', severity: 'CRITICAL',
    details: { gap_seconds: 240, reason: 'WORKER_HEARTBEAT_GAP', mode: 'LIVE' } });
  assert.match(text, /🚨 매타작 · 워커 공백 후 자동 중단/);
  assert.match(text, /관리자 화면에서 실거래를 다시 켜/);
  assert.match(text, /워커 공백 \(초\): 240/);
  assert.match(read('../src/main.js'), /WORKER_HEARTBEAT_GAP: '/);
});

// ---- A5 -------------------------------------------------------------------------------------------------------
test('A5: the Broker UID has no default; missing settings report NOT_CONFIGURED codes', () => {
  assert.deepEqual(resolveBrokerCredentials({}), { configured: false, errorCode: 'GATE_BROKER_UID_REQUIRED' });
  assert.deepEqual(resolveBrokerCredentials({ brokerUid: ' ', apiKey: 'k', secretKey: 's' }), { configured: false, errorCode: 'GATE_BROKER_UID_REQUIRED' });
  assert.deepEqual(resolveBrokerCredentials({ brokerUid: '123', apiKey: 'k', secretKey: 's' }),
    { configured: true, apiKey: 'k', secretKey: 's', source: 'BROKER_ENV' });
  assert.deepEqual(resolveBrokerCredentials({ brokerUid: '123' }), { configured: false, errorCode: 'BROKER_API_KEY_REQUIRED' });
  const master = { gate_uid: '49084031', api_key: 'mk', secret_key: 'ms' };
  assert.deepEqual(resolveBrokerCredentials({ brokerUid: '123', master }), { configured: false, errorCode: 'BROKER_API_KEY_REQUIRED' },
    'the Master key is never used for another UID');
  assert.deepEqual(resolveBrokerCredentials({ master }), { configured: false, errorCode: 'GATE_BROKER_UID_REQUIRED' },
    'an unset UID no longer matches the old Master UID');
  assert.equal(resolveBrokerCredentials({ brokerUid: '49084031', master }).source, 'MASTER_KEY');
  for (const path of ['./index.js', '../deploy/lightsail-configure.sh', '../deploy/lightsail-configure-broker.sh',
    '../docs/WORKER_DEPLOYMENT.md', '../.env.worker.example']) {
    assert.doesNotMatch(read(path), /49084031/, path);
  }
  assert.match(read('../.env.worker.example'), /^GATE_BROKER_UID=$/m);
});
