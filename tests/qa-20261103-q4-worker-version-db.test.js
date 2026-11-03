import test, { before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createVerifiedDatabase, seedVerifiedAccount, cyclePayload, record, ids } from './fixtures/verified-runtime.js';

// 2026-11-03 pre-go-live QA Q4: deploys write WORKER_VERSION=<package.json version>+<git short SHA>. The order gates
// compared the heartbeat version with the literal '0.5.0'; 20261103020000 lets the 0.6.0 build (and 0.5.0) order.
const migration = readFileSync('supabase/migrations/20261103020000_worker_build_version_gate.sql', 'utf8');
let db;
const one = async (q, params = []) => (await db.query(q, params)).rows[0];
const def = async (sig) => (await one('select pg_get_functiondef($1::regprocedure) d', [sig])).d;
before(async () => { db = await createVerifiedDatabase(); });
after(async () => { await db?.close(); });
beforeEach(async () => { await db.exec('begin'); await seedVerifiedAccount(db); });
afterEach(async () => { await db.exec('rollback'); });

test('Q4: supported worker builds are 0.5.0 and 0.6.0[+build]; anything else is refused', async () => {
  const supported = async (v) => (await one('select private.copy_worker_version_supported($1) ok', [v])).ok;
  for (const v of ['0.5.0', '0.6.0', '0.6.0+7026ad2ce098', '0.6.0+nogit', `0.6.0+${'a'.repeat(60)}`]) assert.equal(await supported(v), true, v);
  for (const v of [null, '', 'dev', '0.4.0', '0.5.0+abc', '0.6.0+', '0.6.1', '0.6.0 ', 'x0.6.0', '0.6.0+a b', `0.6.0+${'a'.repeat(61)}`]) {
    assert.equal(await supported(v), false, String(v));
  }
});

test('Q4: exactly the version comparison changed in both gates; re-applying is a no-op; safety version advertises the gate', async () => {
  for (const sig of ['public.claim_copy_order_intents(integer)', 'public.authorize_copy_order_submission(uuid,uuid)']) {
    const body = await def(sig);
    assert.equal(body.split('private.copy_worker_version_supported(r.worker_version)').length - 1, 1, sig);
    assert.doesNotMatch(body, /worker_version\s*=\s*'0\.5\.0'/, sig);
  }
  const before = [await def('public.claim_copy_order_intents(integer)'), await def('public.authorize_copy_order_submission(uuid,uuid)')];
  await db.exec(migration);
  assert.deepEqual([await def('public.claim_copy_order_intents(integer)'), await def('public.authorize_copy_order_submission(uuid,uuid)')], before);
  const version = (await one('select public.get_copy_safety_version() v')).v;
  assert.deepEqual(version, { schema_version: 3, worker_version: '0.5.0', resume_requires_validation: true, current_state_atomic: true,
    trade_alert_exchange_verification: true, reliability_patch: 1, member_own_position_absorption: 1, worker_build_version_gate: 1 });
  assert.doesNotMatch(migration.replace(/^--.*$/gm, ''), /\b(drop|delete|truncate|alter table|update|insert)\b/i);
});

for (const [workerVersion, claims] of [['0.6.0+7026ad2ce098', true], ['0.6.0+nogit', true], ['0.5.0', true], ['0.4.0', false], ['dev', false]]) {
  test(`Q4: a LIVE worker reporting ${workerVersion} ${claims ? 'claims and authorizes' : 'cannot claim'}`, async () => {
    await db.query('update private.copy_worker_runtime set worker_version=$1', [workerVersion]);
    await record(db, cyclePayload());
    const jobs = (await db.query('select * from public.claim_copy_order_intents(10)')).rows;
    assert.equal(jobs.length, claims ? 1 : 0);
    if (!claims) return;
    assert.equal((await one('select public.authorize_copy_order_submission($1,$2) ok', [jobs[0].intent_id, ids.version])).ok, true);
  });
}
