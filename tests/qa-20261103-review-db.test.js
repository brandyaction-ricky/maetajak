import test, { before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createVerifiedDatabase, seedVerifiedAccount, ids } from './fixtures/verified-runtime.js';

// 2026-11-03 review of Q1: 20261103030000 (F3 service_role Master last legs RPC, F2 ordered-start requeue of
// RESUME_MASTER_SNAPSHOT_UNCONFIRMED).
const migration = readFileSync('supabase/migrations/20261103030000_master_last_legs_and_requeue.sql', 'utf8');
const admin = '30000000-0000-4000-8000-0000000000a1';
let db;
const one = async (sql, args = []) => (await db.query(sql, args)).rows[0];
const asWorker = () => db.exec("select set_config('test.admin','false',true), set_config('request.jwt.claim.sub','',true), set_config('request.jwt.claim.role','service_role',true)");
const asAdmin = () => db.exec(`select set_config('test.admin','true',true), set_config('request.jwt.claim.sub','${admin}',true), set_config('request.jwt.claim.role','authenticated',true)`);
before(async () => { db = await createVerifiedDatabase(); });
after(async () => { await db?.close(); });
beforeEach(async () => {
  await db.exec('begin');
  await db.query("insert into public.profiles(id,email,role,approval_status) values($1,'admin@example.invalid','ADMIN','APPROVED')", [admin]);
  await seedVerifiedAccount(db);
  await db.query(`insert into private.gate_api_credentials(user_id,gate_uid,api_key_ciphertext,secret_key_ciphertext,api_key_last4,status,
      futures_read,futures_trade,connection_role,verification_version,verified_worker_ip)
    values($1,'55500011','x','y','TEST','VERIFIED',true,false,'MASTER',2,'192.0.2.1')`, [admin]);
  await db.query("update private.trading_accounts set credential_user_id=$1,user_id=$1 where id=$2", [admin, ids.master]);
  await db.query("update private.copy_resume_sessions set state='ACTIVE',blocker_reason=null where trading_account_id=$1", [ids.member]);
});
afterEach(async () => { await db.exec('rollback'); });

test('F3: get_copy_last_master_legs returns the active Master legs last recorded; service_role only', async () => {
  await asWorker();
  const empty = (await one('select public.get_copy_last_master_legs() r')).r;
  assert.deepEqual(empty, { trading_account_id: ids.master, observed_at: null, legs: [] });
  const at = new Date().toISOString();
  await db.query(`select public.upsert_copy_current_state($1)`, [{ copy_event_id: randomUUID(), observed_at: at,
    master: { trading_account_id: ids.master, total_equity: 1000, available_equity: 900, positions: [
      { contract: 'ETH_USDT', position_side: 'LONG', size: 1000 }, { contract: 'BTC_USDT', position_side: 'SHORT', size: -3 }] },
    members: [] }]);
  const r = (await one('select public.get_copy_last_master_legs() r')).r;
  assert.equal(Date.parse(r.observed_at), Date.parse(at));
  assert.deepEqual(r.legs, [{ contract: 'BTC_USDT', position_side: 'SHORT', size: -3 }, { contract: 'ETH_USDT', position_side: 'LONG', size: 1000 }]);
  const acl = await one(`select has_function_privilege('anon','public.get_copy_last_master_legs()','EXECUTE') anon,
    has_function_privilege('authenticated','public.get_copy_last_master_legs()','EXECUTE') auth,
    has_function_privilege('service_role','public.get_copy_last_master_legs()','EXECUTE') svc`);
  assert.deepEqual(acl, { anon: false, auth: false, svc: true });
  await asAdmin();
  await db.exec('savepoint s');
  await assert.rejects(db.query('select public.get_copy_last_master_legs()'));
  await db.exec('rollback to savepoint s');
});

test('F2: an ordered start ending on RESUME_MASTER_SNAPSHOT_UNCONFIRMED goes back to QUEUED (Master-caused), others still FAIL', async () => {
  const body = (await one("select pg_get_functiondef('private.advance_copy_start_queue(boolean,boolean)'::regprocedure) d")).d;
  assert.equal(body.split('private.copy_start_requeue_master_reason(why)').length - 1, 2);
  assert.doesNotMatch(body, /private\.is_master_pause_reason\(why\)/);
  for (const [reason, expected] of [['RESUME_MASTER_SNAPSHOT_UNCONFIRMED', true], ['MASTER_CREDENTIAL_CHANGED', true],
    ['RESUME_PREVIEW_NOT_ZERO', false], [null, false]]) {
    assert.equal((await one('select private.copy_start_requeue_master_reason($1) v', [reason])).v, expected, String(reason));
  }
  const add = async (name, days) => {
    const id = randomUUID(); const account = randomUUID(); const uid = String(72000000 + Math.floor(Math.random() * 999_999));
    await db.query(`insert into public.profiles(id,email,full_name,gate_uid,role,approval_status,copy_paused,created_at)
      values($1,$2,$3,$4,'MEMBER','APPROVED',true,$5)`, [id, `${uid}@uid.maetajak.trading`, name, uid, new Date(Date.now() - days * 86_400_000).toISOString()]);
    await db.query("insert into private.trading_accounts(id,user_id,credential_user_id,account_role,status) values($1,$2,$2,'MEMBER','ACTIVE')", [account, id]);
    await db.query(`insert into private.gate_api_credentials(user_id,gate_uid,api_key_ciphertext,secret_key_ciphertext,api_key_last4,status,
        futures_read,futures_trade,verification_version,verified_worker_ip) values($1,$2,'x','y','TEST','VERIFIED',true,true,2,'192.0.2.1')`, [id, uid]);
    await db.query("insert into private.copy_resume_sessions(trading_account_id,state) values($1,'REQUIRED')", [account]);
    return { id, account };
  };
  const a = await add('A', 5);
  await add('B', 4);
  await asAdmin();
  await one("select public.admin_enqueue_ordered_copy_start(null,'ADMIN_ORDERED_COPY_START') r");
  const stateOf = async (m) => one('select state,reason,attempts from private.copy_start_queue where user_id=$1', [m.id]);
  assert.equal((await stateOf(a)).state, 'REQUESTED');
  const s = await one('select version from private.copy_resume_sessions where trading_account_id=$1', [a.account]);
  await db.query("update private.copy_resume_sessions set expires_at=clock_timestamp()-interval '1 second' where trading_account_id=$1", [a.account]);
  await asWorker();
  await db.query("select public.report_member_copy_resume_blocker($1,$2,'RESUME_MASTER_SNAPSHOT_UNCONFIRMED')", [a.account, s.version]);
  assert.deepEqual(await stateOf(a), { state: 'QUEUED', reason: 'RESUME_MASTER_SNAPSHOT_UNCONFIRMED', attempts: 1 });
  await one('select private.advance_copy_start_queue(false, true) r');
  assert.deepEqual(await stateOf(a), { state: 'REQUESTED', reason: null, attempts: 2 }, 'the same member is requested again first');
});

test('20261103030000 re-applies as a no-op and contains no destructive statement', async () => {
  const sig = 'private.advance_copy_start_queue(boolean,boolean)';
  const before = (await one('select pg_get_functiondef($1::regprocedure) d', [sig])).d;
  await db.exec(migration);
  assert.equal((await one('select pg_get_functiondef($1::regprocedure) d', [sig])).d, before);
  assert.doesNotMatch(migration.replace(/^--.*$/gm, ''), /\b(drop|delete|truncate|alter table|update|insert)\b/i);
});
