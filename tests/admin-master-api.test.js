import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const theme = readFileSync(new URL('../src/theme.css', import.meta.url), 'utf8');
const migration = readFileSync(new URL('../supabase/migrations/202608210004_admin_master_api.sql', import.meta.url), 'utf8');
const reverifyMigration = readFileSync(new URL('../supabase/migrations/202608280001_admin_master_api_reverify.sql', import.meta.url), 'utf8');

test('admin can submit a separate Master Gate.io credential form', () => {
  for (const id of ['adminGateApiForm', 'adminGateUid', 'adminGateApiKey', 'adminGateSecretKey', 'adminGatePermissionConfirmed', 'adminGateApiConnect']) {
    assert.match(main, new RegExp(id));
  }
  assert.match(main, /save_admin_gate_api_credentials/);
  assert.match(main, /get_admin_master_gate_api_connection/);
  assert.match(main, /adminGateSecretKey" type="password/);
  assert.match(main, /adminGateSecretKey'\)\.value = ''/);
});

test('Master credentials are admin protected, encrypted and provision a Master account only after verification', () => {
  assert.match(migration, /if not public\.is_approved_admin\(\)/);
  assert.match(migration, /pgp_sym_encrypt/);
  assert.match(migration, /vault\.decrypted_secrets/);
  assert.match(migration, /connection_role.*MASTER/s);
  assert.match(migration, /if p_success then[\s\S]*insert into private\.trading_accounts/);
  assert.match(migration, /service_role/);
  assert.match(migration, /MASTER_GATE_API_CREDENTIALS_SAVED/);
});

test('admin API layout stacks safely on mobile', () => {
  assert.match(theme, /\.admin-api-setup\s*\{[^}]*grid-template-columns/s);
  assert.match(theme, /@media \(max-width: 950px\)[\s\S]*\.admin-api-setup,[\s\S]*\.admin-api-fields\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/s);
});

test('Master UID, API key and Secret key each use a full-width row', () => {
  assert.match(theme, /\.admin-api-fields\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/s);
  assert.match(theme, /\.admin-api-fields \.field,[\s\S]*\.admin-api-fields \.field input\s*\{[^}]*width:\s*100%/s);
});

test('Master API instructions require Futures Read Only without order permission', () => {
  assert.match(main, /Perpetual Futures Read Only만 허용/);
  assert.match(main, /Master 주문 권한/);
  assert.match(main, /verified && !connection\.futures_trade/);
});

test('admin can reverify a stored Master credential without exposing or replacing its secret', () => {
  assert.match(main, /retry_admin_master_gate_api_verification/);
  assert.match(main, /저장된 Master API 재검증/);
  assert.match(main, /hasStoredCredential/);
  assert.match(reverifyMigration, /connection_role = 'MASTER'/);
  assert.match(reverifyMigration, /insert into private\.gate_api_verification_jobs/);
  assert.match(reverifyMigration, /futures_trade = false/);
  assert.doesNotMatch(reverifyMigration, /pgp_sym_decrypt|secret_key_ciphertext\s*=/);
});

test('Master reverification remains admin-only and disables the source until verification succeeds', () => {
  assert.match(reverifyMigration, /if not public\.is_approved_admin\(\)/);
  assert.match(reverifyMigration, /update private\.trading_accounts[\s\S]*status = 'DISABLED'/);
  assert.match(reverifyMigration, /revoke all on function public\.retry_admin_master_gate_api_verification\(boolean\)[\s\S]*from public, anon/);
  assert.match(reverifyMigration, /grant execute on function public\.retry_admin_master_gate_api_verification\(boolean\)[\s\S]*to authenticated/);
});
