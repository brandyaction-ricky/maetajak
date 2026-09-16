import test, { before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createVerifiedDatabase, seedVerifiedAccount, ids, position, contracts } from './fixtures/verified-runtime.js';
import { faultRunner } from './fixtures/fault-runner.js';
import { resumePositions } from '../worker/member-resume.js';

let db;
before(async () => { db = await createVerifiedDatabase(); });
after(async () => { await db?.close(); });
beforeEach(async () => { await db.exec('begin'); await seedVerifiedAccount(db); });
afterEach(async () => { await db.exec('rollback'); });
const one = async (sql, args = []) => (await db.query(sql, args)).rows[0];

async function confirm(runner) {
  await runner.syncOnce();
  await db.exec("update private.copy_order_intents set position_match_at=clock_timestamp()-interval '3 seconds' where observation_confirmed_at is null");
  await runner.syncOnce();
}
async function resume(runner) {
  // PostgREST rolls back only the failing RPC. Preserve that behavior inside
  // this test's outer rollback transaction instead of poisoning later RPCs.
  if (!runner.testResumeRpcIsolation) {
    const rpc = runner.rpc.bind(runner);
    runner.rpc = async (name, params) => {
      if (!['get_member_copy_resume_ownership','prepare_member_copy_resume','activate_member_copy_resume'].includes(name)) return rpc(name, params);
      await db.exec('savepoint resume_rpc');
      try { const result = await rpc(name, params); await db.exec('release savepoint resume_rpc'); return result; }
      catch (error) { await db.exec('rollback to savepoint resume_rpc; release savepoint resume_rpc'); throw error; }
    };
    runner.testResumeRpcIsolation = true;
  }
  await db.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claim.role','authenticated',false)", [ids.user]);
  await db.exec("select public.set_my_copy_pause('HOLD'); select public.set_my_copy_pause('RESUME')");
  await db.exec("select set_config('request.jwt.claim.role','service_role',false)");
  runner.readResumeSnapshot = async (masterContext, memberContext) => {
    const startedAt = Date.now();
    const [master, member] = await Promise.all([runner.readAccount(masterContext), runner.readAccount(memberContext)]);
    return { startedAt, master, member, openOrders: [] };
  };
  await runner.syncOnce();
}

test('CT-QA-RESUME-OWNERSHIP-001: confirmed COPY survives ordinary resume and follows later Master close', async () => {
  const exchange = { masterSize: 40, memberSize: 0, posts: 0, orders: [] };
  const { runner } = faultRunner(db, exchange);
  await runner.syncOnce(); await runner.submitOrders(); await confirm(runner);
  assert.equal(exchange.memberSize, 10);
  const fill = await one('select status,filled_size,observation_confirmed_at from private.copy_order_intents');
  assert.equal(fill.status, 'FILLED'); assert.equal(Number(fill.filled_size), 10);
  assert.ok(fill.observation_confirmed_at);
  await resume(runner);
  assert.equal((await one('select state from private.copy_resume_sessions')).state, 'ACTIVE');
  await runner.syncOnce(); await runner.submitOrders();
  assert.equal(exchange.posts, 1, 'resume must create no catch-up order');
  exchange.masterSize = 0;
  await runner.syncOnce(); await runner.submitOrders();
  assert.equal(exchange.memberSize, 0, 'confirmed COPY must not be relabelled as protected personal exposure');
  assert.equal(exchange.orders.at(-1).size, -10);
  assert.equal(exchange.orders.at(-1).is_reduce_only, true);
});

async function entered({ size = 40, fillFraction, personal = [] } = {}) {
  const exchange = { masterSize: size, memberSize: personal.find(p => p.contract === 'BTC_USDT' && p.size > 0)?.size || 0,
    posts: 0, orders: [], fillFraction };
  if (personal.length) await db.query('update private.member_copy_onboarding_baselines set member_positions=$1', [resumePositions(personal)]);
  const { runner } = faultRunner(db, exchange);
  const read = runner.readAccount.bind(runner);
  runner.readAccount = async (account) => {
    const result = await read(account);
    if (account.trading_account_id === ids.member) result.positions.push(...personal.filter(p => p.contract !== 'BTC_USDT' || p.size < 0));
    return result;
  };
  runner.loadContracts = async () => new Map([...contracts, ['MEMBER_ONLY_USDT', { quantoMultiplier: 1, sizeStep: 1, orderSizeMin: 1 }]]);
  await runner.syncOnce(); await runner.submitOrders(); await confirm(runner);
  return { runner, exchange };
}

test('same-symbol protected quantity, opposite hedge and member-only legs survive COPY partial/full close', async () => {
  const personal = [position(7), position(-3), { ...position(100, 'MEMBER_ONLY_USDT'), markPrice: 1 },
    { ...position(-20, 'MEMBER_ONLY_USDT'), markPrice: 1 }];
  const { runner, exchange } = await entered({ personal });
  assert.equal(exchange.memberSize, 17);
  await resume(runner); await runner.syncOnce(); await runner.submitOrders();
  assert.equal(exchange.posts, 1);
  exchange.masterSize = 20;
  await runner.syncOnce(); await runner.submitOrders(); await confirm(runner);
  assert.equal(exchange.memberSize, 12);
  exchange.masterSize = 0;
  await runner.syncOnce(); await runner.submitOrders(); await confirm(runner);
  assert.equal(exchange.memberSize, 7);
  assert.deepEqual(exchange.orders.map(o => [o.contract, o.size, o.is_reduce_only]),
    [['BTC_USDT', 10, false], ['BTC_USDT', -5, true], ['BTC_USDT', -5, true]]);
  const proof = await one('select copy_positions,protected_positions,status from private.copy_ownership_checkpoints');
  assert.equal(proof.status, 'CONFIRMED'); assert.deepEqual(proof.copy_positions, []);
  assert.deepEqual(proof.protected_positions, resumePositions(personal));
});

test('terminal partial fill carries only observed contracts, never the unfilled target', async () => {
  const { runner, exchange } = await entered({ fillFraction: 0.5 });
  assert.equal(exchange.memberSize, 5);
  await resume(runner); await runner.syncOnce(); await runner.submitOrders();
  assert.equal(exchange.posts, 1);
  exchange.fillFraction = 1; exchange.masterSize = 20;
  await runner.syncOnce(); await runner.submitOrders(); await confirm(runner);
  assert.equal(exchange.memberSize, 2, 'five confirmed contracts reduce proportionally with integer precision');
  exchange.masterSize = 0;
  await runner.syncOnce(); await runner.submitOrders();
  assert.equal(exchange.memberSize, 0);
  assert.deepEqual(exchange.orders.map(o => o.size), [10, -3, -2]);
});

test('repeated resume/worker observations preserve attribution and never double-consume a fill', async () => {
  const { runner, exchange } = await entered();
  for (let n = 0; n < 3; n++) {
    await resume(runner); await runner.syncOnce(); await runner.submitOrders(); await confirm(runner);
    assert.equal(exchange.posts, 1);
    const proof = await one('select copy_positions from private.copy_ownership_checkpoints');
    assert.deepEqual(proof.copy_positions, resumePositions([position(10)]));
    assert.equal(Number((await one('select count(*) n from private.copy_ownership_fills')).n), 1);
  }
  exchange.masterSize = 0; await runner.syncOnce(); await runner.submitOrders();
  assert.equal(exchange.memberSize, 0); assert.equal(exchange.posts, 2);
});

test('Master changes during HOLD are not replayed; only post-resume increases are allocated', async () => {
  const { runner, exchange } = await entered();
  exchange.masterSize = 80;
  await resume(runner); await runner.syncOnce(); await runner.submitOrders();
  assert.equal(exchange.posts, 1); assert.equal(exchange.memberSize, 10);
  exchange.masterSize = 88;
  await runner.syncOnce(); await runner.submitOrders(); await confirm(runner);
  assert.equal(exchange.memberSize, 12, 'carry ten plus two new contracts, not full-portfolio twenty-two');
  exchange.masterSize = 44;
  await runner.syncOnce(); await runner.submitOrders();
  assert.equal(exchange.memberSize, 6);
});

test('SHORT COPY resumes on its own leg and closes with a reduce-only BUY', async () => {
  const { runner, exchange } = await entered({ size: -40 });
  assert.equal(exchange.memberSize, -10);
  await resume(runner); await runner.syncOnce(); await runner.submitOrders();
  assert.equal(exchange.posts, 1);
  exchange.masterSize = 0; await runner.syncOnce(); await runner.submitOrders();
  assert.equal(exchange.memberSize, 0);
  assert.equal(exchange.orders.at(-1).size, 10); assert.equal(exchange.orders.at(-1).is_reduce_only, true);
});

for (const [label, change, expected] of [
  ['manual reduction', e => { e.memberSize = 7; }, 'RESUME_COPY_OWNERSHIP_UNKNOWN'],
  ['manual increase', e => { e.memberSize = 13; }, 'RESUME_COPY_OWNERSHIP_UNKNOWN'],
  ['Master already flat at resume', e => { e.masterSize = 0; }, 'RESUME_COPY_SOURCE_MISSING'],
  ['Master reversed during HOLD', e => { e.masterSize = -40; }, 'RESUME_COPY_SOURCE_MISSING'],
]) {
  test(`${label} blocks resume explicitly without trading or reclassifying COPY`, async () => {
    const { runner, exchange } = await entered(); change(exchange);
    const before = exchange.memberSize;
    await resume(runner); await runner.syncOnce(); await runner.submitOrders();
    const session = await one('select state,blocker_reason from private.copy_resume_sessions');
    assert.notEqual(session.state, 'ACTIVE'); assert.equal(session.blocker_reason, expected);
    assert.equal(exchange.posts, 1); assert.equal(exchange.memberSize, before);
    assert.equal((await one('select copy_paused from public.profiles')).copy_paused, true);
  });
}

test('a detected ownership mismatch stays UNKNOWN even if quantity later returns to its old value', async () => {
  const { runner, exchange } = await entered();
  exchange.memberSize = 7; await runner.syncOnce();
  assert.equal((await one('select status from private.copy_ownership_checkpoints')).status, 'UNKNOWN');
  exchange.memberSize = 10; await resume(runner); await runner.submitOrders();
  assert.equal((await one('select blocker_reason from private.copy_resume_sessions')).blocker_reason, 'RESUME_COPY_OWNERSHIP_UNKNOWN');
  assert.equal(exchange.posts, 1);
});

test('legacy historical fills without a checkpoint are not accepted as ownership evidence', async () => {
  const { runner, exchange } = await entered();
  // Corrupt only this rollback-isolated fixture to represent a pre-journal account.
  await db.exec('delete from private.copy_ownership_fills; delete from private.copy_ownership_checkpoints');
  await resume(runner); await runner.submitOrders();
  assert.equal((await one('select blocker_reason from private.copy_resume_sessions')).blocker_reason, 'RESUME_COPY_OWNERSHIP_UNKNOWN');
  assert.equal(exchange.posts, 1); assert.equal(exchange.memberSize, 10);
});

test('unconfirmed terminal fill blocks resume even when predating the latest global halt', async () => {
  const exchange = { masterSize: 40, memberSize: 0, posts: 0, orders: [] };
  const { runner } = faultRunner(db, exchange);
  await runner.syncOnce(); await runner.submitOrders();
  await db.exec('update public.copy_system_control set updated_at=clock_timestamp()');
  await resume(runner); await runner.submitOrders();
  assert.equal((await one('select blocker_reason from private.copy_resume_sessions')).blocker_reason, 'RESUME_UNRESOLVED_OWNERSHIP');
  assert.equal(exchange.posts, 1);
});

test('ownership RPC and private implementation bypasses are unavailable to anonymous and member roles', async () => {
  const privileges = await one(`select
    has_function_privilege('anon','public.get_member_copy_resume_ownership(uuid,uuid,jsonb,jsonb)','execute') anon,
    has_function_privilege('authenticated','public.get_member_copy_resume_ownership(uuid,uuid,jsonb,jsonb)','execute') member,
    has_function_privilege('service_role','public.get_member_copy_resume_ownership(uuid,uuid,jsonb,jsonb)','execute') worker,
    has_function_privilege('service_role','private.activate_member_copy_resume_core(uuid,uuid,jsonb)','execute') bypass`);
  assert.deepEqual(privileges, { anon: false, member: false, worker: true, bypass: false });
});

for (const [label, mutate, error] of [
  ['forged COPY/protected split', async p => { p.ownership.copy_positions[0].size = 20; }, /RESUME_OWNERSHIP_EVIDENCE_CHANGED/],
  ['changed Master on a carried leg', async p => {
    p.observed_master_positions[0].size = 80; p.ownership.target_anchors[0].master_copyable_size = 80;
  }, /RESUME_OWNERSHIP_EVIDENCE_CHANGED/],
  ['a stale ownership revision', async () => { await db.exec('update private.copy_ownership_checkpoints set revision=revision+1'); }, /RESUME_OWNERSHIP_EVIDENCE_CHANGED/],
  ['an overwritten target anchor', async () => { await db.exec('update private.copy_target_anchors set target_size=20'); }, /RESUME_OWNERSHIP_ANCHOR_CHANGED/],
]) {
  test(`SQL activation rejects ${label} without activating or trading`, async () => {
    const { runner, exchange } = await entered(); runner.mode = 'DRY_RUN';
    await resume(runner);
    const s = await one('select * from private.copy_resume_sessions'); assert.equal(s.state, 'VALIDATED');
    const p = { ...s.validation_evidence, started_at: new Date(s.snapshot_started_at).toISOString(),
      observed_at: new Date(s.snapshot_observed_at).toISOString() };
    await mutate(p);
    await db.exec('savepoint rejected_activation');
    await assert.rejects(db.query('select public.activate_member_copy_resume($1,$2,$3)', [ids.member,s.version,p]), error);
    await db.exec('rollback to savepoint rejected_activation; release savepoint rejected_activation');
    assert.equal((await one('select state from private.copy_resume_sessions')).state, 'VALIDATED');
    assert.equal((await one('select copy_paused from public.profiles')).copy_paused, true);
    assert.equal(exchange.posts, 1);
  });
}

test('resume cannot adopt a confirmed COPY through the obsolete protect-all v1 policy', async () => {
  const { runner } = await entered(); runner.mode = 'DRY_RUN'; await resume(runner);
  const s = await one('select * from private.copy_resume_sessions');
  const p = { ...s.validation_evidence, resume_policy_version: 1, member_positions: resumePositions([position(10)]),
    master_positions: resumePositions([position(40)]), started_at: new Date(s.snapshot_started_at).toISOString(),
    observed_at: new Date(s.snapshot_observed_at).toISOString() };
  delete p.ownership;
  await assert.rejects(db.query('select public.prepare_member_copy_resume($1,$2,$3)', [ids.member,s.version,p]), /RESUME_OWNERSHIP_POLICY_REQUIRED/);
});

test('resume over the current risk cap is blocked with no automatic liquidation', async () => {
  const { runner, exchange } = await entered(); exchange.memberEquity = 1000;
  await resume(runner); await runner.submitOrders();
  assert.equal((await one('select blocker_reason from private.copy_resume_sessions')).blocker_reason, 'RESUME_PREVIEW_NOT_ZERO');
  assert.equal(exchange.posts, 1); assert.equal(exchange.memberSize, 10);
});

test('an UNKNOWN timeout resolves by order query and observation, never by a duplicate entry', async () => {
  const exchange = { masterSize: 40, memberSize: 0, posts: 0, orders: [] };
  const { runner } = faultRunner(db, exchange, { exchange: 'timeout' });
  await runner.syncOnce(); await runner.submitOrders();
  assert.equal((await one('select status from private.copy_order_intents')).status, 'UNKNOWN');
  await db.exec("update private.copy_reconciliation_jobs set run_after=clock_timestamp()-interval '1 second',claimed_at=null");
  await runner.reconcileOrders(); await confirm(runner);
  await resume(runner); await runner.syncOnce(); await runner.submitOrders();
  assert.equal(exchange.posts, 1); assert.equal(exchange.memberSize, 10);
  assert.equal((await one('select state from private.copy_resume_sessions')).state, 'ACTIVE');
});
