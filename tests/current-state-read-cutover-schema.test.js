import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const migration = readFileSync(
  new URL('../supabase/migrations/202609040002_current_state_read_cutover.sql', import.meta.url),
  'utf8',
);

test('live member, admin, operations, and public reads use Current State', () => {
  for (const functionName of [
    'get_my_live_trading_data',
    'get_admin_live_trading_data',
    'get_admin_operations_metrics',
    'get_public_master_positions',
  ]) {
    assert.match(migration, new RegExp(`create or replace function public\\.${functionName}\\(`, 'i'));
  }
  assert.match(migration, /private\.copy_current_accounts/i);
  assert.match(migration, /private\.copy_current_positions/i);
  assert.doesNotMatch(migration, /private\.copy_account_snapshots/i);
  assert.doesNotMatch(migration, /private\.copy_position_snapshots/i);
});

test('current read APIs preserve existing access boundaries', () => {
  assert.match(migration, /if auth\.uid\(\) is null then raise exception 'AUTH_REQUIRED'/i);
  assert.match(migration, /if not public\.is_approved_admin\(\) then raise exception 'ADMIN_REQUIRED'/i);
  assert.match(migration, /grant execute on function public\.get_public_master_positions\(\) to anon, authenticated/i);
});
