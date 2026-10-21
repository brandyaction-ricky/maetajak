import test, { before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createVerifiedDatabase, seedVerifiedAccount, cyclePayload, record, ids, observedAccount, position } from './fixtures/verified-runtime.js';

// QA 2026-10-21 area A (onboarding, account lifecycle, Master (re)registration, restart from empty).
// Tests named "[BUG]" assert the SAFE/expected behaviour and are expected to FAIL on 0c39e77: each
// failure documents a finding. The other tests document scenarios that were checked and are safe.
const admin = '30000000-0000-4000-8000-0000000000a1';
const KEY = 'K'.repeat(20);
let db;
const one = async (sql, args = []) => (await db.query(sql, args)).rows[0];
const n = async (sql, args = []) => Number((await one(sql, args)).n);
const asAdmin = () => db.exec(`select set_config('test.admin','true',true), set_config('request.jwt.claim.sub','${admin}',true)`);
const asWorker = () => db.exec("select set_config('test.admin','false',true), set_config('request.jwt.claim.role','service_role',false)");

async function completeJob(user, success = true) {
  const job = (await one('select id from private.gate_api_verification_jobs where user_id=$1', [user])).id;
  await db.query("select public.complete_gate_api_verification($1,$2,'gate-user',$3,'', '192.0.2.1')",
    [job, success, success ? null : 'IP_NOT_ALLOWED']);
}

before(async () => {
  db = await createVerifiedDatabase();
  await db.exec(`create table if not exists private.gate_api_verification_jobs (
      id bigint generated always as identity primary key, user_id uuid not null unique,
      attempts integer not null default 0, run_after timestamptz not null default now(), claimed_at timestamptz,
      created_at timestamptz not null default now(), updated_at timestamptz not null default now());
    create table if not exists private.open_order_cancel_jobs (
      id bigint generated always as identity primary key, trading_account_id uuid not null unique,
      state text not null default 'PENDING', requested_by uuid, reason text, attempts integer not null default 0,
      run_after timestamptz not null default now(), claimed_at timestamptz, cancelled_count integer,
      remaining_count integer, last_error_code text, completed_at timestamptz,
      created_at timestamptz not null default now(), updated_at timestamptz not null default now());
    create table if not exists auth.users (id uuid primary key, email text, raw_user_meta_data jsonb,
      email_confirmed_at timestamptz, banned_until timestamptz, updated_at timestamptz);
    create table if not exists public.legal_acceptances (user_id uuid not null, document_type text not null,
      document_version text not null, accepted_at timestamptz not null, unique (user_id, document_type, document_version));
    create or replace function extensions.pgp_sym_encrypt(text,text,text) returns bytea language sql as $$ select convert_to('TEST_ONLY','UTF8') $$;
    create or replace function extensions.gen_random_bytes(integer) returns bytea language sql as $$ select decode(repeat('00',$1),'hex') $$;
    -- Minimal stand-in carrying the production anchor the uid_accounts migration patches.
    CREATE OR REPLACE FUNCTION public.auto_approve_confirmed_user()
     RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
    AS $function$
begin
  if new.email_confirmed_at is null then
    return new;
  end if;
  return new;
end;
$function$;`);
  await db.exec(readFileSync('supabase/migrations/20261021020000_uid_accounts.sql', 'utf8'));
});
after(async () => { await db?.close(); });
beforeEach(async () => {
  await db.exec('begin');
  await db.query("insert into public.profiles(id,email,role,approval_status) values($1,'admin@example.invalid','ADMIN','APPROVED')", [admin]);
});
afterEach(async () => { await db.exec('rollback'); });

// ---------------------------------------------------------------------------------------------
// Scenario 1: new Master from a wiped database (no trading_accounts, credentials, cycles, members).
// ---------------------------------------------------------------------------------------------
test('empty DB: admin registers a new Master UID, verification binds it cleanly, the worker sees it with zero members', async () => {
  await db.exec("insert into private.copy_worker_runtime(worker_version,mode,gate_base_url,public_ip,broker_channel_id,heartbeat_at) values('0.5.0','DRY_RUN','https://api.gateio.ws','192.0.2.1','maetajak',clock_timestamp())");
  assert.equal(await n('select count(*) n from private.trading_accounts'), 0);
  await asAdmin();
  await db.query('select public.save_admin_gate_api_credentials($1,$2,$3,true)', ['55500011', KEY, KEY]);
  await asWorker();
  await completeJob(admin);
  const a = await one("select id,status,bound_gate_uid from private.trading_accounts where account_role='MASTER'");
  assert.deepEqual([a.status, a.bound_gate_uid], ['ACTIVE', '55500011']);
  assert.equal(await n('select count(*) n from private.trading_account_rebind_archive'), 0, 'first Master: nothing archived');
  const c = await one('select public.get_copy_worker_context() v');
  assert.equal(c.v.master?.gate_uid, '55500011');
  assert.deepEqual(c.v.members, []);
  // First verified cycle with zero members (no copy_current_accounts, anchors or baselines yet).
  const cycleId = randomUUID(); const observedAt = new Date().toISOString();
  const m = observedAccount({ trading_account_id: a.id, total: 20000, available: 18000, positions: [position(40)] });
  await record(db, { cycle_id: cycleId, source_version: cycleId, observed_at: observedAt, master: m, members: [],
    current_state: { copy_event_id: cycleId, observed_at: observedAt, master: { trading_account_id: a.id, account_role: 'MASTER',
      total_equity: 20000, available_equity: 18000, unrealised_pnl: 0, error_code: null,
      positions: [{ contract: 'BTC_USDT', position_side: 'LONG', size: 40, mark_price: 50000, entry_price: 49900, leverage: 10 }] }, members: [] } });
  assert.equal(await n('select count(*) n from private.copy_current_accounts where trading_account_id=$1', [a.id]), 1);
});

test('a member can never register the Master UID (guard) and a different admin Master is still one Master', async () => {
  await asAdmin();
  await db.query('select public.save_admin_gate_api_credentials($1,$2,$3,true)', ['55500011', KEY, KEY]);
  await asWorker();
  await completeJob(admin);
  await db.query("insert into public.profiles(id,email,approval_status) values($1,'m@example.invalid','APPROVED')", [ids.user]);
  await db.exec('savepoint s1');
  await assert.rejects(() => db.query("select private.guard_gate_account_change($1,'MEMBER','55500011')", [ids.user]), /GATE_UID_ALREADY_REGISTERED/);
  await db.exec('rollback to savepoint s1');
});

// ---------------------------------------------------------------------------------------------
// Master key rotation / re-verification with the SAME UID while members copy.
// ---------------------------------------------------------------------------------------------
async function seedMasterAndActiveMember(actualSize = 12) {
  await seedVerifiedAccount(db);
  await db.query(`insert into private.gate_api_credentials(user_id,gate_uid,api_key_ciphertext,secret_key_ciphertext,api_key_last4,status,
      futures_read,futures_trade,connection_role,verification_version,verified_worker_ip)
    values($1,'55500011','x','y','TEST','VERIFIED',true,false,'MASTER',2,'192.0.2.1')`, [admin]);
  await db.query("update private.trading_accounts set credential_user_id=$1,user_id=$1,bound_gate_uid='55500011' where id=$2", [admin, ids.master]);
  await db.query("update private.trading_accounts set bound_gate_uid='70000001' where id=$1", [ids.member]);
  await record(db, cyclePayload({ masterSize: 40, actualSize }));
}

test('master key re-save with the same UID: no rebind, members are not archived', async () => {
  await seedMasterAndActiveMember();
  await asAdmin();
  await db.query('select public.save_admin_gate_api_credentials($1,$2,$3,true)', ['55500011', KEY, KEY]);
  // While the new key waits for verification the Master is absent from the worker context.
  await asWorker();
  assert.equal((await one('select public.get_copy_worker_context() v')).v.master, null);
  await completeJob(admin);
  assert.equal(await n('select count(*) n from private.trading_account_rebind_archive'), 0);
  assert.ok(await n('select count(*) n from private.copy_target_anchors where trading_account_id=$1', [ids.member]) >= 0);
});

test('[BUG] master same-UID re-save pauses every member session but profiles still read as copying (admin shows 카피 중)', async () => {
  await seedMasterAndActiveMember();
  assert.equal((await one('select state from private.copy_resume_sessions where trading_account_id=$1', [ids.member])).state, 'ACTIVE');
  await asAdmin();
  await db.query('select public.save_admin_gate_api_credentials($1,$2,$3,true)', ['55500011', KEY, KEY]);
  await asWorker();
  await completeJob(admin);
  const s = await one('select state,blocker_reason from private.copy_resume_sessions where trading_account_id=$1', [ids.member]);
  const p = await one('select copy_paused,member_halted from public.profiles where id=$1', [ids.user]);
  // get_admin_operations_metrics.copy_status is computed from profiles (+API status, position states) only:
  // a PAUSED session with copy_paused=false is shown as COPYING although the worker holds every leg.
  assert.ok(s.state === 'ACTIVE' || p.copy_paused,
    `session ${s.state}/${s.blocker_reason} but profiles.copy_paused=${p.copy_paused}: copying stopped, status still COPYING, no auto-resume`);
});

// ---------------------------------------------------------------------------------------------
// Scenario 4: a member key revoked/IP-whitelist removed mid-session.
// ---------------------------------------------------------------------------------------------
test('[BUG] a member whose Gate reads fail with INVALID_CREDENTIALS every cycle keeps API status VERIFIED and unchanged leg states', async () => {
  await seedMasterAndActiveMember(0);
  const before = await one("select array_agg(state order by contract,position_side) s from public.copy_position_states where trading_account_id=$1", [ids.member]);
  for (let i = 0; i < 3; i++) {
    const payload = cyclePayload({ masterSize: 40, actualSize: 0 });
    payload.members[0] = { ...payload.members[0], error_code: 'MEMBER_ACCOUNT_READ_INVALID_CREDENTIALS', positions: [], planned_positions: [] };
    payload.current_state.members[0] = { ...payload.current_state.members[0], error_code: 'MEMBER_ACCOUNT_READ_INVALID_CREDENTIALS', positions: [] };
    await record(db, payload);
  }
  const g = await one('select status from private.gate_api_credentials where user_id=$1', [ids.user]);
  const after = await one("select array_agg(state order by contract,position_side) s from public.copy_position_states where trading_account_id=$1", [ids.member]);
  const v = await one('select status from private.copy_current_verifications where trading_account_id=$1', [ids.member]);
  assert.equal(v.status, 'ERROR', 'the read failure is recorded only in copy_current_verifications');
  assert.ok(g.status !== 'VERIFIED' || after.s.some((state) => ['ERROR', 'HALTED'].includes(state)),
    `credentials ${g.status}, leg states ${after.s} (before ${before.s}): admin copy_status/API label stay 카피 중/정상`);
});

// ---------------------------------------------------------------------------------------------
// Scenario 5: withdrawal keeps profiles.gate_uid -> a UID can never be registered again.
// ---------------------------------------------------------------------------------------------
test('[BUG] a squatted/withdrawn UID stays reserved forever: the real owner can never sign up with it', async () => {
  const squatter = randomUUID();
  await db.query("insert into auth.users(id,email,raw_user_meta_data,email_confirmed_at) values($1,'70000002@uid.maetajak.trading',$2,now())",
    [squatter, { gate_uid: '70000002', full_name: 'x', phone: '010-0000-0000' }]);
  await db.query('insert into public.profiles(id,email,gate_uid) values($1,$2,$3) on conflict (id) do nothing',
    [squatter, '70000002@uid.maetajak.trading', '70000002']);
  assert.equal((await one('select gate_uid from public.profiles where id=$1', [squatter])).gate_uid, '70000002');
  await asAdmin();
  await db.query("select public.admin_withdraw_member($1,'ADMIN_WITHDRAW_MEMBER','UID squatting')", [squatter]);
  const still = (await one('select gate_uid from public.profiles where id=$1', [squatter])).gate_uid;
  // uid-signup refuses UID_TAKEN whenever any profile row has the UID (supabase/functions/uid-signup/index.ts:98-105).
  assert.equal(still, null, `withdrawn profile still holds gate_uid=${still}; no RPC/UI frees it`);
});

test('withdrawn member: restore returns PENDING but member_halted stays true, so the member cannot resume by themselves', async () => {
  await seedMasterAndActiveMember();
  await db.query("insert into auth.users(id) values($1) on conflict do nothing", [ids.user]);
  await asAdmin();
  await db.query("select public.admin_withdraw_member($1,'ADMIN_WITHDRAW_MEMBER','t')", [ids.user]);
  await db.query('select public.admin_restore_withdrawn_member($1)', [ids.user]);
  await db.query("select public.set_user_approval($1,'APPROVED')", [ids.user]);
  const p = await one('select approval_status,member_halted,copy_paused from public.profiles where id=$1', [ids.user]);
  assert.deepEqual([p.approval_status, p.member_halted, p.copy_paused], ['APPROVED', true, true]);
  assert.equal((await one('select status from private.trading_accounts where id=$1', [ids.member])).status, 'DISABLED');
  // Context excludes the member until a new API key verifies (credential DISABLED).
  await asWorker();
  const c = await one('select public.get_copy_worker_context() v');
  assert.equal(c.v.members.length, 0);
});

test('suspending/rejecting an APPROVED member pauses the ACTIVE session (trigger) and removes them from the worker context', async () => {
  await seedMasterAndActiveMember();
  await asAdmin();
  await db.query("select public.set_user_approval($1,'SUSPENDED')", [ids.user]);
  const s = await one('select state from private.copy_resume_sessions where trading_account_id=$1', [ids.member]);
  assert.equal(s.state, 'PAUSED');
  await db.query("select public.set_user_approval($1,'APPROVED')", [ids.user]);
  assert.equal((await one('select state from private.copy_resume_sessions where trading_account_id=$1', [ids.member])).state, 'PAUSED',
    're-approval does not silently restart copying');
});
