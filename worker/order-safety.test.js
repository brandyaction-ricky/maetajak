import test from 'node:test';
import assert from 'node:assert/strict';
import { planMemberPositions, TradingRunner } from './trading-runner.js';
import { observedAccount, position } from '../tests/fixtures/verified-runtime.js';

const contracts = new Map([['BTC_USDT', {
  quantoMultiplier: 0.001, sizeStep: 1, orderSizeMin: 1,
  orderSizeMax: 0, marketOrderSizeMax: 0, inDelisting: false,
}]]);

function plan({ unresolved = true, actual = 0, target = 20, side = 'LONG', state = 'DRIFT', closeRequested = false } = {}) {
  return planMemberPositions({
    cycleId: 'next-cycle', system: { emergency_halted: false }, contracts,
    master: { total: 10_000, positions: [{ contract: 'BTC_USDT', positionSide: side, size: target, markPrice: 50_000 }] },
    member: {
      user_id: 'member', total: 10_000, copy_ratio: 100, max_position_ratio: 30,
      close_positions_requested: closeRequested,
      positionMode: 'dual', positions: [{ contract: 'BTC_USDT', positionSide: side, size: actual, markPrice: 50_000 }],
      previous_states: [{ contract: 'BTC_USDT', position_side: side, state, actual_size: actual,
        has_unresolved_order: unresolved, known_fill_delta: 0 }],
    },
  })[0];
}

test('an unresolved order blocks another intent while its target remains visible', () => {
  for (const scenario of [
    {}, { actual: 5 }, { actual: 25 }, { actual: -5, target: -20, side: 'SHORT' },
    { state: 'PAUSED' }, { state: 'HALTED' },
  ]) {
    const position = plan(scenario);
    assert.equal(Object.hasOwn(position, 'intent'), false, JSON.stringify(scenario));
    assert.equal(position.state, 'PAUSED');
    assert.equal(position.pause_reason, 'UNRESOLVED_PLATFORM_ORDER');
    assert.equal(position.target_size, scenario.target ?? 20);
    assert.equal(position.delta_size, 0);
  }
});

test('after reconciliation only the remaining quantity is planned', () => {
  assert.equal(plan({ unresolved: false, actual: 5 }).intent.delta_size, 15);
  assert.equal(Object.hasOwn(plan({ unresolved: false, actual: 20 }), 'intent'), false);
});

test('close requests also wait for unresolved fills before calculating a reduction', () => {
  const waiting = plan({ actual: 5, closeRequested: true });
  assert.equal(waiting.target_size, 0);
  assert.equal(waiting.state, 'PAUSED');
  assert.equal(Object.hasOwn(waiting, 'intent'), false);
  const resolved = plan({ unresolved: false, actual: 20, closeRequested: true });
  assert.equal(resolved.intent.delta_size, -20);
  assert.equal(resolved.intent.reduce_only, true);
});

const job = {
  intent_id: 'intent-1', user_id: 'member', api_key: 'test-key', secret_key: 'test-secret',
  contract: 'BTC_USDT', position_side: 'LONG', position_mode: 'dual', delta_size: 20,
  reduce_only: false, target_leverage: null, gate_order_text: 't-mtj-12345678901234567890',
  slippage_ratio: 0.005, resume_version: 'test-resume', source_observed_at: new Date().toISOString(),
  trading_account_id: 'account', actual_size_at_plan: 0, target_size: 20, master_size_at_plan: 20,
  quanto_multiplier: 0.001, risk_leverage: 10,
};

function runnerFor({ body, status = 201, failCompletion = false, failFetch = false, jobs = [job] }) {
  const completions = [];
  let orderRequests = 0;
  const runner = new TradingRunner({
    supabase: {}, baseUrl: 'https://api.gateio.ws', mode: 'LIVE', channelId: 'maetajak',
    fetchImpl: async () => {
      orderRequests++;
      if (failFetch) throw new Error('connection dropped');
      return new Response(body, { status });
    },
  });
  runner.rpc = async (name, parameters) => {
    if (name === 'get_copy_worker_context') return { master: { trading_account_id: 'master' }, members: [{ trading_account_id: 'account' }] };
    if (name === 'claim_copy_order_intents') return jobs;
    if (name === 'authorize_copy_order_submission') return true;
    if (name === 'complete_copy_order_attempt') {
      completions.push(parameters);
      // Emulate a timeout after a successful DB write: a second write could
      // overwrite an already committed FILLED result with REJECTED.
      if (failCompletion && completions.length === 1) throw new Error('completion response lost');
      return null;
    }
    throw new Error(`unexpected RPC: ${name}`);
  };
  runner.readAccount = async (account) => observedAccount({ ...account, positions: account.trading_account_id === 'master' ? [position(20)] : [] });
  return { runner, completions, orderRequests: () => orderRequests };
}

test('a lost completion response never rewrites a filled order as rejected', async () => {
  const fixture = runnerFor({
    body: JSON.stringify({ id: 'order-1', contract: job.contract, text: job.gate_order_text, size: 20, left: 0, status: 'finished', finish_as: 'filled' }),
    failCompletion: true,
    jobs: [job, { ...job, intent_id: 'intent-2' }],
  });
  await assert.rejects(fixture.runner.submitOrders(), /completion response lost/);
  assert.equal(fixture.orderRequests(), 1);
  assert.equal(fixture.completions.length, 1);
  assert.equal(fixture.completions[0].p_result_status, 'FILLED');
  assert.equal(fixture.completions[0].p_filled_size, 20);
});

test('a malformed successful order response remains unknown, never rejected', async () => {
  const fixture = runnerFor({ body: 'truncated JSON' });
  await fixture.runner.submitOrders();
  assert.equal(fixture.orderRequests(), 1);
  assert.equal(fixture.completions[0].p_result_status, 'UNKNOWN');
});

test('transport failures remain unknown and explicit Gate rejections stay rejected', async () => {
  for (const [options, expected] of [
    [{ failFetch: true }, 'UNKNOWN'],
    [{ body: JSON.stringify({ label: 'BALANCE_NOT_ENOUGH' }), status: 400 }, 'REJECTED'],
    [{ body: '', status: 503 }, 'UNKNOWN'],
  ]) {
    const fixture = runnerFor(options);
    await fixture.runner.submitOrders();
    assert.equal(fixture.orderRequests(), 1);
    assert.equal(fixture.completions[0].p_result_status, expected);
  }
});
