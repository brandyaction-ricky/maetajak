import test, { before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createVerifiedDatabase, seedVerifiedAccount, cyclePayload, record, ids, observedAccount, contracts } from './fixtures/verified-runtime.js';
import { TradingRunner } from '../worker/trading-runner.js';

let db;
const admin = '30000000-0000-4000-8000-000000000001';
const one = async (sql, args = []) => (await db.query(sql, args)).rows[0];
const actor = async (id = admin, role = 'authenticated') => {
  await db.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claim.role',$2,false)", [id, role]);
};
const preview = async () => (await one('select public.get_member_new_operation_preview($1) value', [ids.user])).value;
const invoke = async (p, request = randomUUID(), overrides = {}) => {
  const args = { user: ids.user, request, equity: p.equity, observed: p.observed_at,
    fingerprint: p.fingerprint, confirmation: `NEW_OPERATION:${p.member_email}`, reason: 'TEST_ONLY operator starts a new period', ...overrides };
  return (await one('select public.start_member_new_operation($1,$2,$3,$4,$5,$6,$7) value', Object.values(args))).value;
};
const count = async (table) => Number((await one(`select count(*) n from ${table}`)).n);

before(async () => {
  db = await createVerifiedDatabase();
  const auth = readFileSync('supabase/migrations/202608200001_auth_profiles.sql', 'utf8');
  const start = auth.indexOf('create or replace function public.is_approved_admin()');
  await db.exec(auth.slice(start, auth.indexOf('revoke all on function public.is_approved_admin()', start)));
});
after(async () => { await db?.close(); });
beforeEach(async () => {
  await db.exec('begin');
  await seedVerifiedAccount(db);
  await db.query("insert into public.profiles(id,email,role,approval_status) values($1,'admin@example.invalid','ADMIN','APPROVED')", [admin]);
  await record(db, cyclePayload({ masterSize: 0, member: { total: 1500, available: 1500, copy_paused: true } }));
  await db.query('update private.copy_current_accounts set peak_equity=6000,day_start_equity=6000 where trading_account_id=$1', [ids.member]);
  await db.query('update public.profiles set copy_paused=true,daily_loss_limit_pct=10,max_drawdown_pct=20 where id=$1', [ids.user]);
  await actor();
});
afterEach(async () => { await db.exec('rollback'); });

test('migration and read-only preview create no operation, resume or account reset', async () => {
  const p = await preview();
  assert.equal(p.eligible, true);
  assert.equal(p.previous_peak_equity, 6000);
  assert.equal(p.equity, 1500);
  assert.equal(await count('private.copy_operation_history'), 0);
  assert.equal(await count('private.copy_operation_risk'), 0);
  const session = await one('select state,sync_current_master from private.copy_resume_sessions where trading_account_id=$1', [ids.member]);
  assert.equal(session.state, 'PAUSED');
  assert.equal(session.sync_current_master, false);
});

test('explicit admin action records a separate risk period and stays paused for validation', async () => {
  const receipt = await invoke(await preview());
  assert.equal(receipt.state, 'REQUESTED');
  assert.equal(receipt.copy_paused, true);
  const history = await one('select * from private.copy_operation_history');
  assert.equal(history.requested_by, admin);
  assert.equal(Number(history.start_equity), 1500);
  assert.equal(history.previous_risk.peak_equity, 6000);
  const current = await one('select * from private.copy_operation_risk');
  assert.equal(Number(current.peak_equity), 1500);
  assert.equal(Number(current.day_start_equity), 1500);
  const raw = await one('select peak_equity,day_start_equity from private.copy_current_accounts where trading_account_id=$1', [ids.member]);
  assert.equal(Number(raw.peak_equity), 6000);
  assert.equal(Number(raw.day_start_equity), 6000);
  const p = await one('select copy_paused,member_halted,max_drawdown_pct,daily_loss_limit_pct from public.profiles where id=$1', [ids.user]);
  assert.equal(p.copy_paused, true);
  assert.equal(Number(p.max_drawdown_pct), 20);
  assert.equal(Number(p.daily_loss_limit_pct), 10);
  assert.equal(await count('private.copy_order_intents'), 0);
  assert.equal((await one("select count(*) n from public.admin_audit_logs where action='MEMBER_NEW_OPERATION_STARTED'")).n, 1);
});

test('duplicate request returns original receipt without another reset or audit event', async () => {
  const p = await preview(); const request = randomUUID();
  const original = await invoke(p, request);
  await db.query('update private.copy_operation_risk set peak_equity=1800 where trading_account_id=$1', [ids.member]);
  const replay = await invoke(p, request);
  assert.equal(replay.operation_id, original.operation_id);
  assert.equal(replay.replayed, true);
  assert.equal(await count('private.copy_operation_history'), 1);
  assert.equal(Number((await one('select peak_equity from private.copy_operation_risk')).peak_equity), 1800);
});

test('another operator cannot reuse the same request identifier', async () => {
  const p = await preview(); const request = randomUUID(); await invoke(p, request);
  const other = randomUUID();
  await db.query("insert into public.profiles(id,email,role,approval_status) values($1,'other-admin@example.invalid','ADMIN','APPROVED')", [other]);
  await actor(other);
  await assert.rejects(() => invoke(p, request), /REQUEST_ID_REUSED/);
});

for (const [label, id, role] of [['anonymous', '', 'anon'], ['member', ids.user, 'authenticated'], ['worker', '', 'service_role']]) {
  test(`${label} cannot preview or start a new operation`, async () => {
    const p = await preview(); await actor(id, role);
    await assert.rejects(() => invoke(p), /ADMIN_REQUIRED/);
  });
}
test('anonymous role cannot execute entrypoints and authenticated cannot access private tables', async () => {
  for (const fn of ['get_member_new_operation_preview(uuid)', 'start_member_new_operation(uuid,uuid,numeric,timestamptz,text,text,text)']) {
    assert.equal((await one("select has_function_privilege('anon',$1,'execute') allowed", [`public.${fn}`])).allowed, false);
    assert.equal((await one("select has_function_privilege('authenticated',$1,'execute') allowed", [`public.${fn}`])).allowed, true);
  }
  for (const table of ['copy_operation_history', 'copy_operation_risk']) {
    assert.equal((await one("select has_table_privilege('authenticated',$1,'select,insert,update,delete') allowed", [`private.${table}`])).allowed, false);
    assert.equal((await one('select relrowsecurity enabled from pg_class where oid=$1::regclass', [`private.${table}`])).enabled, true);
  }
});

for (const [label, overrides, expected] of [
  ['missing consent', { confirmation: '' }, 'CONFIRMATION_REQUIRED'],
  ['wrong member consent', { confirmation: 'NEW_OPERATION:other@example.invalid' }, 'CONFIRMATION_REQUIRED'],
  ['empty reason', { reason: ' ' }, 'REASON_REQUIRED'],
  ['different equity', { equity: 1 }, 'PREVIEW_CHANGED'],
  ['changed fingerprint', { fingerprint: 'wrong' }, 'PREVIEW_CHANGED'],
  ['expired preview', { observed: '2000-01-01T00:00:00Z' }, 'PREVIEW_CHANGED'],
]) test(`${label} fails without changing operation state`, async () => {
  const p = await preview();
  await assert.rejects(() => invoke(p, randomUUID(), overrides), new RegExp(expected));
});

test('settings changed after preview require a fresh review', async () => {
  const p = await preview();
  await db.query('update public.profiles set copy_ratio=130 where id=$1', [ids.user]);
  await assert.rejects(() => invoke(p), /PREVIEW_CHANGED/);
});
test('admin has time to review a fresh account snapshot before confirming', async () => {
  const p = await preview();
  const reviewedAt = new Date(new Date(p.observed_at).getTime() - 90_000).toISOString();
  const receipt = await invoke(p, randomUUID(), { observed: reviewedAt });
  assert.equal(receipt.state, 'REQUESTED');
  assert.equal(await count('private.copy_operation_history'), 1);
});
test('an active unpaused member cannot reset risk via this action', async () => {
  await db.query("update private.copy_resume_sessions set state='ACTIVE' where trading_account_id=$1", [ids.member]);
  await db.query('update public.profiles set copy_paused=false where id=$1', [ids.user]);
  const p = await preview();
  assert.ok(p.blockers.includes('MEMBER_NOT_ELIGIBLE'));
  await assert.rejects(() => invoke(p), /MEMBER_NOT_ELIGIBLE/);
});
test('open positions block new operations', async () => {
  await db.query('update private.copy_current_positions set size=1 where trading_account_id=$1', [ids.member]);
  // Flat fixture has no position rows, so add one explicitly when necessary.
  await db.query("insert into private.copy_current_positions(trading_account_id,user_id,account_role,contract,position_side,size,source_hash,observed_at) values($1,$2,'MEMBER','BTC_USDT','LONG',1,'TEST_ONLY',clock_timestamp()) on conflict do nothing", [ids.member, ids.user]);
  const p = await preview(); assert.ok(p.blockers.includes('OPEN_POSITIONS'));
  await assert.rejects(() => invoke(p), /OPEN_POSITIONS/);
});
test('missing verification is not accepted as an empty account', async () => {
  await db.query('delete from private.copy_current_verifications where trading_account_id=$1', [ids.member]);
  const p = await preview(); assert.ok(p.blockers.includes('ACCOUNT_NOT_VERIFIED'));
  await assert.rejects(() => invoke(p), /ACCOUNT_NOT_VERIFIED/);
});

test('Worker context reads new risk basis and subsequent genuine losses still halt', async () => {
  await invoke(await preview());
  await actor('', 'service_role');
  const ctx = (await one('select public.get_copy_worker_context() value')).value.members.find((m) => m.user_id === ids.user);
  assert.equal(ctx.peak_equity, 1500);
  assert.equal(ctx.day_start_equity, 1500);
  let equity = 1500;
  const runner = new TradingRunner({ supabase: {}, baseUrl: 'https://api.gateio.ws', mode: 'DRY_RUN', fetchImpl: async (url, req) => {
    assert.equal(req.method, 'GET');
    return new Response(new URL(url).pathname.endsWith('/accounts')
      ? JSON.stringify({ user: 123, total: String(equity), available: String(equity), unrealised_pnl: '0', in_dual_mode: false }) : '[]');
  } });
  const resumed = await runner.readAccount(ctx);
  assert.equal(resumed.risk_halt_reason, null);
  equity = 1300;
  assert.equal((await runner.readAccount(ctx)).risk_halt_reason, 'DAILY_LOSS_LIMIT');
  equity = 1100;
  const drawdownOnly = { ...ctx, daily_loss_limit_pct: 100 };
  assert.equal((await runner.readAccount(drawdownOnly)).risk_halt_reason, 'MAX_DRAWDOWN_LIMIT');
});

test('period peak advances without rewriting historical start or raw account peak', async () => {
  await invoke(await preview());
  await db.query("update private.copy_current_accounts set total_equity=1800,observed_at=observed_at+interval '1 second' where trading_account_id=$1", [ids.member]);
  assert.equal(Number((await one('select peak_equity from private.copy_operation_risk')).peak_equity), 1800);
  assert.equal(Number((await one('select start_equity from private.copy_operation_history')).start_equity), 1500);
  await db.query("update private.copy_current_accounts set total_equity=1600,observed_at=observed_at+interval '1 second' where trading_account_id=$1", [ids.member]);
  assert.equal(Number((await one('select peak_equity from private.copy_operation_risk')).peak_equity), 1800);
});

test('ordinary resume never creates a new operation or resets existing history', async () => {
  await db.query("select public.set_member_copy_control($1,'RESUME','TEST_ONLY')", [ids.user]);
  assert.equal(await count('private.copy_operation_history'), 0);
  assert.equal(await count('private.copy_operation_risk'), 0);
  assert.equal(Number((await one('select peak_equity from private.copy_current_accounts where trading_account_id=$1', [ids.member])).peak_equity), 6000);
});

test('stale snapshots and failed preview leave no partial operation record', async () => {
  const p = await preview();
  await db.exec('savepoint attempted_start');
  await assert.rejects(() => invoke(p, randomUUID(), { equity: 999 }), /PREVIEW_CHANGED/);
  await db.exec('rollback to attempted_start');
  assert.equal(await count('private.copy_operation_history'), 0);
  assert.equal(await count('private.copy_operation_risk'), 0);
  await db.query("update private.copy_current_accounts set observed_at=clock_timestamp()-interval '3 minutes' where trading_account_id=$1", [ids.member]);
  assert.ok((await preview()).blockers.includes('ACCOUNT_SNAPSHOT_STALE'));
});

test('a second distinct request cannot reset a pending new operation', async () => {
  await invoke(await preview());
  const p = await preview(); assert.ok(p.blockers.includes('NEW_OPERATION_PENDING'));
  await assert.rejects(() => invoke(p), /NEW_OPERATION_PENDING/);
});

test('unknown exchange submissions continue to block a new operation', async () => {
  await db.query("insert into private.copy_order_intents(cycle_id,user_id,trading_account_id,contract,target_size,actual_size_at_plan,delta_size,reduce_only,idempotency_key,gate_order_text,status,submit_attempts) values($1,$2,$3,'BTC_USDT',1,0,1,false,$4,'t-TEST_ONLY','UNKNOWN',1)", [randomUUID(),ids.user,ids.member,randomUUID()]);
  const p = await preview(); assert.ok(p.blockers.includes('UNRESOLVED_ORDERS'));
  await assert.rejects(() => invoke(p), /UNRESOLVED_ORDERS/);
});

test('new day resets only the period day baseline and older observations cannot lower its peak', async () => {
  await invoke(await preview());
  const day = (await one('select equity_day from private.copy_operation_risk')).equity_day;
  await db.query("update private.copy_current_accounts set total_equity=1800,observed_at=observed_at+interval '1 day' where trading_account_id=$1", [ids.member]);
  const r = await one('select * from private.copy_operation_risk');
  assert.notEqual(r.equity_day, day); assert.equal(Number(r.day_start_equity),1800);
  await db.query("update private.copy_current_accounts set total_equity=9000,observed_at=observed_at-interval '2 days' where trading_account_id=$1", [ids.member]);
  assert.equal(Number((await one('select peak_equity from private.copy_operation_risk')).peak_equity),1800);
});

test('existing Worker validates the new period twice before activation, with no exchange writes', async () => {
  await invoke(await preview());
  await actor('', 'service_role');
  const member = (await one('select public.get_copy_worker_context() value')).value.members.find((m) => m.user_id===ids.user);
  const session = (await one('select public.get_copy_resume_context() value')).value.find((s) => s.trading_account_id===ids.member);
  const calls = [];
  const runner = new TradingRunner({ supabase: {}, mode:'LIVE', baseUrl:'https://api.gateio.ws', fetchImpl: async (url,req) => {
    assert.equal(req.method,'GET'); calls.push(new URL(url).pathname);
    return new Response(new URL(url).pathname.endsWith('/accounts')
      ? JSON.stringify({ user:123,total:'1500',available:'1500',unrealised_pnl:'0',in_dual_mode:false }) : '[]');
  } });
  const read = runner.readAccount.bind(runner);
  runner.readAccount = async (a) => a.trading_account_id===ids.master
    ? observedAccount({ ...a,total:10000,positionMode:'single',positions:[] }) : read(a);
  runner.rpc = async (name, params) => {
    assert.match(name,/^[a-z_]+$/);
    const keys = Object.keys(params); const sqlArgs = keys.map((key,i)=>`${key}=>$${i+1}`).join(',');
    return (await one(`select public.${name}(${sqlArgs}) value`,Object.values(params))).value;
  };
  const result = await runner.processMemberResume({ session,memberContext:member,
    masterContext:{ trading_account_id:ids.master,api_key:'TEST_ONLY',secret_key:'TEST_ONLY' },
    contracts,system:{execution_enabled:true,emergency_halted:false} });
  assert.equal(result.activated,true);
  assert.equal((await one('select copy_paused from public.profiles where id=$1',[ids.user])).copy_paused,false);
  assert.equal(calls.filter((p)=>p.endsWith('/accounts')).length,2);
  assert.equal(await count('private.copy_order_intents'),0);
});

test('new-operation and ordinary resume generations both request a current-Master reconciliation', async () => {
  await invoke(await preview());
  await actor('', 'service_role');
  let session = (await one('select public.get_copy_resume_context() value')).value
    .find((item) => item.trading_account_id === ids.member);
  assert.equal(session.sync_current_master, true);

  await actor();
  await db.query("update private.copy_resume_sessions set state='PAUSED' where trading_account_id=$1", [ids.member]);
  await db.query("select public.set_member_copy_control($1,'RESUME','TEST_ONLY ordinary resume')", [ids.user]);
  await actor('', 'service_role');
  session = (await one('select public.get_copy_resume_context() value')).value
    .find((item) => item.trading_account_id === ids.member);
  assert.equal(session.sync_current_master, true);
});

test('resume context exposes net platform fills and blocks unconfirmed fill attribution', async () => {
  const cycle = (await one('select id from private.copy_cycles order by started_at desc limit 1')).id;
  const intent = randomUUID();
  await db.query(`insert into private.copy_order_intents(
    id,cycle_id,user_id,trading_account_id,contract,position_side,target_size,actual_size_at_plan,
    delta_size,reduce_only,idempotency_key,gate_order_text,status,filled_size,submit_attempts,
    exchange_terminal,resume_version,source_observed_at,resolved_at,observation_confirmed_at
  ) values($1,$2,$3,$4,'BTC_USDT','LONG',5,0,5,false,$5,$6,'FILLED',5,1,true,$7,
    clock_timestamp(),clock_timestamp(),clock_timestamp())`, [
    intent, cycle, ids.user, ids.member, randomUUID(), `t-mtj-${randomUUID()}`, ids.version,
  ]);
  await db.query("select public.set_member_copy_control($1,'RESUME','TEST_ONLY attribution resume')", [ids.user]);
  await actor('', 'service_role');
  let session = (await one('select public.get_copy_resume_context() value')).value
    .find((item) => item.trading_account_id === ids.member);
  assert.deepEqual(session.platform_positions, [{ contract: 'BTC_USDT', position_side: 'LONG', size: 5 }]);
  assert.equal(Number(session.unresolved_orders), 0);

  await db.query('update private.copy_order_intents set observation_confirmed_at=null where id=$1', [intent]);
  session = (await one('select public.get_copy_resume_context() value')).value
    .find((item) => item.trading_account_id === ids.member);
  assert.equal(Number(session.unresolved_orders), 1);
});
