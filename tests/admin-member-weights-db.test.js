import test, { before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createVerifiedDatabase, seedVerifiedAccount, ids } from './fixtures/verified-runtime.js';

// 2026-10-20: an approved administrator manages member weights; the member's own setting stays available.
let db;
before(async () => { db = await createVerifiedDatabase(); });
after(async () => { await db?.close(); });
beforeEach(async () => {
  await db.exec('begin');
  await db.query("insert into public.profiles(id,email,approval_status,role,copy_ratio,max_position_ratio) values($1,'m@example.invalid','APPROVED','MEMBER',100,30)", [ids.user]);
  await db.exec("select set_config('test.admin','true',true)");
});
afterEach(async () => { await db.exec('rollback'); });
const call = (copy, max, user = ids.user) => db.query('select public.admin_update_member_copy_settings($1,$2,$3) r', [user, copy, max]);

test('admin weights: an administrator sets a member copy ratio and max position ratio, audited', async () => {
  const { rows: [{ r }] } = await call(150, 40);
  assert.deepEqual([Number(r.copy_ratio), Number(r.max_position_ratio)], [150, 40]);
  const p = (await db.query('select copy_ratio::float8 c,max_position_ratio::float8 m from public.profiles where id=$1', [ids.user])).rows[0];
  assert.deepEqual([p.c, p.m], [150, 40]);
  const log = (await db.query("select previous_value,next_value from public.admin_audit_logs where action='MEMBER_COPY_SETTINGS_UPDATED'")).rows[0];
  assert.deepEqual([Number(log.previous_value.copy_ratio), Number(log.previous_value.max_position_ratio)], [100, 30]);
  assert.deepEqual([Number(log.next_value.copy_ratio), Number(log.next_value.max_position_ratio)], [150, 40]);
});

test('admin weights: non-admins, out-of-range values and non-members are refused', async () => {
  await db.exec("select set_config('test.admin','false',true)");
  await db.exec('savepoint s1');
  await assert.rejects(call(150, 40), /ADMIN_REQUIRED/);
  await db.exec('rollback to savepoint s1');
  await db.exec("select set_config('test.admin','true',true)");
  for (const [copy, max, error] of [[40, 30, /INVALID_COPY_RATIO/], [210, 30, /INVALID_COPY_RATIO/], [155, 30, /INVALID_COPY_RATIO/],
    [100, 10, /INVALID_MAX_POSITION_RATIO/], [100, 60, /INVALID_MAX_POSITION_RATIO/], [100, null, /INVALID_MAX_POSITION_RATIO/]]) {
    await db.exec('savepoint s2');
    await assert.rejects(call(copy, max), error);
    await db.exec('rollback to savepoint s2');
  }
  await db.exec('savepoint s3');
  await assert.rejects(call(100, 30, '20000000-0000-4000-8000-0000000000ff'), /MEMBER_NOT_FOUND/);
  await db.exec('rollback to savepoint s3');
  const p = (await db.query('select copy_ratio::float8 c from public.profiles where id=$1', [ids.user])).rows[0];
  assert.equal(p.c, 100);
});

test('admin weights: the RPC is not executable by anon', () => {
  const sql = readFileSync('supabase/migrations/20261020010000_admin_member_weights_no_member_trade_lock.sql', 'utf8');
  assert.match(sql, /revoke all on function public\.admin_update_member_copy_settings\(uuid, numeric, numeric\) from public, anon;/);
  assert.match(sql, /grant execute on function public\.admin_update_member_copy_settings\(uuid, numeric, numeric\) to authenticated;/);
  assert.match(sql, /if not public\.is_approved_admin\(\) then raise exception 'ADMIN_REQUIRED'/);
});

test('admin weights UI: member detail offers weight editing that calls the admin RPC', () => {
  const main = readFileSync('src/main.js', 'utf8');
  assert.match(main, /renderAdminMemberWeightSettings\(member\)/);
  assert.match(main, /supabase\.rpc\('admin_update_member_copy_settings', \{\s*p_user_id: selectedMemberId, p_copy_ratio: copyRatio, p_max_position_ratio: maxPositionRatio,/);
  assert.match(main, /data-member-weight-save/);
  // The member keeps their own setting.
  assert.match(main, /supabase\.rpc\('update_my_copy_settings'/);
});

test('no member-trade lock: observe_copy_ownership differs from 20260925002511 only in the marked edits', () => {
  const body = (file) => {
    const sql = readFileSync(`supabase/migrations/${file}`, 'utf8');
    const start = sql.indexOf('create or replace function private.observe_copy_ownership');
    return sql.slice(start, sql.indexOf('$$;', start) + 3);
  };
  const before = body('20260925002511_member_own_position_absorption.sql');
  const after = body('20261020010000_admin_member_weights_no_member_trade_lock.sql');
  const reverted = after
    .replace(/    -- held as COPY\. 2026-10-20[\s\S]*?is still followed\.\n/, "    -- held as COPY and its anchor is locked (MEMBER_REDUCED_COPY_POSITION) so the worker neither buys the\n    -- sold COPY back nor trades that leg again until the member resumes.\n")
    .replace("'MEMBER_REDUCED_COPY_ACCEPTED' else t.lock_reason end,", "'MEMBER_REDUCED_COPY_POSITION' else t.lock_reason end,")
    .replace(/        -- The pre-cap decision moves[\s\S]*?\(x->>'protected_before'\)::numeric end,\n(?=        observed_at=)/, '')
    .replace("then 'MEMBER_REDUCED_COPY_ACCEPTED'\n", "then 'MEMBER_REDUCED_COPY_POSITION'\n");
  assert.equal(reverted, before);
});

// Weight changes must not stop an ACTIVE member (they used to pause every session until a resume).
test('admin weights: an ACTIVE member keeps copying after a weight change (admin or member)', async (t) => {
  const fresh = await createVerifiedDatabase();
  t.after(() => fresh.close());
  await seedVerifiedAccount(fresh);
  const state = async () => (await fresh.query(`select p.copy_paused, s.state, s.blocker_reason, s.settings
    from public.profiles p join private.trading_accounts a on a.user_id=p.id join private.copy_resume_sessions s on s.trading_account_id=a.id
    where p.id=$1`, [ids.user])).rows[0];
  await fresh.query(`update private.copy_resume_sessions set settings='{"copy_ratio":100,"max_position_ratio":30,"max_leverage":10}'`);
  await fresh.exec("select set_config('test.admin','true',false)");
  await fresh.query('select public.admin_update_member_copy_settings($1,150,40)', [ids.user]);
  let s = await state();
  assert.deepEqual([s.copy_paused, s.state], [false, 'ACTIVE']);
  assert.deepEqual([Number(s.settings.copy_ratio), Number(s.settings.max_position_ratio), Number(s.settings.max_leverage)], [150, 40, 10]);
  // The member's own setting (update_my_copy_settings updates the same columns) behaves the same way.
  await fresh.query('update public.profiles set copy_ratio=120, max_position_ratio=30 where id=$1', [ids.user]);
  s = await state();
  assert.deepEqual([s.copy_paused, s.state, Number(s.settings.copy_ratio)], [false, 'ACTIVE', 120]);
  // A leverage/risk change still pauses as before.
  await fresh.query('update public.profiles set max_leverage=11 where id=$1', [ids.user]);
  s = await state();
  assert.deepEqual([s.copy_paused, s.state, s.blocker_reason], [true, 'PAUSED', 'COPY_SETTINGS_CHANGED']);
});

test('admin weights: a resume being validated with the old weights is cancelled', async (t) => {
  const fresh = await createVerifiedDatabase();
  t.after(() => fresh.close());
  await seedVerifiedAccount(fresh);
  await fresh.query("update private.copy_resume_sessions set state='REQUESTED'");
  await fresh.exec("select set_config('test.admin','true',false)");
  await fresh.query('select public.admin_update_member_copy_settings($1,150,40)', [ids.user]);
  const s = (await fresh.query(`select p.copy_paused, s.state, s.blocker_reason from public.profiles p
    join private.trading_accounts a on a.user_id=p.id join private.copy_resume_sessions s on s.trading_account_id=a.id`)).rows[0];
  assert.deepEqual([s.copy_paused, s.state, s.blocker_reason], [true, 'PAUSED', 'COPY_SETTINGS_CHANGED']);
});

test('admin weights: an admin-paused member stays paused and keeps the admin blocker', async (t) => {
  const fresh = await createVerifiedDatabase();
  t.after(() => fresh.close());
  await seedVerifiedAccount(fresh);
  await fresh.query("update private.copy_resume_sessions set state='PAUSED', blocker_reason='ADMIN_PAUSE'");
  await fresh.query('update public.profiles set copy_paused=true');
  await fresh.exec("select set_config('test.admin','true',false)");
  await fresh.query('select public.admin_update_member_copy_settings($1,150,40)', [ids.user]);
  const s = (await fresh.query(`select p.copy_paused, s.state, s.blocker_reason from public.profiles p
    join private.trading_accounts a on a.user_id=p.id join private.copy_resume_sessions s on s.trading_account_id=a.id`)).rows[0];
  assert.deepEqual([s.copy_paused, s.state], [true, 'PAUSED']);
});
