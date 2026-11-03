import test, { before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createVerifiedDatabase } from './fixtures/verified-runtime.js';

// 2026-11-03 pre-go-live audit (area 2, DB): the worker deployed on 2026-09-25 (62992c2, 0.5.0) keeps running
// against the database after 20261021032000..20261030010000 until the new worker is deployed. It calls
//   claim_gate_api_verification_jobs(p_limit := 5)                 -> reads job_id,user_id,connection_role,gate_uid,api_key,secret_key
//   complete_gate_api_verification(p_job_id, p_success, p_gate_user_id, p_error_code, p_error_message, p_worker_public_ip)
// through PostgREST (named notation, 6 arguments, no p_claimed_at). Proof that the Master can be registered in that
// window, and of the one protection that is off while the old worker runs (review R7 stale-claim refusal).
const admin = '30000000-0000-4000-8000-0000000000a1';
const KEY = 'K'.repeat(20);
let db;
const one = async (sql, args = []) => (await db.query(sql, args)).rows[0];
const asAdmin = () => db.exec(`select set_config('test.admin','true',true), set_config('request.jwt.claim.sub','${admin}',true), set_config('request.jwt.claim.role','authenticated',true)`);
const asWorker = () => db.exec("select set_config('test.admin','false',true), set_config('request.jwt.claim.role','service_role',true)");
// Exactly what PostgREST sends for the old worker's body (named notation, 6 keys).
const oldWorkerComplete = (job, success, errorCode = null) => db.query(
  `select public.complete_gate_api_verification(p_job_id := $1, p_success := $2, p_gate_user_id := $3,
     p_error_code := $4, p_error_message := $5, p_worker_public_ip := $6)`,
  [job, success, success ? '55500011' : null, errorCode, success ? null : 'failed', '192.0.2.1']);

before(async () => { db = await createVerifiedDatabase(); });
after(async () => { await db?.close(); });
beforeEach(async () => {
  await db.exec('begin');
  // Production start state (2026-11-03): only the administrator profile, no credential, no trading account.
  await db.query("insert into public.profiles(id,email,role,approval_status) values($1,'admin@example.invalid','ADMIN','APPROVED')", [admin]);
});
afterEach(async () => { await db.exec('rollback'); });

test('old worker: first Master registration verifies through the 6-argument named call and the 7-column claim', async () => {
  await asAdmin();
  const saved = (await one('select public.save_admin_gate_api_credentials($1,$2,$3,true) r', ['55500011', KEY, KEY])).r;
  assert.equal(saved.status, 'PENDING_VERIFICATION');
  await asWorker();
  const [job] = (await db.query('select * from public.claim_gate_api_verification_jobs(p_limit := 5)')).rows;
  // The fields the old worker reads are unchanged; claimed_at is extra and ignored by it.
  for (const field of ['job_id', 'user_id', 'connection_role', 'gate_uid', 'api_key', 'secret_key']) assert.ok(field in job, field);
  assert.ok(job.claimed_at instanceof Date);
  assert.deepEqual([job.connection_role, job.gate_uid], ['MASTER', '55500011']);
  await oldWorkerComplete(job.job_id, true);
  const c = await one('select status,verification_version,host(verified_worker_ip) ip,futures_trade,pending_status from private.gate_api_credentials where user_id=$1', [admin]);
  assert.deepEqual([c.status, c.verification_version, c.ip, c.futures_trade, c.pending_status], ['VERIFIED', 2, '192.0.2.1', false, null]);
  const a = await one("select status,bound_gate_uid from private.trading_accounts where credential_user_id=$1 and account_role='MASTER'", [admin]);
  assert.deepEqual([a.status, a.bound_gate_uid], ['ACTIVE', '55500011']);
  assert.equal(Number((await one("select count(*) n from public.admin_audit_logs where action='MEMBERS_PAUSED_BY_MASTER'")).n), 0);
});

test('old worker: a result of a superseded claim is accepted without p_claimed_at (R7 refusal needs the new worker)', async () => {
  await asAdmin();
  await db.query('select public.save_admin_gate_api_credentials($1,$2,$3,true)', ['55500011', KEY, KEY]);
  await asWorker();
  const [first] = (await db.query('select * from public.claim_gate_api_verification_jobs(5)')).rows;
  // The claim lease (2 minutes) ran out and the job was claimed again.
  await db.query("update private.gate_api_verification_jobs set claimed_at = claimed_at - interval '3 minutes' where id=$1", [first.job_id]);
  const [second] = (await db.query('select * from public.claim_gate_api_verification_jobs(5)')).rows;
  assert.equal(second.job_id, first.job_id);
  // New worker: the late result of the first claim is refused.
  await db.exec('savepoint s');
  await assert.rejects(db.query("select public.complete_gate_api_verification($1,false,null,'IP_NOT_ALLOWED','late','192.0.2.1',$2)",
    [first.job_id, first.claimed_at]), /VERIFICATION_JOB_CLAIM_STALE/);
  await db.exec('rollback to savepoint s');
  // Old worker (no p_claimed_at): the same late result is applied.
  await oldWorkerComplete(first.job_id, false, 'IP_NOT_ALLOWED');
  assert.equal((await one('select status from private.gate_api_credentials where user_id=$1', [admin])).status, 'ERROR');
});
