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
  // Decimal contract quantities can land a few ULPs below an integer after
  // subtraction (for example, (0.3 - 0.2) / 0.1). Preserve that complete lot
  // without rounding a genuinely fractional lot into an executable order.
  const nearest = Math.round(units);
  const normalized = Math.abs(units - nearest) <= Number.EPSILON * Math.max(1, Math.abs(units)) * 4
    ? nearest : units;
  const rounded = normalized < 0 ? Math.ceil(normalized) : Math.floor(normalized);
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

// A copy target is an execution decision, not a live mark-to-market display.
// Once a Master quantity has been observed, keep that decision stable while
// only prices/equities move. The sole exception is a stricter current risk cap:
// it may reduce copied exposure, but a later recovery must not buy it back
// unless the Master quantity changes again.
export function capLockedTargetToCurrentRisk({
  lockedTargetSize,
  protectedSize = 0,
  memberEquity,
  memberMarkPrice,
  memberQuantoMultiplier,
  maxPositionRatio = 30,
  sizeStep = 1,
}) {
  const locked = finiteNumber(lockedTargetSize, 'lockedTargetSize');
  const protectedTarget = finiteNumber(protectedSize, 'protectedSize');
  const equity = Math.max(0, finiteNumber(memberEquity, 'memberEquity'));
  const price = positiveNumber(memberMarkPrice, 'memberMarkPrice');
  const multiplier = positiveNumber(memberQuantoMultiplier, 'memberQuantoMultiplier');
  const capRatio = Math.max(0, finiteNumber(maxPositionRatio, 'maxPositionRatio')) / 100;
  const capSize = Math.abs(roundTowardZeroToStep(equity * capRatio / (price * multiplier), sizeStep));
  // Existing member positions captured at resume are never force-closed by a
  // risk cap. Only the copied amount above that protected quantity is bounded.
  const allowedAbsoluteSize = Math.max(Math.abs(protectedTarget), capSize);
  if (Math.abs(locked) <= allowedAbsoluteSize) return locked;
  return Math.sign(locked) * allowedAbsoluteSize;
}

export function calculateReducedCopyTarget({
  previousMasterSize, masterSize, lockedTargetSize, protectedSize = 0, sizeStep = 1,
}) {
  const previous = finiteNumber(previousMasterSize, 'previousMasterSize');
  const current = finiteNumber(masterSize, 'masterSize');
  const locked = finiteNumber(lockedTargetSize, 'lockedTargetSize');
  const protectedTarget = finiteNumber(protectedSize, 'protectedSize');
  if (previous === 0 || Math.abs(current) >= Math.abs(previous)
    || (current !== 0 && Math.sign(current) !== Math.sign(previous))) {
    throw new RangeError('Master quantity must decrease on the same position side');
  }
  // Equity changes must not turn a Master reduction into a member increase.
  // Scale only copied exposure; holdings protected at resume remain intact.
  const copiedSize = locked - protectedTarget;
  const remainingRatio = Math.abs(current / previous);
  return protectedTarget + roundTowardZeroToStep(copiedSize * remainingRatio, sizeStep);
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
  const tolerance = Math.max(0, finiteNumber(driftToleranceSize, 'driftToleranceSize'));
  // A full order step is actionable, including the last contract on a close.
  return delta === 0 || (tolerance > 0 && roundTowardZeroToStep(delta, tolerance) === 0)
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
