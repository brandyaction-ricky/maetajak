// Mirrors record_copy_worker_cycle_with_target_anchors + get_copy_target_anchors (20261021030000) for one planned
// leg, so planner-only tests can chain cycles the way the database stores anchors.
export function anchorFromPlan(p, resumeVersion = 'r1') {
  if (!p.anchor_update_allowed) return null;
  const sameSideNotLarger = (value, of) => [0, Math.sign(of)].includes(Math.sign(value)) && Math.abs(value) <= Math.abs(of);
  const target = p.anchor_target_size != null && sameSideNotLarger(p.anchor_target_size, p.target_size)
    ? p.anchor_target_size : p.target_size;
  const desired = p.anchor_desired_target_size;
  const desiredValid = desired != null && (Math.sign(desired) === 0 || Math.sign(desired) === Math.sign(target))
    && Math.abs(desired) >= Math.abs(target);
  const anchorMaster = p.anchor_master_copyable_size != null && sameSideNotLarger(p.anchor_master_copyable_size, p.master_copyable_size)
    ? p.anchor_master_copyable_size : p.master_copyable_size;
  const reference = p.anchor_reference_master_size != null && sameSideNotLarger(p.anchor_reference_master_size, anchorMaster)
    ? p.anchor_reference_master_size : null;
  return { contract: p.contract, position_side: p.position_side, resume_version: resumeVersion, master_copyable_size: anchorMaster,
    target_size: target, protected_member_size: p.member_baseline_size || 0, lock_reason: p.target_lock_reason,
    ...(desiredValid ? { desired_target_size: desired } : {}),
    reference_master_size: reference, observed_master_size: p.master_copyable_size,
    max_position_ratio: p.anchor_max_position_ratio > 0 && p.anchor_max_position_ratio <= 100 ? p.anchor_max_position_ratio : null };
}
