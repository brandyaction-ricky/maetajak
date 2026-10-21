import test, { before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createVerifiedDatabase, seedVerifiedAccount, cyclePayload, record, ids } from './fixtures/verified-runtime.js';

// 2026-10-21: administrator member withdrawal (soft delete) and restore.
const admin = '20000000-0000-4000-8000-0000000000aa';
let db;
const one = async (sql, args = []) => (await db.query(sql, args)).rows[0];
const n = async (sql, args = []) => Number((await one(sql, args)).n);
async function rejects(sql, args, pattern) {
  await db.exec('savepoint w_expect');
  try { await assert.rejects(db.query(sql, args), pattern); }
  finally { await db.exec('rollback to savepoint w_expect'); }
}
const asAdmin = (on = true) => db.exec(`select set_config('test.admin','${on}',true), set_config('request.jwt.claim.sub','${admin}',true)`);
const withdraw = (user = ids.user, reason = '테스트 사유') =>
  db.query("select public.admin_withdraw_member($1,'ADMIN_WITHDRAW_MEMBER',$2) r", [user, reason]);

before(async () => {
  db = await createVerifiedDatabase();
  // Production objects the structural fixture lacks (test-only stubs, no data).
  await db.exec(`create table if not exists private.gate_api_verification_jobs (
      id bigint generated always as identity primary key, user_id uuid not null unique,
      attempts integer not null default 0, run_after timestamptz not null default now(), claimed_at timestamptz,
      created_at timestamptz not null default now(), updated_at timestamptz not null default now());
    create table if not exists auth.users (id uuid primary key, banned_until timestamptz, updated_at timestamptz);
    create or replace function extensions.pgp_sym_encrypt(text,text,text) returns bytea language sql as $$ select convert_to('TEST_ONLY','UTF8') $$;
    create or replace function extensions.gen_random_bytes(integer) returns bytea language sql as $$ select decode(repeat('00',$1),'hex') $$;`);
});
after(async () => { await db?.close(); });
beforeEach(async () => {
  await db.exec('begin');
  await seedVerifiedAccount(db);
  await db.query('insert into auth.users(id) values($1)', [ids.user]);
  await db.query('insert into private.gate_api_verification_jobs(user_id) values($1)', [ids.user]);
});
afterEach(async () => { await db.exec('rollback'); });

test('withdrawal: stops copying, disables account and key, bans login, keeps every record, audited', async () => {
  await record(db, cyclePayload());
  const intentsBefore = await n('select count(*) n from private.copy_order_intents');
  await asAdmin();
  const { rows: [{ r }] } = await withdraw();
  assert.equal(r.withdrawn, true);
  const p = await one('select approval_status,copy_paused,member_halted,withdrawn_at,withdrawn_by,withdrawal_reason from public.profiles where id=$1', [ids.user]);
  assert.deepEqual([p.approval_status, p.copy_paused, p.member_halted, p.withdrawn_by, p.withdrawal_reason],
    ['SUSPENDED', true, true, admin, '테스트 사유']);
  assert.ok(p.withdrawn_at);
  assert.equal((await one('select state,blocker_reason from private.copy_resume_sessions')).blocker_reason, 'MEMBER_WITHDRAWN');
  assert.equal((await one('select status from private.trading_accounts where id=$1', [ids.member])).status, 'DISABLED');
  const g = await one('select status,gate_uid,futures_trade from private.gate_api_credentials where user_id=$1', [ids.user]);
  assert.deepEqual([g.status, g.gate_uid, g.futures_trade], ['DISABLED', 'DISABLED', false]);
  assert.equal((await one("select run_after='infinity'::timestamptz v from private.gate_api_verification_jobs")).v, true);
  assert.equal((await one('select banned_until=\'infinity\'::timestamptz v from auth.users where id=$1', [ids.user])).v, true);
  // Records are kept: nothing deleted, unsubmitted plans cancelled with a never-sent reason.
  assert.equal(await n('select count(*) n from private.copy_order_intents'), intentsBefore);
  assert.equal((await one('select status,last_error_code from private.copy_order_intents')).last_error_code, 'MEMBER_WITHDRAWN');
  assert.equal(await n('select count(*) n from public.profiles where id=$1', [ids.user]), 1);
  const log = await one("select actor_id,target_user_id,next_value from public.admin_audit_logs where action='MEMBER_WITHDRAWN'");
  assert.deepEqual([log.actor_id, log.target_user_id, log.next_value.approval_status], [admin, ids.user, 'SUSPENDED']);
  await rejects("select public.admin_withdraw_member($1,'ADMIN_WITHDRAW_MEMBER',null)", [ids.user], /MEMBER_ALREADY_WITHDRAWN/);
});

test('withdrawal: refused for non-admins, wrong confirmation, unknown members and in-flight orders; authenticated-only', async () => {
  await asAdmin(false);
  await rejects("select public.admin_withdraw_member($1,'ADMIN_WITHDRAW_MEMBER',null)", [ids.user], /ADMIN_REQUIRED/);
  await asAdmin();
  await rejects("select public.admin_withdraw_member($1,'WITHDRAW',null)", [ids.user], /CONFIRMATION_REQUIRED/);
  await rejects("select public.admin_withdraw_member($1,'ADMIN_WITHDRAW_MEMBER',null)", [randomUUID()], /MEMBER_NOT_FOUND/);
  await record(db, cyclePayload());
  await db.exec("update private.copy_order_intents set status='SUBMITTING',submit_attempts=1,exchange_terminal=false");
  await rejects("select public.admin_withdraw_member($1,'ADMIN_WITHDRAW_MEMBER',null)", [ids.user], /MEMBER_HAS_UNRESOLVED_ORDERS/);
  assert.equal((await one('select approval_status from public.profiles where id=$1', [ids.user])).approval_status, 'APPROVED');
  const acl = await one(`select has_function_privilege('anon','public.admin_withdraw_member(uuid,text,text)','EXECUTE') anon,
    has_function_privilege('authenticated','public.admin_withdraw_member(uuid,text,text)','EXECUTE') auth,
    has_function_privilege('anon','public.admin_restore_withdrawn_member(uuid)','EXECUTE') anon_restore`);
  assert.deepEqual(acl, { anon: false, auth: true, anon_restore: false });
});

test('restore: lifts the ban and returns the member to PENDING; approval cannot bypass restore', async () => {
  await asAdmin();
  await withdraw();
  await rejects("select public.set_user_approval($1,'APPROVED')", [ids.user], /MEMBER_WITHDRAWN/);
  await db.query('select public.admin_restore_withdrawn_member($1)', [ids.user]);
  const p = await one('select approval_status,withdrawn_at,copy_paused,member_halted from public.profiles where id=$1', [ids.user]);
  assert.deepEqual([p.approval_status, p.withdrawn_at, p.copy_paused, p.member_halted], ['PENDING', null, true, true]);
  assert.equal((await one('select banned_until from auth.users where id=$1', [ids.user])).banned_until, null);
  assert.equal(await n("select count(*) n from public.admin_audit_logs where action='MEMBER_RESTORED'"), 1);
  // Restored members still have no usable API key (must reconnect).
  assert.equal((await one('select status from private.gate_api_credentials where user_id=$1', [ids.user])).status, 'DISABLED');
  await rejects('select public.admin_restore_withdrawn_member($1)', [ids.user], /MEMBER_NOT_WITHDRAWN/);
});

test('withdrawal UI: tab, withdraw button and restore wired to the RPCs', () => {
  const main = readFileSync('src/main.js', 'utf8');
  assert.match(main, /data-member-tab="withdrawn"/);
  assert.match(main, /supabase\.rpc\('admin_withdraw_member', \{\s*p_user_id: selectedMemberId, p_confirmation: 'ADMIN_WITHDRAW_MEMBER'/);
  assert.match(main, /supabase\.rpc\('admin_restore_withdrawn_member', \{ p_user_id: userId \}\)/);
  assert.match(main, /profile\.approval_status === 'PENDING' && !profile\.withdrawn_at/);
  assert.match(main, /MEMBER_WITHDRAWN: '회원 탈퇴 처리'/);
});
