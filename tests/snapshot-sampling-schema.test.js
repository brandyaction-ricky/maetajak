import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const migration = readFileSync(
  new URL('../supabase/migrations/202609040003_snapshot_sampling.sql', import.meta.url),
  'utf8',
);

test('snapshot checkpoints bound account and position history writes', () => {
  assert.match(migration, /create table if not exists private\.copy_snapshot_checkpoints/i);
  assert.match(migration, /observed_at - interval '1 minute'/i);
  assert.match(migration, /position_changed := previous_position_structure_hash is distinct from position_structure_hash/i);
  assert.match(migration, /if account_sample_due or position_changed then/i);
  assert.match(migration, /if position_changed then[\s\S]*insert into private\.copy_position_snapshots/i);
});

test('sampling keeps all authoritative order and state writes', () => {
  assert.match(migration, /insert into public\.copy_position_states/i);
  assert.match(migration, /insert into private\.copy_order_intents/i);
  assert.match(migration, /insert into public\.copy_events/i);
  assert.match(migration, /on conflict \(idempotency_key\) do nothing/i);
  assert.match(migration, /on conflict \(trading_account_id, contract, position_side\) do update/i);
  assert.match(migration, /gate_order_text, status, position_side, target_leverage/i);
  assert.match(migration, /observed_at, position_side/i);
});

test('sampling RPC remains service-role only', () => {
  assert.match(migration, /set search_path = public, extensions, pg_temp/i);
  assert.match(migration, /if auth\.role\(\) <> 'service_role'/i);
  assert.match(migration, /revoke all on function public\.record_copy_worker_cycle\(jsonb\) from public, anon, authenticated/i);
  assert.match(migration, /grant execute on function public\.record_copy_worker_cycle\(jsonb\) to service_role/i);
});
