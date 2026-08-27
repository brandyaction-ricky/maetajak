import test from 'node:test';
import assert from 'node:assert/strict';
import { planMemberPositions, suppressExecutableIntents, TradingRunner } from './trading-runner.js';

const contracts = new Map([['BTC_USDT', { quantoMultiplier: 0.001, sizeStep: 1, orderSizeMin: 1, orderSizeMax: 0, marketOrderSizeMax: 0, inDelisting: false }]]);
const base = {
  cycleId: 'fcd65a4f-ef1e-4f3c-958b-dac3c12f0b94',
  system: { emergency_halted: false },
  master: { total: 10_000, positions: [{ contract: 'BTC_USDT', size: 100, markPrice: 50_000 }] },
  member: { user_id: 'member-1', total: 5_000, copy_ratio: 100, max_position_ratio: 30, max_leverage: 10, positions: [], previous_states: [] },
  contracts,
};

test('worker plans Master position to member target to delta order', () => {
  const [position] = planMemberPositions(base);
  assert.equal(position.target_size, 30);
  assert.equal(position.state, 'DRIFT');
  assert.equal(position.intent.delta_size, 30);
  assert.match(position.intent.gate_order_text, /^t-mtj-/);
});

test('manual member change pauses the symbol and blocks re-entry', () => {
  const input = structuredClone(base);
  input.member.positions = [{ contract: 'BTC_USDT', size: 20, markPrice: 50_000, leverage: 2 }];
  input.member.previous_states = [{ contract: 'BTC_USDT', actual_size: 50, known_fill_delta: 0, has_unresolved_order: false, state: 'SYNCED' }];
  const [position] = planMemberPositions({ ...input, contracts });
  assert.equal(position.state, 'MANUAL_OVERRIDE');
  assert.equal(position.intent, null);
  assert.equal(position.pause_reason, 'MEMBER_POSITION_CHANGED_OUTSIDE_PLATFORM');
});

test('global halt blocks all order intents', () => {
  const [position] = planMemberPositions({ ...base, system: { emergency_halted: true } });
  assert.equal(position.state, 'HALTED');
  assert.equal(position.intent, null);
});

test('DRY_RUN can calculate a simulated delta while the global live halt remains enabled', () => {
  const [position] = planMemberPositions({
    ...base,
    system: { emergency_halted: true },
    simulateSystemHalt: true,
  });
  assert.equal(position.state, 'DRIFT');
  assert.equal(position.delta_size, 30);
  assert.equal(position.intent.delta_size, 30);
});

test('a halted observation becomes the new baseline before copy testing resumes', () => {
  const input = structuredClone(base);
  input.member.positions = [];
  input.member.previous_states = [{
    contract: 'BTC_USDT', actual_size: 20, known_fill_delta: 0,
    has_unresolved_order: false, state: 'HALTED',
  }];
  const [position] = planMemberPositions({ ...input, contracts, simulateSystemHalt: true });
  assert.equal(position.state, 'DRIFT');
  assert.equal(position.unexplained_delta, 0);
  assert.equal(position.intent.delta_size, 30);
});

test('large deltas are chunked to the strictest Gate order size limit', () => {
  const limitedContracts = new Map([['BTC_USDT', { ...contracts.get('BTC_USDT'), orderSizeMax: 25, marketOrderSizeMax: 10 }]]);
  const [position] = planMemberPositions({ ...base, contracts: limitedContracts });
  assert.equal(position.target_size, 30);
  assert.equal(position.intent.delta_size, 10);
});

test('OBSERVE and DRY_RUN cannot persist executable order intents', () => {
  const planned = planMemberPositions(base);
  assert.ok(planned[0].intent);
  const observed = suppressExecutableIntents(planned, 'OBSERVE')[0];
  const dryRun = suppressExecutableIntents(planned, 'DRY_RUN')[0];
  assert.equal('intent' in observed, false);
  assert.equal('intent' in dryRun, false);
  assert.equal(observed.delta_size, 30);
  assert.equal(dryRun.delta_size, 30);
  assert.equal(JSON.parse(JSON.stringify(dryRun)).intent, undefined);
  assert.ok(suppressExecutableIntents(planned, 'LIVE')[0].intent);
});

test('DRY_RUN records target, actual, and delta without an intent key', async () => {
  let recordedPayload = null;
  const runner = new TradingRunner({
    supabase: {},
    baseUrl: 'https://api.gateio.ws',
    workerId: 'worker-test',
    workerVersion: 'test',
    publicIp: '3.37.231.51',
    channelId: 'maetajak',
    mode: 'DRY_RUN',
  });
  runner.rpc = async (name, parameters = {}) => {
    if (name === 'get_copy_worker_context') {
      return {
        system: { emergency_halted: true },
        master: { trading_account_id: 'master-1' },
        members: [{
          trading_account_id: 'member-account-1', user_id: 'member-1', copy_ratio: 100,
          max_position_ratio: 30, max_leverage: 10, previous_states: [],
        }],
      };
    }
    if (name === 'record_copy_worker_cycle') {
      recordedPayload = parameters.p_payload;
      return 'cycle-1';
    }
    throw new Error(`unexpected rpc: ${name}`);
  };
  runner.loadContracts = async () => contracts;
  runner.readAccount = async (account) => account.trading_account_id === 'master-1'
    ? { ...account, total: 10_000, available: 9_000, unrealisedPnl: 0, positions: [{ contract: 'BTC_USDT', size: 100, markPrice: 50_000 }] }
    : { ...account, total: 5_000, available: 5_000, unrealisedPnl: 0, positions: [] };

  const observation = await runner.syncOnce();
  const [position] = recordedPayload.members[0].planned_positions;

  assert.deepEqual(observation, { observed: 1, masterObserved: 1, intents: 1 });
  assert.equal(position.target_size, 30);
  assert.equal(position.size, 0);
  assert.equal(position.delta_size, 30);
  assert.equal('intent' in position, false);
  assert.equal(JSON.stringify(recordedPayload).includes('gate_order_text'), false);
  assert.equal(JSON.stringify(recordedPayload).includes('idempotency_key'), false);
});

test('worker snapshots a verified Master before any member API is connected', async () => {
  let recordedPayload = null;
  const runner = new TradingRunner({
    supabase: {},
    baseUrl: 'https://api.gateio.ws',
    workerId: 'worker-test',
    workerVersion: 'test',
    publicIp: '3.37.231.51',
    channelId: 'maetajak',
    mode: 'OBSERVE',
  });
  runner.rpc = async (name, parameters = {}) => {
    if (name === 'get_copy_worker_context') {
      return { system: {}, master: { trading_account_id: 'master-1' }, members: [] };
    }
    if (name === 'record_copy_worker_cycle') {
      recordedPayload = parameters.p_payload;
      return 'cycle-1';
    }
    throw new Error(`unexpected rpc: ${name}`);
  };
  runner.loadContracts = async () => { throw new Error('contracts should not load without members'); };
  runner.readAccount = async (account) => ({
    ...account,
    total: 10_000,
    available: 9_000,
    unrealisedPnl: 100,
    positions: [{ contract: 'BTC_USDT', size: 2, markPrice: 60_000, entryPrice: 58_000, leverage: 3 }],
  });

  const observation = await runner.syncOnce();

  assert.deepEqual(observation, { observed: 0, masterObserved: 1, intents: 0 });
  assert.equal(recordedPayload.master.positions[0].contract, 'BTC_USDT');
  assert.deepEqual(recordedPayload.members, []);
});
