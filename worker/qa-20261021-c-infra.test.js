// QA 2026-10-21 area C (infrastructure / timing). C-1 asserts the fixed behaviour (fix/qa-sizing); C-4 probes existing behaviour.
import test from 'node:test';
import assert from 'node:assert/strict';
import { getFuturesPositions } from './gate.js';
import { TradingRunner as Runner } from './trading-runner.js';

const contracts = new Map([['BTC_USDT', { quantoMultiplier: 0.001, sizeStep: 1, orderSizeMin: 1, orderSizeMax: 0,
  marketOrderSizeMax: 0, inDelisting: false, takerFeeRate: 0.0005 }]]);

function gateFetch(routes) {
  const requested = [];
  const fetchImpl = async (url) => {
    const path = new URL(url).pathname + new URL(url).search;
    requested.push(path);
    for (const [pattern, reply] of routes) {
      if (pattern.test(path)) return new Response(reply.raw ?? JSON.stringify(reply.body), { status: reply.status ?? 200 });
    }
    throw new Error(`unexpected URL: ${url}`);
  };
  return { fetchImpl, requested };
}

// C-1: the list glitch the code documents ("Some unified accounts return an empty list here even with open
// positions") followed by a single-contract read. A 2xx without a position (empty/null body, a scalar) is
// UNCONFIRMED, never flat; 404/POSITION_NOT_FOUND or an empty list confirm flat, marked as resting only on the
// fallback of an empty list.
for (const [label, reply] of [['empty 200 body', { raw: '' }], ['200 null', { raw: 'null' }], ['200 scalar', { raw: '"ok"' }]]) {
  test(`C-1: Master list [] + single read ${label} => BTC_USDT unconfirmed, not flat`, async () => {
    const { fetchImpl, requested } = gateFetch([
      [/\/positions\?holding=true/, { body: [] }],
      [/\/my_trades\?/, { body: [] }],
      [/\/positions\/BTC_USDT$/, reply],
    ]);
    const positions = await getFuturesPositions({ apiKey: 'k', secretKey: 's', fetchImpl,
      expectedContracts: ['BTC_USDT'], expectedLegs: ['BTC_USDT:LONG'], tolerateUnconfirmed: true });
    assert.ok(requested.some((p) => p.endsWith('/positions/BTC_USDT')), 'anchored contract was re-read individually');
    assert.deepEqual(positions, []);
    assert.deepEqual(positions.unconfirmedContracts, ['BTC_USDT']);
    // A member/submission read (not tolerant) fails instead of reporting the leg flat.
    const strict = gateFetch([[/\/positions\?holding=true/, { body: [] }], [/\/my_trades\?/, { body: [] }], [/\/positions\/BTC_USDT$/, reply]]);
    await assert.rejects(getFuturesPositions({ apiKey: 'k', secretKey: 's', fetchImpl: strict.fetchImpl,
      expectedContracts: ['BTC_USDT'], expectedLegs: ['BTC_USDT:LONG'] }), { code: 'INVALID_POSITIONS_RESPONSE' });
  });
}

for (const [label, reply] of [['200 []', { body: [] }], ['404 POSITION_NOT_FOUND', { status: 404, body: { label: 'POSITION_NOT_FOUND' } }]]) {
  test(`C-1: Master list [] + single read ${label} => flat, marked as confirmed only by the empty-list fallback`, async () => {
    const { fetchImpl } = gateFetch([
      [/\/positions\?holding=true/, { body: [] }],
      [/\/my_trades\?/, { body: [] }],
      [/\/positions\/BTC_USDT$/, reply],
    ]);
    const positions = await getFuturesPositions({ apiKey: 'k', secretKey: 's', fetchImpl,
      expectedContracts: ['BTC_USDT'], expectedLegs: ['BTC_USDT:LONG'], tolerateUnconfirmed: true });
    assert.deepEqual(positions, []);
    assert.equal(positions.unconfirmedContracts, undefined);
    assert.deepEqual(positions.listEmptyFallbackContracts, ['BTC_USDT']);
  });
}

test('C-1: a healthy non-empty list that omits an expected contract is not marked as fallback-only', async () => {
  const eth = { contract: 'ETH_USDT', size: '5', mark_price: '4000', mode: 'single', leverage: '10' };
  const { fetchImpl } = gateFetch([
    [/\/positions\?holding=true/, { body: [eth] }],
    [/\/positions\/BTC_USDT$/, { status: 404, body: { label: 'POSITION_NOT_FOUND' } }],
  ]);
  const positions = await getFuturesPositions({ apiKey: 'k', secretKey: 's', fetchImpl,
    expectedContracts: ['BTC_USDT'], expectedLegs: ['BTC_USDT:LONG'], tolerateUnconfirmed: true });
  assert.deepEqual(positions.map((p) => p.contract), ['ETH_USDT']);
  assert.equal(positions.listEmptyFallbackContracts, undefined);
});

// C-1 (cont.): an anchored COPY leg whose Master leg vanished only through that fallback is closed on the second
// consecutive such read (as confirmBaselineClear does for FUTURE_ONLY baselines); a healthy list closes at once.
function fallbackRunner(masterRead) {
  const recorded = [];
  const runner = new Runner({ supabase: {}, baseUrl: 'https://api.gateio.ws', workerId: 'w', workerVersion: '0.5.0',
    publicIp: '192.0.2.1', channelId: 'maetajak', mode: 'LIVE' });
  runner.rpc = async (name, params = {}) => {
    switch (name) {
      case 'get_copy_worker_context': return { system: { emergency_halted: false, execution_enabled: true, max_order_slippage_ratio: 0.005 },
        master: { trading_account_id: 'master' },
        members: [{ trading_account_id: 'acct', user_id: 'u', copy_ratio: 100, max_position_ratio: 30, previous_states: [
          { contract: 'BTC_USDT', position_side: 'LONG', state: 'SYNCED', actual_size: 30 }] }] };
      case 'get_copy_order_observation_guards': return [];
      case 'get_copy_resume_context': return [{ trading_account_id: 'acct', state: 'ACTIVE', version: 'resume-1', baseline_version: 'resume-1',
        positions: [], member_positions: [], copy_positions: [], ownership_status: 'CONFIRMED', resume_authorized: true, unresolved_orders: 0 }];
      case 'get_copy_target_anchors': return [{ trading_account_id: 'acct', contract: 'BTC_USDT', position_side: 'LONG',
        resume_version: 'resume-1', master_copyable_size: 100, target_size: 30, protected_member_size: 0 }];
      case 'get_copy_fund_flow_totals': return [];
      case 'confirm_copy_order_observation': return null;
      case 'record_verified_copy_worker_cycle': recorded.push(params.p_payload); return params.p_payload.cycle_id;
      default: throw new Error(`unexpected rpc ${name}`);
    }
  };
  runner.loadContracts = async () => new Map([...contracts, ['ETH_USDT', { ...contracts.get('BTC_USDT'), quantoMultiplier: 0.01 }]]);
  runner.readAccount = async (account) => {
    const now = new Date().toISOString();
    const base = { ...account, open_orders: [], observed_started_at: now, observed_at: now, unrealisedPnl: 0, positionMode: 'single' };
    if (account.trading_account_id === 'master') return { ...base, total: 10_000, available: 9_000, ...masterRead() };
    return { ...base, total: 5_000, available: 5_000, positions: [{ contract: 'BTC_USDT', size: 30, markPrice: 50_000, positionSide: 'LONG' }],
      unconfirmed_contracts: [], list_empty_fallback_contracts: [] };
  };
  const leg = () => recorded.at(-1).members[0].planned_positions.find((p) => p.contract === 'BTC_USDT' && p.position_side === 'LONG');
  return { runner, leg };
}

test('C-1: a Master leg seen flat only through the empty-list fallback is closed on the second consecutive cycle', async () => {
  const { runner, leg } = fallbackRunner(() => ({ positions: [], unconfirmed_contracts: [], list_empty_fallback_contracts: ['BTC_USDT'] }));
  await runner.syncOnce();
  assert.equal(leg().intent, undefined, 'first sighting: no close order');
  assert.equal(leg().pause_reason, 'MASTER_POSITION_UNCONFIRMED');
  assert.equal(leg().anchor_update_allowed, false, 'the anchor does not move either');
  await runner.syncOnce();
  assert.equal(leg().target_size, 0);
  assert.equal(leg().intent?.delta_size, -30, 'confirmed on a second cycle: reduce-only close');
  assert.equal(leg().intent?.reduce_only, true);
  // Still flat in later consecutive cycles (here the anchor is never rewritten): it stays confirmed, no re-hold.
  await runner.syncOnce();
  assert.equal(leg().pause_reason, null);
  assert.equal(leg().intent?.delta_size, -30);
});

test('C-1: a single fallback-only flat read followed by the position again never closes the member', async () => {
  let reads = 0;
  const { runner, leg } = fallbackRunner(() => (reads++ === 0
    ? { positions: [], unconfirmed_contracts: [], list_empty_fallback_contracts: ['BTC_USDT'] }
    : { positions: [{ contract: 'BTC_USDT', size: 100, markPrice: 50_000, positionSide: 'LONG' }], unconfirmed_contracts: [], list_empty_fallback_contracts: [] }));
  await runner.syncOnce();
  assert.equal(leg().intent, undefined);
  await runner.syncOnce();
  assert.equal(leg().intent, undefined);
  assert.equal(leg().target_size, 30);
});

test('C-1: a Master leg absent from a healthy non-empty list closes the member in the same cycle (unchanged)', async () => {
  const { runner, leg } = fallbackRunner(() => ({ positions: [{ contract: 'ETH_USDT', size: 5, markPrice: 4_000, positionSide: 'LONG' }],
    unconfirmed_contracts: [], list_empty_fallback_contracts: [] }));
  await runner.syncOnce();
  assert.equal(leg().intent?.delta_size, -30);
});

// C-4: a member whose Gate reads keep failing with a NON-credential code (timeout/5xx/429, split position, >=100
// open orders, inconsistent positions, invalid equity) is skipped every cycle (error_code row only) while the cycle
// itself succeeds. FIXED 2026-10-21 (fix/qa-infra): such a streak now alerts MEMBER_ACCOUNT_READ_FAILING once it
// has lasted 5 minutes (the credential alert stays limited to the 4 credential codes).
import { TradingRunner } from './trading-runner.js';
import { GateApiError } from './gate.js';

for (const code of ['GATE_TIMEOUT', 'GATE_API_ERROR', 'SPLIT_POSITION_UNSUPPORTED', 'OPEN_ORDERS_LIMIT_REACHED', 'POSITIONS_INCONSISTENT', 'INVALID_ACCOUNT_EQUITY']) {
  test(`C-4 (fixed): persistent member read failure ${code} alerts after 5 minutes (cycle still succeeds)`, async () => {
    const events = [];
    const recorded = [];
    const runner = new TradingRunner({ supabase: {}, baseUrl: 'https://api.gateio.ws', workerId: 'w', workerVersion: '0.5.0',
      publicIp: '192.0.2.1', channelId: 'maetajak', mode: 'LIVE', onSafetyEvent: async (e) => { events.push(e); return { sent: true }; } });
    runner.rpc = async (name, params = {}) => {
      switch (name) {
        case 'get_copy_worker_context': return { system: { emergency_halted: false, execution_enabled: true },
          master: { trading_account_id: 'master' },
          members: [{ trading_account_id: 'acct', user_id: 'u', nickname: 'm1', copy_ratio: 100, max_position_ratio: 50, previous_states: [] }] };
        case 'get_copy_order_observation_guards': return [];
        case 'get_copy_resume_context': return [{ trading_account_id: 'acct', state: 'ACTIVE', version: 'v1', baseline_version: 'v1',
          positions: [], member_positions: [], copy_positions: [], ownership_status: 'CONFIRMED', resume_authorized: true, unresolved_orders: 0 }];
        case 'get_copy_target_anchors': return [];
        case 'get_copy_fund_flow_totals': return [];
        case 'record_verified_copy_worker_cycle': recorded.push(params.p_payload); return params.p_payload.cycle_id;
        default: throw new Error(`unexpected rpc ${name}`);
      }
    };
    runner.loadContracts = async () => contracts;
    runner.readAccount = async (account) => {
      const now = new Date().toISOString();
      if (account.trading_account_id === 'master') return { ...account, open_orders: [], observed_started_at: now, observed_at: now,
        total: 10_000, available: 9_000, unrealisedPnl: 0, positionMode: 'single',
        positions: [{ contract: 'BTC_USDT', size: 100, markPrice: 50_000, positionSide: 'LONG' }] };
      throw new GateApiError('x', { code });
    };
    for (let i = 0; i < 30; i++) {
      const result = await runner.syncOnce();
      assert.equal(result.masterObserved, 1);
      assert.equal(result.healthyMembers, 0);
    }
    assert.equal(recorded.at(-1).members[0].error_code, `MEMBER_ACCOUNT_READ_${code}`);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(events, [], 'not before the failure has lasted 5 minutes');
    // Five minutes into the streak: one warning for the generic read failure; the credential tracker stays out.
    runner.trackMemberCredentialRead({ trading_account_id: 'acct', user_id: 'u' }, new GateApiError('x', { code }), Date.now() + 300_000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(events.map((e) => [e.event, e.severity, e.details.error_code]), [['MEMBER_ACCOUNT_READ_FAILING', 'WARNING', code]]);
    assert.equal(runner.credentialFailures.size, 0);
  });
}
