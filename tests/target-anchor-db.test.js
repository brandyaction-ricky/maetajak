import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const userId = '10000000-0000-4000-8000-000000000001';
const memberAccountId = '10000000-0000-4000-8000-000000000002';
const masterAccountId = '10000000-0000-4000-8000-000000000003';
const resumeVersion = '10000000-0000-4000-8000-000000000004';
const db = new PGlite();
after(async () => db.close());

test('target anchor persists atomically with the authoritative worker cycle', async () => {
  await db.exec(readFileSync('tests/fixtures/copy-runtime-schema.sql', 'utf8'));
  await db.exec('insert into public.copy_system_control default values');
  await db.exec(readFileSync('supabase/migrations/20260909011308_safe_member_resume.sql', 'utf8'));
  await db.exec(readFileSync('supabase/migrations/20260909065335_lock_targets_to_master_size_changes.sql', 'utf8'));
  await db.query("insert into public.profiles(id,email,approval_status) values($1,'anchor@example.invalid','APPROVED')", [userId]);
  await db.query("insert into private.trading_accounts(id,user_id,credential_user_id,account_role,status) values($1,$2,$2,'MEMBER','ACTIVE'),($3,null,null,'MASTER','ACTIVE')", [memberAccountId, userId, masterAccountId]);
  await db.query("insert into private.copy_resume_sessions(trading_account_id,version,state) values($1,$2,'ACTIVE')", [memberAccountId, resumeVersion]);
  await db.query("select set_config('request.jwt.claim.role','service_role',false)");

  const observedAt = new Date().toISOString();
  const cycleId = '10000000-0000-4000-8000-000000000005';
  const payload = {
    cycle_id: cycleId,
    source_version: 'target-anchor-test',
    observed_at: observedAt,
    master: {
      trading_account_id: masterAccountId,
      total: 10_000,
      available: 9_000,
      unrealisedPnl: 0,
      positions: [{ contract: 'BTC_USDT', positionSide: 'LONG', size: 100, markPrice: 50_000, quanto_multiplier: 0.001 }],
    },
    members: [{
      trading_account_id: memberAccountId,
      user_id: userId,
      resume_version: resumeVersion,
      copy_ratio: 100,
      max_position_ratio: 30,
      total: 5_000,
      available: 4_500,
      unrealisedPnl: 0,
      planned_positions: [{
        contract: 'BTC_USDT', position_side: 'LONG', state: 'SYNCED',
        size: 30, target_size: 30, delta_size: 0, mark_price: 50_000,
        entry_price: 50_000, leverage: 5, quanto_multiplier: 0.001,
        master_copyable_size: 100, member_baseline_size: 0,
        target_resume_version: resumeVersion,
        target_lock_reason: 'TARGET_ANCHOR_INITIALIZED',
      }],
    }],
  };

  const result = await db.query('select public.record_copy_worker_cycle_with_target_anchors($1) id', [payload]);
  assert.equal(result.rows[0].id, cycleId);
  const anchors = await db.query('select * from private.copy_target_anchors');
  assert.equal(anchors.rows.length, 1);
  assert.equal(Number(anchors.rows[0].master_copyable_size), 100);
  assert.equal(Number(anchors.rows[0].target_size), 30);
  assert.equal(anchors.rows[0].resume_version, resumeVersion);
  const states = await db.query('select target_size,actual_size from public.copy_position_states');
  assert.deepEqual(states.rows.map((row) => [Number(row.target_size), Number(row.actual_size)]), [[30, 30]]);
});
