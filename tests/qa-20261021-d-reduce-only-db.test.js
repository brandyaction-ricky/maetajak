import test, { before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createVerifiedDatabase, seedVerifiedAccount, cyclePayload, record, ids } from './fixtures/verified-runtime.js';

// QA 2026-10-21 area D. D1 asserts the fixed behaviour (fix/qa-sizing); each D-REPRO test asserts the CURRENT behaviour of 0c39e77;
// a passing "REPRO" test means the reported finding is reproduced.
let db;
const one = async (q, p) => (await db.query(q, p)).rows[0];
const asMember = () => db.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claim.role','authenticated',false),set_config('test.admin','false',false)", [ids.user]);
const asAdmin = () => db.query("select set_config('request.jwt.claim.sub','',false),set_config('request.jwt.claim.role','authenticated',false),set_config('test.admin','true',false)");
const asWorker = () => db.query("select set_config('request.jwt.claim.role','service_role',false),set_config('test.admin','false',false)");
before(async () => { db = await createVerifiedDatabase(); });
after(async () => { await db?.close(); });
beforeEach(async () => { await db.exec('begin'); await seedVerifiedAccount(db); });
afterEach(async () => { await db.exec('rollback'); });

const anchors = async () => { await asWorker(); return (await one('select public.get_copy_target_anchors() a')).a; };

test('D1: risk limit -> sticky reduce-only; after ACTIVE "재개" the Master entry made meanwhile is not bought', async () => {
  // Cycle 1: daily loss limit reached (worker evaluation). Master opens BTC LONG 40 in the same period.
  await record(db, cyclePayload({ masterSize: 40, member: { reduce_only: true, risk_halt_reason: 'DAILY_LOSS_LIMIT' } }));
  assert.equal((await one('select reduce_only from public.profiles where id=$1', [ids.user])).reduce_only, true, 'sticky');
  assert.equal(Number((await one('select count(*) n from private.copy_order_intents')).n), 0, 'nothing bought while reduce-only');
  const stored = await anchors();
  assert.equal(stored.length, 1);
  assert.equal(Number(stored[0].target_size), 0, 'the anchor records what is held: the increase is consumed');
  assert.equal(Number(stored[0].master_copyable_size), 40);
  assert.equal(Number(stored[0].reference_master_size), 0);
  assert.equal(Number(stored[0].observed_master_size), 40);

  // Member presses "카피 재개" (session is ACTIVE, not paused): reduce-only is cleared in place, no validation.
  await asMember();
  await db.query("select public.set_my_copy_pause('RESUME')");
  await asWorker();
  const session = await one('select state,version from private.copy_resume_sessions where trading_account_id=$1', [ids.member]);
  assert.deepEqual([session.state, session.version], ['ACTIVE', ids.version]);
  assert.equal((await one('select reduce_only from public.profiles where id=$1', [ids.user])).reduce_only, false);

  // Next cycle (Master unchanged at 40, member still flat): nothing is bought.
  await record(db, cyclePayload({ masterSize: 40, member: { target_anchors: await anchors() } }));
  assert.equal(Number((await one('select count(*) n from private.copy_order_intents')).n), 0, 'no catch-up BUY');
  // A later Master increase (40 -> 80) is followed: +10.
  await record(db, cyclePayload({ masterSize: 80, member: { target_anchors: await anchors() } }));
  const intent = await one("select delta_size,reduce_only,status from private.copy_order_intents order by created_at desc limit 1");
  assert.equal(Number(intent.delta_size), 10);
  assert.equal(intent.reduce_only, false);
});

test('D3 FIXED admin REDUCE_ONLY survives a member HOLD then RESUME (and the activation); only admin RESUME lifts it', async () => {
  await asAdmin();
  await db.query("select public.set_member_copy_control($1,'REDUCE_ONLY','QA')", [ids.user]);
  await asWorker();
  let s = await one('select state,blocker_reason from private.copy_resume_sessions where trading_account_id=$1', [ids.member]);
  assert.deepEqual([s.state, s.blocker_reason], ['ACTIVE', 'ADMIN_REDUCE_ONLY']);
  assert.equal((await one('select admin_reduce_only from public.profiles where id=$1', [ids.user])).admin_reduce_only, true);

  await asMember();
  await db.query("select public.set_my_copy_pause('RESUME')");
  assert.equal((await one('select reduce_only from public.profiles where id=$1', [ids.user])).reduce_only, true, 'guarded path');

  await db.query("select public.set_my_copy_pause('HOLD')");
  await db.query("select public.set_my_copy_pause('RESUME')");
  await asWorker();
  let p = await one('select reduce_only,admin_reduce_only,copy_paused from public.profiles where id=$1', [ids.user]);
  s = await one('select state,blocker_reason from private.copy_resume_sessions where trading_account_id=$1', [ids.member]);
  assert.deepEqual([p.reduce_only, p.admin_reduce_only], [true, true], 'HOLD/RESUME cannot clear the admin restriction');
  assert.equal(s.state, 'REQUESTED', 'a normal resume validation runs; the member resumes reduce-only');
  // The activation core writes reduce_only=false: the restriction is re-applied on the same row.
  await db.query("update private.copy_resume_sessions set state='ACTIVE' where trading_account_id=$1", [ids.member]);
  await db.query("update public.profiles set copy_paused=false,reduce_only=false where id=$1", [ids.user]);
  assert.equal((await one('select reduce_only from public.profiles where id=$1', [ids.user])).reduce_only, true);

  await asAdmin();
  await db.query("select public.set_member_copy_control($1,'RESUME','QA')", [ids.user]);
  p = await one('select reduce_only,admin_reduce_only from public.profiles where id=$1', [ids.user]);
  assert.deepEqual([p.reduce_only, p.admin_reduce_only], [false, false], 'administrator RESUME lifts it');
});

test('D3 FIXED admin PAUSE: the member HOLD does not erase it and the member cannot resume; admin RESUME can', async () => {
  await asAdmin();
  await db.query("select public.set_member_copy_control($1,'PAUSE','QA')", [ids.user]);
  await asMember();
  await db.query("select public.set_my_copy_pause('HOLD')");
  const s = await one('select state,blocker_reason from private.copy_resume_sessions where trading_account_id=$1', [ids.member]);
  assert.deepEqual([s.state, s.blocker_reason], ['PAUSED', 'MEMBER_PAUSED']);
  await db.exec('savepoint d3');
  await assert.rejects(db.query("select public.set_my_copy_pause('RESUME')"), /ADMIN_PAUSED/);
  await db.exec('rollback to savepoint d3');
  // Even a direct copy_paused=false write cannot unpause while the admin pause stands.
  await asWorker();
  await db.query("update public.profiles set copy_paused=false where id=$1", [ids.user]);
  assert.equal((await one('select copy_paused,admin_paused from public.profiles where id=$1', [ids.user])).copy_paused, true);
  await asAdmin();
  await db.query("select public.set_member_copy_control($1,'RESUME','QA')", [ids.user]);
  const p = await one('select admin_paused,copy_paused from public.profiles where id=$1', [ids.user]);
  assert.equal(p.admin_paused, false);
  assert.equal((await one('select state from private.copy_resume_sessions where trading_account_id=$1', [ids.member])).state, 'REQUESTED');
});

test('D3 admin REDUCE_ONLY on a paused member keeps them paused (no VALIDATED_RESUME_REQUIRED error)', async () => {
  await asMember();
  await db.query("select public.set_my_copy_pause('HOLD')");
  await asAdmin();
  await db.query("select public.set_member_copy_control($1,'REDUCE_ONLY','QA')", [ids.user]);
  const p = await one('select copy_paused,reduce_only,admin_reduce_only from public.profiles where id=$1', [ids.user]);
  assert.deepEqual([p.copy_paused, p.reduce_only, p.admin_reduce_only], [true, true, true]);
});

test('D3 risk reduce-only is unchanged: the member RESUME on an ACTIVE session still lifts it', async () => {
  await db.query("update public.profiles set reduce_only=true where id=$1", [ids.user]);
  await asMember();
  await db.query("select public.set_my_copy_pause('RESUME')");
  assert.equal((await one('select reduce_only from public.profiles where id=$1', [ids.user])).reduce_only, false);
});
