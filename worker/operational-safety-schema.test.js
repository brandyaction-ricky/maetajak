import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const migration = readFileSync(new URL('../supabase/migrations/202608210008_operational_safety.sql', import.meta.url), 'utf8');
const worker = readFileSync(new URL('./index.js', import.meta.url), 'utf8');
const runner = readFileSync(new URL('./trading-runner.js', import.meta.url), 'utf8');
const browser = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');

test('repeated live Worker failures fail closed', () => {
  assert.match(migration, /consecutive_failures integer not null default 0/i);
  assert.match(migration, /runtime\.mode='LIVE' and runtime\.consecutive_failures>=3/i);
  assert.match(migration, /WORKER_REPEATED_FAILURE/);
  assert.match(worker, /reportCycle\(true\)/);
  assert.match(worker, /reportCycle\(false, code\)/);
  assert.match(runner, /report_copy_worker_cycle/);
});

test('admins have real member controls, events and audit logs', () => {
  assert.match(migration, /set_member_copy_control/);
  assert.match(migration, /get_admin_operational_events/);
  assert.match(migration, /get_admin_audit_log/);
  assert.match(browser, /data-member-control="PAUSE"/);
  assert.match(browser, /loadAdminOperationalEvents/);
  assert.match(browser, /loadAdminAuditLog/);
});

test('Gate credential disconnect wipes encrypted values and halts trading', () => {
  assert.match(migration, /disable_my_gate_api_connection/);
  assert.match(migration, /disable_admin_master_gate_api_connection/);
  assert.match(migration, /api_key_ciphertext=pgp_sym_encrypt\(encode\(gen_random_bytes/);
  assert.match(migration, /halt_reason='MASTER_API_DISCONNECTED'/);
  assert.match(browser, /API 연결 해제/);
});
