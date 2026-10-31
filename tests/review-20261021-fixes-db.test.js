import test, { before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createVerifiedDatabase, seedVerifiedAccount, cyclePayload, record, ids } from './fixtures/verified-runtime.js';
import { adminCopyStatus } from '../src/copy-status.js';

// Review 2026-10-21 fixes, database side: R4 (20261021034000), R6/R7 (20261021032000), R8 (20261021033000).
const ADMIN_MIGRATION = 'supabase/migrations/20261021032000_qa_admin_lifecycle.sql';
const RISK_MIGRATION = 'supabase/migrations/20261021033000_qa_risk_basis.sql';
let db;
const one = async (q, p = []) => (await db.query(q, p)).rows[0];
const asAdmin = () => db.exec("select set_config('test.admin','true',true), set_config('request.jwt.claim.sub','30000000-0000-4000-8000-0000000000a1',true), set_config('request.jwt.claim.role','authenticated',true)");
const asWorker = () => db.exec("select set_config('test.admin','false',true), set_config('request.jwt.claim.role','service_role',true)");
async function rejects(sql, args, pattern) {
  await db.exec('savepoint q_expect');
  try { await assert.rejects(db.query(sql, args), pattern); } finally { await db.exec('rollback to savepoint q_expect'); }
}
const metricsMember = async () => {
  await asAdmin();
  const row = (await one('select public.get_admin_operations_metrics() v')).v;
  await asWorker();
  return row.members.find((m) => m.id === ids.user);
};
const session = () => one('select state,blocker_reason from private.copy_resume_sessions where trading_account_id=$1', [ids.member]);
const profile = () => one('select reduce_only,admin_reduce_only,admin_paused from public.profiles where id=$1', [ids.user]);

before(async () => {
  db = await createVerifiedDatabase();
  await db.exec(`create table if not exists public.member_daily_performance (user_id uuid not null, trading_date date not null,
    opening_equity numeric not null default 0, closing_equity numeric not null default 0, deposits numeric not null default 0,
    withdrawals numeric not null default 0, realised_pnl numeric not null default 0, unrealised_pnl numeric not null default 0,
    fees numeric not null default 0, funding_pnl numeric not null default 0, trading_volume numeric not null default 0,
    trade_count integer not null default 0, winning_trade_count integer not null default 0, losing_trade_count integer not null default 0,
    daily_return_pct numeric, source_snapshot_at timestamptz not null default now(), primary key (user_id, trading_date))`);
});
after(async () => { await db?.close(); });
beforeEach(async () => {
  await db.exec('begin');
  await db.query("insert into public.profiles(id,email,role,approval_status) values('30000000-0000-4000-8000-0000000000a1','admin@example.invalid','ADMIN','APPROVED')");
  await seedVerifiedAccount(db);
});
afterEach(async () => { await db.exec('rollback'); });

// ---- R4 ----
test('R4 a unified member held by the worker is shown as ACCOUNT_POLICY_BLOCKED (통합계정 미지원), not 카피 중', async () => {
  await record(db, cyclePayload({ masterSize: 40 }));
  assert.equal((await metricsMember()).copy_status, 'COPYING');
  await asWorker();
  assert.equal((await one("select public.report_copy_account_policy($1,'UNIFIED_ACCOUNT_UNSUPPORTED') v", [ids.member])).v, true);
  const since = (await one('select policy_since from private.copy_account_policies where trading_account_id=$1', [ids.member])).policy_since;
  let m = await metricsMember();
  assert.deepEqual([m.copy_status, m.account_policy_code], ['ACCOUNT_POLICY_BLOCKED', 'UNIFIED_ACCOUNT_UNSUPPORTED']);
  assert.equal(adminCopyStatus(m)[0], '통합계정 미지원');
  // Re-reporting keeps the start; clearing returns to the normal status.
  await one("select public.report_copy_account_policy($1,'UNIFIED_ACCOUNT_UNSUPPORTED') v", [ids.member]);
  assert.equal(String((await one('select policy_since from private.copy_account_policies where trading_account_id=$1', [ids.member])).policy_since), String(since));
  await one('select public.report_copy_account_policy($1,null) v', [ids.member]);
  m = await metricsMember();
  assert.deepEqual([m.copy_status, m.account_policy_code], ['COPYING', null]);
  // Master accounts and unknown codes are refused; the RPC is worker-only.
  assert.equal((await one("select public.report_copy_account_policy($1,'UNIFIED_ACCOUNT_UNSUPPORTED') v", [ids.master])).v, false);
  await rejects("select public.report_copy_account_policy($1,'OTHER')", [ids.member], /INVALID_ACCOUNT_POLICY_CODE/);
  await db.exec("select set_config('request.jwt.claim.role','authenticated',true)");
  await rejects("select public.report_copy_account_policy($1,null)", [ids.member], /./);
});

// ---- R6 ----
test('R6 administrator RESUME of an ACTIVE reduce-only member clears the ADMIN_REDUCE_ONLY blocker', async () => {
  await asAdmin();
  await db.query("select public.set_member_copy_control($1,'REDUCE_ONLY','QA')", [ids.user]);
  assert.deepEqual(Object.values(await session()), ['ACTIVE', 'ADMIN_REDUCE_ONLY']);
  await db.query("select public.set_member_copy_control($1,'RESUME','QA')", [ids.user]);
  assert.deepEqual(Object.values(await session()), ['ACTIVE', null]);
  assert.deepEqual(Object.values(await profile()), [false, false, false]);
});

test('R6 a re-run never turns a risk reduce-only into an administrator restriction; a stale ADMIN_ blocker is cleared', async () => {
  // State an earlier administrator RESUME left behind (ACTIVE + ADMIN_REDUCE_ONLY), then a risk reduce-only.
  await db.query("update private.copy_resume_sessions set blocker_reason='ADMIN_REDUCE_ONLY' where trading_account_id=$1", [ids.member]);
  await db.query('update public.profiles set reduce_only=true where id=$1', [ids.user]);
  await db.query(`insert into public.admin_audit_logs(action,target_user_id,next_value)
    values('MEMBER_COPY_CONTROL_UPDATED',$1,'{"mode":"REDUCE_ONLY"}')`, [ids.user]);
  await db.exec(readFileSync(ADMIN_MIGRATION, 'utf8'));
  assert.deepEqual(Object.values(await profile()), [true, false, false], 'the columns existed: no backfill');
  assert.deepEqual(Object.values(await session()), ['ACTIVE', null]);
});

test('R6 first apply: the backfill needs both the session blocker and the latest administrator control', async () => {
  const firstApply = async () => {
    await db.exec('alter table public.profiles drop column admin_paused, drop column admin_reduce_only');
    await db.exec(readFileSync(ADMIN_MIGRATION, 'utf8'));
  };
  await db.query("update private.copy_resume_sessions set blocker_reason='ADMIN_REDUCE_ONLY' where trading_account_id=$1", [ids.member]);
  await db.query('update public.profiles set reduce_only=true where id=$1', [ids.user]);
  // Latest administrator control is RESUME (the blocker is a leftover; reduce_only came from a risk limit).
  await db.query(`insert into public.admin_audit_logs(action,target_user_id,next_value,created_at) values
    ('MEMBER_COPY_CONTROL_UPDATED',$1,'{"mode":"REDUCE_ONLY"}',now()-interval '2 days'),
    ('MEMBER_COPY_CONTROL_UPDATED',$1,'{"mode":"RESUME"}',now()-interval '1 day')`, [ids.user]);
  await firstApply();
  assert.equal((await profile()).admin_reduce_only, false);
  // Latest control is REDUCE_ONLY: an administrator restriction.
  await db.query("update private.copy_resume_sessions set blocker_reason='ADMIN_REDUCE_ONLY' where trading_account_id=$1", [ids.member]);
  await db.query(`insert into public.admin_audit_logs(action,target_user_id,next_value) values
    ('MEMBER_COPY_CONTROL_UPDATED',$1,'{"mode":"REDUCE_ONLY"}')`, [ids.user]);
  await firstApply();
  assert.deepEqual(Object.values(await profile()), [true, true, false]);
  assert.deepEqual(Object.values(await session()), ['ACTIVE', 'ADMIN_REDUCE_ONLY'], 'kept: the restriction is real');
});

// ---- R7 ----
test('R7 a verification result of a superseded claim cannot verify the requeued key', async () => {
  await db.query('delete from private.gate_api_verification_jobs');
  await db.query("update private.gate_api_credentials set status='PENDING_VERIFICATION' where user_id=$1", [ids.user]);
  await db.query('insert into private.gate_api_verification_jobs(user_id) values($1)', [ids.user]);
  await asWorker();
  const [first] = (await db.query('select * from public.claim_gate_api_verification_jobs(5)')).rows;
  assert.ok(first.claimed_at instanceof Date || typeof first.claimed_at === 'string');
  // The member saves another key while the worker is still verifying the first: same job id, claim cleared.
  await db.query("update private.gate_api_verification_jobs set claimed_at=null,attempts=0,run_after=now() where id=$1", [first.job_id]);
  await rejects("select public.complete_gate_api_verification($1,true,'gate-user',null,null,'192.0.2.1',$2)",
    [first.job_id, first.claimed_at], /VERIFICATION_JOB_CLAIM_STALE/);
  // Re-claimed: only the new claim completes it.
  await db.query("update private.gate_api_verification_jobs set claimed_at=now()-interval '3 minutes' where id=$1", [first.job_id]);
  const [second] = (await db.query('select * from public.claim_gate_api_verification_jobs(5)')).rows;
  assert.equal(second.job_id, first.job_id);
  await rejects("select public.complete_gate_api_verification($1,true,'gate-user',null,null,'192.0.2.1',$2)",
    [first.job_id, first.claimed_at], /VERIFICATION_JOB_CLAIM_STALE/);
  await db.query("select public.complete_gate_api_verification($1,true,'gate-user',null,null,'192.0.2.1',$2)", [second.job_id, second.claimed_at]);
  assert.equal((await one('select status from private.gate_api_credentials where user_id=$1', [ids.user])).status, 'VERIFIED');
  assert.equal((await one('select count(*)::int n from private.gate_api_verification_jobs')).n, 0);
  // One signature only (6-argument calls of an older worker resolve to it).
  assert.equal((await one("select count(*)::int n from pg_proc where proname='complete_gate_api_verification'")).n, 1);
});

// ---- R8 ----
test('R8 rows from before 20261021033000 are WALLET_V0, so the first write restarts peak/day-start only at the MTM switch', async () => {
  const classic = { total: 1000, available: 500, unrealisedPnl: -400, equityIncludesUnrealised: false };
  const legacyPayload = (member) => {
    const payload = cyclePayload({ masterSize: 0, member });
    for (const account of payload.current_state.members) { delete account.risk_equity; delete account.risk_basis; }
    return payload;
  };
  await record(db, legacyPayload(classic));
  // Simulate the pre-migration row (no basis) with a peak above the current wallet value.
  await db.query('update private.copy_current_accounts set risk_basis=null, peak_equity=1200 where trading_account_id=$1', [ids.member]);
  await db.exec(readFileSync(RISK_MIGRATION, 'utf8'));
  const stored = () => one('select risk_basis, peak_equity::numeric peak from private.copy_current_accounts where trading_account_id=$1', [ids.member]);
  assert.deepEqual([(await stored()).risk_basis, Number((await stored()).peak)], ['WALLET_V0', 1200], 'backfilled, peak kept');
  // An older worker writes first: same basis, no restart (the 1200 peak is kept).
  await record(db, legacyPayload(classic));
  assert.deepEqual([(await stored()).risk_basis, Number((await stored()).peak)], ['WALLET_V0', 1200]);
  // The MTM worker: one restart at the switch.
  await record(db, cyclePayload({ masterSize: 0, member: classic }));
  assert.deepEqual([(await stored()).risk_basis, Number((await stored()).peak)], ['MTM_V1', 600]);
});
