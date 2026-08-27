import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildGateOrderText,
  buildIdempotencyKey,
  calculateDeltaOrder,
  calculateTargetPosition,
  deriveCopyState,
  detectManualOverride,
  roundTowardZeroToStep,
} from './copy-engine.js';

test('target position follows master exposure and member copy ratio', () => {
  const result = calculateTargetPosition({
    masterSize: 10,
    masterEquity: 10_000,
    masterMarkPrice: 1_000,
    masterQuantoMultiplier: 0.1,
    memberEquity: 5_000,
    copyRatio: 100,
    maxPositionRatio: 30,
    sizeStep: 1,
  });
  assert.equal(result.masterExposureRatio, 0.1);
  assert.equal(result.targetNotional, 500);
  assert.equal(result.targetSize, 5);
  assert.equal(result.capped, false);
});

test('reported incident values scale every member strictly by account equity', () => {
  const input = {
    masterSize: -12,
    masterEquity: 17_150.85,
    masterMarkPrice: 80_271.6,
    masterQuantoMultiplier: 0.0001,
    copyRatio: 100,
    maxPositionRatio: 40,
    sizeStep: 1,
  };
  const small = calculateTargetPosition({ ...input, memberEquity: 2_000 });
  const incidentMember = calculateTargetPosition({ ...input, memberEquity: 15_440.54 });
  const large = calculateTargetPosition({ ...input, memberEquity: 20_000 });

  assert.equal(small.targetSize, -1);
  assert.equal(incidentMember.targetSize, -10);
  assert.equal(large.targetSize, -13);
  assert.equal(incidentMember.equityScale, 15_440.54 / 17_150.85);
  assert.equal(incidentMember.capped, false);
  assert.ok(Math.abs(incidentMember.targetSize) < 20);
});

test('target position applies copy ratio and maximum position cap', () => {
  const result = calculateTargetPosition({
    masterSize: -100,
    masterEquity: 10_000,
    masterMarkPrice: 1_000,
    masterQuantoMultiplier: 0.1,
    memberEquity: 5_000,
    copyRatio: 200,
    maxPositionRatio: 30,
    sizeStep: 1,
  });
  assert.equal(result.targetNotional, -1_500);
  assert.equal(result.targetSize, -15);
  assert.equal(result.capped, true);
});

test('contract sizes are rounded toward zero', () => {
  assert.equal(roundTowardZeroToStep(3.9, 1), 3);
  assert.equal(roundTowardZeroToStep(-3.9, 1), -3);
  assert.equal(roundTowardZeroToStep(1.29, 0.1), 1.2);
});

test('unexplained member position change is a manual override', () => {
  assert.deepEqual(detectManualOverride({
    previousActualSize: 10,
    currentActualSize: 4,
    knownPlatformFillDelta: 0,
    sizeStep: 1,
  }), { detected: true, unexplainedDelta: -6, expectedActualSize: 10 });
});

test('platform fill and unresolved order do not become manual override', () => {
  assert.equal(detectManualOverride({
    previousActualSize: 10,
    currentActualSize: 4,
    knownPlatformFillDelta: -6,
    sizeStep: 1,
  }).detected, false);
  assert.equal(detectManualOverride({
    previousActualSize: 10,
    currentActualSize: 4,
    hasUnresolvedPlatformOrder: true,
    sizeStep: 1,
  }).detected, false);
});

test('copy-state priority protects halt, manual override, and pause', () => {
  const base = { targetSize: 10, actualSize: 0, driftToleranceSize: 0 };
  assert.equal(deriveCopyState({ ...base, systemHalted: true, manualOverride: true }), 'HALTED');
  assert.equal(deriveCopyState({ ...base, symbolPaused: true, manualOverride: true }), 'MANUAL_OVERRIDE');
  assert.equal(deriveCopyState({ ...base, manualOverride: true }), 'MANUAL_OVERRIDE');
  assert.equal(deriveCopyState(base), 'DRIFT');
  assert.equal(deriveCopyState({ ...base, actualSize: 10 }), 'SYNCED');
});

test('delta orders are blocked for manual override and constrained in reduce-only', () => {
  assert.equal(calculateDeltaOrder({ state: 'MANUAL_OVERRIDE', targetSize: 10, actualSize: 0 }).shouldSubmit, false);
  assert.deepEqual(calculateDeltaOrder({ state: 'REDUCE_ONLY', targetSize: 4, actualSize: 10 }), {
    shouldSubmit: true, deltaSize: -6, reduceOnly: true, reason: 'DELTA_REQUIRED',
  });
  assert.equal(calculateDeltaOrder({ state: 'REDUCE_ONLY', targetSize: 12, actualSize: 10 }).shouldSubmit, false);
  assert.equal(calculateDeltaOrder({ state: 'REDUCE_ONLY', targetSize: -2, actualSize: 10 }).shouldSubmit, false);
});

test('idempotency key and Gate order text are deterministic', () => {
  const input = { cycleId: 'cycle-1', userId: 'user-1', contract: 'BTC_USDT', targetSize: 5, actualSize: 2 };
  const first = buildIdempotencyKey(input);
  assert.equal(first, buildIdempotencyKey(input));
  assert.notEqual(first, buildIdempotencyKey({ ...input, targetSize: 6 }));
  assert.match(buildGateOrderText(first), /^t-mtj-[a-f0-9]{20}$/);
});
