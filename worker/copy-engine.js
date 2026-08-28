import { createHash } from 'node:crypto';

export const COPY_STATES = Object.freeze([
  'SYNCED',
  'DRIFT',
  'MANUAL_OVERRIDE',
  'PAUSED',
  'REDUCE_ONLY',
  'ERROR',
  'HALTED',
]);

function finiteNumber(value, name) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new TypeError(`${name} must be a finite number`);
  return parsed;
}

function positiveNumber(value, name) {
  const parsed = finiteNumber(value, name);
  if (parsed <= 0) throw new RangeError(`${name} must be greater than zero`);
  return parsed;
}

export function roundTowardZeroToStep(value, step = 1) {
  const amount = finiteNumber(value, 'value');
  const increment = positiveNumber(step, 'step');
  const units = amount / increment;
  const rounded = units < 0 ? Math.ceil(units) : Math.floor(units);
  return Number((rounded * increment).toPrecision(15));
}

export function calculateCopyableMasterSize({ masterSize, baselineSize = 0 }) {
  const current = finiteNumber(masterSize, 'masterSize');
  const baseline = finiteNumber(baselineSize, 'baselineSize');
  if (baseline === 0) return { copyableSize: current, clearBaseline: false };
  if (current === 0 || Math.sign(current) !== Math.sign(baseline)) {
    return { copyableSize: current, clearBaseline: true };
  }
  const delta = current - baseline;
  const copyableSize = Math.sign(delta) === Math.sign(baseline) ? delta : 0;
  return { copyableSize, clearBaseline: false };
}

export function calculateTargetPosition({
  masterSize,
  masterEquity,
  masterMarkPrice,
  masterQuantoMultiplier,
  memberEquity,
  memberMarkPrice = masterMarkPrice,
  memberQuantoMultiplier = masterQuantoMultiplier,
  copyRatio = 100,
  maxPositionRatio = 30,
  sizeStep = 1,
}) {
  const signedMasterSize = finiteNumber(masterSize, 'masterSize');
  const masterAccountEquity = positiveNumber(masterEquity, 'masterEquity');
  const masterPrice = positiveNumber(masterMarkPrice, 'masterMarkPrice');
  const masterMultiplier = positiveNumber(masterQuantoMultiplier, 'masterQuantoMultiplier');
  const memberAccountEquity = Math.max(0, finiteNumber(memberEquity, 'memberEquity'));
  const memberPrice = positiveNumber(memberMarkPrice, 'memberMarkPrice');
  const memberMultiplier = positiveNumber(memberQuantoMultiplier, 'memberQuantoMultiplier');
  const ratio = Math.max(0, finiteNumber(copyRatio, 'copyRatio')) / 100;
  const positionCapRatio = Math.max(0, finiteNumber(maxPositionRatio, 'maxPositionRatio')) / 100;

  // Scale the contract quantity by account equity first. Price and contract
  // multiplier adjustments keep the same exposure percentage even if Gate
  // reports different instrument units for the two accounts.
  const equityScale = memberAccountEquity / masterAccountEquity;
  const rawTargetSizeByEquity = signedMasterSize
    * equityScale
    * ratio
    * (masterPrice * masterMultiplier) / (memberPrice * memberMultiplier);
  const uncappedTargetNotional = rawTargetSizeByEquity * memberPrice * memberMultiplier;
  const masterNotional = signedMasterSize * masterPrice * masterMultiplier;
  const masterExposureRatio = masterNotional / masterAccountEquity;
  const maxTargetNotional = memberAccountEquity * positionCapRatio;
  const targetNotional = Math.sign(uncappedTargetNotional)
    * Math.min(Math.abs(uncappedTargetNotional), maxTargetNotional);
  const rawTargetSize = targetNotional / (memberPrice * memberMultiplier);
  const targetSize = roundTowardZeroToStep(rawTargetSize, sizeStep);

  return {
    targetSize,
    targetNotional,
    uncappedTargetNotional,
    masterExposureRatio,
    equityScale,
    capped: Math.abs(uncappedTargetNotional) > maxTargetNotional,
  };
}

export function detectManualOverride({
  previousActualSize,
  currentActualSize,
  knownPlatformFillDelta = 0,
  sizeStep = 1,
  manualToleranceSize,
  hasUnresolvedPlatformOrder = false,
  hasBaseline = true,
}) {
  if (!hasBaseline || hasUnresolvedPlatformOrder) {
    return { detected: false, unexplainedDelta: 0, expectedActualSize: currentActualSize };
  }

  const previous = finiteNumber(previousActualSize, 'previousActualSize');
  const current = finiteNumber(currentActualSize, 'currentActualSize');
  const fills = finiteNumber(knownPlatformFillDelta, 'knownPlatformFillDelta');
  const expectedActualSize = previous + fills;
  const unexplainedDelta = current - expectedActualSize;
  const tolerance = manualToleranceSize == null
    ? positiveNumber(sizeStep, 'sizeStep')
    : Math.max(0, finiteNumber(manualToleranceSize, 'manualToleranceSize'));

  return {
    detected: Math.abs(unexplainedDelta) >= tolerance && unexplainedDelta !== 0,
    unexplainedDelta,
    expectedActualSize,
  };
}

export function deriveCopyState({
  systemHalted = false,
  memberHalted = false,
  hasError = false,
  symbolPaused = false,
  manualOverride = false,
  reduceOnly = false,
  targetSize,
  actualSize,
  driftToleranceSize = 1,
}) {
  if (systemHalted || memberHalted) return 'HALTED';
  if (hasError) return 'ERROR';
  if (manualOverride) return 'MANUAL_OVERRIDE';
  if (symbolPaused) return 'PAUSED';
  if (reduceOnly) return 'REDUCE_ONLY';

  const delta = finiteNumber(targetSize, 'targetSize') - finiteNumber(actualSize, 'actualSize');
  return Math.abs(delta) <= Math.max(0, finiteNumber(driftToleranceSize, 'driftToleranceSize'))
    ? 'SYNCED'
    : 'DRIFT';
}

export function calculateDeltaOrder({ state, targetSize, actualSize, sizeStep = 1 }) {
  if (!COPY_STATES.includes(state)) throw new RangeError('Unknown copy state');
  const target = finiteNumber(targetSize, 'targetSize');
  const actual = finiteNumber(actualSize, 'actualSize');
  const deltaSize = roundTowardZeroToStep(target - actual, sizeStep);

  if (!['DRIFT', 'REDUCE_ONLY'].includes(state) || deltaSize === 0) {
    return { shouldSubmit: false, deltaSize: 0, reduceOnly: false, reason: state };
  }

  const resultingSize = actual + deltaSize;
  const reducesExposure = Math.abs(resultingSize) < Math.abs(actual)
    && (resultingSize === 0 || Math.sign(resultingSize) === Math.sign(actual));

  if (state === 'REDUCE_ONLY') {
    if (!reducesExposure) {
      return { shouldSubmit: false, deltaSize: 0, reduceOnly: true, reason: 'REDUCE_ONLY_BLOCKED' };
    }
  }

  return {
    shouldSubmit: true,
    deltaSize,
    // In Gate hedge mode, an opposite-signed order without reduce_only opens
    // the other leg instead of reducing the current one. Mark every exposure
    // reduction explicitly, not only account-level REDUCE_ONLY states.
    reduceOnly: reducesExposure,
    reason: 'DELTA_REQUIRED',
  };
}

export function buildIdempotencyKey({ cycleId, userId, contract, positionSide = '', targetSize, actualSize }) {
  const source = [cycleId, userId, contract, positionSide, targetSize, actualSize].map(String).join('|');
  return createHash('sha256').update(source).digest('hex');
}

export function buildGateOrderText(idempotencyKey) {
  const normalized = String(idempotencyKey).replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
  if (normalized.length < 12) throw new RangeError('idempotencyKey is too short');
  return `t-mtj-${normalized.slice(0, 20)}`;
}
