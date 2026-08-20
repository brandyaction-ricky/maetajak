import test from 'node:test';
import assert from 'node:assert/strict';
import { planMemberPositions } from './trading-runner.js';

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

test('large deltas are chunked to the strictest Gate order size limit', () => {
  const limitedContracts = new Map([['BTC_USDT', { ...contracts.get('BTC_USDT'), orderSizeMax: 25, marketOrderSizeMax: 10 }]]);
  const [position] = planMemberPositions({ ...base, contracts: limitedContracts });
  assert.equal(position.target_size, 30);
  assert.equal(position.intent.delta_size, 10);
});
