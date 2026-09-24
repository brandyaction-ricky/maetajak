import test, { before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createVerifiedDatabase, seedVerifiedAccount, cyclePayload, record, ids, position } from './fixtures/verified-runtime.js';
import { faultRunner } from './fixtures/fault-runner.js';

// DB-backed regression tests for the 2026-09-24 QA findings (P1-1, P1-4, P1-5, P1-6, P1-7, P0-1 anchor).
let db;
before(async () => { db = await createVerifiedDatabase(); });
after(async () => { await db?.close(); });
beforeEach(async () => { await db.exec('begin'); await seedVerifiedAccount(db); });
afterEach(async () => { await db.exec('rollback'); });
const one = async (sql, args = []) => (await db.query(sql, args)).rows[0];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const report = async (success, code = null) => (await one('select public.report_copy_worker_cycle($1,$2) r', [success, code])).r;
const haltEvents = async () => Number((await one("select count(*) n from public.copy_events where event_type='SYSTEM_HALTED'")).n);

test('P1-1: three quick failures degrade (no claims) but do not halt; a 5-minute streak halts once', async () => {
  await record(db, cyclePayload());
  let r;
  for (let i = 0; i < 3; i++) r = await report(false, 'DB_TIMEOUT');
  assert.equal(r.consecutive_failures, 3);
  assert.equal(r.newly_halted, false);
  assert.equal(r.halted, false);
  assert.deepEqual(await one('select execution_enabled,emergency_halted from public.copy_system_control'),
    { execution_enabled: true, emergency_halted: false });
  assert.equal((await db.query('select * from public.claim_copy_order_intents(10)')).rows.length, 0,
    'claims already stop while any failure is outstanding');
  await db.exec("update private.copy_worker_runtime set failure_started_at=now()-interval '6 minutes'");
  r = await report(false, 'DB_TIMEOUT');
  assert.equal(r.newly_halted, true);
  assert.equal(r.halted, true);
  assert.deepEqual(await one('select execution_enabled,emergency_halted,halt_reason from public.copy_system_control'),
    { execution_enabled: false, emergency_halted: true, halt_reason: 'WORKER_REPEATED_FAILURE' });
  r = await report(false, 'DB_TIMEOUT');
  assert.equal(r.newly_halted, false);
  assert.equal(await haltEvents(), 1, 'SYSTEM_HALTED is written only on the transition');
  r = await report(true);
  assert.equal(r.consecutive_failures, 0);
  assert.equal(r.failure_started_at, null);
});

test('P1-1: a later infrastructure failure never overwrites a safety halt reason', async () => {
  await db.exec("update public.copy_system_control set execution_enabled=false,emergency_halted=true,halt_reason='DUPLICATE_ORDER_ANOMALY'");
  for (let i = 0; i < 3; i++) await report(false, 'DB_TIMEOUT');
  await db.exec("update private.copy_worker_runtime set failure_started_at=now()-interval '10 minutes'");
  const r = await report(false, 'DB_TIMEOUT');
  assert.equal(r.newly_halted, false);
  assert.equal((await one('select halt_reason from public.copy_system_control')).halt_reason, 'DUPLICATE_ORDER_ANOMALY');
  assert.equal(await haltEvents(), 0);
});

async function executeNext({ confirm = true } = {}) {
  const [job] = (await db.query('select * from public.claim_copy_order_intents(10)')).rows;
  assert.ok(job, 'an intent must be claimable');
  assert.equal((await one('select public.authorize_copy_order_submission($1,$2) ok', [job.intent_id, ids.version])).ok, true);
  await db.query("select public.complete_copy_order_attempt($1,'FILLED','g-'||$2,$3,50000,201,'filled',null,'{\"terminal\":true}')",
    [job.intent_id, String(Date.now()) + Math.random(), Number(job.delta_size)]);
  if (confirm) await db.query('update private.copy_order_intents set position_match_at=now()-interval \'3 seconds\', observation_confirmed_at=now() where id=$1', [job.intent_id]);
  return job;
}
const anchorsNow = async () => (await db.query(`select contract,position_side,resume_version,master_copyable_size::float8 master_copyable_size,
  target_size::float8 target_size from private.copy_target_anchors`)).rows;
const detect = async () => (await one('select public.detect_and_halt_copy_order_anomaly() r')).r;

test('P1-7 (QA s5): open -> close -> reopen from the same size within 30 s is normal trading, not a halt', async () => {
  await record(db, cyclePayload({ masterSize: 40, actualSize: 0 })); await executeNext();
  assert.equal((await detect()).anomaly_detected, false);
  await sleep(30);
  await record(db, cyclePayload({ masterSize: 0, actualSize: 10, member: { target_anchors: await anchorsNow(),
    previous_states: [{ contract: 'BTC_USDT', position_side: 'LONG', actual_size: 10, state: 'SYNCED' }] } }));
  await executeNext();
  assert.equal((await detect()).anomaly_detected, false);
  await sleep(30);
  await record(db, cyclePayload({ masterSize: 40, actualSize: 0, member: { target_anchors: await anchorsNow(),
    previous_states: [{ contract: 'BTC_USDT', position_side: 'LONG', actual_size: 0, state: 'SYNCED' }] } }));
  assert.equal(Number((await one("select count(*) n from private.copy_order_intents where status='PLANNED'")).n), 1);
  assert.equal((await detect()).anomaly_detected, false);
  assert.deepEqual(await one('select execution_enabled,emergency_halted from public.copy_system_control'),
    { execution_enabled: true, emergency_halted: false });
});

async function insertIntent(fields) {
  // Times are offsets (ms) from the transaction start so they fall inside the detector window.
  const id = crypto.randomUUID();
  await db.query(`insert into private.copy_order_intents(id,cycle_id,user_id,trading_account_id,contract,position_side,target_size,
    actual_size_at_plan,delta_size,reduce_only,idempotency_key,gate_order_text,status,submit_attempts,filled_size,resume_version,
    source_observed_at,created_at,observation_confirmed_at)
    values($1,gen_random_uuid(),$2,$3,'BTC_USDT','LONG',10,0,10,false,$4,$5,$6,$7,$8,$9,now(),
      now()+$10*interval '1 millisecond',case when $11::int is null then null else now()+$11*interval '1 millisecond' end)`,
  [id, ids.user, ids.member, `k-${id}`, `t-mtj-${id.replace(/-/g, '').slice(0, 20)}`, fields.status, fields.submit_attempts ?? 1,
    fields.filled_size ?? 0, ids.version, fields.at, fields.confirmed_at ?? null]);
  return id;
}

test('P1-7: a second same-size intent while the first fill is unobserved is still a duplicate (halts)', async () => {
  await db.exec('alter table private.copy_order_intents disable trigger guard_copy_resume_order');
  await insertIntent({ status: 'FILLED', filled_size: 10, at: 1 });
  await insertIntent({ status: 'PLANNED', submit_attempts: 0, at: 5 });
  const r = await detect();
  assert.equal(r.anomaly_detected, true);
  assert.equal(r.duplicate_count, 2);
  assert.equal((await one('select halt_reason from public.copy_system_control')).halt_reason, 'DUPLICATE_ORDER_ANOMALY');
});

test('P1-7: an earlier plan that never reached Gate, or whose fill was observed first, is not a duplicate', async () => {
  await db.exec('alter table private.copy_order_intents disable trigger guard_copy_resume_order');
  await insertIntent({ status: 'PLANNED', submit_attempts: 0, at: 1 });
  await insertIntent({ status: 'FILLED', filled_size: 10, at: 2, confirmed_at: 3 });
  await insertIntent({ status: 'PLANNED', submit_attempts: 0, at: 5 });
  assert.equal((await detect()).anomaly_detected, false);
});

const soxl = (size) => ({ contract: 'SOXL_USDT', positionSide: 'LONG', size, markPrice: 50, entryPrice: 50, leverage: 5,
  mode: 'dual_long', posMarginMode: 'cross' });

async function closingCycles(held, masterPositions, protectedLegs = []) {
  const version = (await one('select version from private.copy_resume_sessions')).version;
  const legs = () => [...held].filter(([, s]) => s).map(([c, s]) => (c === 'BTC_USDT' ? position(s) : soxl(s)));
  for (let i = 0; i < 6; i++) {
    await sleep(15);
    await record(db, cyclePayload({ master: { positions: masterPositions }, member: {
      positions: legs(), resume_version: version, close_positions_requested: true, reduce_only: true, copy_paused: true,
      member_position_baselines: protectedLegs,
      previous_states: [...held].map(([c, s]) => ({ contract: c, position_side: 'LONG', actual_size: s, state: 'SYNCED' })) } }));
    const [job] = (await db.query('select * from public.claim_copy_order_intents(10)')).rows;
    if (!job) continue;
    assert.equal(job.reduce_only, true);
    assert.equal(Number(job.target_size), 0);
    assert.equal((await one('select public.authorize_copy_order_submission($1,$2) ok', [job.intent_id, version])).ok, true);
    await db.query("select public.complete_copy_order_attempt($1,'FILLED','g-'||$2,$3,50000,201,'filled',null,'{\"terminal\":true}')",
      [job.intent_id, String(Math.random()), Number(job.delta_size)]);
    await db.query("update private.copy_order_intents set position_match_at=now()-interval '3 seconds', observation_confirmed_at=now() where id=$1", [job.intent_id]);
    held.set(job.contract, held.get(job.contract) + Number(job.delta_size));
  }
}

async function copiedBtcAndSoxl() {
  const master = [position(40), soxl(400)];
  const held = new Map([['BTC_USDT', 0], ['SOXL_USDT', 0]]);
  for (let i = 0; i < 3; i++) {
    await sleep(15);
    await record(db, cyclePayload({ master: { positions: master }, member: {
      positions: [...held].filter(([, s]) => s).map(([c, s]) => (c === 'BTC_USDT' ? position(s) : soxl(s))),
      previous_states: [...held].map(([c, s]) => ({ contract: c, position_side: 'LONG', actual_size: s, state: 'SYNCED' })),
      target_anchors: await anchorsNow() } }));
    const [job] = (await db.query('select * from public.claim_copy_order_intents(10)')).rows;
    if (!job) continue;
    await one('select public.authorize_copy_order_submission($1,$2)', [job.intent_id, ids.version]);
    await db.query("select public.complete_copy_order_attempt($1,'FILLED','g-'||$2,$3,50000,201,'filled',null,'{\"terminal\":true}')",
      [job.intent_id, String(Math.random()), Number(job.delta_size)]);
    await db.query("update private.copy_order_intents set position_match_at=now()-interval '3 seconds', observation_confirmed_at=now() where id=$1", [job.intent_id]);
    held.set(job.contract, held.get(job.contract) + Number(job.delta_size));
  }
  return { master, held };
}

test('P1-4 (QA s12): CLOSE closes every copied leg, never latches UNKNOWN, and leaves the account resumable', async () => {
  const { master, held } = await copiedBtcAndSoxl();
  assert.ok(held.get('BTC_USDT') > 0 && held.get('SOXL_USDT') > 0);
  await db.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claim.role','authenticated',false)", [ids.user]);
  await db.exec("select public.set_my_copy_pause('CLOSE'); select set_config('request.jwt.claim.role','service_role',false)");
  await closingCycles(held, master);
  assert.deepEqual(Object.fromEntries(held), { BTC_USDT: 0, SOXL_USDT: 0 });
  const proof = await one('select status,reason,protected_positions,copy_positions from private.copy_ownership_checkpoints');
  assert.equal(proof.status, 'CONFIRMED');
  assert.equal(proof.reason, 'CLOSE_OWNERSHIP_RELEASED');
  assert.deepEqual(proof.protected_positions, []); assert.deepEqual(proof.copy_positions, []);
  // A later RESUME can compute ownership for the flat account (this used to raise RESUME_COPY_OWNERSHIP_UNKNOWN).
  await db.query("select set_config('request.jwt.claim.role','authenticated',false)");
  await db.exec("select public.set_my_copy_pause('RESUME'); select set_config('request.jwt.claim.role','service_role',false)");
  const session = await one('select version,state from private.copy_resume_sessions');
  assert.equal(session.state, 'REQUESTED');
  const ownership = (await one('select public.get_member_copy_resume_ownership($1,$2,$3,$4) o',
    [ids.member, session.version, JSON.stringify([{ contract: 'BTC_USDT', position_side: 'LONG', size: 40 }]), '[]'])).o;
  assert.deepEqual(ownership.copy_positions, []);
  assert.deepEqual(ownership.member_positions, []);
});

test('P1-4: CLOSE also closes member-protected legs and still works when ownership was already UNKNOWN', async () => {
  const { master, held } = await copiedBtcAndSoxl();
  await db.exec("update private.copy_ownership_checkpoints set status='UNKNOWN',reason='OBSERVED_OWNERSHIP_MISMATCH'");
  held.set('BTC_USDT', held.get('BTC_USDT') + 7); // a member-owned addition on the copied leg
  await db.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claim.role','authenticated',false)", [ids.user]);
  await db.exec("select public.set_my_copy_pause('CLOSE'); select set_config('request.jwt.claim.role','service_role',false)");
  await closingCycles(held, master);
  assert.deepEqual(Object.fromEntries(held), { BTC_USDT: 0, SOXL_USDT: 0 });
  assert.equal((await one('select status from private.copy_ownership_checkpoints')).status, 'CONFIRMED');
});

test('P1-4: UNKNOWN ownership still blocks every order outside CLOSE', async () => {
  await record(db, cyclePayload());
  await db.exec(`insert into private.copy_ownership_checkpoints(trading_account_id,resume_version,status,protected_positions,observed_at)
    values('${ids.member}','${ids.version}','UNKNOWN','[]',now()) on conflict(trading_account_id) do update set status='UNKNOWN'`);
  assert.equal((await db.query('select * from public.claim_copy_order_intents(10)')).rows.length, 0);
});

test('P1-5: a never-authorized intent recorded as UNKNOWN (pre-send failure, old worker) is settled as not sent', async () => {
  await record(db, cyclePayload());
  const [job] = (await db.query('select * from public.claim_copy_order_intents(10)')).rows;
  await db.query("select public.complete_copy_order_attempt($1,'UNKNOWN',null,0,null,0,null,'WORKER_GATE_TIMEOUT','{}')", [job.intent_id]);
  assert.equal((await one('select status from private.copy_order_intents where id=$1', [job.intent_id])).status, 'UNKNOWN');
  await db.exec("update private.copy_order_intents set submitted_at=now()-interval '40 seconds'");
  await db.query('select * from public.claim_copy_reconciliation_jobs(10)');
  const settled = await one('select status,exchange_terminal,last_error_code from private.copy_order_intents where id=$1', [job.intent_id]);
  assert.deepEqual(settled, { status: 'CANCELLED', exchange_terminal: true, last_error_code: 'UNSENT_UNKNOWN_RESOLVED' });
  assert.equal(Number((await one('select count(*) n from private.copy_reconciliation_jobs')).n), 0);
});

test('P1-5: an authorized order is never settled by the unsent rule', async () => {
  await record(db, cyclePayload());
  const [job] = (await db.query('select * from public.claim_copy_order_intents(10)')).rows;
  await one('select public.authorize_copy_order_submission($1,$2)', [job.intent_id, ids.version]);
  await db.query("select public.complete_copy_order_attempt($1,'UNKNOWN',null,0,null,0,null,'WORKER_GATE_TIMEOUT','{}')", [job.intent_id]);
  await db.exec("update private.copy_order_intents set submitted_at=now()-interval '40 seconds'");
  await db.query('select * from public.claim_copy_reconciliation_jobs(10)');
  assert.equal((await one('select status from private.copy_order_intents where id=$1', [job.intent_id])).status, 'UNKNOWN');
});

function lostOrderRunner(exchange) {
  const harness = faultRunner(db, exchange);
  const transport = harness.runner.fetchImpl;
  // The order request times out BEFORE Gate receives it: nothing exists at Gate.
  harness.runner.fetchImpl = async (url, request = {}) => {
    if (request.method === 'POST' && new URL(url).pathname.endsWith('/orders')) throw new DOMException('SIMULATED', 'TimeoutError');
    return transport(url, request);
  };
  return harness;
}

test('P1-5: an order Gate never received resolves to CANCELLED only after its expiry and a second lookup', async () => {
  const exchange = { masterSize: 40, memberSize: 0, posts: 0, orders: [] };
  const { runner, alerts } = lostOrderRunner(exchange);
  await runner.syncOnce(); await runner.submitOrders();
  const intent = await one('select id,status from private.copy_order_intents');
  assert.equal(intent.status, 'UNKNOWN');
  assert.ok(alerts.some((a) => a.event === 'COPY_ORDER_UNCONFIRMED'));
  // First lookup right away: not found, but the Exptime has not passed -> stays UNKNOWN.
  await db.exec("update private.copy_reconciliation_jobs set run_after=now()-interval '1 second'");
  await runner.reconcileOrders();
  assert.equal((await one('select status from private.copy_order_intents')).status, 'UNKNOWN');
  // Two minutes later, second lookup, member leg unchanged -> proven never placed.
  await db.exec("update private.copy_order_intents set source_observed_at=now()-interval '2 minutes'; update private.copy_reconciliation_jobs set run_after=now()-interval '1 second',claimed_at=null");
  const positionsCall = runner.fetchImpl;
  runner.fetchImpl = async (url, request = {}) => {
    const u = new URL(url);
    // The member leg is still flat: empty list, and Gate's single-contract read says no position.
    if (request.method === 'GET' && u.pathname.endsWith('/positions')) return new Response('[]');
    if (request.method === 'GET' && u.pathname.endsWith('/positions/BTC_USDT')) {
      return new Response(JSON.stringify({ label: 'POSITION_NOT_FOUND' }), { status: 404 });
    }
    return positionsCall(url, request);
  };
  await runner.reconcileOrders();
  const resolved = await one('select status,exchange_terminal,filled_size,last_error_code from private.copy_order_intents');
  assert.deepEqual({ ...resolved, filled_size: Number(resolved.filled_size) },
    { status: 'CANCELLED', exchange_terminal: true, filled_size: 0, last_error_code: 'NOT_FOUND_AFTER_EXPIRY' });
  assert.equal(exchange.posts, 0);
});

test('P1-5: a missing order with a changed member leg stays UNKNOWN and alerts', async () => {
  const exchange = { masterSize: 40, memberSize: 0, posts: 0, orders: [] };
  const { runner, alerts } = lostOrderRunner(exchange);
  await runner.syncOnce(); await runner.submitOrders();
  await db.exec("update private.copy_order_intents set source_observed_at=now()-interval '2 minutes'; update private.copy_reconciliation_jobs set run_after=now()-interval '1 second',attempts=1");
  const transport = runner.fetchImpl;
  runner.fetchImpl = async (url, request = {}) => {
    const u = new URL(url);
    if (request.method === 'GET' && u.pathname.endsWith('/positions')) return new Response(JSON.stringify([{
      contract: 'BTC_USDT', size: 10, mark_price: '50000', entry_price: '50000', lever: '10', mode: 'dual_long' }]));
    return transport(url, request);
  };
  await runner.reconcileOrders();
  assert.equal((await one('select status from private.copy_order_intents')).status, 'UNKNOWN');
  assert.ok(alerts.some((a) => a.event === 'COPY_ORDER_UNRESOLVED'));
});

test('P1-5: the database refuses a not-found resolution before the Gate expiry has passed', async () => {
  const exchange = { masterSize: 40, memberSize: 0, posts: 0, orders: [] };
  const { runner } = lostOrderRunner(exchange);
  await runner.syncOnce(); await runner.submitOrders();
  const job = (await one('select id from private.copy_reconciliation_jobs')).id;
  await db.query(`select public.complete_copy_reconciliation($1,'CANCELLED',null,0,null,
    '{"found":false,"resolution":"NOT_FOUND_AFTER_EXPIRY","terminal":true}')`, [job]);
  assert.equal((await one('select status from private.copy_order_intents')).status, 'UNKNOWN');
});

test('P1-5: a pre-send failure (leverage POST timeout) is REJECTED, not UNKNOWN, and the next cycle can trade', async () => {
  const exchange = { masterSize: 40, memberSize: 0, posts: 0, orders: [] };
  const { runner } = faultRunner(db, exchange);
  const transport = runner.fetchImpl;
  let leverageFails = true;
  runner.fetchImpl = async (url, request = {}) => {
    if (leverageFails && request.method === 'POST' && new URL(url).pathname.includes('leverage')) throw new DOMException('SIMULATED', 'TimeoutError');
    return transport(url, request);
  };
  await runner.syncOnce(); await runner.submitOrders();
  const first = await one('select status,last_error_code from private.copy_order_intents');
  assert.equal(first.status, 'REJECTED');
  assert.equal(exchange.posts, 0);
  leverageFails = false;
  await sleep(10);
  await runner.syncOnce(); await runner.submitOrders();
  assert.equal(exchange.posts, 1);
  assert.equal(exchange.memberSize, 10);
});

test('P1-6: a fill that never matches an observation is reported once', async () => {
  await record(db, cyclePayload());
  const job = await executeNext({ confirm: false });
  await db.query("update private.copy_order_intents set resolved_at=now()-interval '10 minutes' where id=$1", [job.intent_id]);
  const stale = (await one('select public.get_copy_stale_fill_observations(300) s')).s;
  assert.equal(stale.length, 1); assert.equal(stale[0].intent_id, job.intent_id);
  const { runner, alerts } = faultRunner(db, { masterSize: 40, memberSize: 10, posts: 0, orders: [] });
  assert.equal(await runner.alertStaleFillObservations(300), 1);
  assert.equal(await runner.alertStaleFillObservations(300), 0);
  assert.equal(alerts.filter((a) => a.event === 'COPY_FILL_OBSERVATION_STALE').length, 1);
});

test('P0-1: the target anchor stores only the Master quantity consumed by whole member lots', async () => {
  // Master 20k / member 5k -> ratio 0.25. Anchor (100, 25); Master 105 -> 1.25 lots -> buy 1, consume 4.
  const anchors = [{ contract: 'BTC_USDT', position_side: 'LONG', resume_version: ids.version, master_copyable_size: 100, target_size: 25 }];
  const payload = cyclePayload({ masterSize: 105, actualSize: 25, member: { max_position_ratio: 100, target_anchors: anchors,
    previous_states: [{ contract: 'BTC_USDT', position_side: 'LONG', actual_size: 25, state: 'SYNCED' }] } });
  const plan = payload.members[0].planned_positions[0];
  assert.equal(plan.target_size, 26);
  assert.equal(plan.anchor_master_copyable_size, 104);
  await record(db, payload);
  const anchor = await one('select master_copyable_size::float8 m,target_size::float8 t from private.copy_target_anchors');
  assert.deepEqual(anchor, { m: 104, t: 26 });
  const intent = await one('select plan_evidence from private.copy_order_intents');
  assert.equal(Number(intent.plan_evidence.master_copyable_size), 105, 'evidence keeps the observed Master size');
});
