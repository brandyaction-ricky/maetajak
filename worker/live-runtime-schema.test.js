import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const migration = readFileSync(new URL('../supabase/migrations/202608210006_live_worker_runtime.sql', import.meta.url), 'utf8');

test('live worker functions require service role and credentials stay private', () => {
  assert.match(migration, /SERVICE_ROLE_REQUIRED/g);
  assert.match(migration, /pgp_sym_decrypt/);
  assert.match(migration, /revoke all on function public\.get_copy_worker_context\(\) from public/);
});

test('activation requires a healthy live worker, fixed IP, recent test, master and member', () => {
  for (const requirement of ['ENABLE_LIVE_COPY_TRADING', "r.mode='LIVE'", "r.public_ip is not null", 'last_test_passed_at', 'VERIFIED_MASTER_REQUIRED', 'VERIFIED_MEMBER_REQUIRED']) {
    assert.match(migration, new RegExp(requirement));
  }
});

test('UNKNOWN orders are reconciled instead of returned to submission queue', () => {
  assert.match(migration, /copy_reconciliation_jobs/);
  assert.match(migration, /i\.status in \('PLANNED','QUEUED'\)/);
  assert.doesNotMatch(migration, /i\.status in \('PLANNED','QUEUED','UNKNOWN'\)/);
});

test('worker lease, latched risk limits, and live read models are present', () => {
  assert.match(migration, /WORKER_LEASE_HELD/);
  assert.match(migration, /DAILY_LOSS_LIMIT/);
  assert.match(migration, /MAX_DRAWDOWN_LIMIT/);
  assert.match(migration, /get_my_live_trading_data/);
  assert.match(migration, /get_admin_live_trading_data/);
});
