import test, { before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createVerifiedDatabase, seedVerifiedAccount, cyclePayload, record, ids } from './fixtures/verified-runtime.js';
import { aggregateMemberPerformance } from '../worker/performance.js';

// Review 2026-10-21 (R1): fix/qa-risk D5 stores day_start_equity on the MTM basis (classic wallet + unrealised PnL)
// while fix/qa-admin D11 builds the daily opening equity from day_start_equity and the closing equity from the raw
// Gate wallet `total` (no unrealised PnL). For a classic account the two ends of the daily return are on different
// bases: an unchanged account with an open position reports a non-zero daily return.
// FIXED (review R1): the closing equity follows the basis of the opening (worker/performance.js closingEquityFor).
let db;
const one = async (q, p) => (await db.query(q, p)).rows[0];
before(async () => { db = await createVerifiedDatabase(); });
after(async () => { await db?.close(); });
beforeEach(async () => { await db.exec('begin'); await seedVerifiedAccount(db); });
afterEach(async () => { await db.exec('rollback'); });

// Classic futures member: wallet 1000 with an open unrealised loss of -400 that does not move all day.
const classic = { total: 1000, available: 500, unrealisedPnl: -400, equityIncludesUnrealised: false };

test('R1 basis check: day_start_equity reaching the worker is MTM (wallet + unrealised), not the wallet', async () => {
  await record(db, cyclePayload({ masterSize: 0, member: classic }));
  await db.query("select set_config('request.jwt.claim.role','service_role',false)");
  const member = (await one('select public.get_copy_worker_context() v')).v.members[0];
  assert.equal(Number(member.day_start_equity), 600, 'MTM basis: 1000 + (-400)');
});

test('R1 an account with no trade, no transfer and an unchanged open position has a 0 % daily return', async () => {
    await record(db, cyclePayload({ masterSize: 0, member: classic }));
    await db.query("select set_config('request.jwt.claim.role','service_role',false)");
    const context = (await one('select public.get_copy_worker_context() v')).v.members[0];
    // The worker performance sync passes the context member merged with the Gate summary (same shape as syncOnce).
    const { daily } = aggregateMemberPerformance({
      member: { ...context, ...classic, fund_flow_net: 0, fund_flow_net_after_sync: 0 },
      ledger: [], trades: [], observedAt: new Date().toISOString(),
    });
    // Today: opening 600 (MTM) vs closing 1000 (wallet) -> +66.7 % although nothing happened.
    assert.equal(daily.dailyReturnPct, 0, `opening=${daily.openingEquity} closing=${daily.closingEquity} return=${daily.dailyReturnPct}`);
  });
