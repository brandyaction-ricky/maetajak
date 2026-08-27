import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const migration = readFileSync(new URL('../supabase/migrations/202608280002_member_gate_api_reverify.sql', import.meta.url), 'utf8');

test('member can request verification with the already encrypted API credentials', () => {
  assert.match(main, /retry_my_gate_api_verification/);
  assert.match(main, /저장된 API 재검증/);
  assert.match(migration, /status = 'PENDING_VERIFICATION'/);
  assert.match(migration, /credentials_reused', true/);
  assert.doesNotMatch(migration, /pgp_sym_decrypt|secret_key_ciphertext\s*=/);
});

test('member reverification stays restricted to an approved member and disables trading until verified', () => {
  assert.match(migration, /role = 'MEMBER' and approval_status = 'APPROVED'/);
  assert.match(migration, /connection_role = 'MEMBER'/);
  assert.match(migration, /set status = 'DISABLED'/);
  assert.match(migration, /revoke all on function public\.retry_my_gate_api_verification\(boolean\)[\s\S]*from public, anon/);
  assert.match(migration, /grant execute on function public\.retry_my_gate_api_verification\(boolean\)[\s\S]*to authenticated/);
});
