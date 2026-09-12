import test from 'node:test';
import assert from 'node:assert/strict';
import { TradingRunner, planMemberPositions } from './trading-runner.js';
import {
  deriveProtectedMemberPositions, resumePositions, sameResumePositions,
  validateCurrentMasterSyncPreview, validateResumeSnapshot,
} from './member-resume.js';
const contracts = new Map([['BTC_USDT', { quantoMultiplier: 0.001, sizeStep: 1, orderSizeMin: 1 }]]);
const positions = (size) => [{ contract: 'BTC_USDT', positionSide: 'LONG', size, markPrice: 50_000 }];
function fixture(mode = 'LIVE') {
  const calls = [];
  const runner = new TradingRunner({ supabase: {}, mode, fetchImpl: () => { throw new Error('No exchange writes allowed during resume'); } });
  runner.readResumeSnapshot = async () => {
    const now = Date.now();
    return { startedAt: now, openOrders: [], master: { positions: positions(100), total: 10_000, positionMode: 'single', observed_at: new Date(now).toISOString() },
      member: { user_id: 'member', positions: positions(7), total: 10_000, positionMode: 'single', copy_ratio: 100, max_position_ratio: 30, observed_at: new Date(now).toISOString() } };
  };
  runner.rpc = async (name, params) => { calls.push({ name, params }); return { state: name.startsWith('activate') ? 'ACTIVE' : 'VALIDATED' }; };
  const input = { session: { state: 'REQUESTED', version: 'v1', expires_at: new Date(Date.now() + 60_000).toISOString(), unresolved_orders: 0 },
    masterContext: {}, memberContext: { trading_account_id: 'account', user_id: 'member' }, contracts,
    system: { execution_enabled: true, emergency_halted: false } };
  return { runner, calls, input };
}
test('resume observes twice, saves exact holdings, and then requests activation without exchange writes', async () => {
  const { runner, calls, input } = fixture();
  await runner.processMemberResume(input);
  assert.deepEqual(calls.map((c) => c.name), ['prepare_member_copy_resume', 'activate_member_copy_resume']);
  assert.equal(calls[0].params.p_snapshot.member_positions[0].size, 7);
  assert.equal(calls[0].params.p_snapshot.master_positions[0].size, 100);
});
test('DRY_RUN and globally halted execution never request member activation', async () => {
  for (const dryRun of [true, false]) {
    const { runner, calls, input } = fixture(dryRun ? 'DRY_RUN' : 'LIVE');
    if (!dryRun) input.system.emergency_halted = true;
    await runner.processMemberResume(input);
    assert.deepEqual(calls.map((c) => c.name), ['prepare_member_copy_resume']);
    if (dryRun) assert.equal(await runner.submitOrders(), 0);
  }
});
test('unknown legacy orders prevent baseline reads and preserve the paused state', async () => {
  const { runner, calls, input } = fixture(); input.session.unresolved_orders = 1;
  runner.readResumeSnapshot = () => { throw new Error('Must not snapshot unresolved exposure'); };
  await runner.processMemberResume(input);
  assert.deepEqual(calls.map((c) => c.name), ['report_member_copy_resume_blocker']);
  assert.equal(calls[0].params.p_reason, 'RESUME_UNRESOLVED_ORDERS');
});
test('position changes during validation are retried instead of activating a stale baseline', async () => {
  const { runner, calls, input } = fixture(); const read = runner.readResumeSnapshot.bind(runner); let n = 0;
  runner.readResumeSnapshot = async () => { const r = await read(); if (++n === 2) r.member.positions = positions(8); return r; };
  await runner.processMemberResume(input);
  assert.deepEqual(calls.map((c) => c.name), ['prepare_member_copy_resume', 'report_member_copy_resume_blocker']);
  assert.equal(calls[1].params.p_reason, 'RESUME_SNAPSHOT_CHANGED');
});
test('price jitter alone does not change the signed contract baseline', () => {
  assert.equal(sameResumePositions(positions(7), [{ ...positions(7)[0], markPrice: 50_123.45 }]), true);
  assert.equal(sameResumePositions(positions(7), positions(7.01)), false);
});
test('invalid positions, duplicate legs, open orders and skewed snapshots fail closed', async () => {
  for (const p of [null, [{ contract: 'BTC_USDT', size: NaN }], [...positions(7), ...positions(7)]]) assert.throws(() => resumePositions(p));
  const f = fixture(); const s = await f.runner.readResumeSnapshot();
  assert.equal(validateResumeSnapshot({ ...s, contracts, openOrders: [{}] }), 'RESUME_OPEN_EXCHANGE_ORDERS');
  s.master.observed_at = new Date(s.startedAt - 10_000).toISOString();
  assert.equal(validateResumeSnapshot({ ...s, contracts }), 'RESUME_SNAPSHOT_SKEW');
});
test('existing holdings are kept when master closes, and manually reduced holdings are never repurchased', () => {
  const member = { user_id: 'm', total: 10_000, copy_ratio: 100, max_position_ratio: 30,
    positions: positions(7), master_baselines: positions(100), member_position_baselines: positions(7) };
  const input = { cycleId: 'c', system: {}, master: { total: 10_000, positions: [] }, member, contracts };
  const [kept] = planMemberPositions(input);
  assert.equal(kept.target_size, 7); assert.equal(kept.intent, undefined);
  const [manual] = planMemberPositions({ ...input, member: { ...member, positions: positions(3) } });
  assert.equal(manual.state, 'MANUAL_OVERRIDE'); assert.equal(manual.intent, undefined);
});
test('copying a later increase never changes the leverage of the protected existing holding', () => {
  const [p] = planMemberPositions({ cycleId: 'c', system: {}, master: { total: 10_000, positions: [{ ...positions(110)[0], leverage: 10 }] },
    member: { user_id: 'm', total: 10_000, copy_ratio: 100, max_position_ratio: 30, positions: positions(7),
      master_baselines: positions(100), member_position_baselines: positions(7) }, contracts });
  assert.equal(p.intent.delta_size, 10); assert.equal(p.intent.target_leverage, null);
});
test('an unvalidated member never creates intents even in a LIVE process', () => {
  const [p] = planMemberPositions({ cycleId: 'c', system: {}, master: { total: 10_000, positions: positions(100) },
    member: { user_id: 'm', total: 10_000, copy_ratio: 100, max_position_ratio: 30, positions: [], resume_required: true }, contracts });
  assert.equal(p.intent, undefined); assert.equal(p.state, 'PAUSED');
});
test('protected holdings count toward the position cap without being automatically sold', () => {
  const build = (held) => planMemberPositions({ cycleId: 'c', system: {}, master: { total: 10_000, positions: positions(100) },
    member: { user_id: 'm', total: 10_000, copy_ratio: 100, max_position_ratio: 30, positions: positions(held),
      member_position_baselines: positions(held) }, contracts })[0];
  assert.equal(build(50).target_size, 60);
  assert.equal(build(70).target_size, 70);
  assert.equal(build(70).intent, undefined);
});

test('new operation validates a full current-Master preview and stores no Master baseline', async () => {
  const { runner, calls, input } = fixture();
  input.session.sync_current_master = true;
  runner.readResumeSnapshot = async () => {
    const now = Date.now();
    return {
      startedAt: now,
      openOrders: [],
      master: {
        positions: positions(100), total: 10_000, positionMode: 'single',
        observed_at: new Date(now).toISOString(),
      },
      member: {
        user_id: 'member', positions: [], total: 5_000, available: 5_000,
        positionMode: 'single', copy_ratio: 100, max_position_ratio: 30,
        observed_at: new Date(now).toISOString(),
      },
    };
  };

  const result = await runner.processMemberResume(input);

  assert.equal(result.activated, true);
  assert.deepEqual(calls.map((call) => call.name), [
    'prepare_member_copy_resume', 'activate_member_copy_resume',
  ]);
  assert.deepEqual(calls[0].params.p_snapshot.master_positions, []);
  assert.deepEqual(calls[0].params.p_snapshot.member_positions, []);
});

test('resume attribution keeps only quantities not filled by the platform as protected', () => {
  assert.deepEqual(deriveProtectedMemberPositions([
    { contract: 'BTC_USDT', positionSide: 'LONG', size: 84 },
    { contract: 'HYPE_USDT', positionSide: 'LONG', size: 73 },
    { contract: 'HOOD_USDT', positionSide: 'LONG', size: 30 },
  ], [
    { contract: 'BTC_USDT', positionSide: 'LONG', size: 84 },
    { contract: 'HOOD_USDT', positionSide: 'LONG', size: 11 },
  ]), [
    { contract: 'HOOD_USDT', position_side: 'LONG', size: 19 },
    { contract: 'HYPE_USDT', position_side: 'LONG', size: 73 },
  ]);
});

test('ordinary current-Master resume preserves personal residual and reconciles copied exposure', async () => {
  const { runner, calls, input } = fixture();
  input.session.sync_current_master = true;
  input.session.platform_positions = positions(5);

  const result = await runner.processMemberResume(input);

  assert.equal(result.activated, true);
  assert.deepEqual(calls[0].params.p_snapshot.master_positions, []);
  assert.deepEqual(calls[0].params.p_snapshot.member_positions, positions(2).map(({ contract, positionSide, size }) => ({
    contract, position_side: positionSide, size,
  })));
});

test('current-Master resume accepts a safely chunked reconciliation intent', () => {
  assert.equal(validateCurrentMasterSyncPreview([{
    contract: 'BTC_USDT', position_side: 'LONG', size: 0, target_size: 100,
    member_baseline_size: 0, state: 'DRIFT', delta_size: 25,
    intent: { delta_size: 25, reduce_only: false },
  }], [], []), true);
});
