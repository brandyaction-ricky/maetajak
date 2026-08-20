import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const migration = readFileSync(
  new URL('../supabase/migrations/202608210001_copy_trading_core.sql', import.meta.url),
  'utf8',
);

test('copy schema contains the required operational states', () => {
  for (const state of ['SYNCED', 'DRIFT', 'MANUAL_OVERRIDE', 'PAUSED', 'REDUCE_ONLY', 'ERROR', 'HALTED']) {
    assert.match(migration, new RegExp(`'${state}'`));
  }
});

test('live execution is fail-closed and cannot be enabled from browser RPC', () => {
  assert.match(migration, /execution_enabled boolean not null default false/);
  assert.match(migration, /emergency_halted boolean not null default true/);
  assert.match(migration, /if p_execution_enabled then raise exception 'DEPLOYMENT_APPROVAL_REQUIRED'/);
  assert.match(migration, /current_setting\('request\.jwt\.claim\.role'/);
});

test('order intents enforce idempotency and UNKNOWN reconciliation', () => {
  assert.match(migration, /idempotency_key text not null unique/);
  assert.match(migration, /gate_order_text text not null unique/);
  assert.match(migration, /'UNKNOWN'/);
  assert.match(migration, /create table if not exists private\.copy_reconciliation_jobs/);
});

test('private trading data is not granted to browser roles', () => {
  for (const table of [
    'trading_accounts', 'copy_account_snapshots', 'copy_position_snapshots',
    'copy_cycles', 'copy_order_intents', 'copy_order_attempts', 'copy_reconciliation_jobs',
  ]) {
    assert.match(migration, new RegExp(`revoke all on private\\.${table} from public, anon, authenticated`));
  }
});
