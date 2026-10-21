import test, { before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createVerifiedDatabase, seedVerifiedAccount, cyclePayload, record, ids } from './fixtures/verified-runtime.js';

// QA 2026-10-21 D5/D6 (20261021033000_qa_risk_basis.sql): peak/day-start on the sizing equity basis with a basis
// marker, never compared across bases; unified-member policy flag.
let db;
const one = async (q, p) => (await db.query(q, p)).rows[0];
const worker = () => db.query("select set_config('request.jwt.claim.role','service_role',false)");
before(async () => { db = await createVerifiedDatabase(); });
after(async () => { await db?.close(); });
beforeEach(async () => { await db.exec('begin'); await seedVerifiedAccount(db); });
afterEach(async () => { await db.exec('rollback'); });

// Classic futures member: Gate `total` (wallet) 1000 with an open loss.
const classic = (unrealisedPnl, total = 1000) => ({ total, available: 500, unrealisedPnl, equityIncludesUnrealised: false });
const stored = () => one(`select total_equity::numeric total, risk_equity_adjustment::numeric adj, risk_basis,
  peak_equity::numeric peak, day_start_equity::numeric ds from private.copy_current_accounts where trading_account_id=$1`, [ids.member]);
const riskContext = async () => { await worker(); return (await one('select public.get_copy_risk_context() v')).v; };

test('peak and day-start follow wallet + unrealised PnL; total_equity keeps the Gate wallet value', async () => {
  await record(db, cyclePayload({ masterSize: 0, member: classic(-400) }));
  let row = await stored();
  assert.deepEqual([Number(row.total), Number(row.adj), row.risk_basis, Number(row.peak), Number(row.ds)], [1000, -400, 'MTM_V1', 600, 600]);
  await record(db, cyclePayload({ masterSize: 0, member: classic(-100) }));
  assert.equal(Number((await stored()).peak), 900, 'a recovery of the open loss raises the peak');
  await record(db, cyclePayload({ masterSize: 0, member: classic(-400) }));
  row = await stored();
  assert.equal(Number(row.peak), 900, 'a new open loss is a drawdown from it');
  await worker();
  const member = (await one('select public.get_copy_worker_context() v')).v.members[0];
  assert.equal(Number(member.peak_equity), 900);
  assert.equal(Number(member.day_start_equity), 600);
  assert.equal((await riskContext()).accounts[0].risk_basis, 'MTM_V1');
});

test('a row stored on the old wallet basis is restarted, never compared, when the first risk-basis observation arrives', async () => {
  // An older worker (no risk_equity in the payload): wallet basis, peak 1000.
  const legacy = cyclePayload({ masterSize: 0, member: classic(-400) });
  for (const account of legacy.current_state.members) { delete account.risk_equity; delete account.risk_basis; }
  await record(db, legacy);
  let row = await stored();
  assert.deepEqual([row.risk_basis, Number(row.peak), row.adj], ['WALLET_V0', 1000, null]);
  assert.equal((await riskContext()).accounts[0].risk_basis, 'WALLET_V0', 'the worker skips the risk decision for it');
  await record(db, cyclePayload({ masterSize: 0, member: classic(-400) }));
  row = await stored();
  assert.deepEqual([row.risk_basis, Number(row.peak), Number(row.ds)], ['MTM_V1', 600, 600], 'restarted at 600, no 40% drawdown');
  // A row whose basis is still unknown (pre-migration rows have null) behaves the same.
  await db.query('update private.copy_current_accounts set risk_basis=null where trading_account_id=$1', [ids.member]);
  await record(db, cyclePayload({ masterSize: 0, member: classic(-500) }));
  assert.deepEqual([(await stored()).risk_basis, Number((await stored()).peak)], ['MTM_V1', 500]);
});

test('operation-period risk: a new operation start (raw wallet value) is restarted on the risk basis by the next observation', async () => {
  await record(db, cyclePayload({ masterSize: 0, member: classic(-400) }));
  const operationId = randomUUID();
  await db.query(`insert into private.copy_operation_history(id,trading_account_id,user_id,requested_by,reason,start_equity,
    source_observed_at,previous_risk,settings,resume_version,receipt) values($1,$2,$3,$3,'QA',1000,now(),'{}','{}',$4,'{}')`,
  [operationId, ids.member, ids.user, ids.version]);
  await db.query(`insert into private.copy_operation_risk(trading_account_id,operation_id,equity_day,day_start_equity,peak_equity,observed_at,risk_basis)
    values($1,$2,(now() at time zone 'Asia/Seoul')::date,1000,1000,now()-interval '1 minute','MTM_V1')`, [ids.member, operationId]);
  let risk = await one('select peak_equity::numeric peak, risk_basis from private.copy_operation_risk where trading_account_id=$1', [ids.member]);
  assert.deepEqual([Number(risk.peak), risk.risk_basis], [1000, null], 'insert marks the basis unknown');
  assert.equal((await riskContext()).accounts[0].risk_basis, null);
  await record(db, cyclePayload({ masterSize: 0, member: classic(-400) }));
  risk = await one('select peak_equity::numeric peak, day_start_equity::numeric ds, risk_basis from private.copy_operation_risk where trading_account_id=$1', [ids.member]);
  assert.deepEqual([Number(risk.peak), Number(risk.ds), risk.risk_basis], [600, 600, 'MTM_V1']);
  await record(db, cyclePayload({ masterSize: 0, member: classic(0) }));
  assert.equal(Number((await one('select peak_equity::numeric peak from private.copy_operation_risk')).peak), 1000);
});

test('RESUME baseline reset uses the risk basis', async () => {
  await record(db, cyclePayload({ masterSize: 0, member: classic(-400) }));
  await db.query('update private.copy_current_accounts set peak_equity=5000,day_start_equity=5000 where trading_account_id=$1', [ids.member]);
  assert.equal(Number((await one('select private.reset_copy_risk_baseline($1) v', [ids.member])).v), 600);
  assert.equal(Number((await stored()).peak), 600);
});

test('unified members are refused by default; the operator flag is reported to the worker only', async () => {
  assert.equal((await riskContext()).allow_unified_members, false);
  await db.query('update public.copy_system_control set allow_unified_members=true');
  assert.equal((await riskContext()).allow_unified_members, true);
  assert.equal((await riskContext()).risk_basis, 'MTM_V1');
  await db.query("select set_config('request.jwt.claim.role','authenticated',false)");
  await db.exec('savepoint denied');
  await assert.rejects(() => db.query('select public.get_copy_risk_context()'));
  await db.exec('rollback to denied');
});
