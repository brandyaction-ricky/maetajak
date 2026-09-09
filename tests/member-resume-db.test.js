import test, { before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';

const user = '00000000-0000-4000-8000-000000000001';
const account = '00000000-0000-4000-8000-000000000002';
const master = '00000000-0000-4000-8000-000000000003';
let db;
const sql = (q, params = []) => db.query(q, params);
const one = async (q, params) => (await sql(q, params)).rows[0];
const worker = () => sql("select set_config('request.jwt.claim.role','service_role',false)");
const member = () => sql("select set_config('request.jwt.claim.role','authenticated',false),set_config('request.jwt.claim.sub',$1,false)", [user]);
before(async () => {
  db = new PGlite();
  await db.exec(readFileSync('tests/fixtures/copy-runtime-schema.sql', 'utf8'));
  await db.exec('insert into public.copy_system_control default values');
  await db.exec(readFileSync('supabase/migrations/20260909011308_safe_member_resume.sql', 'utf8'));
  await db.exec(readFileSync('supabase/migrations/20260909011702_fix_resume_reconciliation_alias.sql', 'utf8'));
  await db.exec(readFileSync('supabase/migrations/20260909014924_copy_entry_alert_outbox.sql', 'utf8'));
  await db.exec('delete from public.copy_system_control');
});
after(async () => db.close());
beforeEach(async () => {
  await db.exec('begin');
  await sql("insert into public.profiles(id,email,approval_status) values($1,'member@example.invalid','APPROVED')", [user]);
  await sql("insert into private.trading_accounts(id,user_id,credential_user_id,account_role,status) values($1,$2,$2,'MEMBER','ACTIVE'),($3,null,null,'MASTER','ACTIVE')", [account, user, master]);
  await db.exec("insert into public.copy_system_control default values; insert into private.copy_worker_runtime(worker_version,mode,gate_base_url,public_ip,broker_channel_id,heartbeat_at) values('0.4.0','DRY_RUN','https://api.gateio.ws','192.0.2.1','maetajak',now())");
  await sql("insert into private.gate_api_credentials(user_id,gate_uid,api_key_ciphertext,secret_key_ciphertext,api_key_last4,status,futures_read,futures_trade,verification_version,verified_worker_ip) values($1,'TEST_ONLY','x','y','TEST','VERIFIED',true,true,2,'192.0.2.1')", [user]);
  await member();
});
afterEach(async () => { await db.exec('rollback'); });

async function request() {
  await member();
  await sql("select public.set_my_copy_pause('RESUME')");
  return (await one('select version from private.copy_resume_sessions where trading_account_id=$1', [account])).version;
}
async function snapshot() {
  const time = (await one("select clock_timestamp()::text as t")).t;
  return { started_at: time, observed_at: time, master_positions: [{ contract: 'BTC_USDT', position_side: 'LONG', size: 100 }],
    member_positions: [{ contract: 'BTC_USDT', position_side: 'LONG', size: 7 }], open_order_count: 0, preview_passed: true,
    settings: { copy_ratio: 100, max_position_ratio: 30, daily_loss_limit_pct: 5, max_drawdown_pct: 15, max_leverage: 10 } };
}
async function prepared() {
  const version = await request();
  await worker();
  const payload = await snapshot();
  await sql('select public.prepare_member_copy_resume($1,$2,$3)', [account, version, payload]);
  return { version, payload };
}
async function activated() {
  const result = await prepared();
  await db.exec("update public.copy_system_control set execution_enabled=true,emergency_halted=false; update private.copy_worker_runtime set mode='LIVE'");
  await sql('select public.activate_member_copy_resume($1,$2,$3)', [account, result.version, result.payload]);
  return result;
}
async function intent(version, options = {}) {
  const id = randomUUID(); const cycle = randomUUID();
  const { status = 'PLANNED', actual = 7, delta = 2, target = actual + delta, side = 'LONG', reduceOnly = false } = options;
  await sql("insert into private.copy_cycles(id,master_account_id,source_version) values($1::uuid,$2,$1::uuid::text)", [cycle, master]);
  await sql(`insert into public.copy_position_states(user_id,trading_account_id,contract,position_side,state,actual_size,target_size,copy_ratio,max_position_ratio,last_cycle_id,last_observed_at)
    values($1,$2,'BTC_USDT',$3,'DRIFT',$4,$5,100,30,$6,clock_timestamp())
    on conflict(trading_account_id,contract,position_side) do update set state='DRIFT',actual_size=excluded.actual_size,target_size=excluded.target_size,last_cycle_id=excluded.last_cycle_id,last_observed_at=excluded.last_observed_at`,
    [user, account, side, actual, target, cycle]);
  const r = await sql(`insert into private.copy_order_intents(id,cycle_id,user_id,trading_account_id,contract,position_side,
    actual_size_at_plan,target_size,delta_size,reduce_only,idempotency_key,gate_order_text,status,resume_version,source_observed_at,position_mode)
    values($1::uuid,$2,$3,$4,'BTC_USDT',$5,$6,$7,$8,$9,$1::uuid::text,$1::uuid::text,$10,$11,clock_timestamp(),'dual') returning id`,
    [id, cycle, user, account, side, actual, target, delta, reduceOnly, status, version]);
  return r.rows.length ? id : null;
}
async function claim() { await worker(); return (await sql('select * from public.claim_copy_order_intents(10)')).rows; }

test('reconciliation polling executes while halted without claiming new orders', async () => {
  await worker();
  assert.deepEqual((await sql('select * from public.claim_copy_reconciliation_jobs(10)')).rows, []);
});

test('reconciliation cancels only expired claims that never received submission authorization', async () => {
  const { version } = await activated();
  const id = await intent(version);
  await claim();
  await sql("update private.copy_order_intents set submitted_at=now()-interval '1 minute' where id=$1", [id]);
  await sql('select * from public.claim_copy_reconciliation_jobs(10)');
  assert.equal((await one('select status from private.copy_order_intents where id=$1', [id])).status, 'CANCELLED');
});

test('a completed entry fill creates one durable Korean alert delivery job', async () => {
  const { version } = await activated();
  const id = await intent(version);
  const [job] = await claim();
  await sql("select public.complete_copy_order_attempt($1,'FILLED','qa-entry',2,101.25,201,'filled',null,$2)",
    [job.intent_id, { terminal: true }]);
  await worker();
  const alerts = (await sql('select * from public.claim_copy_entry_alerts(10)')).rows;
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].details.contract, 'BTC_USDT');
  assert.equal(Number(alerts[0].details.filled_size), 2);
  await sql('select public.complete_copy_entry_alert($1,true,null)', [alerts[0].alert_id]);
  assert.deepEqual((await sql('select * from public.claim_copy_entry_alerts(10)')).rows, []);
  assert.equal((await one('select count(*)::int n from private.copy_entry_alert_outbox where intent_id=$1', [id])).n, 1);
});

test('resume requests are idempotent, paused, and invalidate old unsubmitted plans', async () => {
  const old = await intent(null, { status: 'REJECTED' });
  // Simulate a legacy row present before the migration (without running a live order).
  await db.exec('alter table private.copy_order_intents disable trigger guard_copy_resume_order');
  await sql("update private.copy_order_intents set status='PLANNED' where id=$1", [old]);
  await db.exec('alter table private.copy_order_intents enable trigger guard_copy_resume_order');
  const first = await request(); const second = await request();
  assert.equal(first, second);
  assert.equal((await one('select copy_paused from public.profiles where id=$1', [user])).copy_paused, true);
  assert.equal((await one('select status from private.copy_order_intents where id=$1', [old])).status, 'CANCELLED');
  assert.deepEqual(await claim(), []);
});
test('an outstanding order from before the halt blocks replacement of the baseline', async () => {
  await intent(null, { status: 'UNKNOWN' });
  const version = await request(); await worker();
  await assert.rejects(sql('select public.prepare_member_copy_resume($1,$2,$3)', [account, version, await snapshot()]), /RESUME_UNRESOLVED_ORDERS/);
});
test('DRY_RUN saves exact protected quantities but cannot activate', async () => {
  const { version, payload } = await prepared();
  const r = await one('select public.activate_member_copy_resume($1,$2,$3) as result', [account, version, payload]);
  assert.equal(r.result.reason, 'SYSTEM_NOT_LIVE');
  const b = await one('select * from private.member_copy_onboarding_baselines where trading_account_id=$1', [account]);
  assert.deepEqual(b.positions, payload.master_positions);
  assert.deepEqual(b.member_positions, payload.member_positions);
  assert.equal(b.resume_version, version);
  assert.equal((await one('select copy_paused from public.profiles where id=$1', [user])).copy_paused, true);
});
test('stale or malformed snapshots cannot become baselines', async () => {
  const version = await request(); await worker();
  const p = await snapshot(); p.started_at = '2020-01-01T00:00:00Z';
  await assert.rejects(sql('select public.prepare_member_copy_resume($1,$2,$3)', [account, version, p]), /RESUME_SNAPSHOT_STALE/);
});
test('a pause during validation invalidates the activation result', async () => {
  const { version, payload } = await prepared();
  await member(); await sql("select public.set_my_copy_pause('HOLD')"); await worker();
  await assert.rejects(sql('select public.activate_member_copy_resume($1,$2,$3)', [account, version, payload]), /RESUME_VERSION_OR_STATE_CHANGED/);
});
test('a previous resume version cannot overwrite a later resume', async () => {
  const { version } = await prepared();
  await member(); await sql("select public.set_my_copy_pause('HOLD')"); await request(); await worker();
  await assert.rejects(sql('select public.prepare_member_copy_resume($1,$2,$3)', [account, version, await snapshot()]), /RESUME_VERSION_OR_STATE_CHANGED/);
});
test('valid live activation clears only the member pause flag and preserves both baselines', async () => {
  const { version } = await activated();
  assert.equal((await one('select state from private.copy_resume_sessions')).state, 'ACTIVE');
  assert.equal((await one('select copy_paused from public.profiles')).copy_paused, false);
  assert.equal((await one('select resume_version from private.member_copy_onboarding_baselines')).resume_version, version);
});
test('an old worker or versionless plan cannot dispatch orders', async () => {
  const { version } = await activated();
  assert.equal(await intent(null), null);
  await intent(version);
  await db.exec("update private.copy_worker_runtime set worker_version='0.3.0'");
  assert.deepEqual(await claim(), []);
});
test('two claimers cannot claim the same intent or submit two orders for one leg', async () => {
  const { version } = await activated(); const id = await intent(version);
  assert.equal((await claim())[0].intent_id, id);
  assert.deepEqual(await claim(), []);
  assert.equal(await intent(version), null);
});
test('pausing after a claim revokes submission permission', async () => {
  const { version } = await activated(); await intent(version); const [job] = await claim();
  await member(); await sql("select public.set_my_copy_pause('HOLD')"); await worker();
  const r = await one('select public.authorize_copy_order_submission($1,$2) as permitted', [job.intent_id, version]);
  assert.equal(r.permitted, false);
  assert.equal((await one('select status from private.copy_order_intents where id=$1', [job.intent_id])).status, 'CANCELLED');
});
test('terminal partial fills retain their fill and wait for two subsequent position observations', async () => {
  const { version } = await activated(); await intent(version); const [job] = await claim();
  await sql("select public.complete_copy_order_attempt($1,'PARTIALLY_FILLED','qa-order',1,null,201,'ioc',null,$2)",
    [job.intent_id, { terminal: true }]);
  assert.equal((await one('select exchange_terminal from private.copy_order_intents where id=$1', [job.intent_id])).exchange_terminal, true);
  assert.equal((await one('select count(*)::int as n from private.copy_reconciliation_jobs')).n, 0);
  const observe = async (size) => sql(`select public.confirm_copy_order_observation($1,$2,$3,clock_timestamp(),clock_timestamp())`,
    [account, version, [{ contract: 'BTC_USDT', position_side: 'LONG', size }]]);
  await observe(7);
  assert.equal((await one('select observation_confirmed_at from private.copy_order_intents')).observation_confirmed_at, null);
  await observe(8);
  assert.equal((await one('select observation_confirmed_at from private.copy_order_intents')).observation_confirmed_at, null);
  await db.exec("update private.copy_order_intents set position_match_at=clock_timestamp()-interval '3 seconds'");
  await observe(8);
  assert.ok((await one('select observation_confirmed_at from private.copy_order_intents')).observation_confirmed_at);
  assert.ok(await intent(version, { actual: 8, delta: 1 }));
});
test('a delayed rejection cannot erase a committed fill', async () => {
  const { version } = await activated(); await intent(version); const [job] = await claim();
  await sql("select public.complete_copy_order_attempt($1,'FILLED','qa',2)", [job.intent_id]);
  await sql("select public.complete_copy_order_attempt($1,'REJECTED',null,0)", [job.intent_id]);
  const r = await one('select status,filled_size from private.copy_order_intents');
  assert.equal(r.status, 'FILLED'); assert.equal(Number(r.filled_size), 2);
});
test('an impossible fill halts execution without modifying the protected baseline', async () => {
  const { version } = await activated(); await intent(version); const [job] = await claim();
  await sql("select public.complete_copy_order_attempt($1,'FILLED','qa',200)", [job.intent_id]);
  const c = await one('select execution_enabled,emergency_halted from public.copy_system_control');
  assert.equal(c.execution_enabled, false); assert.equal(c.emergency_halted, true);
  assert.equal((await one('select member_positions from private.member_copy_onboarding_baselines')).member_positions[0].size, 7);
});
test('worker RPCs and private resume data are inaccessible to browser roles', async () => {
  const r = await one(`select
    has_function_privilege('anon','public.prepare_member_copy_resume(uuid,uuid,jsonb)','execute') as anon,
    has_function_privilege('authenticated','public.prepare_member_copy_resume(uuid,uuid,jsonb)','execute') as member,
    has_function_privilege('service_role','public.prepare_member_copy_resume(uuid,uuid,jsonb)','execute') as worker,
    has_table_privilege('authenticated','private.copy_resume_sessions','select') as table_access`);
  assert.deepEqual(r, { anon: false, member: false, worker: true, table_access: false });
});
test('submission authorization is single-use and a repeated request cannot cancel a potentially sent order', async () => {
  const { version } = await activated(); await intent(version); const [job] = await claim();
  const authorize = () => one('select public.authorize_copy_order_submission($1,$2) as permitted', [job.intent_id, version]);
  assert.equal((await authorize()).permitted, true);
  assert.equal((await authorize()).permitted, false);
  assert.equal((await one('select status from private.copy_order_intents')).status, 'SUBMITTING');
});
test('copy setting changes invalidate active sessions and keep the member paused', async () => {
  await activated();
  await db.exec('update public.profiles set copy_ratio=120');
  assert.equal((await one('select state from private.copy_resume_sessions')).state, 'PAUSED');
  assert.equal((await one('select copy_paused from public.profiles')).copy_paused, true);
});
test('an explicit CLOSE request can only claim reduce-only orders to zero', async () => {
  await activated(); await member(); await sql("select public.set_my_copy_pause('CLOSE')");
  const { version } = await one('select version from private.copy_resume_sessions');
  assert.equal(await intent(version), null);
  await intent(version, { actual: 7, target: 0, delta: -7, reduceOnly: true });
  const [job] = await claim();
  assert.equal(job.reduce_only, true); assert.equal(Number(job.delta_size), -7);
});
test('the remaining pre-resume master baseline shrinks after reductions and never grows back', async () => {
  const { version } = await activated();
  const advance = (size) => sql('select public.advance_member_copy_resume_baseline_legs($1,$2,$3)',
    [account, version, [{ contract: 'BTC_USDT', position_side: 'LONG', size }]]);
  await advance(50);
  assert.equal((await one('select positions from private.member_copy_onboarding_baselines')).positions[0].size, 50);
  await advance(80);
  assert.equal((await one('select positions from private.member_copy_onboarding_baselines')).positions[0].size, 50);
  await advance(0);
  assert.deepEqual((await one('select positions from private.member_copy_onboarding_baselines')).positions, []);
});
