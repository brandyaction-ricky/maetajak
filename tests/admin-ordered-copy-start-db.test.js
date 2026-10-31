import test, { before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createVerifiedDatabase, seedVerifiedAccount, ids } from './fixtures/verified-runtime.js';
import { faultRunner } from './fixtures/fault-runner.js';

// 2026-10-30 administrator ordered copy start: supabase/migrations/20261030010000_admin_ordered_copy_start.sql.
const MIGRATION = 'supabase/migrations/20261030010000_admin_ordered_copy_start.sql';
const CONFIRM = 'ADMIN_ORDERED_COPY_START';
const CANCEL = 'ADMIN_ORDERED_COPY_START_CANCEL';
const admin = '30000000-0000-4000-8000-0000000000a1';
let db;
let uidSeq = 0;
const one = async (sql, args = []) => (await db.query(sql, args)).rows[0];
async function rejects(sql, args, pattern) {
  await db.exec('savepoint q_expect');
  try { await assert.rejects(db.query(sql, args), pattern); }
  finally { await db.exec('rollback to savepoint q_expect'); }
}
const asAdmin = () => db.exec(`select set_config('test.admin','true',true), set_config('request.jwt.claim.sub','${admin}',true), set_config('request.jwt.claim.role','authenticated',true)`);
const asUser = (id) => db.exec(`select set_config('test.admin','false',true), set_config('request.jwt.claim.sub','${id}',true), set_config('request.jwt.claim.role','authenticated',true)`);
const asWorker = () => db.exec("select set_config('test.admin','false',true), set_config('request.jwt.claim.sub','',true), set_config('request.jwt.claim.role','service_role',true)");
const daysAgo = (days) => new Date(Date.now() - days * 86_400_000).toISOString();

before(async () => { db = await createVerifiedDatabase(); });
after(async () => { await db?.close(); });
beforeEach(async () => {
  await db.exec('begin');
  await db.query("insert into public.profiles(id,email,role,approval_status) values($1,'admin@example.invalid','ADMIN','APPROVED')", [admin]);
  // LIVE runtime, execution enabled; the fixture member (ids.user) is already copying (ACTIVE).
  await seedVerifiedAccount(db);
  await db.query(`insert into private.gate_api_credentials(user_id,gate_uid,api_key_ciphertext,secret_key_ciphertext,api_key_last4,status,
      futures_read,futures_trade,connection_role,verification_version,verified_worker_ip)
    values($1,'55500011','x','y','TEST','VERIFIED',true,false,'MASTER',2,'192.0.2.1')`, [admin]);
  await db.query("update private.trading_accounts set credential_user_id=$1,user_id=$1 where id=$2", [admin, ids.master]);
  await db.query("update private.copy_resume_sessions set state='ACTIVE',blocker_reason=null where trading_account_id=$1", [ids.member]);
  await db.query("update public.profiles set created_at=$2 where id=$1", [ids.user, daysAgo(30)]);
});
afterEach(async () => { await db.exec('rollback'); });

// A member who has never started copying (session REQUIRED), Gate key VERIFIED, account ACTIVE.
async function addMember(name, signupAt, { approval = 'APPROVED', verified = true, accountStatus = 'ACTIVE',
  session = 'REQUIRED', blocker = null } = {}) {
  const id = randomUUID(); const account = randomUUID(); const uid = String(71000000 + ++uidSeq);
  await db.query(`insert into public.profiles(id,email,full_name,gate_uid,role,approval_status,copy_paused,created_at)
    values($1,$2,$3,$4,'MEMBER',$5,true,$6)`, [id, `${uid}@uid.maetajak.trading`, name, uid, approval, signupAt]);
  await db.query("insert into private.trading_accounts(id,user_id,credential_user_id,account_role,status) values($1,$2,$2,'MEMBER',$3)",
    [account, id, accountStatus]);
  if (verified) {
    await db.query(`insert into private.gate_api_credentials(user_id,gate_uid,api_key_ciphertext,secret_key_ciphertext,api_key_last4,status,
        futures_read,futures_trade,verification_version,verified_worker_ip) values($1,$2,'x','y','TEST','VERIFIED',true,true,2,'192.0.2.1')`, [id, uid]);
  }
  await db.query('insert into private.copy_resume_sessions(trading_account_id,state,blocker_reason) values($1,$2,$3)', [account, session, blocker]);
  return { id, account, uid, name };
}
const session = (m) => one('select * from private.copy_resume_sessions where trading_account_id=$1', [m.account]);
const items = async () => (await db.query('select user_id,seq,state,reason,attempts from private.copy_start_queue order by seq')).rows;
const stateOf = async (m) => (await one('select state,reason,attempts from private.copy_start_queue where user_id=$1 order by id desc limit 1', [m.id])) || {};
const states = async (...members) => Promise.all(members.map(async (m) => (await stateOf(m)).state));
async function enqueue(userIds = null) {
  await asAdmin();
  return (await one('select public.admin_enqueue_ordered_copy_start($1,$2) r', [userIds, CONFIRM])).r;
}
async function status() {
  await asAdmin();
  return (await one('select public.get_admin_ordered_copy_start() r')).r;
}
// What the worker does for a requested session (prepare → VALIDATED, activate → ACTIVE), as state transitions.
async function activate(m) {
  await asWorker();
  await db.query("update private.copy_resume_sessions set state='VALIDATED',validated_at=clock_timestamp() where trading_account_id=$1", [m.account]);
  await db.query("update private.copy_resume_sessions set state='ACTIVE',activated_at=clock_timestamp() where trading_account_id=$1", [m.account]);
}
const cron = () => one('select private.advance_copy_start_queue(false, true) r');

test('signup order, one at a time: the earliest member is requested FUTURE_ONLY, the next only after it is ACTIVE', async () => {
  const a = await addMember('가', daysAgo(3));
  const b = await addMember('나', daysAgo(1));
  const c = await addMember('다', daysAgo(2));
  const result = await enqueue();
  assert.equal(result.queued, 3);
  assert.deepEqual((await items()).map((i) => [i.user_id, i.seq]), [[a.id, 1], [c.id, 2], [b.id, 3]], 'ordered by profiles.created_at');
  assert.ok(!(await items()).some((i) => i.user_id === ids.user), 'the copying member is not queued');
  assert.deepEqual(await states(a, c, b), ['REQUESTED', 'QUEUED', 'QUEUED']);
  const sa = await session(a);
  assert.deepEqual([sa.state, sa.sync_current_master, sa.reclassify_missing_copy, sa.requested_by], ['REQUESTED', false, false, admin],
    'the ordinary FUTURE_ONLY resume request, attributed to the administrator');
  assert.equal((await session(c)).state, 'REQUIRED', 'the second member is not requested yet');
  assert.equal((await one("select count(*)::int n from private.copy_operation_history where user_id=$1", [a.id])).n, 0, 'no new-operation receipt');

  await cron();
  assert.deepEqual(await states(a, c, b), ['REQUESTED', 'QUEUED', 'QUEUED'], 'the fallback job does not start a second member');

  await activate(a);
  assert.deepEqual(await states(a, c, b), ['ACTIVE', 'QUEUED', 'QUEUED'], 'the trigger only resolves (worker transaction)');
  assert.equal((await session(c)).state, 'REQUIRED', 'no other member is requested inside the activation transaction');
  await cron();
  assert.deepEqual(await states(a, c, b), ['ACTIVE', 'REQUESTED', 'QUEUED'], 'the per-minute job starts the next member');
  assert.equal((await session(c)).state, 'REQUESTED');
  assert.equal((await session(b)).state, 'REQUIRED');
  await activate(c); await cron();
  await activate(b); await cron();
  assert.deepEqual(await states(a, c, b), ['ACTIVE', 'ACTIVE', 'ACTIVE']);
  const s = await status();
  assert.equal(s.running, false);
  assert.deepEqual([s.batch.total, s.batch.active], [3, 3]);
  const audit = (await db.query("select action,target_user_id from public.admin_audit_logs where action like 'ADMIN_ORDERED_COPY_START_%' order by id")).rows;
  assert.deepEqual(audit.map((r) => r.action), ['ADMIN_ORDERED_COPY_START_ENQUEUED', 'ADMIN_ORDERED_COPY_START_REQUESTED',
    'ADMIN_ORDERED_COPY_START_REQUESTED', 'ADMIN_ORDERED_COPY_START_REQUESTED']);
  assert.deepEqual(audit.slice(1).map((r) => r.target_user_id), [a.id, c.id, b.id]);
});

test('status lists READY members in signup order and the approved members that are not ready with the reason', async () => {
  const late = await addMember('늦은 가입', daysAgo(1));
  const early = await addMember('이른 가입', daysAgo(5));
  const noKey = await addMember('키 없음', daysAgo(4), { verified: false });
  const paused = await addMember('관리자 정지', daysAgo(3));
  await db.query('update public.profiles set admin_paused=true where id=$1', [paused.id]);
  const self = await addMember('회원 정지', daysAgo(2), { session: 'PAUSED', blocker: 'MEMBER_PAUSED' });
  const pending = await addMember('승인 대기', daysAgo(6), { approval: 'PENDING' });
  const disabled = await addMember('계정 비활성', daysAgo(7), { accountStatus: 'DISABLED' });
  const masterPaused = await addMember('Master 변경', daysAgo(8), { session: 'PAUSED', blocker: 'MASTER_CREDENTIAL_CHANGED' });
  const s = await status();
  assert.deepEqual(s.ready_members.map((m) => m.user_id), [masterPaused.id, early.id, late.id]);
  assert.equal(s.ready_members[0].session_blocker, 'MASTER_CREDENTIAL_CHANGED');
  const reasons = Object.fromEntries(s.not_ready_members.map((m) => [m.user_id, m.reason]));
  assert.deepEqual(reasons, { [disabled.id]: 'TRADING_ACCOUNT_NOT_ACTIVE', [noKey.id]: 'GATE_API_NOT_VERIFIED',
    [paused.id]: 'ADMIN_PAUSED', [self.id]: 'MEMBER_PAUSED' });
  assert.ok(!(pending.id in reasons) && !(ids.user in reasons), 'pending approval and copying members are not listed');
  assert.deepEqual([s.live_ready, s.live_reason, s.running, s.batch, s.items], [true, null, false, null, []]);
});

test('members not ready are skipped, not waited for (at enqueue and when their turn comes)', async () => {
  const a = await addMember('A', daysAgo(5));
  const b = await addMember('B', daysAgo(4));
  const c = await addMember('C', daysAgo(3));
  const noKey = await addMember('키 없음', daysAgo(2), { verified: false });
  const result = await enqueue([c.id, a.id, b.id, noKey.id]);
  assert.deepEqual([result.queued, result.skipped], [3, 1]);
  assert.deepEqual(await stateOf(noKey), { state: 'SKIPPED', reason: 'GATE_API_NOT_VERIFIED', attempts: 0 }, 'a selected member that is not ready is recorded');
  assert.deepEqual(await states(a, b, c), ['REQUESTED', 'QUEUED', 'QUEUED']);
  // B becomes not ready while waiting (administrator PAUSE).
  await asAdmin();
  await db.query("select public.set_member_copy_control($1,'PAUSE','test')", [b.id]);
  await activate(a);
  await cron();
  assert.deepEqual(await stateOf(b), { state: 'SKIPPED', reason: 'ADMIN_PAUSED', attempts: 0 });
  assert.equal((await stateOf(c)).state, 'REQUESTED', 'the next ready member is started without waiting for B');
  assert.equal((await session(b)).state, 'PAUSED', 'the skipped member is left untouched');
});

test('a requested member that becomes not ready is SKIPPED (member pause) and the queue moves on via the fallback job', async () => {
  const a = await addMember('A', daysAgo(5));
  const b = await addMember('B', daysAgo(4));
  await enqueue();
  await asUser(a.id);
  await db.query("select public.set_my_copy_pause('HOLD')");
  assert.deepEqual(await stateOf(a), { state: 'SKIPPED', reason: 'MEMBER_PAUSED', attempts: 1 });
  assert.equal((await stateOf(b)).state, 'QUEUED', 'a failure transition does not start the next member inside the member transaction');
  await cron();
  assert.equal((await stateOf(b)).state, 'REQUESTED');
});

test('a worker blocker after expiry resolves FAILED with the reason; the next member follows', async () => {
  const a = await addMember('A', daysAgo(5));
  const b = await addMember('B', daysAgo(4));
  await enqueue();
  const sa = await session(a);
  await db.query("update private.copy_resume_sessions set expires_at=clock_timestamp()-interval '1 second' where trading_account_id=$1", [a.account]);
  await asWorker();
  await db.query("select public.report_member_copy_resume_blocker($1,$2,'RESUME_PREVIEW_NOT_ZERO')", [a.account, sa.version]);
  assert.equal((await session(a)).state, 'BLOCKED');
  assert.deepEqual(await stateOf(a), { state: 'FAILED', reason: 'RESUME_PREVIEW_NOT_ZERO', attempts: 1 });
  assert.equal((await stateOf(b)).state, 'QUEUED');
  await cron();
  assert.equal((await stateOf(b)).state, 'REQUESTED');
});

test('a blocker reported before expiry keeps waiting (the worker retries until the session expires)', async () => {
  const a = await addMember('A', daysAgo(5));
  await addMember('B', daysAgo(4));
  await enqueue();
  await asWorker();
  await db.query("select public.report_member_copy_resume_blocker($1,$2,'RESUME_SNAPSHOT_STALE')", [a.account, (await session(a)).version]);
  await cron();
  assert.equal((await stateOf(a)).state, 'REQUESTED');
});

test('expiry: never validated while LIVE → FAILED; validated but never activated → re-requested (at most 3 requests)', async () => {
  const a = await addMember('A', daysAgo(5));
  const b = await addMember('B', daysAgo(4));
  await enqueue();
  await db.query("update private.copy_resume_sessions set expires_at=clock_timestamp()-interval '1 minute' where trading_account_id=$1", [a.account]);
  await cron();
  assert.deepEqual(await stateOf(a), { state: 'FAILED', reason: 'RESUME_REQUEST_EXPIRED', attempts: 1 });
  assert.equal((await stateOf(b)).state, 'REQUESTED');
  for (const attempt of [2, 3]) {
    const before = (await session(b)).version;
    await db.query("update private.copy_resume_sessions set state='VALIDATED',validated_at=clock_timestamp(),expires_at=clock_timestamp()-interval '1 minute' where trading_account_id=$1", [b.account]);
    await cron();
    assert.deepEqual(await stateOf(b), { state: 'REQUESTED', reason: null, attempts: attempt });
    assert.notEqual((await session(b)).version, before, 'a new resume generation');
  }
  await db.query("update private.copy_resume_sessions set state='VALIDATED',validated_at=clock_timestamp(),expires_at=clock_timestamp()-interval '1 minute' where trading_account_id=$1", [b.account]);
  await cron();
  assert.deepEqual(await stateOf(b), { state: 'FAILED', reason: 'RESUME_REQUEST_EXPIRED', attempts: 3 });
});

test('not LIVE: items wait QUEUED (waiting_for_live) and start when the system is LIVE again', async () => {
  const a = await addMember('A', daysAgo(5));
  const b = await addMember('B', daysAgo(4));
  await db.exec('update public.copy_system_control set execution_enabled=false');
  const result = await enqueue();
  assert.deepEqual(await states(a, b), ['QUEUED', 'QUEUED']);
  assert.equal((await session(a)).state, 'REQUIRED', 'no session is requested while it could not be activated');
  assert.deepEqual([result.waiting_for_live, result.live_reason, result.running], [true, 'EXECUTION_DISABLED', true]);
  await cron();
  assert.equal((await stateOf(a)).state, 'QUEUED');
  for (const [sql, reason] of [["update public.copy_system_control set execution_enabled=true; update private.copy_worker_runtime set mode='DRY_RUN'", 'WORKER_NOT_LIVE'],
    ["update private.copy_worker_runtime set mode='LIVE',heartbeat_at=now()-interval '5 minutes'", 'WORKER_OFFLINE'],
    ["update private.copy_worker_runtime set heartbeat_at=clock_timestamp(); update public.copy_system_control set emergency_halted=true", 'EMERGENCY_HALTED']]) {
    await db.exec(sql);
    assert.equal((await status()).live_reason, reason);
  }
  await db.exec('update public.copy_system_control set emergency_halted=false');
  await cron();
  assert.deepEqual(await states(a, b), ['REQUESTED', 'QUEUED']);
  assert.equal((await status()).waiting_for_live, false);
});

test('DRY_RUN: a validated session that expired without activation goes back to QUEUED and waits for LIVE', async () => {
  const a = await addMember('A', daysAgo(5));
  await addMember('B', daysAgo(4));
  await enqueue();
  const sa = await session(a);
  await db.exec("update private.copy_worker_runtime set mode='DRY_RUN'");
  await db.query("update private.copy_resume_sessions set state='VALIDATED',validated_at=clock_timestamp(),expires_at=clock_timestamp()-interval '1 second' where trading_account_id=$1", [a.account]);
  await asWorker();
  await db.query("select public.report_member_copy_resume_blocker($1,$2,'RESUME_REQUEST_EXPIRED')", [a.account, sa.version]);
  assert.deepEqual(await stateOf(a), { state: 'QUEUED', reason: 'WAITING_FOR_LIVE', attempts: 1 });
  await cron();
  assert.equal((await stateOf(a)).state, 'QUEUED');
  assert.equal((await status()).waiting_for_live, true);
  await db.exec("update private.copy_worker_runtime set mode='LIVE'");
  await cron();
  assert.deepEqual(await stateOf(a), { state: 'REQUESTED', reason: null, attempts: 2 });
});

test('a Master change while a member is requested waits for the Master and re-requests that member', async () => {
  const a = await addMember('A', daysAgo(5));
  await addMember('B', daysAgo(4));
  await enqueue();
  await db.query("update private.copy_resume_sessions set state='PAUSED',blocker_reason='MASTER_CREDENTIAL_CHANGED' where trading_account_id=$1", [a.account]);
  assert.deepEqual(await stateOf(a), { state: 'QUEUED', reason: 'MASTER_CREDENTIAL_CHANGED', attempts: 1 });
  await db.query("update private.trading_accounts set status='DISABLED' where id=$1", [ids.master]);
  await cron();
  assert.equal((await status()).live_reason, 'MASTER_NOT_ACTIVE');
  assert.equal((await stateOf(a)).state, 'QUEUED');
  await db.query("update private.trading_accounts set status='ACTIVE' where id=$1", [ids.master]);
  await cron();
  assert.deepEqual(await stateOf(a), { state: 'REQUESTED', reason: null, attempts: 2 });
});

test('member self-start: a queued member that starts itself resolves ACTIVE and is never requested by the queue', async () => {
  const a = await addMember('A', daysAgo(5));
  const b = await addMember('B', daysAgo(4));
  await enqueue();
  await asUser(b.id);
  await db.query("select public.set_my_copy_pause('RESUME')");
  const sb = await session(b);
  assert.deepEqual([sb.state, sb.requested_by], ['REQUESTED', b.id], 'the member self-start path is unchanged');
  assert.equal((await stateOf(b)).state, 'QUEUED');
  await activate(b);
  assert.deepEqual(await stateOf(b), { state: 'ACTIVE', reason: 'STARTED_OUTSIDE_QUEUE', attempts: 0 });
  assert.equal((await stateOf(a)).state, 'REQUESTED');
  await activate(a);
  assert.deepEqual(await states(a, b), ['ACTIVE', 'ACTIVE']);
  assert.equal((await session(b)).version, sb.version, 'the self-started member is not requested again');
  assert.equal((await status()).running, false);
});

test('the requested member starting itself as well still resolves ACTIVE', async () => {
  const a = await addMember('A', daysAgo(5));
  await enqueue();
  const version = (await session(a)).version;
  await asUser(a.id);
  await db.query("select public.set_my_copy_pause('RESUME')");
  assert.equal((await session(a)).version, version, 'an in-progress request is preserved');
  await activate(a);
  assert.equal((await stateOf(a)).state, 'ACTIVE');
});

test('cancel: pending items are cancelled, the requested one is still followed; one batch at a time', async () => {
  const a = await addMember('A', daysAgo(5));
  const b = await addMember('B', daysAgo(4));
  const c = await addMember('C', daysAgo(3));
  await enqueue([a.id, b.id]);
  await asAdmin();
  await rejects('select public.admin_enqueue_ordered_copy_start($1,$2)', [[c.id], CONFIRM], /ORDERED_COPY_START_RUNNING/);
  await rejects('select public.admin_cancel_ordered_copy_start($1)', ['nope'], /CONFIRMATION_REQUIRED/);
  const cancelled = (await one('select public.admin_cancel_ordered_copy_start($1) r', [CANCEL])).r;
  assert.deepEqual([cancelled.cancelled, cancelled.in_progress], [1, 1]);
  assert.deepEqual(await stateOf(b), { state: 'CANCELLED', reason: 'ADMIN_CANCELLED', attempts: 0 });
  assert.equal((await session(b)).state, 'REQUIRED');
  await activate(a);
  assert.deepEqual(await states(a, b), ['ACTIVE', 'CANCELLED']);
  assert.equal((await session(b)).state, 'REQUIRED', 'a cancelled member is not started');
  const next = await enqueue();
  assert.deepEqual(next.items.map((i) => [i.user_id, i.state]), [[b.id, 'REQUESTED'], [c.id, 'QUEUED']], 'a new batch after the previous one ended');
  assert.notEqual(next.batch_id, (await one('select batch_id from private.copy_start_queue where user_id=$1 and state=$2', [a.id, 'ACTIVE'])).batch_id);
});

test('enqueue refusals: no ready member, Master not active, empty selection, confirmation', async () => {
  await asAdmin();
  await rejects('select public.admin_enqueue_ordered_copy_start(null,$1)', [CONFIRM], /NO_READY_MEMBERS/);
  await rejects('select public.admin_enqueue_ordered_copy_start($1,$2)', [[ids.user], CONFIRM], /NO_READY_MEMBERS/);
  await rejects("select public.admin_enqueue_ordered_copy_start('{}'::uuid[],$1)", [CONFIRM], /NO_MEMBERS_SELECTED/);
  await addMember('A', daysAgo(5));
  await rejects('select public.admin_enqueue_ordered_copy_start(null,$1)', ['WRONG'], /CONFIRMATION_REQUIRED/);
  await db.query("update private.trading_accounts set status='DISABLED' where id=$1", [ids.master]);
  await asAdmin();
  await rejects('select public.admin_enqueue_ordered_copy_start(null,$1)', [CONFIRM], /MASTER_NOT_ACTIVE/);
  assert.equal((await one('select count(*)::int n from private.copy_start_queue')).n, 0, 'a refused enqueue leaves nothing behind');
});

test('administrator only: members and anon are refused, least-privilege grants', async () => {
  const a = await addMember('A', daysAgo(5));
  await asUser(a.id);
  await rejects('select public.get_admin_ordered_copy_start()', [], /ADMIN_REQUIRED/);
  await rejects('select public.admin_enqueue_ordered_copy_start(null,$1)', [CONFIRM], /ADMIN_REQUIRED/);
  await rejects('select public.admin_cancel_ordered_copy_start($1)', [CANCEL], /ADMIN_REQUIRED/);
  for (const fn of ['get_admin_ordered_copy_start()', 'admin_enqueue_ordered_copy_start(uuid[],text)', 'admin_cancel_ordered_copy_start(text)']) {
    const acl = await one(`select has_function_privilege('anon',$1,'EXECUTE') anon, has_function_privilege('authenticated',$1,'EXECUTE') auth,
      has_function_privilege('service_role',$1,'EXECUTE') service`, [`public.${fn}`]);
    assert.deepEqual(acl, { anon: false, auth: true, service: false }, fn);
  }
  for (const fn of ['advance_copy_start_queue(boolean,boolean)', 'copy_start_readiness(uuid)', 'copy_start_live_state()',
    'copy_start_queue_status()', 'copy_start_queue_on_session_state()']) {
    const acl = await one("select has_function_privilege('anon',$1,'EXECUTE') anon, has_function_privilege('authenticated',$1,'EXECUTE') auth", [`private.${fn}`]);
    assert.deepEqual(acl, { anon: false, auth: false }, fn);
  }
  const table = await one(`select has_table_privilege('anon','private.copy_start_queue','SELECT') anon,
    has_table_privilege('authenticated','private.copy_start_queue','SELECT,INSERT,UPDATE,DELETE') auth,
    (select relrowsecurity from pg_class where oid='private.copy_start_queue'::regclass) rls`);
  assert.deepEqual(table, { anon: false, auth: false, rls: true });
});

test('members without queue items are unaffected: session changes and resumes behave as before', async () => {
  const a = await addMember('A', daysAgo(5));
  await asUser(a.id);
  await db.query("select public.set_my_copy_pause('RESUME')");
  await activate(a);
  await db.query("update private.copy_resume_sessions set state='PAUSED',blocker_reason='MEMBER_PAUSED' where trading_account_id=$1", [ids.member]);
  assert.equal((await session(a)).state, 'ACTIVE');
  assert.equal((await one('select count(*)::int n from private.copy_start_queue')).n, 0);
  assert.equal((await one("select count(*)::int n from public.admin_audit_logs where action like 'ADMIN_ORDERED_COPY_START_%'")).n, 0);
  assert.deepEqual((await cron()).r, { open: 0 });
});

test('the migration re-applies cleanly and keeps the queue', async () => {
  const a = await addMember('A', daysAgo(5));
  const b = await addMember('B', daysAgo(4));
  await enqueue();
  const sql = readFileSync(MIGRATION, 'utf8');
  assert.doesNotMatch(sql, /\bdrop\s+(table|column|schema|function)\b|\bdelete\s+from\b|\btruncate\b/i);
  await db.exec(sql);
  assert.deepEqual(await states(a, b), ['REQUESTED', 'QUEUED']);
  assert.equal((await one("select count(*)::int n from pg_trigger where tgname='copy_start_queue_on_session_state'")).n, 1);
  await activate(a);
  await cron();
  assert.deepEqual(await states(a, b), ['ACTIVE', 'REQUESTED']);
});

test('end to end with the worker: FUTURE_ONLY start buys nothing the Master holds, follows later increases; next member by the job', async () => {
  // The fixture member (signed up first) was paused by a Master change and is ready again.
  await db.query('update public.profiles set copy_paused=true where id=$1', [ids.user]);
  await db.query("update private.copy_resume_sessions set state='PAUSED',blocker_reason='MASTER_CREDENTIAL_CHANGED' where trading_account_id=$1", [ids.member]);
  const next = await addMember('다음 회원', daysAgo(1));
  await enqueue();
  assert.deepEqual(await states({ id: ids.user }, next), ['REQUESTED', 'QUEUED']);
  const exchange = { masterSize: 40, memberSize: 0, posts: 0, orders: [] };
  const { runner } = faultRunner(db, exchange);
  const rpc = runner.rpc.bind(runner);
  runner.rpc = async (name, params) => {
    if (!['get_member_copy_resume_ownership', 'prepare_member_copy_resume', 'activate_member_copy_resume'].includes(name)) return rpc(name, params);
    await db.exec('savepoint resume_rpc');
    try { const result = await rpc(name, params); await db.exec('release savepoint resume_rpc'); return result; }
    catch (error) { await db.exec('rollback to savepoint resume_rpc; release savepoint resume_rpc'); throw error; }
  };
  runner.readResumeSnapshot = async (masterContext, memberContext) => {
    const startedAt = Date.now();
    const [master, member] = await Promise.all([runner.readAccount(masterContext), runner.readAccount(memberContext)]);
    return { startedAt, master, member, openOrders: [] };
  };
  await asWorker();
  await runner.syncOnce(); await runner.processPendingResumes(5);
  assert.equal((await one('select state from private.copy_resume_sessions where trading_account_id=$1', [ids.member])).state, 'ACTIVE');
  assert.deepEqual(await states({ id: ids.user }, next), ['ACTIVE', 'QUEUED'], 'the activation transaction only resolves');
  await cron();
  assert.deepEqual(await states({ id: ids.user }, next), ['ACTIVE', 'REQUESTED'], 'the per-minute job requests the next member');
  await runner.syncOnce(); await runner.submitOrders();
  assert.equal(exchange.posts, 0, 'the position the Master already held is not bought');
  exchange.masterSize = 60;
  await runner.syncOnce(); await runner.submitOrders();
  assert.equal(exchange.posts, 1, 'a later Master increase is copied');
  assert.ok(exchange.orders[0].size > 0);
});

test('F6 readiness and resolution cover every ACTIVE member account of the user', async () => {
  const a = await addMember('두 계정', daysAgo(5));
  const second = randomUUID();
  // Second (BTC-settled) account without a verified key (its credential owner has none).
  await db.query("insert into private.trading_accounts(id,user_id,credential_user_id,account_role,status,settle) values($1,$2,$3,'MEMBER','ACTIVE','btc')",
    [second, a.id, randomUUID()]);
  await db.query("insert into private.copy_resume_sessions(trading_account_id,state) values($1,'REQUIRED')", [second]);
  assert.equal((await one('select private.copy_start_readiness($1) r', [a.id])).r, 'GATE_API_NOT_VERIFIED');
  await db.query('update private.trading_accounts set credential_user_id=$2 where id=$1', [second, a.id]);
  await db.query("update private.copy_resume_sessions set state='PAUSED',blocker_reason='MEMBER_PAUSED' where trading_account_id=$1", [second]);
  assert.equal((await one('select private.copy_start_readiness($1) r', [a.id])).r, 'MEMBER_PAUSED', 'a member pause on any account');
  await db.query("update private.copy_resume_sessions set state='ACTIVE',blocker_reason=null where trading_account_id=$1", [second]);
  assert.equal((await one('select private.copy_start_readiness($1) r', [a.id])).r, null, 'one account still to start');
  await enqueue();
  assert.equal((await stateOf(a)).state, 'REQUESTED');
  assert.deepEqual([(await session(a)).state, (await session({ account: second })).state], ['REQUESTED', 'REQUESTED'],
    'request_member_copy_resume requests every account of the paused member');
  await db.query("update private.copy_resume_sessions set state='ACTIVE' where trading_account_id=$1", [a.account]);
  assert.equal((await stateOf(a)).state, 'REQUESTED', 'not ACTIVE while another account is not');
  await db.query("update private.copy_resume_sessions set state='ACTIVE',blocker_reason=null where trading_account_id=$1", [second]);
  assert.equal((await stateOf(a)).state, 'ACTIVE', 'the trigger also fires for the other account');
  assert.equal((await one("select private.copy_start_readiness($1) r", [a.id])).r, 'ALREADY_ACTIVE');
});

test('F2 expiry while not LIVE requeues whatever the last blocker was', async () => {
  const a = await addMember('A', daysAgo(5));
  await enqueue();
  const sa = await session(a);
  await db.exec('update public.copy_system_control set execution_enabled=false');
  await db.query("update private.copy_resume_sessions set expires_at=clock_timestamp()-interval '1 second' where trading_account_id=$1", [a.account]);
  await asWorker();
  await db.query("select public.report_member_copy_resume_blocker($1,$2,'RESUME_PREVIEW_NOT_ZERO')", [a.account, sa.version]);
  assert.deepEqual(await stateOf(a), { state: 'QUEUED', reason: 'WAITING_FOR_LIVE', attempts: 1 });
});
