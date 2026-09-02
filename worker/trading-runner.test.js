import test from 'node:test';
import assert from 'node:assert/strict';
import { planMemberPositions, safeError, suppressExecutableIntents, TradingRunner } from './trading-runner.js';

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

test('worker plans simultaneous LONG and SHORT legs independently', () => {
  const positions = planMemberPositions({
    ...base,
    master: {
      total: 10_000,
      positions: [
        { contract: 'BTC_USDT', positionSide: 'LONG', mode: 'dual_long', size: 20, markPrice: 50_000, leverage: 7, posMarginMode: 'cross' },
        { contract: 'BTC_USDT', positionSide: 'SHORT', mode: 'dual_short', size: -10, markPrice: 50_000, leverage: 4, posMarginMode: 'cross' },
      ],
    },
    member: { ...base.member, positionMode: 'dual', positions: [] },
  });
  assert.deepEqual(positions.map(({ position_side, target_size, target_leverage }) => ({ position_side, target_size, target_leverage })), [
    { position_side: 'LONG', target_size: 10, target_leverage: 7 },
    { position_side: 'SHORT', target_size: -5, target_leverage: 4 },
  ]);
  assert.equal(positions[0].intent.reduce_only, false);
  assert.equal(positions[1].intent.reduce_only, false);
});

test('normal drift reductions are reduce-only so hedge legs cannot cross', () => {
  const [position] = planMemberPositions({
    ...base,
    master: { total: 10_000, positions: [{ contract: 'BTC_USDT', positionSide: 'LONG', mode: 'dual_long', size: 10, markPrice: 50_000, leverage: 5 }] },
    member: { ...base.member, total: 10_000, positionMode: 'dual', positions: [{ contract: 'BTC_USDT', positionSide: 'LONG', mode: 'dual_long', size: 20, markPrice: 50_000, leverage: 2 }] },
  });
  assert.equal(position.intent.delta_size, -10);
  assert.equal(position.intent.reduce_only, true);
});

test('member leverage limit no longer blocks entry and Master leverage wins', () => {
  const [position] = planMemberPositions({
    ...base,
    master: { total: 10_000, positions: [{ contract: 'BTC_USDT', size: 100, markPrice: 50_000, leverage: 6, posMarginMode: 'isolated' }] },
    member: { ...base.member, max_leverage: 2, positions: [] },
  });
  assert.equal(position.state, 'DRIFT');
  assert.equal(position.pause_reason, null);
  assert.equal(position.intent.target_leverage, 6);
  assert.equal(position.intent.margin_mode, 'isolated');
});

test('new member baseline blocks existing Master positions and follows only later increases', () => {
  const [initial] = planMemberPositions({
    ...base,
    member: { ...base.member, master_baselines: [{ contract: 'BTC_USDT', size: 100 }] },
  });
  assert.equal(initial.target_size, 0);
  assert.equal(initial.state, 'SYNCED');
  assert.equal(Object.hasOwn(initial, 'intent'), false);

  const [increased] = planMemberPositions({
    ...base,
    master: { ...base.master, positions: [{ contract: 'BTC_USDT', size: 120, markPrice: 50_000 }] },
    member: { ...base.member, master_baselines: [{ contract: 'BTC_USDT', size: 100 }] },
  });
  assert.equal(increased.target_size, 10);
  assert.equal(increased.intent.delta_size, 10);
});

test('member positions held before copy starts are preserved while later copy exposure is added', () => {
  const [protectedOnly] = planMemberPositions({
    ...base,
    master: { ...base.master, positions: [] },
    member: {
      ...base.member,
      positions: [{ contract: 'BTC_USDT', size: 20, markPrice: 50_000 }],
      member_position_baselines: [{ contract: 'BTC_USDT', size: 20 }],
    },
  });
  assert.equal(protectedOnly.target_size, 20);
  assert.equal(protectedOnly.delta_size, 0);
  assert.equal(Object.hasOwn(protectedOnly, 'intent'), false);

  const [withCopy] = planMemberPositions({
    ...base,
    member: {
      ...base.member,
      positions: [{ contract: 'BTC_USDT', size: 50, markPrice: 50_000 }],
      member_position_baselines: [{ contract: 'BTC_USDT', size: 20 }],
    },
  });
  assert.equal(withCopy.target_size, 50);
  assert.equal(withCopy.delta_size, 0);
  assert.equal(withCopy.member_baseline_size, 20);
});

test('single-mode copy never closes a protected opposite-side member position', () => {
  const planned = planMemberPositions({
    ...base,
    master: { ...base.master, positions: [{ contract: 'BTC_USDT', size: -100, markPrice: 50_000 }] },
    member: {
      ...base.member,
      positionMode: 'single',
      positions: [{ contract: 'BTC_USDT', size: 20, markPrice: 50_000 }],
      member_position_baselines: [{ contract: 'BTC_USDT', positionSide: 'LONG', size: 20 }],
    },
  });
  const shortPlan = planned.find((position) => position.position_side === 'SHORT');
  const longPlan = planned.find((position) => position.position_side === 'LONG');
  assert.equal(shortPlan.state, 'PAUSED');
  assert.equal(shortPlan.pause_reason, 'PROTECTED_EXISTING_POSITION_OPPOSITE_SIDE');
  assert.equal(Object.hasOwn(shortPlan, 'intent'), false);
  assert.equal(longPlan.target_size, 20);
  assert.equal(longPlan.delta_size, 0);
});

test('Master close clears onboarding baseline so a later re-entry is copied', () => {
  const [reentered] = planMemberPositions({
    ...base,
    master: { ...base.master, positions: [{ contract: 'BTC_USDT', size: 20, markPrice: 50_000 }] },
    member: { ...base.member, master_baselines: [] },
  });
  assert.equal(reentered.target_size, 10);
  assert.equal(reentered.intent.delta_size, 10);
});

test('synced LIVE position omits the executable intent key', () => {
  const positions = planMemberPositions({
    cycleId: 'cycle-synced', system: { emergency_halted: false },
    master: { total: 10_000, positions: [{ contract: 'BTC_USDT', size: 10, markPrice: 100 }] },
    member: { ...base.member, total: 10_000, positions: [{ contract: 'BTC_USDT', size: 10, markPrice: 100 }] },
    contracts,
  });
  assert.equal(positions[0].state, 'SYNCED');
  assert.equal(Object.hasOwn(positions[0], 'intent'), false);
});

test('manual member change pauses the symbol and blocks re-entry', () => {
  const input = structuredClone(base);
  input.member.positions = [{ contract: 'BTC_USDT', size: 20, markPrice: 50_000, leverage: 2 }];
  input.member.previous_states = [{ contract: 'BTC_USDT', actual_size: 50, known_fill_delta: 0, has_unresolved_order: false, state: 'SYNCED' }];
  const [position] = planMemberPositions({ ...input, contracts });
  assert.equal(position.state, 'MANUAL_OVERRIDE');
  assert.equal(Object.hasOwn(position, 'intent'), false);
  assert.equal(position.pause_reason, 'MEMBER_POSITION_CHANGED_OUTSIDE_PLATFORM');
});

test('global halt blocks all order intents', () => {
  const [position] = planMemberPositions({ ...base, system: { emergency_halted: true } });
  assert.equal(position.state, 'HALTED');
  assert.equal(Object.hasOwn(position, 'intent'), false);
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
  const dryRunLogs = [];
  const runner = new TradingRunner({
    supabase: {},
    baseUrl: 'https://api.gateio.ws',
    workerId: 'worker-test',
    workerVersion: 'test',
    publicIp: '3.37.231.51',
    channelId: 'maetajak',
    mode: 'DRY_RUN',
    logger: (event, details) => dryRunLogs.push({ event, details }),
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
    if (name === 'get_or_initialize_member_copy_baselines') return { positions: [], member_positions: [] };
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
  assert.equal(recordedPayload.master.positions[0].quanto_multiplier, 0.001);
  assert.deepEqual(dryRunLogs, [{
    event: 'dry_run_master_snapshot',
    details: { total_equity: 10_000, available_equity: 9_000, positions: [{ contract: 'BTC_USDT', position_side: 'LONG', size: 100, mark_price: 50_000, leverage: null, margin_mode: null }] },
  }, {
    event: 'dry_run_plan',
    details: { positions: [{ contract: 'BTC_USDT', position_side: 'LONG', target_size: 30, actual_size: 0, delta_size: 30, target_leverage: null, state: 'DRIFT', pause_reason: null }] },
  }]);
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

test('worker refreshes cached contract metadata when Master opens an unknown contract', async () => {
  const runner = new TradingRunner({
    supabase: {}, baseUrl: 'https://api.gateio.ws', workerId: 'worker-test',
    workerVersion: 'test', publicIp: '3.37.231.51', channelId: 'maetajak', mode: 'DRY_RUN',
  });
  let loads = 0;
  runner.rpc = async (name) => {
    if (name === 'get_copy_worker_context') return {
      system: { emergency_halted: true },
      master: { user_id: 'master', api_key: 'key', secret_key: 'secret' },
      members: [{ user_id: 'member', api_key: 'key', secret_key: 'secret', copy_ratio: 100, max_position_ratio: 40 }],
    };
    if (name === 'record_copy_worker_cycle') return {};
    if (name === 'get_or_initialize_member_copy_baselines') return { positions: [], member_positions: [] };
    throw new Error(`unexpected rpc ${name}`);
  };
  runner.loadContracts = async () => {
    loads += 1;
    return loads === 1
      ? new Map([['BTC_USDT', contracts.get('BTC_USDT')]])
      : new Map([['BTC_USDT', contracts.get('BTC_USDT')], ['DELL_USDT', contracts.get('BTC_USDT')]]);
  };
  let reads = 0;
  runner.readAccount = async (account) => {
    reads += 1;
    return reads === 1
      ? { ...account, total: 10_000, available: 9_000, positions: [{ contract: 'DELL_USDT', size: 10, markPrice: 100 }] }
      : { ...account, total: 10_000, available: 9_000, positions: [] };
  };
  await runner.syncOnce();
  assert.equal(loads, 2);
});

test('member failures expose a safe stage without leaking upstream messages', async () => {
  assert.equal(safeError(new Error('secret database detail'), 'baseline init'), 'BASELINE_INIT_FAILED');
  assert.equal(safeError(new TypeError('secret payload'), 'member account read'), 'MEMBER_ACCOUNT_READ_TYPE_ERROR');

  let recordedPayload = null;
  const logs = [];
  const runner = new TradingRunner({
    supabase: {}, baseUrl: 'https://api.gateio.ws', workerId: 'worker-test',
    workerVersion: 'test', publicIp: '3.37.231.51', channelId: 'maetajak', mode: 'DRY_RUN',
    logger: (event, details) => logs.push({ event, details }),
  });
  runner.rpc = async (name, parameters = {}) => {
    if (name === 'get_copy_worker_context') return {
      system: { emergency_halted: true },
      master: { trading_account_id: 'master-1' },
      members: [{ trading_account_id: 'member-account-1', user_id: 'member-1' }],
    };
    if (name === 'get_or_initialize_member_copy_baselines') throw new Error('private SQL error');
    if (name === 'record_copy_worker_cycle') {
      recordedPayload = parameters.p_payload;
      return 'cycle-1';
    }
    throw new Error(`unexpected rpc: ${name}`);
  };
  runner.loadContracts = async () => contracts;
  runner.readAccount = async (account) => ({
    ...account, total: 10_000, available: 9_000, positions: [],
  });

  await runner.syncOnce();

  assert.equal(recordedPayload.members[0].error_code, 'BASELINE_INIT_FAILED');
  assert.deepEqual(logs.find(({ event }) => event === 'member_sync_failed'), {
    event: 'member_sync_failed',
    details: {
      user_id: 'member-1',
      trading_account_id: 'member-account-1',
      error_code: 'BASELINE_INIT_FAILED',
    },
  });
  assert.equal(JSON.stringify(logs).includes('private SQL error'), false);
});

test('LIVE applies Master leverage to the correct hedge leg before submitting an entry order', async () => {
  const requests = [];
  const completions = [];
  const runner = new TradingRunner({
    supabase: {}, baseUrl: 'https://api.gateio.ws', workerId: 'worker-test',
    workerVersion: 'test', publicIp: '3.37.231.51', channelId: 'maetajak', mode: 'LIVE',
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      if (url.includes('/dual_comp/positions/BTC_USDT/leverage')) {
        return new Response(JSON.stringify([{ cross_leverage_limit: '7' }]), { status: 200 });
      }
      if (url.endsWith('/futures/usdt/orders')) {
        return new Response(JSON.stringify({
          id: '9223372036854775807', size: 3, left: 0, status: 'finished', finish_as: 'filled',
        }), { status: 201 });
      }
      throw new Error(`unexpected URL: ${url}`);
    },
  });
  runner.rpc = async (name, parameters = {}) => {
    if (name === 'claim_copy_order_intents') return [{
      intent_id: 'intent-1', api_key: 'key', secret_key: 'secret', contract: 'BTC_USDT',
      position_side: 'LONG', position_mode: 'dual', delta_size: 3, reduce_only: false,
      target_leverage: 7, margin_mode: 'cross', gate_order_text: 't-mtj-12345678901234567890',
      slippage_ratio: 0.005,
    }];
    if (name === 'complete_copy_order_attempt') {
      completions.push(parameters);
      return null;
    }
    throw new Error(`unexpected rpc: ${name}`);
  };

  assert.equal(await runner.submitOrders(), 1);
  assert.equal(requests.length, 2);
  assert.match(requests[0].url, /dual_comp\/positions\/BTC_USDT\/leverage\?leverage=0&cross_leverage_limit=7$/);
  assert.match(requests[1].url, /\/futures\/usdt\/orders$/);
  assert.equal(JSON.parse(requests[1].options.body).reduce_only, false);
  assert.equal(completions[0].p_result_status, 'FILLED');
});
