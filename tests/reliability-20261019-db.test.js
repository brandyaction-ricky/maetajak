import test, { before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createVerifiedDatabase, seedVerifiedAccount, cyclePayload, record, ids } from './fixtures/verified-runtime.js';

// 2026-10-19 reliability fixes: error-event throttle and noise retention, transfer-adjusted risk
// equity, desired (pre-cap) anchor targets, Gate account change rebind, RESUME risk reset.
let db;
const one = async (sql, args = []) => (await db.query(sql, args)).rows[0];
const n = async (sql, args = []) => Number((await one(sql, args)).n);
const worker = () => db.query("select set_config('request.jwt.claim.role','service_role',false)");

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
      created_at timestamptz not null default now(), updated_at timestamptz not null default now());`);
});
after(async () => { await db?.close(); });
beforeEach(async () => { await db.exec('begin'); await seedVerifiedAccount(db); });
afterEach(async () => { await db.exec('rollback'); });

const errorEvent = (code, at = 'now()') => db.query(`insert into public.copy_events(user_id,event_type,severity,safe_payload,occurred_at)
  values($1,'ERROR','CRITICAL',jsonb_build_object('code',$2::text),${at})`, [ids.user, code]);

test('a repeated ERROR with the same code within 10 minutes is not stored again; a new code is', async () => {
  await errorEvent('MEMBER_ACCOUNT_READ_INVALID_CREDENTIALS');
  await errorEvent('MEMBER_ACCOUNT_READ_INVALID_CREDENTIALS');
  await errorEvent('MEMBER_ACCOUNT_READ_INVALID_CREDENTIALS');
  await errorEvent('MEMBER_ACCOUNT_READ_FUTURES_READ_REQUIRED');
  assert.equal(await n("select count(*) n from public.copy_events where event_type='ERROR'"), 2);
  // Older than 10 minutes: stored again.
  await db.query("update public.copy_events set occurred_at=now()-interval '11 minutes'");
  await errorEvent('MEMBER_ACCOUNT_READ_INVALID_CREDENTIALS');
  assert.equal(await n("select count(*) n from public.copy_events where event_type='ERROR'"), 3);
});

test('non-error events are never throttled', async () => {
  for (let i = 0; i < 3; i += 1) await db.query(`insert into public.copy_events(user_id,event_type,severity,safe_payload)
    values($1,'ORDER_FILLED','INFO','{}')`, [ids.user]);
  assert.equal(await n("select count(*) n from public.copy_events where event_type='ORDER_FILLED'"), 3);
});

test('noise events do not keep a cycle; order events still do; old noise is deleted, orders are kept', async () => {
  const noiseCycle = randomUUID(); const orderCycle = randomUUID();
  for (const id of [noiseCycle, orderCycle]) await db.query(`insert into private.copy_cycles(id,master_account_id,status,source_version,started_at,created_at)
    values($1,$2,'COMPLETED',$3,now()-interval '5 days',now()-interval '5 days')`, [id, ids.master, id]);
  await db.query(`insert into public.copy_events(user_id,event_type,severity,cycle_id,safe_payload,occurred_at) values
    ($1,'SYMBOL_PAUSED','WARNING',$2,'{}',now()-interval '20 days'),
    ($1,'POSITION_SYNCED','INFO',$2,'{}',now()-interval '20 days'),
    ($1,'ORDER_FILLED','INFO',$3,'{}',now()-interval '20 days'),
    ($1,'MANUAL_OVERRIDE_DETECTED','CRITICAL',null,'{}',now()-interval '20 days'),
    ($1,'SYMBOL_PAUSED','WARNING',null,'{}',now()-interval '3 days')`, [ids.user, noiseCycle, orderCycle]);
  const r = (await one("select private.prune_copy_history(interval '1 day',1000,false,interval '3 days') r")).r;
  assert.equal(r.cycles, 1);
  assert.equal(r.events, 2);
  assert.equal(await n('select count(*) n from private.copy_cycles where id=$1', [noiseCycle]), 0);
  assert.equal(await n('select count(*) n from private.copy_cycles where id=$1', [orderCycle]), 1);
  assert.equal(await n("select count(*) n from public.copy_events where event_type='ORDER_FILLED'"), 1);
  assert.equal(await n("select count(*) n from public.copy_events where event_type='MANUAL_OVERRIDE_DETECTED'"), 1);
  assert.equal(await n("select count(*) n from public.copy_events where event_type='SYMBOL_PAUSED'"), 1, 'recent noise stays');
  const dry = (await one("select private.prune_copy_history(interval '1 day',1000,true,interval '3 days') r")).r;
  assert.equal(dry.events, 0, 'events keep 14 days: a 3-day-old event is not eligible');
});

// ---- transfer-adjusted risk equity ----
const observe = (total, secondsLater = 1) => db.query(`update private.copy_current_accounts set total_equity=$2,
  observed_at=observed_at+make_interval(secs=>$3) where trading_account_id=$1`, [ids.member, total, secondsLater]);
const flows = (entries) => db.query('select public.record_copy_fund_flows($1,$2::jsonb) v', [ids.member, JSON.stringify(entries)]);
const risk = async () => one('select peak_equity::numeric peak, day_start_equity::numeric ds from private.copy_current_accounts where trading_account_id=$1', [ids.member]);

test('a withdrawal does not count as a drawdown and a deposit does not raise the peak', async () => {
  await record(db, cyclePayload({ masterSize: 0, member: { total: 6000, available: 6000 } }));
  const start = await risk();
  assert.equal(Number(start.peak), 6000);
  await worker();
  // Tracking starts at the first record call; transfers before it are ignored (the peak already has them).
  await flows([{ key: 'old', change: '-999', time: Math.floor(Date.now() / 1000) - 3600 }]);
  assert.equal(Number((await one('select private.copy_fund_flow_net($1) v', [ids.member])).v), 0);
  const later = Math.floor(Date.now() / 1000) + 5;
  const net = (await flows([{ key: 'w1', change: '-4000', time: later }, { key: 'w1', change: '-4000', time: later }])).rows[0].v;
  assert.equal(Number(net), -4000, 'idempotent per key');
  await observe(2000);
  let r = await risk();
  assert.equal(Number(r.peak), 6000, 'adjusted equity 2000-(-4000)=6000 is not below the peak');
  await flows([{ key: 'd1', change: '10000', time: later + 1 }]);
  await observe(12500, 2);
  r = await risk();
  assert.equal(Number(r.peak), 6500, 'only the trading gain of 500 raises the peak');
});

test('net 0: peak and day-start behave exactly as before', async () => {
  await record(db, cyclePayload({ masterSize: 0, member: { total: 5000, available: 5000 } }));
  await observe(5200); assert.equal(Number((await risk()).peak), 5200);
  await observe(4800, 2); assert.equal(Number((await risk()).peak), 5200);
});

test('an administrative reset (observed_at unchanged) keeps the value it sets', async () => {
  await record(db, cyclePayload({ masterSize: 0, member: { total: 5000, available: 5000 } }));
  await db.query('update private.copy_current_accounts set peak_equity=1234 where trading_account_id=$1', [ids.member]);
  assert.equal(Number((await risk()).peak), 1234);
});

test('RESUME clears reduce-only on an ACTIVE member and resets the risk baseline to current equity', async () => {
  await record(db, cyclePayload({ masterSize: 0, member: { total: 3000, available: 3000 } }));
  await db.query('update private.copy_current_accounts set peak_equity=9000,day_start_equity=9000 where trading_account_id=$1', [ids.member]);
  await db.query('update public.profiles set reduce_only=true,copy_paused=false where id=$1', [ids.user]);
  const result = (await one('select private.request_member_copy_resume($1) v', [ids.user])).v;
  assert.equal(result.sessions[0].state, 'ACTIVE');
  const p = await one('select reduce_only from public.profiles where id=$1', [ids.user]);
  assert.equal(p.reduce_only, false);
  const r = await risk();
  assert.equal(Number(r.peak), 3000);
  assert.equal(Number(r.ds), 3000);
});

// ---- desired anchor target ----
test('anchor stores the desired size with its basis; another writer of target_size invalidates it', async () => {
  await worker();
  const payload = cyclePayload({ masterSize: 40 });
  const leg = payload.members[0].planned_positions[0];
  leg.anchor_desired_target_size = Number(leg.target_size) + 50;
  await db.query('select public.record_copy_worker_cycle_with_target_anchors($1)', [payload]);
  let anchors = (await one('select public.get_copy_target_anchors() v')).v;
  const mine = anchors.find((a) => a.trading_account_id === ids.member);
  assert.equal(Number(mine.desired_target_size), Number(leg.target_size) + 50);
  await db.query('update private.copy_target_anchors set target_size=target_size-1 where trading_account_id=$1', [ids.member]);
  anchors = (await one('select public.get_copy_target_anchors() v')).v;
  assert.equal(anchors.find((a) => a.trading_account_id === ids.member).desired_target_size, null);
});

test('a desired size smaller than the target or on the other side is not stored', async () => {
  await worker();
  const payload = cyclePayload({ masterSize: 40 });
  const leg = payload.members[0].planned_positions[0];
  leg.anchor_desired_target_size = -Math.abs(Number(leg.target_size)) - 1;
  await db.query('select public.record_copy_worker_cycle_with_target_anchors($1)', [payload]);
  const row = await one('select desired_target_size from private.copy_target_anchors where trading_account_id=$1', [ids.member]);
  assert.equal(row.desired_target_size, null);
});

// ---- Gate account change ----
async function verifyWithUid(uid, role = 'MEMBER', user = ids.user) {
  await db.query('update private.gate_api_credentials set gate_uid=$2, connection_role=$3 where user_id=$1', [user, uid, role]);
  const job = (await one('insert into private.gate_api_verification_jobs(user_id) values($1) on conflict(user_id) do update set attempts=0 returning id', [user])).id;
  await db.query("select public.complete_gate_api_verification($1,true,'gate-user','','', '192.0.2.1')", [job]);
}

test('verifying a different Gate UID archives and clears the member account state and pauses the member', async () => {
  await record(db, cyclePayload({ masterSize: 40 }));
  await db.query("update private.trading_accounts set bound_gate_uid='OLD_UID' where id=$1", [ids.member]);
  await db.query('update private.copy_current_accounts set peak_equity=9000 where trading_account_id=$1', [ids.member]);
  await db.query("insert into private.open_order_cancel_jobs(trading_account_id,state) values($1,'PENDING')", [ids.member]);
  const before = await n('select count(*) n from public.copy_position_states where trading_account_id=$1', [ids.member]);
  assert.ok(before > 0);
  await verifyWithUid('NEW_UID');
  assert.equal(await n('select count(*) n from public.copy_position_states where trading_account_id=$1', [ids.member]), 0);
  assert.equal(await n('select count(*) n from private.copy_current_accounts where trading_account_id=$1', [ids.member]), 0);
  assert.equal(await n('select count(*) n from private.member_copy_onboarding_baselines where trading_account_id=$1', [ids.member]), 0);
  assert.equal(await n('select count(*) n from private.copy_target_anchors where trading_account_id=$1', [ids.member]), 0);
  const archive = await one('select * from private.trading_account_rebind_archive where trading_account_id=$1', [ids.member]);
  assert.equal(archive.old_gate_uid, 'OLD_UID');
  assert.equal(archive.new_gate_uid, 'NEW_UID');
  assert.ok(archive.archived.copy_position_states.length === before);
  assert.equal((await one('select bound_gate_uid from private.trading_accounts where id=$1', [ids.member])).bound_gate_uid, 'NEW_UID');
  const p = await one('select copy_paused,reduce_only from public.profiles where id=$1', [ids.user]);
  assert.equal(p.copy_paused, true);
  const s = await one('select state,blocker_reason from private.copy_resume_sessions where trading_account_id=$1', [ids.member]);
  assert.deepEqual([s.state, s.blocker_reason], ['PAUSED', 'GATE_ACCOUNT_CHANGED']);
  const job = await one('select state,attempts from private.open_order_cancel_jobs where trading_account_id=$1', [ids.member]);
  assert.equal(job.state, 'FAILED');
  assert.ok(job.attempts >= 5);
});

test('re-verifying the same Gate UID keeps every state row', async () => {
  await record(db, cyclePayload({ masterSize: 40 }));
  await db.query("update private.trading_accounts set bound_gate_uid='SAME_UID' where id=$1", [ids.member]);
  const before = await n('select count(*) n from public.copy_position_states where trading_account_id=$1', [ids.member]);
  await verifyWithUid('SAME_UID');
  assert.equal(await n('select count(*) n from public.copy_position_states where trading_account_id=$1', [ids.member]), before);
  assert.equal(await n('select count(*) n from private.trading_account_rebind_archive'), 0);
});

test('a Master Gate account change pauses every member and clears their Master-derived state', async () => {
  await record(db, cyclePayload({ masterSize: 40 }));
  const admin = '30000000-0000-4000-8000-000000000009';
  await db.query("insert into public.profiles(id,email,role,approval_status) values($1,'a@example.invalid','ADMIN','APPROVED')", [admin]);
  await db.query(`insert into private.gate_api_credentials(user_id,gate_uid,api_key_ciphertext,secret_key_ciphertext,api_key_last4,status,connection_role)
    values($1,'OLD_MASTER','x','y','TEST','VERIFIED','MASTER')`, [admin]);
  await db.query("update private.trading_accounts set credential_user_id=$1,user_id=$1,bound_gate_uid='OLD_MASTER' where id=$2", [admin, ids.master]);
  await db.query('update public.profiles set copy_paused=false where id=$1', [ids.user]);
  const memberStates = await n('select count(*) n from public.copy_position_states where trading_account_id=$1', [ids.member]);
  await verifyWithUid('NEW_MASTER', 'MASTER', admin);
  assert.equal(await n('select count(*) n from private.member_copy_onboarding_baselines where trading_account_id=$1', [ids.member]), 0);
  assert.equal(await n('select count(*) n from private.copy_target_anchors where trading_account_id=$1', [ids.member]), 0);
  // The member's own observation state (its Gate account did not change) is kept.
  assert.equal(await n('select count(*) n from public.copy_position_states where trading_account_id=$1', [ids.member]), memberStates);
  const s = await one('select state,blocker_reason from private.copy_resume_sessions where trading_account_id=$1', [ids.member]);
  assert.deepEqual([s.state, s.blocker_reason], ['PAUSED', 'MASTER_ACCOUNT_CHANGED']);
  assert.equal((await one('select copy_paused from public.profiles where id=$1', [ids.user])).copy_paused, true);
});

test('only one Master stays active after a Master verification', async () => {
  const admin = '30000000-0000-4000-8000-000000000008';
  await db.query("insert into public.profiles(id,email,role,approval_status) values($1,'b@example.invalid','ADMIN','APPROVED')", [admin]);
  await db.query(`insert into private.gate_api_credentials(user_id,gate_uid,api_key_ciphertext,secret_key_ciphertext,api_key_last4,status,connection_role)
    values($1,'SECOND_MASTER','x','y','TEST','PENDING_VERIFICATION','MASTER')`, [admin]);
  await verifyWithUid('SECOND_MASTER', 'MASTER', admin);
  assert.equal(await n("select count(*) n from private.trading_accounts where account_role='MASTER' and status='ACTIVE'"), 1);
  assert.equal((await one("select status from private.trading_accounts where id=$1", [ids.master])).status, 'DISABLED');
});

test('the guard refuses a UID another user registered, and an account change with an unresolved order', async () => {
  const other = '30000000-0000-4000-8000-000000000007';
  await db.query("insert into public.profiles(id,email,approval_status) values($1,'c@example.invalid','APPROVED')", [other]);
  await db.query(`insert into private.gate_api_credentials(user_id,gate_uid,api_key_ciphertext,secret_key_ciphertext,api_key_last4,status)
    values($1,'TAKEN_UID','x','y','TEST','VERIFIED')`, [other]);
  await db.exec('savepoint s1');
  await assert.rejects(() => db.query("select private.guard_gate_account_change($1,'MEMBER','TAKEN_UID')", [ids.user]), /GATE_UID_ALREADY_REGISTERED/);
  await db.exec('rollback to s1');
  await record(db, cyclePayload({ masterSize: 40 }));
  await db.query("update private.trading_accounts set bound_gate_uid='OLD_UID' where id=$1", [ids.member]);
  await db.query("update private.copy_order_intents set status='UNKNOWN', exchange_terminal=false where trading_account_id=$1", [ids.member]);
  assert.ok(await n("select count(*) n from private.copy_order_intents where status='UNKNOWN'") > 0);
  await db.exec('savepoint s2');
  await assert.rejects(() => db.query("select private.guard_gate_account_change($1,'MEMBER','BRAND_NEW')", [ids.user]), /ACCOUNT_CHANGE_UNRESOLVED_ORDERS/);
  await db.exec('rollback to s2');
  await db.query("update private.copy_order_intents set status='FILLED', exchange_terminal=true where trading_account_id=$1", [ids.member]);
  await db.query("select private.guard_gate_account_change($1,'MEMBER','BRAND_NEW')", [ids.user]);
  const s = await one('select state,blocker_reason from private.copy_resume_sessions where trading_account_id=$1', [ids.member]);
  assert.deepEqual([s.state, s.blocker_reason], ['PAUSED', 'GATE_ACCOUNT_CHANGE_PENDING']);
});

// ---- review findings (2026-10-19) ----
test('rebind succeeds when the ownership ledger has fills (fills are archived before checkpoints)', async () => {
  await record(db, cyclePayload({ masterSize: 40 }));
  const intent = (await one('select id from private.copy_order_intents where trading_account_id=$1 limit 1', [ids.member])).id;
  await db.query(`insert into private.copy_ownership_checkpoints(trading_account_id,resume_version,status,protected_positions,observed_at)
    values($1,$2,'CONFIRMED','[]',now()) on conflict (trading_account_id) do nothing`, [ids.member, ids.version]);
  await db.query(`insert into private.copy_ownership_fills(intent_id,trading_account_id,resume_version,filled_size,confirmed_at)
    values($1,$2,$3,1,now())`, [intent, ids.member, ids.version]);
  await db.query("update private.trading_accounts set bound_gate_uid='OLD_UID' where id=$1", [ids.member]);
  await verifyWithUid('NEW_UID');
  assert.equal(await n('select count(*) n from private.copy_ownership_fills where trading_account_id=$1', [ids.member]), 0);
  const archive = await one('select archived from private.trading_account_rebind_archive where trading_account_id=$1', [ids.member]);
  assert.equal(archive.archived.copy_ownership_fills.length, 1);
});

test('a deposit recorded after the peak already included it does not read as a drawdown', async () => {
  await record(db, cyclePayload({ masterSize: 0, member: { total: 1000, available: 1000 } }));
  await worker();
  await flows([]); // tracking starts now
  const depositAt = Math.floor(Date.now() / 1000) + 1;
  await observe(6000, 2); // deposit of 5,000 observed before the ledger sync recorded it
  assert.equal(Number((await risk()).peak), 6000);
  await flows([{ key: 'dep', change: '5000', time: depositAt }]);
  const r = await risk();
  assert.equal(Number(r.peak), 1000, 'peak back to the pre-deposit value');
  const adjusted = 6000 - 5000;
  assert.equal((Number(r.peak) - adjusted) / Number(r.peak), 0, 'no drawdown');
});

test('a transfer recorded late corrects a day-start set after it', async () => {
  await record(db, cyclePayload({ masterSize: 0, member: { total: 1000, available: 1000 } }));
  await worker();
  await flows([]);
  const at = Math.floor(Date.now() / 1000) + 1;
  // New day opens after a withdrawal of 400 that is not recorded yet.
  await db.query(`update private.copy_current_accounts set total_equity=600, equity_day=equity_day+1,
    observed_at=observed_at+interval '3 seconds' where trading_account_id=$1`, [ids.member]);
  assert.equal(Number((await risk()).ds), 600);
  await flows([{ key: 'wd', change: '-400', time: at }]);
  assert.equal(Number((await risk()).ds), 1000, 'day-start on the same basis as adjusted equity (600+400)');
});

test('a desired size does not survive a resume that rewrites the anchor', async () => {
  await worker();
  const payload = cyclePayload({ masterSize: 40 });
  const leg = payload.members[0].planned_positions[0];
  leg.anchor_desired_target_size = Number(leg.target_size) + 50;
  await db.query('select public.record_copy_worker_cycle_with_target_anchors($1)', [payload]);
  // A resume preparation rewrites resume_version / master size but leaves the target unchanged.
  await db.query('update private.copy_target_anchors set resume_version=gen_random_uuid() where trading_account_id=$1', [ids.member]);
  let a = (await one('select public.get_copy_target_anchors() v')).v.find((x) => x.trading_account_id === ids.member);
  assert.equal(a.desired_target_size, null);
  await db.query('update private.copy_target_anchors set resume_version=desired_basis_resume_version, master_copyable_size=master_copyable_size-1 where trading_account_id=$1', [ids.member]);
  a = (await one('select public.get_copy_target_anchors() v')).v.find((x) => x.trading_account_id === ids.member);
  assert.equal(a.desired_target_size, null, 'a Master size rewrite invalidates it too');
});

test('a Master registered by a different admin resets members as a Master change', async () => {
  await record(db, cyclePayload({ masterSize: 40 }));
  const oldAdmin = '30000000-0000-4000-8000-000000000006';
  const newAdmin = '30000000-0000-4000-8000-000000000005';
  for (const [id, email] of [[oldAdmin, 'o@example.invalid'], [newAdmin, 'n@example.invalid']]) {
    await db.query("insert into public.profiles(id,email,role,approval_status) values($1,$2,'ADMIN','APPROVED')", [id, email]);
  }
  await db.query(`insert into private.gate_api_credentials(user_id,gate_uid,api_key_ciphertext,secret_key_ciphertext,api_key_last4,status,connection_role)
    values($1,'OLD_MASTER','x','y','TEST','VERIFIED','MASTER'),($2,'NEW_MASTER','x','y','TEST','PENDING_VERIFICATION','MASTER')`, [oldAdmin, newAdmin]);
  await db.query("update private.trading_accounts set credential_user_id=$1,user_id=$1,bound_gate_uid='OLD_MASTER' where id=$2", [oldAdmin, ids.master]);
  await db.query('update public.profiles set copy_paused=false where id=$1', [ids.user]);
  await verifyWithUid('NEW_MASTER', 'MASTER', newAdmin);
  assert.equal(await n('select count(*) n from private.member_copy_onboarding_baselines where trading_account_id=$1', [ids.member]), 0);
  const s = await one('select state,blocker_reason from private.copy_resume_sessions where trading_account_id=$1', [ids.member]);
  assert.deepEqual([s.state, s.blocker_reason], ['PAUSED', 'MASTER_ACCOUNT_CHANGED']);
  assert.equal(await n("select count(*) n from private.trading_accounts where account_role='MASTER' and status='ACTIVE'"), 1);
});

test("a member's RESUME does not lift an administrator's REDUCE_ONLY", async () => {
  await record(db, cyclePayload({ masterSize: 0, member: { total: 3000, available: 3000 } }));
  await db.query("update public.profiles set reduce_only=true,copy_paused=false where id=$1", [ids.user]);
  await db.query("update private.copy_resume_sessions set state='ACTIVE',blocker_reason='ADMIN_REDUCE_ONLY' where trading_account_id=$1", [ids.member]);
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [ids.user]);
  await db.query('select private.request_member_copy_resume($1)', [ids.user]);
  assert.equal((await one('select reduce_only from public.profiles where id=$1', [ids.user])).reduce_only, true);
});
