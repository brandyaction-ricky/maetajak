import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const theme = readFileSync(new URL('../src/theme.css', import.meta.url), 'utf8');
const migration = readFileSync(new URL('../supabase/migrations/202608210004_admin_master_api.sql', import.meta.url), 'utf8');

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
