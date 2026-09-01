import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const migration = readFileSync(new URL('../supabase/migrations/202609010001_admin_operations_metrics.sql', import.meta.url), 'utf8');
const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');

test('admin operations metrics are admin-only and sourced from actual worker ledgers', () => {
  assert.match(migration, /security definer/i);
  assert.match(migration, /public\.is_approved_admin\(\)/i);
  assert.match(migration, /private\.copy_account_snapshots/i);
  assert.match(migration, /public\.member_daily_performance/i);
  assert.match(migration, /sum\(performance\.trading_volume\)/i);
  assert.match(migration, /sum\(performance\.fees\)/i);
  assert.doesNotMatch(migration, /generate_series|random\(\)/i);
  assert.match(migration, /revoke all on function public\.get_admin_operations_metrics/i);
});

test('admin dashboard exposes real PNL, broker volume, fees, and member metrics', () => {
  assert.match(main, /get_admin_operations_metrics/);
  assert.match(main, /adminBrokerVolume/);
  assert.match(main, /adminBrokerFees/);
  assert.match(main, /adminTotalAssets/);
  assert.match(main, /adminPeriodPnl/);
  assert.match(main, /adminMembersCache/);
});
