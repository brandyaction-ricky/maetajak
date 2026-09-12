// Resume compares signed contract quantities. Changes in mark price or USDT
// display value alone must not reset a member's protected positions.
export const RESUME_MAX_AGE_MS = 15_000;
export const RESUME_MAX_SKEW_MS = 3_000;

export function resumePositions(positions) {
  if (!Array.isArray(positions)) throw new Error('RESUME_POSITIONS_INVALID');
  const seen = new Set();
  return positions.map((p) => {
    const size = Number(p.size);
    const side = p.position_side || p.positionSide || (size < 0 ? 'SHORT' : 'LONG');
    if (!/^[A-Z0-9_]{2,80}$/.test(p.contract || '') || p.size == null
      || !Number.isFinite(size) || Math.abs(size) > Number.MAX_SAFE_INTEGER
      || !['LONG', 'SHORT'].includes(side) || (size && (size < 0) !== (side === 'SHORT'))) {
      throw new Error('RESUME_POSITIONS_INVALID');
    }
    const key = `${p.contract}:${side}`;
    if (seen.has(key)) throw new Error('RESUME_DUPLICATE_POSITION');
    seen.add(key);
    return { contract: p.contract, position_side: side, size };
  }).filter((p) => p.size !== 0).sort((a, b) =>
    `${a.contract}:${a.position_side}`.localeCompare(`${b.contract}:${b.position_side}`));
}

export function validateResumeSnapshot({ master, member, contracts, startedAt, now = Date.now(), openOrders = [] }) {
  if (!Number.isFinite(startedAt) || now < startedAt || now - startedAt > RESUME_MAX_AGE_MS) return 'RESUME_SNAPSHOT_STALE';
  if (!Array.isArray(openOrders) || openOrders.length) return 'RESUME_OPEN_EXCHANGE_ORDERS';
  const times = [master.observed_at, member.observed_at].map((v) => Date.parse(v));
  if (times.some((v) => !Number.isFinite(v) || v < startedAt || v > now)
    || Math.abs(times[0] - times[1]) > RESUME_MAX_SKEW_MS) return 'RESUME_SNAPSHOT_SKEW';
  if (![master.total, member.total].every((v) => Number.isFinite(v) && v > 0)) return 'RESUME_INVALID_EQUITY';
  if (member.halted || member.risk_halt_reason || member.close_positions_requested) return 'RESUME_MEMBER_RISK_HALT';
  const masterPositions = resumePositions(master.positions);
  const memberPositions = resumePositions(member.positions);
  for (const position of [...masterPositions, ...memberPositions]) {
    const contract = contracts.get(position.contract);
    if (!contract || contract.inDelisting || !(contract.sizeStep > 0) || !(contract.quantoMultiplier > 0)) return 'RESUME_CONTRACT_UNAVAILABLE';
  }
  const masterDual = String(master.positionMode || '').startsWith('dual')
    || master.positions.some((p) => String(p.mode || '').startsWith('dual'));
  const memberDual = String(member.positionMode || '').startsWith('dual')
    || member.positions.some((p) => String(p.mode || '').startsWith('dual'));
  if (masterDual && !memberDual) return 'RESUME_POSITION_MODE_MISMATCH';
  return null;
}

export function sameResumePositions(first, second) {
  return JSON.stringify(resumePositions(first)) === JSON.stringify(resumePositions(second));
}

export function validateResumePreview(positions, protectedPositions) {
  const expected = new Map(resumePositions(protectedPositions).map((p) => [`${p.contract}:${p.position_side}`, p.size]));
  for (const p of positions) {
    const key = `${p.contract}:${p.position_side}`;
    if (p.intent || p.delta_size !== 0 || !Number.isFinite(p.target_size)
      || p.target_size !== (expected.get(key) || 0) || p.size !== p.target_size) return false;
    expected.delete(key);
  }
  return expected.size === 0;
}

export function deriveProtectedMemberPositions(memberPositions, platformPositions) {
  if (!Array.isArray(platformPositions)) throw new Error('RESUME_POSITIONS_INVALID');
  const platform = new Map();
  for (const position of platformPositions) {
    const size = Number(position.size);
    const side = position.position_side || position.positionSide;
    if (!/^[A-Z0-9_]{2,80}$/.test(position.contract || '') || position.size == null
      || !Number.isFinite(size) || Math.abs(size) > Number.MAX_SAFE_INTEGER
      || !['LONG', 'SHORT'].includes(side)) throw new Error('RESUME_POSITIONS_INVALID');
    const key = `${position.contract}:${side}`;
    if (platform.has(key)) throw new Error('RESUME_DUPLICATE_POSITION');
    // A durable fill sum is a signed history delta, not a Gate position. An
    // old LONG leg can therefore have a negative net after later closes (and
    // vice versa). Keep the signed value here; the clamp below only attributes
    // it when it still has the same direction as the current Gate position.
    platform.set(key, size);
  }
  return resumePositions(memberPositions).map((position) => {
    const platformSize = platform.get(`${position.contract}:${position.position_side}`) || 0;
    const retainedPlatformSize = Math.sign(platformSize) === Math.sign(position.size)
      ? Math.sign(position.size) * Math.min(Math.abs(position.size), Math.abs(platformSize))
      : 0;
    return {
      ...position,
      // Gate exposes one aggregate quantity per leg. The durable sum of fills
      // submitted by this platform is the copied component; the residual is the
      // member-owned component that must survive a pause/resume unchanged.
      size: position.size - retainedPlatformSize,
    };
  }).filter((position) => position.size !== 0);
}

export function validateCurrentMasterSyncPreview(positions, memberPositions, protectedPositions) {
  // Resume is allowed to reconcile the copied component to the Master's
  // current portfolio. It must leave the independently held residual intact.
  if (!Array.isArray(positions)) return false;
  const actual = new Map(resumePositions(memberPositions)
    .map((position) => [`${position.contract}:${position.position_side}`, position.size]));
  const protectedByKey = new Map(resumePositions(protectedPositions)
    .map((position) => [`${position.contract}:${position.position_side}`, position.size]));
  return positions.every((position) => {
    const key = `${position.contract}:${position.position_side}`;
    if (!Number.isFinite(position.target_size) || !Number.isFinite(position.size)
      || !Number.isFinite(position.delta_size) || position.size !== (actual.get(key) || 0)
      || position.member_baseline_size !== (protectedByKey.get(key) || 0)
      || !['SYNCED', 'DRIFT'].includes(position.state)) return false;
    if (position.target_size === position.size) {
      return position.delta_size === 0 && !position.intent;
    }
    const fullDelta = position.target_size - position.size;
    const resultingSize = position.size + position.delta_size;
    const reducesExposure = Math.abs(resultingSize) < Math.abs(position.size)
      && (resultingSize === 0 || Math.sign(resultingSize) === Math.sign(position.size));
    return position.state === 'DRIFT' && position.delta_size !== 0
      && Math.sign(position.delta_size) === Math.sign(fullDelta)
      && Math.abs(position.delta_size) <= Math.abs(fullDelta)
      && position.intent?.delta_size === position.delta_size
      && position.intent?.reduce_only === reducesExposure;
  });
}
