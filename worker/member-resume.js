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
