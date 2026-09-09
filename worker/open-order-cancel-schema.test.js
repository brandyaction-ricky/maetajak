import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const migration = readFileSync(new URL('../supabase/migrations/20260909023500_open_order_cancellation_jobs.sql', import.meta.url), 'utf8');
const eventMigration = readFileSync(new URL('../supabase/migrations/20260909025000_allow_open_order_cancel_events.sql', import.meta.url), 'utf8');
const liveNoopMigration = readFileSync(new URL('../supabase/migrations/20260909031500_open_order_cancel_live_noop.sql', import.meta.url), 'utf8');
const runner = readFileSync(new URL('./trading-runner.js', import.meta.url), 'utf8');

test('open-order cancellation is admin requested, worker claimed, and fail closed', () => {
  assert.match(migration, /request_cancel_member_open_orders/);
  assert.match(migration, /GLOBAL_HALT_REQUIRED/g);
  assert.match(migration, /require_copy_worker_role/);
  assert.match(migration, /g\.verified_worker_ip=r\.public_ip/);
  assert.match(migration, /remaining_count/);
  assert.match(runner, /cancelAllOpenFuturesOrders/);
  assert.match(runner, /complete_open_order_cancel_job/);
  assert.match(eventMigration, /OPEN_ORDERS_CANCELLED/);
  assert.match(eventMigration, /OPEN_ORDER_CANCEL_FAILED/);
  assert.match(liveNoopMigration, /if not exists[\s\S]*then return; end if;/);
});
