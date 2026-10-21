import test, { before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createVerifiedDatabase, seedVerifiedAccount, ids } from './fixtures/verified-runtime.js';

// 2026-10-21: Gate UID accounts (UID login ID, PENDING until admin approval, UID-bound Gate API).
const migration = readFileSync('supabase/migrations/20261021020000_uid_accounts.sql', 'utf8');
const KEY = 'K'.repeat(20);
let db;
const one = async (sql, args = []) => (await db.query(sql, args)).rows[0];
async function rejects(sql, args, pattern) {
  await db.exec('savepoint u_expect');
  try { await assert.rejects(db.query(sql, args), pattern); }
  finally { await db.exec('rollback to savepoint u_expect'); }
}
const asUser = (id) => db.exec(`select set_config('request.jwt.claim.sub','${id}',true)`);
const addAuthUser = (email, meta, confirmed = true, id = randomUUID()) => db.query(
  'insert into auth.users(id,email,raw_user_meta_data,email_confirmed_at) values($1,$2,$3,$4) returning id',
  [id, email, meta, confirmed ? new Date().toISOString() : null]).then((r) => r.rows[0].id);
const signupMeta = (uid) => ({ full_name: '테스트', phone: '010-0000-0000', gate_uid: uid,
  terms_accepted_at: '2026-10-21T00:00:00Z', terms_version: '2026-08-21-v1', privacy_version: '2026-08-21-v1' });
const save = (uid) => db.query('select public.save_gate_api_credentials($1,$2,$3,true) r', [uid, KEY, KEY]);

before(async () => {
  db = await createVerifiedDatabase();
  // Production objects the structural fixture lacks (test-only stubs, no data).
  await db.exec(`create table if not exists private.gate_api_verification_jobs (
      id bigint generated always as identity primary key, user_id uuid not null unique,
      attempts integer not null default 0, run_after timestamptz not null default now(), claimed_at timestamptz,
      created_at timestamptz not null default now(), updated_at timestamptz not null default now());
    create table if not exists auth.users (id uuid primary key, email text, raw_user_meta_data jsonb,
      email_confirmed_at timestamptz, banned_until timestamptz, updated_at timestamptz);
    create table if not exists public.legal_acceptances (user_id uuid not null, document_type text not null,
      document_version text not null, accepted_at timestamptz not null, unique (user_id, document_type, document_version));
    create or replace function extensions.pgp_sym_encrypt(text,text,text) returns bytea language sql as $$ select convert_to('TEST_ONLY','UTF8') $$;
    create or replace function public.request_member_password_reset(p_user_id uuid) returns jsonb language sql as $$ select '{}'::jsonb $$;
    grant execute on function public.request_member_password_reset(uuid) to authenticated;
    -- Production definition of the email-confirmation auto-approval (2026-10-21).
    CREATE OR REPLACE FUNCTION public.auto_approve_confirmed_user()
     RETURNS trigger
     LANGUAGE plpgsql
     SECURITY DEFINER
     SET search_path TO 'public', 'pg_temp'
    AS $function$
declare changed_profile public.profiles;
begin
  if new.email_confirmed_at is null then
    return new;
  end if;

  update public.profiles
  set approval_status = 'APPROVED',
      approved_at = coalesce(approved_at, new.email_confirmed_at, now()),
      approved_by = null,
      updated_at = now()
  where id = new.id
    and role = 'MEMBER'
    and approval_status = 'PENDING'
  returning * into changed_profile;

  if found then
    insert into public.admin_audit_logs (
      actor_id, action, target_user_id, previous_value, next_value
    ) values (
      null,
      'USER_AUTO_APPROVED_EMAIL_CONFIRMED',
      new.id,
      jsonb_build_object('approval_status', 'PENDING'),
      to_jsonb(changed_profile)
    );
  end if;
  return new;
end;
$function$;`);
  await db.exec(migration);
  // Applying it again is a no-op (idempotent patches).
  await db.exec(migration);
  await db.exec(`create trigger on_auth_user_created after insert on auth.users
      for each row execute function public.handle_new_user();
    create trigger zz_auto_approve_confirmed_user after insert or update of email_confirmed_at on auth.users
      for each row when (new.email_confirmed_at is not null) execute function public.auto_approve_confirmed_user();`);
});
after(async () => { await db?.close(); });
beforeEach(async () => { await db.exec('begin'); });
afterEach(async () => { await db.exec('rollback'); });

test('uid signup: gate_uid comes from metadata, account stays PENDING, terms recorded', async () => {
  const id = await addAuthUser('12345678@uid.maetajak.trading', signupMeta('12345678'));
  const p = await one('select gate_uid,approval_status,full_name,phone,terms_version from public.profiles where id=$1', [id]);
  assert.deepEqual(p, { gate_uid: '12345678', approval_status: 'PENDING', full_name: '테스트',
    phone: '010-0000-0000', terms_version: '2026-08-21-v1' });
  assert.equal(Number((await one('select count(*) n from public.legal_acceptances where user_id=$1', [id])).n), 2);
  assert.equal(Number((await one("select count(*) n from public.admin_audit_logs where action='USER_AUTO_APPROVED_EMAIL_CONFIRMED' and target_user_id=$1", [id])).n), 0);
  // A later confirmation update does not auto-approve a UID account either.
  await db.query('update auth.users set email_confirmed_at=now() where id=$1', [id]);
  assert.equal((await one('select approval_status from public.profiles where id=$1', [id])).approval_status, 'PENDING');
});

test('uid signup: invalid or mismatched metadata UID is ignored; legacy email auto-approval unchanged', async () => {
  const bad = await addAuthUser('12ab@uid.maetajak.trading', signupMeta('12ab'));
  assert.equal((await one('select gate_uid from public.profiles where id=$1', [bad])).gate_uid, null);
  // An ordinary email signup cannot claim a UID through metadata.
  const legacy = await addAuthUser('legacy@example.invalid', signupMeta('87654321'));
  const p = await one('select gate_uid,approval_status from public.profiles where id=$1', [legacy]);
  assert.deepEqual(p, { gate_uid: null, approval_status: 'APPROVED' });
});

test('uid signup: gate_uid is unique and digits-only', async () => {
  await addAuthUser('55556666@uid.maetajak.trading', signupMeta('55556666'));
  await rejects('insert into auth.users(id,email,raw_user_meta_data) values($1,$2,$3)',
    [randomUUID(), '55556666@uid.maetajak.trading', signupMeta('55556666')], /profiles_gate_uid_unique|duplicate key/);
  await seedVerifiedAccount(db);
  await rejects("update public.profiles set gate_uid='55556666' where id=$1", [ids.user], /duplicate key|profiles_gate_uid_unique/);
  await rejects("update public.profiles set gate_uid='12ab5' where id=$1", [ids.user], /profiles_gate_uid_format_check/);
  await rejects("update public.profiles set gate_uid='123' where id=$1", [ids.user], /profiles_gate_uid_format_check/);
});

test('member Gate API: a UID account can only save its own signup UID', async () => {
  await seedVerifiedAccount(db);
  await db.query("update public.profiles set gate_uid='123456', role='MEMBER' where id=$1", [ids.user]);
  await asUser(ids.user);
  await rejects('select public.save_gate_api_credentials($1,$2,$3,true)', ['654321', KEY, KEY], /GATE_UID_MUST_MATCH_ACCOUNT/);
  assert.equal((await one('select gate_uid from private.gate_api_credentials where user_id=$1', [ids.user])).gate_uid, 'TEST_ONLY');
  const { rows: [{ r }] } = await save(' 123456 ');
  assert.equal(r.gate_uid, '123456');
  assert.equal(r.status, 'PENDING_VERIFICATION');
});

test('member Gate API: legacy email accounts (no gate_uid) keep the previous behaviour', async () => {
  await seedVerifiedAccount(db);
  await asUser(ids.user);
  const { rows: [{ r }] } = await save('99887766');
  assert.equal(r.gate_uid, '99887766');
});

test('patched definitions: guard inserted once, before the copy lock; reset email RPC revoked', async () => {
  const save = (await one("select pg_get_functiondef('public.save_gate_api_credentials(text,text,text,boolean)'::regprocedure) d")).d;
  assert.equal(save.split('GATE_UID_MUST_MATCH_ACCOUNT').length - 1, 1);
  assert.ok(save.indexOf('GATE_UID_MUST_MATCH_ACCOUNT') < save.indexOf('pg_advisory_xact_lock'));
  assert.ok(save.includes("perform private.guard_gate_account_change(auth.uid(), 'MEMBER', p_gate_uid);"));
  const approve = (await one("select pg_get_functiondef('public.auto_approve_confirmed_user()'::regprocedure) d")).d;
  assert.equal(approve.split("like '%@uid.maetajak.trading'").length - 1, 1);
  const acl = await one(`select has_function_privilege('authenticated','public.request_member_password_reset(uuid)','EXECUTE') auth,
    has_function_privilege('anon','public.request_member_password_reset(uuid)','EXECUTE') anon`);
  assert.deepEqual(acl, { auth: false, anon: false });
});
