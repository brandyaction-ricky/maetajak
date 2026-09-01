import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const migration = readFileSync(new URL('../supabase/migrations/202609010003_gate_broker_actual_metrics.sql', import.meta.url), 'utf8');
const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');

test('actual Gate broker metrics remain private and admin-only', () => {
  assert.match(migration, /private\.gate_broker_daily_metrics/i);
  assert.match(migration, /public\.is_approved_admin\(\)/i);
  assert.match(migration, /auth\.role\(\) <> 'service_role'/i);
  assert.match(migration, /GATE_BROKER_API/i);
  assert.doesNotMatch(migration, /member_daily_performance/i);
});

test('broker metrics storage remains available while its dashboard section is removed', () => {
  assert.doesNotMatch(main, /adminBrokerChart/);
  assert.doesNotMatch(main, /data-broker-range/);
  assert.doesNotMatch(main, /adminBrokerRange/);
  assert.doesNotMatch(main, /loadAdminBrokerMetrics/);
});
