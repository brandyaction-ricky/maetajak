import test, { before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createVerifiedDatabase, seedVerifiedAccount, cyclePayload, record, ids } from './fixtures/verified-runtime.js';

// 2026-10-21 QA fixes (A1 A2 A3 A4 A7 D3 D8 D11): supabase/migrations/20261021032000_qa_admin_lifecycle.sql.
const MIGRATION = 'supabase/migrations/20261021032000_qa_admin_lifecycle.sql';
const admin = '30000000-0000-4000-8000-0000000000a1';
const KEY = 'K'.repeat(20);
let db;
const one = async (sql, args = []) => (await db.query(sql, args)).rows[0];
const n = async (sql, args = []) => Number((await one(sql, args)).n);
async function rejects(sql, args, pattern) {
  await db.exec('savepoint q_expect');
  try { await assert.rejects(db.query(sql, args), pattern); }
  finally { await db.exec('rollback to savepoint q_expect'); }
}
const asAdmin = () => db.exec(`select set_config('test.admin','true',true), set_config('request.jwt.claim.sub','${admin}',true), set_config('request.jwt.claim.role','authenticated',true)`);
const asMember = () => db.exec(`select set_config('test.admin','false',true), set_config('request.jwt.claim.sub','${ids.user}',true), set_config('request.jwt.claim.role','authenticated',true)`);
const asWorker = () => db.exec("select set_config('test.admin','false',true), set_config('request.jwt.claim.role','service_role',true)");
const session = () => one('select state,blocker_reason,version,reclassify_missing_copy from private.copy_resume_sessions where trading_account_id=$1', [ids.member]);
const credential = (user) => one('select * from private.gate_api_credentials where user_id=$1', [user]);
const metricsFor = async (user = ids.user) => {
  await asAdmin();
  const row = (await one('select public.get_admin_operations_metrics() v')).v;
  await asWorker();
  return { member: row.members.find((m) => m.id === user), totals: row.totals };
};
async function completeJob(user, success = true, errorCode = 'IP_NOT_ALLOWED') {
  const job = (await one('select id from private.gate_api_verification_jobs where user_id=$1', [user])).id;
  await asWorker();
  await db.query("select public.complete_gate_api_verification($1,$2,'gate-user',$3,'', '192.0.2.1')", [job, success, success ? null : errorCode]);
}

before(async () => {
  db = await createVerifiedDatabase();
  await db.exec(`create table if not exists public.member_daily_performance (user_id uuid not null, trading_date date not null,
    opening_equity numeric not null default 0, closing_equity numeric not null default 0, deposits numeric not null default 0,
    withdrawals numeric not null default 0, realised_pnl numeric not null default 0, unrealised_pnl numeric not null default 0,
    fees numeric not null default 0, funding_pnl numeric not null default 0, trading_volume numeric not null default 0,
    trade_count integer not null default 0, winning_trade_count integer not null default 0, losing_trade_count integer not null default 0,
    daily_return_pct numeric check (daily_return_pct is null or daily_return_pct >= -100),
    source_snapshot_at timestamptz not null default now(), primary key (user_id, trading_date))`);
});
after(async () => { await db?.close(); });
beforeEach(async () => {
  await db.exec('begin');
  await db.query("insert into public.profiles(id,email,role,approval_status) values($1,'admin@example.invalid','ADMIN','APPROVED')", [admin]);
});
afterEach(async () => { await db.exec('rollback'); });

// Master (admin's VERIFIED key, ACTIVE account on UID 55500011) and one ACTIVE copying member (UID 70000001).
async function seedMasterAndMember(actualSize = 0) {
  await seedVerifiedAccount(db);
  await db.query(`insert into private.gate_api_credentials(user_id,gate_uid,api_key_ciphertext,secret_key_ciphertext,api_key_last4,status,
      futures_read,futures_trade,connection_role,verification_version,verified_worker_ip)
    values($1,'55500011','x','y','TEST','VERIFIED',true,false,'MASTER',2,'192.0.2.1')`, [admin]);
  await db.query("update private.trading_accounts set credential_user_id=$1,user_id=$1,bound_gate_uid='55500011' where id=$2", [admin, ids.master]);
  await db.query("update private.trading_accounts set bound_gate_uid='70000001' where id=$1", [ids.member]);
  await db.query("update private.gate_api_credentials set gate_uid='70000001' where user_id=$1", [ids.user]);
  await db.query("update public.profiles set gate_uid='70000001',email='70000001@uid.maetajak.trading' where id=$1", [ids.user]);
  await db.query("insert into auth.users(id,email,raw_user_meta_data) values($1,'70000001@uid.maetajak.trading','{\"gate_uid\":\"70000001\"}')", [ids.user]);
  // The UID edit above is a credential change (trigger pause): the fixture member is copying.
  await db.query("update private.copy_resume_sessions set state='ACTIVE',blocker_reason=null where trading_account_id=$1", [ids.member]);
  await record(db, cyclePayload({ masterSize: 40, actualSize }));
}

// A platform fill of the current generation, confirmed and journalled (an ownership checkpoint with COPY 10).
async function seedConfirmedCopy(size = 10) {
  await db.query(`insert into private.copy_order_intents(cycle_id,user_id,trading_account_id,contract,target_size,actual_size_at_plan,
      delta_size,idempotency_key,gate_order_text,status,filled_size,submit_attempts,exchange_terminal,resume_version,
      observation_confirmed_at,resolved_at,position_side)
    values(gen_random_uuid(),$1,$2,'BTC_USDT',$3,0,$3,'k-'||gen_random_uuid(),'t-'||gen_random_uuid(),'FILLED',$3,1,true,$4,now(),now(),'LONG')`,
    [ids.user, ids.member, size, ids.version]);
  await db.query(`insert into private.copy_ownership_checkpoints(trading_account_id,resume_version,status,protected_positions,copy_positions,observed_at)
    values($1,$2,'CONFIRMED','[]',$3,now())`, [ids.member, ids.version, JSON.stringify([{ contract: 'BTC_USDT', position_side: 'LONG', size }])]);
  await db.query(`insert into private.copy_ownership_fills(intent_id,trading_account_id,resume_version,filled_size,confirmed_at)
    select id,trading_account_id,resume_version,filled_size,observation_confirmed_at from private.copy_order_intents where trading_account_id=$1`, [ids.member]);
}
const btc = (size) => [{ contract: 'BTC_USDT', position_side: size < 0 ? 'SHORT' : 'LONG', size }];

// ---------------------------------------------------------------------------------------------
// A1: same-UID Master key replacement
// ---------------------------------------------------------------------------------------------
test('A1 same-UID key: the worker verifies the pending key while the current one stays VERIFIED and in use', async () => {
  await seedMasterAndMember();
  await asAdmin();
  const saved = (await one('select public.save_admin_gate_api_credentials($1,$2,$3,true) r', ['55500011', KEY, KEY])).r;
  assert.deepEqual([saved.status, saved.api_key_last4, saved.pending_status, saved.pending_api_key_last4],
    ['VERIFIED', 'TEST', 'PENDING_VERIFICATION', 'KKKK']);
  await asWorker();
  const [job] = (await db.query('select * from public.claim_gate_api_verification_jobs(5)')).rows;
  assert.equal(job.gate_uid, '55500011');
  const c = await credential(admin);
  assert.deepEqual([c.status, c.pending_status], ['VERIFIED', 'VERIFYING'], 'claiming does not touch the key in use');
  assert.equal((await one('select public.get_copy_worker_context() v')).v.master?.gate_uid, '55500011');
  assert.equal((await session()).state, 'ACTIVE');
});

test('A1 same-UID key: a second key cannot replace the one the worker is verifying right now', async () => {
  await seedMasterAndMember();
  await asAdmin();
  await db.query('select public.save_admin_gate_api_credentials($1,$2,$3,true)', ['55500011', KEY, KEY]);
  await asWorker();
  await db.query('select * from public.claim_gate_api_verification_jobs(5)');
  await asAdmin();
  await rejects('select public.save_admin_gate_api_credentials($1,$2,$3,true)', ['55500011', 'L'.repeat(20), 'L'.repeat(20)],
    /MASTER_KEY_VERIFICATION_IN_PROGRESS/);
  await rejects('select public.retry_admin_master_gate_api_verification(true)', [], /MASTER_KEY_VERIFICATION_IN_PROGRESS/);
});

test('A1 same-UID key: a failed verification keeps the current key and account, members keep copying, the admin sees it', async () => {
  await seedMasterAndMember();
  await asAdmin();
  await db.query('select public.save_admin_gate_api_credentials($1,$2,$3,true)', ['55500011', KEY, KEY]);
  await completeJob(admin, false, 'IP_NOT_ALLOWED');
  const c = await credential(admin);
  assert.deepEqual([c.status, c.api_key_last4, c.pending_status, c.pending_error_code, c.pending_api_key_ciphertext],
    ['VERIFIED', 'TEST', 'ERROR', 'IP_NOT_ALLOWED', null]);
  assert.equal((await one('select status from private.trading_accounts where id=$1', [ids.master])).status, 'ACTIVE');
  assert.equal((await session()).state, 'ACTIVE');
  assert.equal(await n("select count(*) n from public.admin_audit_logs where action='MEMBERS_PAUSED_BY_MASTER'"), 0);
  assert.equal(await n("select count(*) n from public.admin_audit_logs where action='MASTER_GATE_API_KEY_ROTATION_FAILED'"), 1);
  await asAdmin();
  const view = (await one('select public.get_admin_master_gate_api_connection() v')).v;
  assert.deepEqual([view.status, view.pending_status, view.pending_error_code, view.pending_api_key_last4],
    ['VERIFIED', 'ERROR', 'IP_NOT_ALLOWED', 'KKKK']);
});

test('A1 re-verify of the stored Master key while in use: no account disable, no member pause', async () => {
  await seedMasterAndMember();
  await asAdmin();
  const r = (await one('select public.retry_admin_master_gate_api_verification(true) r')).r;
  assert.deepEqual([r.status, r.pending_status], ['VERIFIED', 'PENDING_VERIFICATION']);
  assert.equal((await one('select status from private.trading_accounts where id=$1', [ids.master])).status, 'ACTIVE');
  await completeJob(admin, true);
  assert.equal((await credential(admin)).pending_status, 'VERIFIED');
  assert.equal((await session()).state, 'ACTIVE');
});

test('A1 Master-caused pause: own reason, audit + events, member pause reasons preserved, bulk resume requests a validated resume', async () => {
  await seedMasterAndMember();
  // A second member who paused themselves first.
  const other = randomUUID(); const otherAccount = randomUUID();
  await db.query("insert into public.profiles(id,email,approval_status,copy_paused) values($1,'o@example.invalid','APPROVED',true)", [other]);
  await db.query("insert into private.trading_accounts(id,user_id,credential_user_id,account_role,status) values($1,$2,$2,'MEMBER','ACTIVE')", [otherAccount, other]);
  await db.query("insert into private.copy_resume_sessions(trading_account_id,state,blocker_reason) values($1,'PAUSED','MEMBER_PAUSED')", [otherAccount]);
  // The Master key fails (ERROR): every copying member is paused because of the Master.
  await db.query("update private.gate_api_credentials set status='ERROR' where user_id=$1", [admin]);
  let s = await session();
  assert.deepEqual([s.state, s.blocker_reason], ['PAUSED', 'MASTER_CREDENTIAL_CHANGED']);
  // Re-saving the failed key goes through the full re-verification (the members stay paused).
  await asAdmin();
  await db.query('select public.save_admin_gate_api_credentials($1,$2,$3,true)', ['55500011', KEY, KEY]);
  s = await session();
  assert.deepEqual([s.state, s.blocker_reason], ['PAUSED', 'MASTER_CREDENTIAL_CHANGED']);
  assert.equal((await one('select blocker_reason from private.copy_resume_sessions where trading_account_id=$1', [otherAccount])).blocker_reason,
    'MEMBER_PAUSED', 'an existing pause reason is not relabelled');
  assert.ok(await n("select count(*) n from public.admin_audit_logs where action='MEMBERS_PAUSED_BY_MASTER'") >= 1);
  assert.ok(await n("select count(*) n from public.copy_events where user_id=$1 and event_type='SYMBOL_PAUSED' and safe_payload->>'cause'='MASTER'", [ids.user]) >= 1);
  await completeJob(admin, true);
  const { member, totals } = await metricsFor();
  assert.equal(member.copy_status, 'RESUME_REQUIRED', 'not 카피 중');
  assert.equal(member.paused_by_master, true);
  assert.equal(totals.paused_by_master, 1);
  await asAdmin();
  await rejects("select public.admin_request_all_member_copy_resume('YES')", [], /CONFIRMATION_REQUIRED/);
  const r = (await one("select public.admin_request_all_member_copy_resume('ADMIN_RESUME_MEMBERS_PAUSED_BY_MASTER') r")).r;
  assert.equal(r.requested, 1, 'only the member paused by the Master');
  s = await session();
  assert.equal(s.state, 'REQUESTED');
  assert.equal((await one('select state from private.copy_resume_sessions where trading_account_id=$1', [otherAccount])).state, 'PAUSED');
  assert.equal(await n("select count(*) n from public.admin_audit_logs where action='ADMIN_BULK_COPY_RESUME_REQUESTED'"), 1);
  await asMember();
  await rejects("select public.admin_request_all_member_copy_resume('ADMIN_RESUME_MEMBERS_PAUSED_BY_MASTER')", [], /ADMIN_REQUIRED/);
});

test('A1 bulk resume refuses while the Master is not active', async () => {
  await seedMasterAndMember();
  await db.query("update private.trading_accounts set status='DISABLED' where id=$1", [ids.master]);
  await asAdmin();
  await rejects("select public.admin_request_all_member_copy_resume('ADMIN_RESUME_MEMBERS_PAUSED_BY_MASTER')", [], /MASTER_NOT_ACTIVE/);
});

test('A1/A7 a different Master UID resets members; their next resume protects every holding despite old platform fills', async () => {
  await seedMasterAndMember(10);
  await seedConfirmedCopy(10);
  await asAdmin();
  await db.query('select public.save_admin_gate_api_credentials($1,$2,$3,true)', ['55500099', KEY, KEY]);
  assert.equal((await session()).blocker_reason, 'MASTER_ACCOUNT_CHANGE_PENDING');
  await completeJob(admin, true);
  assert.equal((await session()).blocker_reason, 'MASTER_ACCOUNT_CHANGED');
  assert.equal(await n('select count(*) n from private.copy_ownership_resets where trading_account_id=$1', [ids.member]), 1);
  await asAdmin();
  assert.equal((await one("select public.admin_request_all_member_copy_resume('ADMIN_RESUME_MEMBERS_PAUSED_BY_MASTER') r")).r.requested, 1);
  const s = await session();
  await asWorker();
  // Before 2026-10-21 the old fill without a checkpoint raised RESUME_COPY_OWNERSHIP_UNKNOWN for ever.
  const ownership = (await one('select public.get_member_copy_resume_ownership($1,$2,$3,$4) o',
    [ids.member, s.version, JSON.stringify(btc(80)), JSON.stringify(btc(10))])).o;
  assert.deepEqual(ownership.member_positions, btc(10), 'the old COPY is the member\'s own after a Master change');
  assert.deepEqual(ownership.copy_positions, []);
});

// ---------------------------------------------------------------------------------------------
// A2: admin copy status
// ---------------------------------------------------------------------------------------------
test('A2 copy status: 미시작 without a session, 재개 확인 필요 for a non-ACTIVE session, 일시중지 when paused', async () => {
  await seedMasterAndMember();
  assert.equal((await metricsFor()).member.copy_status, 'COPYING');
  await db.query("update private.copy_resume_sessions set state='PAUSED',blocker_reason='TRADING_ACCOUNT_CHANGED' where trading_account_id=$1", [ids.member]);
  let m = (await metricsFor()).member;
  assert.deepEqual([m.copy_status, m.session_state, m.resume_blocker], ['RESUME_REQUIRED', 'PAUSED', 'TRADING_ACCOUNT_CHANGED']);
  await db.query("update public.profiles set copy_paused=true where id=$1", [ids.user]);
  assert.equal((await metricsFor()).member.copy_status, 'PAUSED');
  await db.query('delete from private.copy_resume_sessions where trading_account_id=$1', [ids.member]);
  assert.equal((await metricsFor()).member.copy_status, 'NOT_STARTED');
  await db.query("update private.gate_api_credentials set status='ERROR' where user_id=$1", [ids.user]);
  assert.equal((await metricsFor()).member.copy_status, 'API_ERROR');
});

// ---------------------------------------------------------------------------------------------
// A3: admin disconnect of a member API
// ---------------------------------------------------------------------------------------------
test('A3 admin_disable_member_gate_api_connection exists with the UI signature and admin-only access', async () => {
  await seedMasterAndMember();
  const acl = await one(`select has_function_privilege('anon','public.admin_disable_member_gate_api_connection(uuid,text)','EXECUTE') anon,
    has_function_privilege('authenticated','public.admin_disable_member_gate_api_connection(uuid,text)','EXECUTE') auth`);
  assert.deepEqual(acl, { anon: false, auth: true });
  await asMember();
  await rejects("select public.admin_disable_member_gate_api_connection($1,'ADMIN_DISCONNECT_MEMBER_GATE_API')", [ids.user], /ADMIN_REQUIRED/);
  await asAdmin();
  await rejects("select public.admin_disable_member_gate_api_connection($1,'X')", [ids.user], /CONFIRMATION_REQUIRED/);
  await db.query("select public.admin_disable_member_gate_api_connection(p_user_id => $1, p_confirmation => 'ADMIN_DISCONNECT_MEMBER_GATE_API')", [ids.user]);
  assert.equal((await credential(ids.user)).status, 'DISABLED');
  assert.equal((await one('select status from private.trading_accounts where id=$1', [ids.member])).status, 'DISABLED');
});

// ---------------------------------------------------------------------------------------------
// A4: UID release
// ---------------------------------------------------------------------------------------------
test('A4 release_member_gate_uid: guarded, audited, frees the UID and the login email for the real owner', async () => {
  await seedMasterAndMember();
  await db.exec('create table auth.identities (user_id uuid, provider text, identity_data jsonb, updated_at timestamptz)');
  await db.query(`insert into auth.identities values($1,'email','{"email":"70000001@uid.maetajak.trading","sub":"x"}',now())`, [ids.user]);
  await asAdmin();
  await rejects("select public.release_member_gate_uid($1,'X')", [ids.user], /CONFIRMATION_REQUIRED/);
  await rejects("select public.release_member_gate_uid($1,'RELEASE_MEMBER_GATE_UID')", [ids.user], /MEMBER_ACTIVE/);
  // A verified member keeps the UID through withdrawal (it proved ownership of the Gate account).
  await db.query("select public.admin_withdraw_member($1,'ADMIN_WITHDRAW_MEMBER','t')", [ids.user]);
  assert.equal((await one('select gate_uid from public.profiles where id=$1', [ids.user])).gate_uid, '70000001');
  const r = (await one("select public.release_member_gate_uid($1,'RELEASE_MEMBER_GATE_UID') r", [ids.user])).r;
  assert.equal(r.released_gate_uid, '70000001');
  const p = await one('select gate_uid,released_gate_uid,gate_uid_released_by,email from public.profiles where id=$1', [ids.user]);
  assert.deepEqual([p.gate_uid, p.released_gate_uid, p.gate_uid_released_by], [null, '70000001', admin]);
  const u = await one('select email,raw_user_meta_data from auth.users where id=$1', [ids.user]);
  assert.match(u.email, /^released\+[0-9a-f]{32}@uid\.maetajak\.trading$/);
  assert.equal(u.raw_user_meta_data.gate_uid, undefined);
  assert.equal(p.email, u.email);
  const identity = await one('select identity_data from auth.identities where user_id=$1', [ids.user]);
  assert.deepEqual(identity.identity_data, { email: u.email, sub: 'x' });
  assert.equal(await n("select count(*) n from public.admin_audit_logs where action='MEMBER_GATE_UID_RELEASED' and target_user_id=$1", [ids.user]), 1);
  // uid-signup: profiles.gate_uid is free (UID_TAKEN check) and so is the synthetic auth email.
  assert.equal(await n("select count(*) n from public.profiles where gate_uid='70000001'"), 0);
  assert.equal(await n("select count(*) n from auth.users where lower(email)='70000001@uid.maetajak.trading'"), 0);
  const owner = randomUUID();
  await db.query("insert into public.profiles(id,email,gate_uid) values($1,'70000001@uid.maetajak.trading','70000001')", [owner]);
  await asMember();
  await rejects("select public.release_member_gate_uid($1,'RELEASE_MEMBER_GATE_UID')", [owner], /ADMIN_REQUIRED/);
});

test('A4 release is refused while a Gate key is live; rejection releases an unused UID', async () => {
  const pending = randomUUID();
  await db.query("insert into public.profiles(id,email,gate_uid) values($1,'70000005@uid.maetajak.trading','70000005')", [pending]);
  await db.query("insert into auth.users(id,email) values($1,'70000005@uid.maetajak.trading')", [pending]);
  await db.query(`insert into private.gate_api_credentials(user_id,gate_uid,api_key_ciphertext,secret_key_ciphertext,api_key_last4,status)
    values($1,'70000005','x','y','TEST','ERROR')`, [pending]);
  await asAdmin();
  await rejects("select public.release_member_gate_uid($1,'RELEASE_MEMBER_GATE_UID')", [pending], /MEMBER_GATE_API_CONNECTED/);
  await db.query("select public.set_user_approval($1,'REJECTED')", [pending]);
  assert.equal((await one('select gate_uid from public.profiles where id=$1', [pending])).gate_uid, '70000005', 'a live key keeps it');
  await db.query("update private.gate_api_credentials set status='DISABLED' where user_id=$1", [pending]);
  await db.query("select public.set_user_approval($1,'REJECTED')", [pending]);
  const p = await one('select gate_uid,released_gate_uid from public.profiles where id=$1', [pending]);
  assert.deepEqual([p.gate_uid, p.released_gate_uid], [null, '70000005']);
});

// ---------------------------------------------------------------------------------------------
// A7: restore
// ---------------------------------------------------------------------------------------------
test('A7 restore archives copy-derived state, unbinds the UID and a reconnect of the same UID starts clean', async () => {
  await seedMasterAndMember(10);
  await seedConfirmedCopy(10);
  assert.ok(await n('select count(*) n from public.copy_position_states where trading_account_id=$1', [ids.member]) > 0);
  await asAdmin();
  await db.query("select public.admin_withdraw_member($1,'ADMIN_WITHDRAW_MEMBER','t')", [ids.user]);
  const restored = (await one('select public.admin_restore_withdrawn_member($1) r', [ids.user])).r;
  assert.equal(restored.copy_state_reset, 1);
  const archive = await one("select archived from private.trading_account_rebind_archive where trading_account_id=$1 and reason='MEMBER_RESTORED'", [ids.member]);
  assert.equal(archive.archived.copy_ownership_checkpoints.length, 1);
  assert.equal(await n('select count(*) n from public.copy_position_states where trading_account_id=$1', [ids.member]), 0);
  assert.equal(await n('select count(*) n from private.copy_ownership_checkpoints where trading_account_id=$1', [ids.member]), 0);
  assert.equal((await one('select bound_gate_uid from private.trading_accounts where id=$1', [ids.member])).bound_gate_uid, null);
  let s = await session();
  assert.deepEqual([s.state, s.blocker_reason], ['REQUIRED', 'MEMBER_RESTORED']);
  assert.equal((await metricsFor()).member, undefined, 'PENDING members are not in the operations list');
  // Re-approval and reconnect of the same UID: bound again without a GATE_ACCOUNT_CHANGED archive.
  await asAdmin();
  await db.query("select public.set_user_approval($1,'APPROVED')", [ids.user]);
  await asMember();
  await db.query('select public.save_gate_api_credentials($1,$2,$3,true)', ['70000001', KEY, KEY]);
  await completeJob(ids.user, true);
  const account = await one('select status,bound_gate_uid from private.trading_accounts where id=$1', [ids.member]);
  assert.deepEqual([account.status, account.bound_gate_uid], ['ACTIVE', '70000001']);
  assert.equal(await n("select count(*) n from private.trading_account_rebind_archive where trading_account_id=$1 and reason='GATE_ACCOUNT_CHANGED'", [ids.member]), 0);
  assert.equal((await metricsFor()).member.copy_status, 'NOT_STARTED');
  await asMember();
  await db.query("select public.set_my_copy_pause('RESUME')");
  s = await session();
  assert.equal(s.state, 'REQUESTED');
  await asWorker();
  const ownership = (await one('select public.get_member_copy_resume_ownership($1,$2,$3,$4) o',
    [ids.member, s.version, JSON.stringify(btc(40)), JSON.stringify(btc(10))])).o;
  assert.deepEqual(ownership.member_positions, btc(10), 'holdings from before the withdrawal are the member\'s own');
  assert.deepEqual(ownership.copy_positions, []);
});

test('A7 restore gives a released UID back when nobody took it, and keeps it released when someone did', async () => {
  const squatter = randomUUID();
  await db.query("insert into public.profiles(id,email,gate_uid) values($1,'70000002@uid.maetajak.trading','70000002')", [squatter]);
  await db.query("insert into auth.users(id,email) values($1,'70000002@uid.maetajak.trading')", [squatter]);
  await asAdmin();
  await db.query("select public.admin_withdraw_member($1,'ADMIN_WITHDRAW_MEMBER','t')", [squatter]);
  assert.equal((await one('select gate_uid from public.profiles where id=$1', [squatter])).gate_uid, null);
  await db.exec('savepoint reclaim');
  let r = (await one('select public.admin_restore_withdrawn_member($1) r', [squatter])).r;
  assert.deepEqual([r.gate_uid, r.released_gate_uid], ['70000002', null]);
  assert.equal((await one('select email from auth.users where id=$1', [squatter])).email, '70000002@uid.maetajak.trading');
  await db.exec('rollback to savepoint reclaim');
  await db.query("insert into public.profiles(id,email,gate_uid) values($1,'70000002@uid.maetajak.trading','70000002')", [randomUUID()]);
  r = (await one('select public.admin_restore_withdrawn_member($1) r', [squatter])).r;
  assert.deepEqual([r.gate_uid, r.released_gate_uid], [null, '70000002']);
});

// ---------------------------------------------------------------------------------------------
// D8: RESUME_COPY_SOURCE_MISSING
// ---------------------------------------------------------------------------------------------
test('D8 COPY whose Master leg is gone blocks a normal resume; the opt-in turns it into the member\'s own, audited', async () => {
  await seedMasterAndMember(10);
  await seedConfirmedCopy(10);
  await asMember();
  await rejects("select public.request_my_copy_resume_reclassify('RECLASSIFY_UNMATCHED_COPY_AS_PERSONAL')", [], /RECLASSIFY_NOT_AVAILABLE/);
  await db.query("select public.set_my_copy_pause('HOLD')");
  await db.query("select public.set_my_copy_pause('RESUME')");
  let s = await session();
  await asWorker();
  // The Master closed BTC during the HOLD.
  await rejects('select public.get_member_copy_resume_ownership($1,$2,$3,$4)', [ids.member, s.version, '[]', JSON.stringify(btc(10))],
    /RESUME_COPY_SOURCE_MISSING/);
  await db.query("select public.report_member_copy_resume_blocker($1,$2,'RESUME_COPY_SOURCE_MISSING')", [ids.member, s.version]);
  await asMember();
  await rejects("select public.request_my_copy_resume_reclassify('YES')", [], /CONFIRMATION_REQUIRED/);
  const r = (await one("select public.request_my_copy_resume_reclassify('RECLASSIFY_UNMATCHED_COPY_AS_PERSONAL') r")).r;
  assert.equal(r.reclassify_missing_copy, true);
  const next = await session();
  assert.notEqual(next.version, s.version, 'a new resume generation');
  assert.deepEqual([next.state, next.reclassify_missing_copy], ['REQUESTED', true]);
  s = next;
  await asWorker();
  const ownership = (await one('select public.get_member_copy_resume_ownership($1,$2,$3,$4) o',
    [ids.member, s.version, '[]', JSON.stringify(btc(10))])).o;
  assert.deepEqual(ownership.member_positions, btc(10));
  assert.deepEqual(ownership.copy_positions, []);
  const proof = await one('select protected_positions,copy_positions,reason from private.copy_ownership_checkpoints where trading_account_id=$1', [ids.member]);
  assert.deepEqual([proof.protected_positions, proof.copy_positions, proof.reason], [btc(10), [], 'COPY_RECLASSIFIED_AS_PERSONAL']);
  assert.equal(await n("select count(*) n from public.admin_audit_logs where action='MEMBER_COPY_RECLASSIFY_REQUESTED' and actor_id=$1", [ids.user]), 1);
  assert.equal(await n("select count(*) n from public.admin_audit_logs where action='MEMBER_COPY_RECLASSIFIED_AS_PERSONAL'"), 1);
  // Idempotent on the second evaluation (prepare/activate run it again).
  await db.query('select public.get_member_copy_resume_ownership($1,$2,$3,$4)', [ids.member, s.version, '[]', JSON.stringify(btc(10))]);
  assert.equal(await n("select count(*) n from public.admin_audit_logs where action='MEMBER_COPY_RECLASSIFIED_AS_PERSONAL'"), 1);
});

test('D8 a COPY leg the Master still holds stays COPY under the opt-in', async () => {
  await seedMasterAndMember(10);
  await seedConfirmedCopy(10);
  await db.query("update private.copy_resume_sessions set reclassify_missing_copy=true where trading_account_id=$1", [ids.member]);
  await db.query("update private.copy_resume_sessions set state='REQUESTED' where trading_account_id=$1", [ids.member]);
  await asWorker();
  const ownership = (await one('select public.get_member_copy_resume_ownership($1,$2,$3,$4) o',
    [ids.member, ids.version, JSON.stringify(btc(40)), JSON.stringify(btc(10))])).o;
  assert.deepEqual(ownership.copy_positions, btc(10));
  assert.deepEqual(ownership.member_positions, []);
});

// ---------------------------------------------------------------------------------------------
// D11: dashboard MDD on the return index
// ---------------------------------------------------------------------------------------------
test('D11 dashboard MDD ignores deposits/withdrawals and counts the first day\'s loss', async () => {
  await seedVerifiedAccount(db);
  await db.query("update public.profiles set copy_started_at=now()-interval '10 days' where id=$1", [ids.user]);
  const today = (await one("select (now() at time zone 'Asia/Seoul')::date d")).d;
  const day = (offset) => { const d = new Date(today); d.setUTCDate(d.getUTCDate() - offset); return d.toISOString().slice(0, 10); };
  // 1000 -> 900 (-10%), withdraw 800 -> 100 (0%), -> 90 (-10%).
  for (const [offset, open, close, wd, ret] of [[3, 1000, 900, 0, -10], [2, 900, 100, 800, 0], [1, 100, 90, 0, -10]]) {
    await db.query(`insert into public.member_daily_performance(user_id,trading_date,opening_equity,closing_equity,withdrawals,daily_return_pct)
      values($1,$2,$3,$4,$5,$6)`, [ids.user, day(offset), open, close, wd, ret]);
  }
  await asMember();
  const r = (await one('select public.get_my_dashboard_performance_range($1,$2) r', [day(5), day(0)])).r;
  assert.ok(Math.abs(Number(r.totals.mdd) - 19) < 1e-9, `MDD ${r.totals.mdd}: index 0.9 -> 0.81, not 91% from the withdrawal`);
  assert.ok(Math.abs(Number(r.totals.roi) + 19) < 1e-9);
  const p = (await one('select public.get_my_dashboard_performance(30) r')).r;
  assert.ok(Math.abs(Number(p.totals.mdd) - 19) < 1e-9);
});

// ---------------------------------------------------------------------------------------------
// The migration is idempotent.
// ---------------------------------------------------------------------------------------------
const fnDef = async (sig) => (await one(`select pg_get_functiondef('${sig}'::regprocedure) d`)).d;
const CORE = 'private.copy_resume_ownership_core(uuid,uuid,jsonb,jsonb)';
const OBSERVE = 'private.observe_copy_ownership()';
// Review R5: only the evidence clauses carry the epoch; the "filled, not observed yet" guards do not.
function assertEpochOnlyOnEvidence(core, observe) {
  assert.equal(core.split('copy_ownership_reset_at').length - 1, 2, 'core: journal check + no-checkpoint check');
  assert.equal(observe.split('copy_ownership_reset_at').length - 1, 3, 'observe: CLOSE journal, no-checkpoint check, journal loop');
  for (const def of [core, observe]) {
    assert.doesNotMatch(def, /observation_confirmed_at is null[^;]{0,80}copy_ownership_reset_at/);
    assert.match(def, /i\.observation_confirmed_at is null and i\.resume_version is not null\)/);
  }
}
test('the migration can be applied twice and patches the ownership functions once', async () => {
  await db.exec(readFileSync(MIGRATION, 'utf8'));
  const core = await fnDef(CORE);
  assertEpochOnlyOnEvidence(core, await fnDef(OBSERVE));
  const wrapper = (await one("select pg_get_functiondef('private.copy_resume_ownership(uuid,uuid,jsonb,jsonb)'::regprocedure) d")).d;
  assert.match(wrapper, /copy_resume_ownership_core/);
  assert.doesNotMatch(wrapper, /copy_ownership_reset_at/);
});

test('R5 a re-run repairs an earlier, broader epoch patch of the guard clauses', async () => {
  // The pre-review patch also limited the three "filled but not observed" guards.
  for (const sig of [CORE, OBSERVE]) {
    const broad = (await fnDef(sig)).replace(/i\.observation_confirmed_at is null and i\.resume_version is not null\)/g,
      'i.observation_confirmed_at is null and i.resume_version is not null and i.created_at>private.copy_ownership_reset_at(i.trading_account_id))');
    await db.exec(broad);
  }
  assert.match(await fnDef(CORE), /is null and i\.resume_version is not null and i\.created_at/);
  await db.exec(readFileSync(MIGRATION, 'utf8'));
  assertEpochOnlyOnEvidence(await fnDef(CORE), await fnDef(OBSERVE));
});

test('R5 a fill still unobserved at an ownership reset keeps blocking the resume (not hidden by the epoch)', async () => {
  await seedMasterAndMember(10);
  await seedConfirmedCopy(10);
  // A platform fill not yet confirmed by an observation, created before the reset.
  await db.query(`insert into private.copy_order_intents(cycle_id,user_id,trading_account_id,contract,target_size,actual_size_at_plan,
      delta_size,idempotency_key,gate_order_text,status,filled_size,submit_attempts,exchange_terminal,resume_version,resolved_at,position_side)
    values(gen_random_uuid(),$1,$2,'BTC_USDT',15,10,5,'k-'||gen_random_uuid(),'t-'||gen_random_uuid(),'FILLED',5,1,true,$3,now(),'LONG')`,
  [ids.user, ids.member, ids.version]);
  await db.query(`insert into private.copy_ownership_resets(trading_account_id,reset_at,reason) values($1,clock_timestamp()+interval '1 second','ACCOUNT_RESET')
    on conflict (trading_account_id) do update set reset_at=excluded.reset_at`, [ids.member]);
  await asWorker();
  await rejects('select private.copy_resume_ownership_core($1,$2,$3,$4)',
    [ids.member, ids.version, JSON.stringify(btc(80)), JSON.stringify(btc(15))], /RESUME_UNRESOLVED_OWNERSHIP/);
});
