// QA 2026-10-21 area C (infrastructure / timing). Read-only probes of existing behaviour; no source changes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { getFuturesPositions } from './gate.js';
import { planMemberPositions } from './trading-runner.js';

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
// positions") followed by a single-contract read answering HTTP 200 with an empty body or [] is accepted as a
// CONFIRMED flat contract, not as "unconfirmed" — even in the Master's tolerant mode.
for (const [label, reply] of [['empty 200 body', { raw: '' }], ['200 []', { body: [] }], ['404 POSITION_NOT_FOUND', { status: 404, body: { label: 'POSITION_NOT_FOUND' } }]]) {
  test(`C-1: Master list [] + single read ${label} => BTC_USDT reported flat and NOT unconfirmed`, async () => {
    const { fetchImpl, requested } = gateFetch([
      [/\/positions\?holding=true/, { body: [] }],
      [/\/my_trades\?/, { body: [] }],
      [/\/positions\/BTC_USDT$/, reply],
    ]);
    const positions = await getFuturesPositions({ apiKey: 'k', secretKey: 's', fetchImpl,
      expectedContracts: ['BTC_USDT'], expectedLegs: ['BTC_USDT:LONG'], tolerateUnconfirmed: true });
    assert.ok(requested.some((p) => p.endsWith('/positions/BTC_USDT')), 'anchored contract was re-read individually');
    assert.deepEqual(positions, []);
    assert.equal(positions.unconfirmedContracts, undefined, 'no unconfirmed marker -> the planner treats the leg as closed');
  });
}

// C-1 (cont.): a single such read is acted on in the SAME cycle for an anchored (CURRENT_MASTER / continued COPY)
// leg: the member gets a reduce-only close. The FUTURE_ONLY baseline path requires two consecutive reads for the
// same kind of reduction (confirmBaselineClear); the anchor path has no such confirmation.
test('C-1: one flat Master read closes an anchored member COPY leg immediately (no second-read confirmation)', () => {
  const [leg] = planMemberPositions({
    cycleId: 'fcd65a4f-ef1e-4f3c-958b-dac3c12f0b94',
    system: { emergency_halted: false, max_order_slippage_ratio: 0.005 },
    master: { total: 10_000, positions: [] },
    member: {
      user_id: 'member-1', total: 5_000, available: 5_000, copy_ratio: 100, max_position_ratio: 30, max_leverage: 10,
      positionMode: 'single', open_orders: [], previous_states: [{ contract: 'BTC_USDT', position_side: 'LONG', state: 'SYNCED', actual_size: 30 }],
      resume_version: 'resume-1',
      positions: [{ contract: 'BTC_USDT', size: 30, markPrice: 50_000, positionSide: 'LONG' }],
      ledger_positions: [{ contract: 'BTC_USDT', position_side: 'LONG', size: 30 }],
      target_anchors: [{ contract: 'BTC_USDT', position_side: 'LONG', resume_version: 'resume-1',
        master_copyable_size: 100, target_size: 30, protected_member_size: 0 }],
    },
    contracts,
  });
  assert.equal(leg.target_size, 0);
  assert.equal(leg.target_lock_reason, 'MASTER_QUANTITY_REDUCED_PROPORTIONALLY');
  assert.ok(leg.intent, 'an executable order is planned in this cycle');
  assert.equal(leg.intent.delta_size, -30);
  assert.equal(leg.intent.reduce_only, true);
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
