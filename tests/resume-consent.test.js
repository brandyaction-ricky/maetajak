import test, { before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createVerifiedDatabase, seedVerifiedAccount, ids, position, contracts, record, cyclePayload } from './fixtures/verified-runtime.js';
import { TradingRunner, planMemberPositions } from '../worker/trading-runner.js';
import { resumePositions } from '../worker/member-resume.js';

let db;
const one = async (query, values = []) => (await db.query(query, values)).rows[0];
before(async () => { db = await createVerifiedDatabase(); });
after(async () => { await db?.close(); });
beforeEach(async () => { await db.exec('begin'); await seedVerifiedAccount(db); });
afterEach(async () => { await db.exec('rollback'); });

async function request() {
  await db.query("update private.copy_resume_sessions set state='PAUSED' where trading_account_id=$1", [ids.member]);
  await db.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claim.role','authenticated',false)", [ids.user]);
  await db.query("select public.set_my_copy_pause('RESUME')");
  await db.exec("select set_config('request.jwt.claim.role','service_role',false)");
  return (await one('select public.get_copy_resume_context() value')).value.find(s => s.trading_account_id === ids.member);
}

test('incident regression: ordinary RESUME must not authorize current-portfolio catch-up', async () => {
  const s = await request();
  assert.equal(s.sync_current_master, false);
  assert.equal(Number((await one('select count(*) n from private.copy_operation_history')).n), 0);
});

test('incident regression: unreceipted current-seed session cannot reach activation', async () => {
  const s = await request(); s.sync_current_master = true;
  const calls = [];
  const runner = new TradingRunner({ supabase: {}, mode: 'LIVE', fetchImpl: () => { throw new Error('EXCHANGE_DISABLED'); } });
  runner.readResumeSnapshot = async () => {
    const now = Date.now();
    return { startedAt: now, openOrders: [], master: { total: 20000, positionMode: 'dual', positions: [position(40)], observed_at: new Date(now).toISOString() },
      member: { total: 5000, available: 4500, positionMode: 'dual', copy_ratio: 100, max_position_ratio: 30, positions: [], observed_at: new Date(now).toISOString() } };
  };
  runner.rpc = async (name, params) => { calls.push({ name, params }); return { state: 'ACTIVE' }; };
  await runner.processMemberResume({ session: s, memberContext: { trading_account_id: ids.member }, masterContext: {}, contracts,
    system: { execution_enabled: true, emergency_halted: false } });
  assert.deepEqual(calls.map(c => c.name), ['report_member_copy_resume_blocker']);
  assert.equal(calls[0].params.p_reason, 'RESUME_CURRENT_MASTER_AUTHORIZATION_REQUIRED');
});

test('incident regression: old current-seed flag cannot authorize a claimed intent', async () => {
  await record(db, cyclePayload());
  await db.query('update private.copy_resume_sessions set sync_current_master=true where trading_account_id=$1', [ids.member]);
  assert.deepEqual((await db.query('select * from public.claim_copy_order_intents(10)')).rows, []);
});

async function snapshot(master = [position(40)], member = [position(7), position(-3)]) {
  const now = new Date().toISOString();
  return { resume_policy_version: 1, resume_mode: 'FUTURE_ONLY', current_master_operation_id: null,
    started_at: now, observed_at: now, open_order_count: 0, preview_passed: true,
    observed_master_positions: resumePositions(master), observed_member_positions: resumePositions(member),
    master_positions: resumePositions(master), member_positions: resumePositions(member),
    settings: (await one('select private.copy_resume_settings($1) settings', [ids.user])).settings };
}

test('SQL prepare and activation retain an exact future-only baseline, including both hedge legs', async () => {
  const s = await request(); const p = await snapshot();
  await db.query('select public.prepare_member_copy_resume($1,$2,$3)', [ids.member, s.version, p]);
  const activated = await one('select public.activate_member_copy_resume($1,$2,$3) value', [ids.member, s.version, p]);
  assert.equal(activated.value.state, 'ACTIVE');
  const b = await one('select positions,member_positions from private.member_copy_onboarding_baselines where trading_account_id=$1', [ids.member]);
  assert.deepEqual(b.positions, p.observed_master_positions);
  assert.deepEqual(b.member_positions, p.observed_member_positions);
});

for (const [name, mutate, error] of [
  ['missing policy evidence', p => { delete p.resume_policy_version; }, /RESUME_POLICY_EVIDENCE_REQUIRED/],
  ['empty Master baseline', p => { p.master_positions = []; }, /RESUME_FUTURE_ONLY_BASELINE_REQUIRED/],
  ['historical fills subtracted from personal holdings', p => { p.member_positions[0].size = 2; }, /RESUME_FUTURE_ONLY_BASELINE_REQUIRED/],
  ['forged current-seed approval', p => { p.resume_mode = 'CURRENT_MASTER'; p.current_master_operation_id = ids.version; p.master_positions = []; }, /RESUME_FUTURE_ONLY_BASELINE_REQUIRED/],
]) {
  test(`SQL rejects ${name} without replacing the baseline`, async () => {
    const s = await request(); const p = await snapshot(); mutate(p);
    await assert.rejects(db.query('select public.prepare_member_copy_resume($1,$2,$3)', [ids.member, s.version, p]), error);
  });
}

test('SQL activation rechecks consent after a valid prepare', async () => {
  const s = await request(); const p = await snapshot();
  await db.query('select public.prepare_member_copy_resume($1,$2,$3)', [ids.member, s.version, p]);
  await db.query('update private.copy_resume_sessions set sync_current_master=true where trading_account_id=$1', [ids.member]);
  await assert.rejects(db.query('select public.activate_member_copy_resume($1,$2,$3)', [ids.member, s.version, p]), /RESUME_CURRENT_MASTER_AUTHORIZATION_REQUIRED/);
});

test('SQL cannot authorize a previously claimed intent after consent is invalidated', async () => {
  await record(db, cyclePayload());
  const [job] = (await db.query('select * from public.claim_copy_order_intents(10)')).rows;
  await db.query('update private.copy_resume_sessions set sync_current_master=true where trading_account_id=$1', [ids.member]);
  const result = await one('select public.authorize_copy_order_submission($1,$2) allowed', [job.intent_id, ids.version]);
  assert.equal(result.allowed, false);
  assert.equal((await one('select submission_authorized_at from private.copy_order_intents where id=$1', [job.intent_id])).submission_authorized_at, null);
});

test('an explicit new-operation receipt never permits adopting non-flat or hedged member holdings', async () => {
  const s = await request(); s.sync_current_master = true; s.current_master_operation_id = ids.version;
  const calls = [];
  const runner = new TradingRunner({ supabase: {}, mode: 'LIVE', fetchImpl: () => { throw new Error('EXCHANGE_DISABLED'); } });
  runner.readResumeSnapshot = async () => {
    const now = Date.now();
    return { startedAt: now, openOrders: [], master: { total: 20000, positionMode: 'dual', positions: [position(40)], observed_at: new Date(now).toISOString() },
      member: { total: 5000, available: 4500, positionMode: 'dual', copy_ratio: 100, max_position_ratio: 30, positions: [position(7), position(-3)], observed_at: new Date(now).toISOString() } };
  };
  runner.rpc = async (name, params) => { calls.push({ name, params }); };
  await runner.processMemberResume({ session: s, memberContext: { trading_account_id: ids.member }, masterContext: {}, contracts, system: {} });
  assert.deepEqual(calls.map(c => c.name), ['report_member_copy_resume_blocker']);
  assert.equal(calls[0].params.p_reason, 'RESUME_NEW_OPERATION_NOT_FLAT');
});

test('personal and opposite hedge holdings survive ordinary resume and later Master close', () => {
  const cash = (size) => ({ ...position(size, 'CASHCAT_USDT'), markPrice: 1 });
  const protectedPositions = [position(7), position(-3), cash(700), cash(-90)];
  const allContracts = new Map([...contracts, ['CASHCAT_USDT', { quantoMultiplier: 1, sizeStep: 1, orderSizeMin: 1 }]]);
  for (const masterPositions of [[position(40)], []]) {
    const plans = planMemberPositions({ cycleId: 'TEST_ONLY', system: {}, contracts: allContracts,
      master: { total: 20000, positions: masterPositions },
      member: { total: 5000, available: 4500, copy_ratio: 100, max_position_ratio: 30, positionMode: 'dual',
        resume_version: ids.version, master_baselines: [position(40)], member_position_baselines: protectedPositions,
        positions: protectedPositions } });
    for (const plan of plans) { assert.equal(plan.intent, undefined); assert.equal(plan.target_size, plan.size); }
  }
});
