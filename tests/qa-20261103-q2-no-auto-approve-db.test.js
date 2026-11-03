import test, { before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createVerifiedDatabase } from './fixtures/verified-runtime.js';

// 2026-11-03 pre-go-live QA Q2: a confirmed email (non-UID) account was auto-approved by the production trigger
// zz_auto_approve_confirmed_user. 20261103010000 makes every member wait for an administrator.
const q2 = readFileSync('supabase/migrations/20261103010000_disable_email_auto_approve.sql', 'utf8');
const uidMigration = readFileSync('supabase/migrations/20261021020000_uid_accounts.sql', 'utf8');
// Production body before Q2 (pg_get_functiondef 2026-11-03).
const productionBefore = `CREATE OR REPLACE FUNCTION public.auto_approve_confirmed_user()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
declare changed_profile public.profiles;
begin
  if new.email_confirmed_at is null then
    return new;
  end if;
  -- Gate UID accounts (synthetic email, created confirmed) wait for administrator approval.
  if lower(coalesce(new.email, '')) like '%@uid.maetajak.trading' then
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
$function$;`;

let db;
const one = async (sql, args = []) => (await db.query(sql, args)).rows[0];
const meta = (uid = null) => ({ full_name: '테스트', phone: '010-0000-0000', ...(uid ? { gate_uid: uid } : {}),
  terms_accepted_at: '2026-11-03T00:00:00Z', terms_version: '2026-08-21-v1', privacy_version: '2026-08-21-v1' });
const addUser = (email, { uid = null, confirmed = true } = {}) => db.query(
  'insert into auth.users(id,email,raw_user_meta_data,email_confirmed_at) values($1,$2,$3,$4) returning id',
  [randomUUID(), email, meta(uid), confirmed ? new Date().toISOString() : null]).then((r) => r.rows[0].id);
const status = async (id) => (await one('select approval_status, gate_uid, approved_at from public.profiles where id=$1', [id]));
const autoApprovals = async (id) => Number((await one(
  "select count(*) n from public.admin_audit_logs where action='USER_AUTO_APPROVED_EMAIL_CONFIRMED' and target_user_id=$1", [id])).n);

before(async () => {
  db = await createVerifiedDatabase();
  // The production triggers on auth.users (the structural fixture has the table, not the triggers).
  await db.exec(`create trigger on_auth_user_created after insert on auth.users
      for each row execute function public.handle_new_user();
    create trigger zz_auto_approve_confirmed_user after insert or update of email_confirmed_at on auth.users
      for each row when (new.email_confirmed_at is not null) execute function public.auto_approve_confirmed_user();`);
});
after(async () => { await db?.close(); });
beforeEach(async () => { await db.exec('begin'); });
afterEach(async () => { await db.exec('rollback'); });

test('Q2: an email-confirmed member stays PENDING (signup confirmed, and confirmed later); no auto-approval audit row', async () => {
  const confirmedAtSignup = await addUser('member-a@example.invalid');
  assert.deepEqual(await status(confirmedAtSignup), { approval_status: 'PENDING', gate_uid: null, approved_at: null });
  assert.equal(await autoApprovals(confirmedAtSignup), 0);
  const confirmedLater = await addUser('member-b@example.invalid', { confirmed: false });
  await db.query('update auth.users set email_confirmed_at=now() where id=$1', [confirmedLater]);
  assert.equal((await status(confirmedLater)).approval_status, 'PENDING');
  assert.equal(await autoApprovals(confirmedLater), 0);
});

test('Q2: Gate UID accounts are unchanged (PENDING, UID kept); an approved profile is not touched by a later confirmation', async () => {
  const uidAccount = await addUser('12345678@uid.maetajak.trading', { uid: '12345678' });
  assert.deepEqual(await status(uidAccount), { approval_status: 'PENDING', gate_uid: '12345678', approved_at: null });
  const approved = await addUser('member-c@example.invalid', { confirmed: false });
  await db.query("update public.profiles set approval_status='APPROVED', approved_at=now() where id=$1", [approved]);
  await db.query('update auth.users set email_confirmed_at=now() where id=$1', [approved]);
  assert.equal((await status(approved)).approval_status, 'APPROVED');
});

test('Q2: the migration replaces the production body, is idempotent, keeps the trigger, and survives a UID migration re-run', async () => {
  await db.exec(productionBefore);
  const before = await addUser('member-d@example.invalid');
  assert.equal((await status(before)).approval_status, 'APPROVED', 'control: the production body approves an email account');
  await db.exec(q2);
  await db.exec(q2);
  const after = await addUser('member-e@example.invalid');
  assert.equal((await status(after)).approval_status, 'PENDING');
  // The UID migration's anchored patch recognises the replaced body as already patched (no exception, no change).
  const body = (await one("select pg_get_functiondef('public.auto_approve_confirmed_user()'::regprocedure) d")).d;
  await db.exec(uidMigration);
  assert.equal((await one("select pg_get_functiondef('public.auto_approve_confirmed_user()'::regprocedure) d")).d, body);
  assert.doesNotMatch(body, /approval_status|update public\.profiles/i, 'the function writes nothing');
  const trigger = await one(`select tgname, tgenabled from pg_trigger where tgrelid='auth.users'::regclass
    and tgfoid='public.auto_approve_confirmed_user()'::regprocedure`);
  assert.deepEqual(trigger, { tgname: 'zz_auto_approve_confirmed_user', tgenabled: 'O' });
  assert.doesNotMatch(q2.replace(/^--.*$/gm, ''), /\b(drop|delete|truncate|alter table|update|insert|revoke|grant)\b/i, 'no destructive or privilege statement');
});
