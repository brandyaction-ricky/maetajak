import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const worker = readFileSync(new URL('../worker/index.js', import.meta.url), 'utf8');
const migration = readFileSync(new URL('../supabase/migrations/202608270002_master_read_only.sql', import.meta.url), 'utf8');

test('verification jobs expose the connection role and Worker separates Master from members', () => {
  assert.match(migration, /connection_role text, gate_uid text/);
  assert.match(worker, /requiresTradingPermission: job\.connection_role !== 'MASTER'/);
});

test('verified Master remains read-only while verified members retain trading permission', () => {
  assert.match(migration, /futures_trade = p_success and target_connection_role = 'MEMBER'/);
  assert.match(migration, /connection_role = 'MASTER'[\s\S]*g\.futures_read and not g\.futures_trade/);
  assert.match(migration, /account_role = 'MEMBER'[\s\S]*g\.futures_read and g\.futures_trade/);
});

test('credential functions remain service-role only', () => {
  assert.match(migration, /revoke all on function public\.claim_gate_api_verification_jobs\(integer\) from public, anon, authenticated/);
  assert.match(migration, /grant execute on function public\.claim_gate_api_verification_jobs\(integer\) to service_role/);
  assert.match(migration, /revoke all on function public\.get_copy_worker_context\(\) from public, anon, authenticated/);
});
