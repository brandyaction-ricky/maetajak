import test, { before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createVerifiedDatabase, seedVerifiedAccount, ids } from './fixtures/verified-runtime.js';

// Independent review 2026-10-30 of 43b7981 (supabase/migrations/20261030010000_admin_ordered_copy_start.sql).
// Each test asserts the fixed behaviour for one review claim (F1-F5). Fault injection replaces a helper inside the test
// transaction only (rolled back after each test).
const CONFIRM = 'ADMIN_ORDERED_COPY_START';
const CANCEL = 'ADMIN_ORDERED_COPY_START_CANCEL';
const admin = '30000000-0000-4000-8000-0000000000b1';
let db;
let uidSeq = 0;
const one = async (sql, args = []) => (await db.query(sql, args)).rows[0];
const asAdmin = () => db.exec(`select set_config('test.admin','true',true), set_config('request.jwt.claim.sub','${admin}',true), set_config('request.jwt.claim.role','authenticated',true)`);
const asWorker = () => db.exec("select set_config('test.admin','false',true), set_config('request.jwt.claim.sub','',true), set_config('request.jwt.claim.role','service_role',true)");
const daysAgo = (days) => new Date(Date.now() - days * 86_400_000).toISOString();

before(async () => { db = await createVerifiedDatabase(); });
after(async () => { await db?.close(); });
beforeEach(async () => {
  await db.exec('begin');
  await db.query("insert into public.profiles(id,email,role,approval_status) values($1,'admin-r@example.invalid','ADMIN','APPROVED')", [admin]);
  await seedVerifiedAccount(db);
  await db.query(`insert into private.gate_api_credentials(user_id,gate_uid,api_key_ciphertext,secret_key_ciphertext,api_key_last4,status,
      futures_read,futures_trade,connection_role,verification_version,verified_worker_ip)
    values($1,'55500099','x','y','TEST','VERIFIED',true,false,'MASTER',2,'192.0.2.1')`, [admin]);
  await db.query('update private.trading_accounts set credential_user_id=$1,user_id=$1 where id=$2', [admin, ids.master]);
  await db.query("update private.copy_resume_sessions set state='ACTIVE',blocker_reason=null where trading_account_id=$1", [ids.member]);
  await db.query('update public.profiles set created_at=$2 where id=$1', [ids.user, daysAgo(30)]);
});
afterEach(async () => { await db.exec('rollback'); });

async function addMember(name, signupAt) {
  const id = randomUUID(); const account = randomUUID(); const uid = String(72000000 + ++uidSeq);
  await db.query(`insert into public.profiles(id,email,full_name,gate_uid,role,approval_status,copy_paused,created_at)
    values($1,$2,$3,$4,'MEMBER','APPROVED',true,$5)`, [id, `${uid}@uid.maetajak.trading`, name, uid, signupAt]);
  await db.query("insert into private.trading_accounts(id,user_id,credential_user_id,account_role,status) values($1,$2,$2,'MEMBER','ACTIVE')", [account, id]);
  await db.query(`insert into private.gate_api_credentials(user_id,gate_uid,api_key_ciphertext,secret_key_ciphertext,api_key_last4,status,
      futures_read,futures_trade,verification_version,verified_worker_ip) values($1,$2,'x','y','TEST','VERIFIED',true,true,2,'192.0.2.1')`, [id, uid]);
  await db.query("insert into private.copy_resume_sessions(trading_account_id,state) values($1,'REQUIRED')", [account]);
  return { id, account };
}
const stateOf = async (m) => (await one('select state,reason,attempts from private.copy_start_queue where user_id=$1 order by id desc limit 1', [m.id])) || {};
const session = (m) => one('select * from private.copy_resume_sessions where trading_account_id=$1', [m.account]);
async function enqueue() { await asAdmin(); return (await one('select public.admin_enqueue_ordered_copy_start(null,$1) r', [CONFIRM])).r; }
const cron = () => one('select private.advance_copy_start_queue(false, true) r');
const gucs = () => one("select current_setting('lock_timeout') lt, coalesce(current_setting('maetajak.copy_start_queue_busy', true),'') busy");

// Replace the live gate so the trigger's advance raises the given SQLSTATE (fault injection, test transaction only).
async function injectAdvanceError(sqlstate) {
  await db.exec(`create or replace function private.copy_start_live_state() returns text language plpgsql
    set search_path to 'pg_catalog' as $f$ begin
      if current_setting('review.fault', true) = 'on' then raise exception 'REVIEW_FAULT' using errcode = '${sqlstate}'; end if;
      return null; end $f$`);
}

test('R-A: trigger success path restores lock_timeout and clears the busy flag in the outer (worker) transaction', async () => {
  const a = await addMember('A', daysAgo(5));
  await addMember('B', daysAgo(4));
  await enqueue();
  await db.exec("set local lock_timeout = '7s'");
  await asWorker();
  await db.query("update private.copy_resume_sessions set state='VALIDATED',validated_at=clock_timestamp() where trading_account_id=$1", [a.account]);
  await db.query("update private.copy_resume_sessions set state='ACTIVE',activated_at=clock_timestamp() where trading_account_id=$1", [a.account]);
  assert.equal((await stateOf(a)).state, 'ACTIVE');
  assert.deepEqual(await gucs(), { lt: '7s', busy: '' }, 'no GUC leaks into the rest of the worker transaction');
});

test('R-B (F5): an error inside the trigger (lock_not_available 55P03) is swallowed, rolled back, traced, and GUCs revert', async () => {
  const a = await addMember('A', daysAgo(5));
  await addMember('B', daysAgo(4));
  await enqueue();
  await injectAdvanceError('55P03');
  await db.exec("set local lock_timeout = '7s'; select set_config('review.fault','on',true)");
  await asWorker();
  await db.query("update private.copy_resume_sessions set state='ACTIVE',activated_at=clock_timestamp() where trading_account_id=$1", [a.account]);
  assert.equal((await session(a)).state, 'ACTIVE', 'the session update itself succeeds');
  assert.equal((await stateOf(a)).state, 'REQUESTED', 'the trigger work was rolled back (cron resolves it later)');
  assert.deepEqual(await gucs(), { lt: '7s', busy: '' }, 'subtransaction abort reverts lock_timeout=200ms and busy=on');
  const trace = await one('select last_error_code, error_count, trading_account_id from private.copy_start_queue_trigger_errors');
  assert.deepEqual(trace, { last_error_code: '55P03', error_count: 1, trading_account_id: a.account }, 'the swallowed error is observable');
  await db.exec("select set_config('review.fault','off',true)");
  await asAdmin();
  assert.equal((await one('select public.get_admin_ordered_copy_start() r')).r.trigger_error.code, '55P03', 'exposed to the administrator');
  await cron();
  assert.equal((await stateOf(a)).state, 'ACTIVE');
});

test('R-C (F3): query_canceled (57014, e.g. statement_timeout) inside the trigger is swallowed: the session update succeeds', async () => {
  const a = await addMember('A', daysAgo(5));
  await addMember('B', daysAgo(4));
  await enqueue();
  await injectAdvanceError('57014');
  await db.exec("select set_config('review.fault','on',true)");
  await asWorker();
  await db.exec('savepoint r_c');
  let failed = null;
  try {
    await db.query("update private.copy_resume_sessions set state='ACTIVE',activated_at=clock_timestamp() where trading_account_id=$1", [a.account]);
  } catch (error) { failed = error; }
  await db.exec('rollback to savepoint r_c');
  assert.equal(failed, null, 'WHEN OTHERS OR QUERY_CANCELED: the worker activation statement is not aborted');
  // (rolled back to the savepoint above) Repeat outside the savepoint to inspect the result.
  await db.query("update private.copy_resume_sessions set state='ACTIVE',activated_at=clock_timestamp() where trading_account_id=$1", [a.account]);
  assert.equal((await session(a)).state, 'ACTIVE');
  assert.equal((await stateOf(a)).state, 'REQUESTED', 'resolved later by the per-minute job');
  assert.equal((await one('select last_error_code from private.copy_start_queue_trigger_errors')).last_error_code, '57014');
});

test('R-D (F1/F2): the trigger never requests the next member; a transient lock_timeout on that request keeps it QUEUED', async () => {
  const a = await addMember('A', daysAgo(5));
  const b = await addMember('B', daysAgo(4));
  const c = await addMember('C', daysAgo(3));
  await enqueue();
  // Simulate a 2s lock_timeout while requesting B (e.g. B's profile row locked by another transaction).
  await db.exec(`create or replace function private.request_member_copy_resume(p_user_id uuid, p_reclassify boolean) returns jsonb
    language plpgsql set search_path to 'pg_catalog' as $f$ begin
      raise exception 'canceling statement due to lock timeout' using errcode = '55P03'; end $f$`);
  await asWorker();
  await db.query("update private.copy_resume_sessions set state='ACTIVE',activated_at=clock_timestamp() where trading_account_id=$1", [a.account]);
  assert.equal((await stateOf(a)).state, 'ACTIVE');
  assert.deepEqual(await stateOf(b), { state: 'QUEUED', reason: null, attempts: 0 }, 'nothing requested inside the worker transaction');
  await cron();
  assert.deepEqual(await stateOf(b), { state: 'QUEUED', reason: 'RETRY_TRANSIENT', attempts: 0 }, 'transient: back to QUEUED, no attempt counted');
  assert.equal((await one('select last_error_code from private.copy_start_queue where user_id=$1', [b.id])).last_error_code, '55P03');
  assert.deepEqual(await stateOf(c), { state: 'QUEUED', reason: null, attempts: 0 }, 'the run stops; C is not requested out of order');
  assert.equal((await session(c)).state, 'REQUIRED');
});

test('R-E (F4): after cancel, the in-progress member that would be requeued (Master change) ends CANCELLED', async () => {
  const a = await addMember('A', daysAgo(5));
  const b = await addMember('B', daysAgo(4));
  await enqueue();
  await asAdmin();
  const cancelled = (await one('select public.admin_cancel_ordered_copy_start($1) r', [CANCEL])).r;
  assert.deepEqual([cancelled.cancelled, cancelled.in_progress], [1, 1]);
  await db.query("update private.copy_resume_sessions set state='PAUSED',blocker_reason='MASTER_CREDENTIAL_CHANGED' where trading_account_id=$1", [a.account]);
  assert.deepEqual(await stateOf(a), { state: 'CANCELLED', reason: 'ADMIN_CANCELLED', attempts: 1 }, 'not requeued after the administrator cancelled');
  const version = (await session(a)).version;
  await cron();
  assert.equal((await session(a)).version, version, 'no new resume generation after cancel');
  assert.equal((await stateOf(b)).state, 'CANCELLED');
});

test('R-E2 (F4): a cancelled batch\'s requested member that becomes ACTIVE stays ACTIVE', async () => {
  const a = await addMember('A', daysAgo(5));
  await addMember('B', daysAgo(4));
  await enqueue();
  await asAdmin();
  await db.query('select public.admin_cancel_ordered_copy_start($1)', [CANCEL]);
  await asWorker();
  await db.query("update private.copy_resume_sessions set state='ACTIVE',activated_at=clock_timestamp() where trading_account_id=$1", [a.account]);
  assert.deepEqual(await stateOf(a), { state: 'ACTIVE', reason: null, attempts: 1 });
});

test('R-F: the queue resume is FUTURE_ONLY and leaves administrator restrictions untouched', async () => {
  const a = await addMember('A', daysAgo(5));
  await db.query('update public.profiles set admin_reduce_only=true, reduce_only=true where id=$1', [a.id]);
  const b = await addMember('B', daysAgo(4));
  await enqueue();
  assert.deepEqual(await stateOf(a), {}, 'admin reduce-only member is not queued with p_user_ids null');
  const sb = await session(b);
  assert.deepEqual([sb.state, sb.sync_current_master], ['REQUESTED', false]);
  const pa = await one('select admin_reduce_only, reduce_only, admin_paused, member_halted from public.profiles where id=$1', [a.id]);
  assert.deepEqual(pa, { admin_reduce_only: true, reduce_only: true, admin_paused: false, member_halted: false });
});
