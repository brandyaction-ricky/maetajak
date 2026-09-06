import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const migration = readFileSync(
  new URL('../supabase/migrations/202609060002_auto_halt_duplicate_orders.sql', import.meta.url),
  'utf8',
);
const worker = readFileSync(new URL('./index.js', import.meta.url), 'utf8');
const liveActivation = readFileSync(
  new URL('../deploy/lightsail-enable-live.sh', import.meta.url),
  'utf8',
);

test('repeated stale-position intents atomically halt live copying', () => {
  assert.match(migration, /actual_size_at_plan/);
  assert.match(migration, /sign\(intent\.delta_size\)/);
  assert.match(migration, /having count\(\*\) >= 2/);
  assert.match(migration, /execution_enabled = false/);
  assert.match(migration, /emergency_halted = true/);
  assert.match(migration, /halt_reason = 'DUPLICATE_ORDER_ANOMALY'/);
});

test('the anomaly detector is service-role only and exposes no credentials', () => {
  assert.match(migration, /SERVICE_ROLE_REQUIRED/);
  assert.match(migration, /revoke all on function public\.detect_and_halt_copy_order_anomaly\(\) from public, anon, authenticated/);
  assert.doesNotMatch(migration, /api_key|secret_key|decrypted_secret|pgp_sym_decrypt/);
});

test('the worker halts and alerts before claiming another order', () => {
  const detectIndex = worker.indexOf('await runner.detectAndHaltOrderAnomaly()');
  const alertIndex = worker.indexOf("event: 'COPY_DUPLICATE_ORDER_AUTO_HALTED'");
  const submitIndex = worker.indexOf('await runner.submitOrders()');
  assert.ok(detectIndex > 0);
  assert.ok(alertIndex > detectIndex);
  assert.ok(submitIndex > alertIndex);
  assert.match(worker, /LIVE mode requires Telegram for critical copy safety alerts/);
});

test('LIVE activation stops when the Telegram delivery test fails', () => {
  assert.match(liveActivation, /npm run worker:alert-test/);
  assert.doesNotMatch(liveActivation, /alert_test=delivery_warning/);
});
