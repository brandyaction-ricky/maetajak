import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const migration = readFileSync(new URL('../supabase/migrations/20260909065335_lock_targets_to_master_size_changes.sql', import.meta.url), 'utf8');

test('target anchors are private and only worker RPCs can read or write them', () => {
  assert.match(migration, /create table private\.copy_target_anchors/i);
  assert.match(migration, /alter table private\.copy_target_anchors enable row level security/i);
  assert.match(migration, /revoke all on private\.copy_target_anchors from public, anon, authenticated/i);
  assert.match(migration, /private\.require_copy_worker_role\(\)/i);
  assert.match(migration, /revoke all on function public\.get_copy_target_anchors\(\) from public, anon, authenticated/i);
  assert.match(migration, /grant execute on function public\.get_copy_target_anchors\(\) to service_role/i);
});

test('cycle state, intent, and target anchor are committed through one atomic wrapper', () => {
  assert.match(migration, /cycle_id := public\.record_copy_worker_cycle\(p_payload\)/i);
  assert.match(migration, /insert into private\.copy_target_anchors/i);
  assert.match(migration, /on conflict \(trading_account_id, contract, position_side\) do update/i);
  assert.match(migration, /excluded\.observed_at > private\.copy_target_anchors\.observed_at/i);
  assert.match(migration, /revoke all on function public\.record_copy_worker_cycle_with_target_anchors\(jsonb\)[\s\S]*from public, anon, authenticated/i);
});
