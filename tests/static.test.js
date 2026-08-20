import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const script = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const migration = readFileSync(new URL('../supabase/migrations/202608200001_auth_profiles.sql', import.meta.url), 'utf8');
const copySettingsMigration = readFileSync(new URL('../supabase/migrations/202608200002_copy_settings.sql', import.meta.url), 'utf8');
const gateApiMigration = readFileSync(new URL('../supabase/migrations/202608200003_gate_api_credentials.sql', import.meta.url), 'utf8');
const gateVerificationMigration = readFileSync(new URL('../supabase/migrations/202608200004_gate_api_verification_queue.sql', import.meta.url), 'utf8');
const gateWorker = readFileSync(new URL('../worker/gate.js', import.meta.url), 'utf8');

test('authentication controls are wired without demo credentials', () => {
  for (const id of ['loginEmail', 'loginPassword', 'signupName', 'signupPhone', 'signupEmail', 'signupPassword', 'signupPasswordConfirm', 'signupTerms', 'pendingStatusLabel']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.doesNotMatch(html, /ricky@example\.com|value="12345678"/);
  assert.doesNotMatch(html, /초대코드|GS-PRIVATE|관리자 데모로 보기/);
  assert.match(html, /<script type="module" src="\/src\/main\.js"><\/script>/);
});

test('signup validates password confirmation before Supabase signup', () => {
  assert.match(script, /password !== passwordConfirm/);
  assert.match(script, /비밀번호와 비밀번호 확인이 일치하지 않습니다/);
});

test('copy settings include 200% copy ratio and 20% maximum position ratio', () => {
  assert.match(script, /addOption\(copyRatio, '200%'\)/);
  assert.match(script, /addOption\(maxPositionRatio, '20%'\)/);
});

test('approved members can save copy settings and admins can query them', () => {
  assert.match(copySettingsMigration, /copy_ratio numeric not null default 100/i);
  assert.match(copySettingsMigration, /max_position_ratio numeric not null default 30/i);
  assert.match(copySettingsMigration, /update_my_copy_settings/i);
  assert.match(copySettingsMigration, /approval_status = 'APPROVED'/i);
  assert.match(script, /copy_ratio,max_position_ratio/);
  assert.match(script, /update_my_copy_settings/);
  assert.match(script, /최대 포지션 비중/);
});

test('Gate.io credentials are collected securely and encrypted server-side', () => {
  for (const id of ['gateUid', 'gateApiKey', 'gateSecretKey', 'gatePermissionConfirmed', 'gateApiConnect']) assert.match(script, new RegExp(id));
  assert.match(script, /type="password"/);
  assert.match(script, /save_gate_api_credentials/);
  assert.match(script, /gateApiKey'\)\.value = ''/);
  assert.match(script, /gateSecretKey'\)\.value = ''/);
  assert.match(gateApiMigration, /create schema if not exists private/i);
  assert.match(gateApiMigration, /pgp_sym_encrypt/gi);
  assert.match(gateApiMigration, /vault\.decrypted_secrets/i);
  assert.match(gateApiMigration, /alter table private\.gate_api_credentials enable row level security/i);
  assert.match(gateApiMigration, /revoke all on private\.gate_api_credentials/i);
  assert.doesNotMatch(gateApiMigration, /api_key\s+text\s+not null/i);
  assert.doesNotMatch(gateApiMigration, /secret_key\s+text\s+not null/i);
});

test('Gate.io verification is queued for a fixed-IP worker and uses signed Futures API requests', () => {
  assert.match(gateVerificationMigration, /gate_api_verification_jobs/i);
  assert.match(gateVerificationMigration, /claim_gate_api_verification_jobs/i);
  assert.match(gateVerificationMigration, /complete_gate_api_verification/i);
  assert.match(gateVerificationMigration, /service_role/i);
  assert.match(gateWorker, /\/api\/v4\/futures\/usdt\/accounts/);
  assert.match(gateWorker, /createHmac\('sha512'/);
  assert.match(gateWorker, /UID_MISMATCH/);
  assert.match(script, /loadAdminGateConnections/);
  assert.match(script, /gateStatusTimer/);
  assert.match(script, /VITE_TRADING_WORKER_IP/);
  assert.doesNotMatch(script, /146\.56\.140\.75/);
});

test('pause modal can be dismissed safely', () => {
  assert.match(script, /id="pauseModalClose"/);
  assert.match(script, /aria-label="일시중지 창 닫기"/);
  assert.match(script, /event\.target\.id === 'pauseModal'/);
  assert.match(script, /event\.key === 'Escape'/);
});

test('sidebar brand image keeps its original colors', () => {
  const theme = readFileSync(new URL('../src/theme.css', import.meta.url), 'utf8');
  assert.match(theme, /\.side-brand img\s*\{[^}]*filter:\s*none/s);
  assert.doesNotMatch(theme, /\.side-brand img\s*\{[^}]*grayscale/s);
});

test('all navigation targets exist and IDs are unique', () => {
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(ids).size, ids.length);
  for (const [, page] of html.matchAll(/data-page="([^"]+)"/g)) assert.match(html, new RegExp(`id="${page}"`));
});

test('mobile breakpoints and two-column mobile KPI layout remain present', () => {
  assert.match(html, /@media\s*\(max-width:\s*950px\)/);
  assert.match(html, /@media\s*\(max-width:\s*560px\)/);
  assert.match(html, /\.kpis\s*\{\s*grid-template-columns:repeat\(2,1fr\)/s);
  const theme = readFileSync(new URL('../src/theme.css', import.meta.url), 'utf8');
  assert.match(theme, /@media\s*\(max-width:\s*950px\)/);
  assert.match(theme, /\.app\s*\{[^}]*display:\s*block[^}]*max-width:\s*100vw/s);
  assert.match(theme, /\.main\s*\{[^}]*max-width:\s*100vw/s);
  assert.match(theme, /\.page\.active\s*>\s*\*/);
  assert.match(theme, /scrollbar-width:\s*none/);
  assert.match(theme, /env\(safe-area-inset-bottom\)/);
  assert.match(theme, /#member-account \.half\s*\{[^}]*grid-auto-rows:\s*1fr/s);
});

test('browser code contains no privileged credentials or local storage secret handling', () => {
  assert.doesNotMatch(script, /service[_-]?role/i);
  assert.doesNotMatch(script, /VITE_[A-Z0-9_]*SECRET|GATE_[A-Z0-9_]*SECRET/i);
  assert.doesNotMatch(script, /gate_api_credentials_key|pgp_sym_decrypt/i);
  assert.doesNotMatch(script, /localStorage\.(setItem|getItem)/);
});

test('database migration enforces RLS and approved-admin authorization', () => {
  assert.match(migration, /alter table public\.profiles enable row level security/i);
  assert.match(migration, /role = 'ADMIN' and approval_status = 'APPROVED'/i);
  assert.match(migration, /security definer/gi);
  assert.match(migration, /admin_audit_logs/i);
});
