import test from 'node:test';
import assert from 'node:assert/strict';
import { TradingRunner, planMemberPositions } from './trading-runner.js';
import { observedAccount, position, contracts } from '../tests/fixtures/verified-runtime.js';
import { anchorFromPlan } from '../tests/fixtures/anchor-mirror.js';

// Review 2026-10-21 (R2): fix/qa-risk D4 holds a NEW risk violation in memory for confirmation (reduce_only=true,
// risk_halt_pending) while fix/qa-sizing treats every reduce_only leg as "increase blocked" and CONSUMES a Master
// increase into the anchor (FUTURE_ONLY). A violation that is NOT confirmed (the case D4 exists for: a transfer the
// ledger had not recorded yet) therefore still loses the Master entry made in that cycle for good.
// FIXED: see the test bodies (todo markers removed).

const version = '30000000-0000-4000-8000-000000000004';
const baseMember = (fields = {}) => observedAccount({ trading_account_id: 'member', user_id: 'user', resume_version: version,
  copy_ratio: 100, max_position_ratio: 30, target_anchors: [], ...fields });
const baseMaster = (positions) => observedAccount({ trading_account_id: 'master', total: 20000, available: 18000, positions });
const plan = (member, master) => planMemberPositions({ cycleId: 'c-' + Math.random(), system: { emergency_halted: false },
  master, member, contracts });

function pendingMember(fields) {
  // Exactly what TradingRunner.confirmRiskHalt returns in the first cycle of a new violation.
  const runner = new TradingRunner({ supabase: {}, baseUrl: 'https://api.gateio.ws', workerId: 'qa', workerVersion: 'qa', mode: 'LIVE' });
  runner.cycleSeq = 1;
  return runner.confirmRiskHalt(baseMember({ trading_account_id: 'member', risk_halt_reason: 'DAILY_LOSS_LIMIT',
    profile_reduce_only: false, reduce_only: true, ...fields }));
}

test('R2 setup: a pending (unconfirmed) risk violation makes the leg reduce-only in this cycle only', () => {
  const member = pendingMember({});
  assert.equal(member.risk_halt_reason, null);
  assert.equal(member.risk_halt_pending, 'DAILY_LOSS_LIMIT');
  assert.equal(member.reduce_only, true);
});

test('R2 a Master entry seen during an unconfirmed risk violation is still copied once the violation clears', () => {
    // Cycle N: Master opens LONG 40 while the member has a pending (unconfirmed) DAILY_LOSS_LIMIT.
    const [pending] = plan(pendingMember({}), baseMaster([position(40)]));
    assert.equal(pending.intent, undefined, 'no entry while the violation is pending (correct)');
    const anchor = anchorFromPlan(pending, version);
    // Cycle N+1: the confirming re-check found the transfer; the violation is gone. Master unchanged.
    const [cleared] = plan(baseMember({ target_anchors: anchor ? [anchor] : [] }), baseMaster([position(40)]));
    assert.equal(cleared.intent?.delta_size, 10,
      `expected the entry 5 s late; got ${cleared.target_lock_reason} (pending cycle anchored ${JSON.stringify(anchor && {
        master: anchor.master_copyable_size, target: anchor.target_size, reason: anchor.lock_reason })})`);
  });
