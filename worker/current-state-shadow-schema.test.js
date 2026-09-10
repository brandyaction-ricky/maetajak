import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const migration = readFileSync(new URL('../supabase/migrations/202609030001_current_state_shadow.sql', import.meta.url), 'utf8');
const runner = readFileSync(new URL('./trading-runner.js', import.meta.url), 'utf8');
const worker = readFileSync(new URL('./index.js', import.meta.url), 'utf8');
const deployment = readFileSync(new URL('../deploy/lightsail-auto-deploy.sh', import.meta.url), 'utf8');

test('phase-one current state is bounded by account and hedge leg', () => {
  assert.match(migration, /copy_current_accounts[\s\S]*trading_account_id uuid primary key/i);
  assert.match(migration, /primary key \(trading_account_id, contract, position_side\)/i);
  assert.match(migration, /on conflict \(trading_account_id\) do update/i);
  assert.match(migration, /on conflict \(trading_account_id, contract, position_side\) do update/i);
  assert.match(migration, /delete from private\.copy_current_positions/i);
});

test('shadow projection is service-role only and leaves authoritative tables untouched', () => {
  assert.match(migration, /SERVICE_ROLE_REQUIRED/);
  assert.match(migration, /revoke all on function public\.upsert_copy_current_state\(jsonb\) from public, anon, authenticated/i);
  assert.doesNotMatch(migration, /(insert into|update|delete from) private\.copy_(account_snapshots|position_snapshots|cycles|order_intents|order_attempts)/i);
  assert.doesNotMatch(migration, /(insert into|update|delete from) public\.copy_position_states/i);
});

test('verified state commits before order work and propagates write failures', () => {
  assert.match(runner, /await this\.rpc\('record_verified_copy_worker_cycle'/);
  const syncIndex = worker.indexOf('await runner.syncOnce()');
  const reconcileIndex = worker.indexOf('await runner.reconcileOrders()');
  const submitIndex = worker.indexOf('await runner.submitOrders()');
  const reportIndex = worker.indexOf('await runner.reportCycle(true)');
  assert.ok(syncIndex > 0 && reconcileIndex > syncIndex && submitIndex > reconcileIndex && reportIndex > submitIndex);
  assert.doesNotMatch(worker, /runner\.syncCurrentState/);
});

test('worker deployment is blocked until the shadow RPC exists', () => {
  assert.match(deployment, /\/rpc\/upsert_copy_current_state/);
});
