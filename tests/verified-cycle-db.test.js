import test, { before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createVerifiedDatabase, seedVerifiedAccount, cyclePayload, record, ids } from './fixtures/verified-runtime.js';

let db;
const one = async (q, params = []) => (await db.query(q, params)).rows[0];
before(async () => { db = await createVerifiedDatabase(); });
after(async () => { await db?.close(); });
beforeEach(async () => { await db.exec('begin'); await seedVerifiedAccount(db); });
afterEach(async () => { await db.exec('rollback'); });

test('verified cycle commits exchange, engine, Current State and target anchors together', async () => {
  const p = cyclePayload(); await record(db, p);
  assert.equal(Number((await one('select target_size from public.copy_position_states')).target_size), 10);
  const a = await one('select * from private.copy_target_anchors');
  assert.equal(Number(a.master_copyable_size), 40); assert.equal(Number(a.target_size), 10);
  const states = (await db.query('select * from private.copy_current_verifications')).rows;
  assert.equal(states.length, 2); assert.ok(states.every((r) => r.cycle_id === p.cycle_id && r.status === 'VERIFIED'));
  const claimed = (await db.query('select * from public.claim_copy_order_intents(10)')).rows;
  assert.equal(claimed.length, 1); assert.equal(Number(claimed[0].delta_size), 10);
  assert.equal(Number(claimed[0].master_size_at_plan), 40); assert.equal(Number(claimed[0].quanto_multiplier), 0.001);
});

test('a Current State mismatch rolls back the entire cycle including intents and anchors', async () => {
  const p = cyclePayload(); p.current_state.members[0].positions[0].size = 100;
  await db.exec('savepoint bad');
  await assert.rejects(record(db, p), /ENGINE_EXCHANGE_RECONCILIATION_MISMATCH/);
  await db.exec('rollback to bad');
  for (const table of ['private.copy_cycles','private.copy_order_intents','private.copy_target_anchors','private.copy_current_accounts']) {
    assert.equal((await one(`select count(*)::int n from ${table}`)).n, 0);
  }
});

test('stale observations, stale workers, missing verification and repeated claims cannot submit', async () => {
  const p = cyclePayload(); p.observed_at = p.current_state.observed_at = '2020-01-01T00:00:00Z';
  await db.exec('savepoint stale'); await assert.rejects(record(db, p), /CURRENT_STATE_SNAPSHOT_INVALID/); await db.exec('rollback to stale');
  await record(db, cyclePayload());
  await db.exec("update private.copy_worker_runtime set worker_version='0.4.0'");
  assert.equal((await db.query('select * from public.claim_copy_order_intents(10)')).rows.length, 0);
  await db.exec("update private.copy_worker_runtime set worker_version='0.5.0'; update private.copy_current_verifications set status='ERROR'");
  assert.equal((await db.query('select * from public.claim_copy_order_intents(10)')).rows.length, 0);
  await db.exec("update private.copy_current_verifications set status='VERIFIED'");
  const [job] = (await db.query('select * from public.claim_copy_order_intents(10)')).rows;
  assert.ok(job); assert.equal((await db.query('select * from public.claim_copy_order_intents(10)')).rows.length, 0);
  const auth = () => one('select public.authorize_copy_order_submission($1,$2) permitted',[job.intent_id,ids.version]);
  assert.equal((await auth()).permitted, true); assert.equal((await auth()).permitted, false);
});

test('the audit detects a Current State / engine mismatch and authorization revokes a tampered claim', async () => {
  await record(db, cyclePayload());
  const [job] = (await db.query('select * from public.claim_copy_order_intents(10)')).rows;
  await db.exec("update private.copy_current_positions set size=100 where account_role='MEMBER'");
  const report = (await one('select public.get_copy_state_reconciliation() report')).report;
  assert.equal(report.accounts.find((a)=>a.role==='MEMBER').status,'MISMATCH');
  assert.equal((await one('select public.authorize_copy_order_submission($1,$2) ok',[job.intent_id,ids.version])).ok,false);
});

test('a failed member read preserves prior holdings and marks verification ERROR', async () => {
  await record(db,cyclePayload({actualSize:10}));
  const p = cyclePayload(); p.members[0].error_code=p.current_state.members[0].error_code='MEMBER_ACCOUNT_READ_GATE_TIMEOUT';
  p.members[0].planned_positions=[]; p.current_state.members[0].positions=[];
  await record(db,p);
  assert.equal(Number((await one("select size from private.copy_current_positions where account_role='MEMBER'")).size),10);
  assert.equal((await one('select status from private.copy_current_verifications where trading_account_id=$1',[ids.member])).status,'ERROR');
});

test('unknown or open orders do not advance the target anchor past an unprocessed Master reduction', async () => {
  const p = cyclePayload(); await record(db,p);
  const initial = await one('select * from private.copy_target_anchors');
  const blocked = cyclePayload({masterSize:20,member:{previous_states:[{contract:'BTC_USDT',position_side:'LONG',state:'DRIFT',has_unresolved_order:true}],
    target_anchors:[initial]}});
  await record(db,blocked);
  assert.equal(Number((await one('select master_copyable_size from private.copy_target_anchors')).master_copyable_size),40);
});

test('loss-limit persistence keeps reductions eligible and does not convert risk control into an operator halt', async () => {
  await record(db,cyclePayload({masterSize:0,actualSize:10,member:{reduce_only:true,risk_halt_reason:'DAILY_LOSS_LIMIT',
    previous_states:[{contract:'BTC_USDT',position_side:'LONG',actual_size:10,state:'SYNCED'}]}}));
  const profile = await one('select member_halted,reduce_only from public.profiles');
  assert.equal(profile.member_halted,false); assert.equal(profile.reduce_only,true);
  assert.equal((await db.query('select * from public.claim_copy_order_intents(10)')).rows.length,1);
});

test('foreign order identity and impossible fill quantities halt the system without accepting a fill', async () => {
  await record(db,cyclePayload()); const [job] = (await db.query('select * from public.claim_copy_order_intents(10)')).rows;
  await db.query("select public.complete_copy_order_attempt($1,'UNKNOWN',null,0,null,201,null,'WORKER_ORDER_IDENTITY_MISMATCH','{}')",[job.intent_id]);
  assert.equal((await one('select emergency_halted from public.copy_system_control')).emergency_halted,true);
  assert.equal(Number((await one('select filled_size from private.copy_order_intents')).filled_size),0);
});

test('new worker RPCs and credential-bearing alert claims are unavailable to authenticated users', async () => {
  for (const name of ['record_verified_copy_worker_cycle(jsonb)','get_copy_state_reconciliation()',
    'claim_copy_order_intents(integer)','claim_copy_entry_alerts(integer)','claim_copy_reconciliation_jobs(integer)']) {
    assert.equal((await one("select has_function_privilege('authenticated',$1,'execute') allowed",[`public.${name}`])).allowed,false);
    assert.equal((await one("select has_function_privilege('anon',$1,'execute') allowed",[`public.${name}`])).allowed,false);
  }
  await db.exec("select set_config('request.jwt.claim.role','authenticated',false); savepoint unprivileged");
  await assert.rejects(db.query('select public.get_copy_state_reconciliation()'),/SERVICE_ROLE_REQUIRED/);
  await db.exec('rollback to unprivileged');
});
