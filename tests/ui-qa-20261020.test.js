import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const theme = readFileSync(new URL('../src/prototype-theme.css', import.meta.url), 'utf8');
const newOperation = readFileSync(new URL('../src/new-operation.js', import.meta.url), 'utf8');
const vercel = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('member copy settings re-read the profile and confirm before overwriting admin weights', () => {
  assert.match(main, /function populateCopySettingsForm/);
  assert.match(main, /id === 'member-copy' && currentProfile\?\.role === 'MEMBER'\) refreshCopySettingsFromServer\(\)/);
  const save = main.slice(main.indexOf('async function saveCopySettings'), main.indexOf('function escapeHtml'));
  assert.match(save, /latest = await loadProfile\(currentProfile\.id\)/);
  assert.match(save, /관리자가 비중을 변경했습니다/);
  assert.match(save, /populateCopySettingsForm\(currentProfile\)/);
});

test('business dates are cut in KST, never with toISOString', () => {
  assert.match(main, /timeZone: 'Asia\/Seoul'/);
  assert.doesNotMatch(main, /toISOString\(\)\.slice\(0, 10\)/);
  assert.match(main, /lastDay\.date === kstDate\(\) \? '오늘'/);
});

test('token refresh does not re-route or refill forms', () => {
  assert.match(main, /event === 'TOKEN_REFRESHED' && session\) refreshProfileSilently\(session\)/);
  assert.doesNotMatch(main, /TOKEN_REFRESHED' && session\) routeSession/);
});

test('polling never overwrites focused or edited Gate UID inputs', () => {
  assert.match(main, /function setInputIfIdle/);
  assert.match(main, /setInputIfIdle\(byId\('gateUid'\)/);
  assert.match(main, /setInputIfIdle\(byId\('adminGateUid'\)/);
  assert.match(main, /byId\('member-account'\)\?\.classList\.contains\('active'\)\) loadGateConnection\(false\)/);
});

test('closing positions needs an explicit second confirmation and locks the modal buttons', () => {
  assert.match(main, /pauseButton\.dataset\.copyPause === 'CLOSE'\) setPauseCloseConfirm\(true\)/);
  assert.match(main, /data-copy-pause-confirm="CLOSE"/);
  assert.match(main, /function setPauseButtonsDisabled/);
  assert.match(main, /title\.textContent = '카피 관리'/);
});

test('halt states are styled and shown in Korean', () => {
  assert.match(theme, /\.dot\.offline \{/);
  assert.match(theme, /\.status\.status-halted \{/);
  assert.match(main, /ADMIN_EMERGENCY_HALT: '관리자 긴급 중단'/);
  assert.match(main, /MANUAL_OVERRIDE: \['직접 거래 감지'/);
});

test('money formatting separates signed PnL from unsigned amounts', () => {
  assert.match(main, /function formatAmount/);
  assert.match(main, /function signClass/);
  assert.match(main, /formatAmount\(account\.total_equity\)/);
  assert.match(main, /<b>\$\{formatMasterPrice\(position\.entry_price\)\}<\/b>/);
});

test('admin writes are guarded and requests apply latest-wins', () => {
  assert.match(main, /ticket !== adminExecutionRequestSeq/);
  assert.match(main, /ticket !== adminAnalysisRequestSeq/);
  assert.match(main, /function setUserApproval/);
  assert.match(main, /가입 신청을 거절할까요/);
  assert.match(newOperation, /if \(busy\) return;\n    const ticket = \+\+generation;/);
  assert.match(main, /newOperationPanel\.isBusy\(\)/);
});

test('audit log labels admin weight changes with previous and next values', () => {
  assert.match(main, /MEMBER_COPY_SETTINGS_UPDATED: '회원 비중 변경'/);
  assert.match(main, /카피 비율 \$\{percent\(previous\.copy_ratio\)\} → \$\{percent\(next\.copy_ratio\)\}/);
});

test('no inline event handlers and a strict CSP is deployed', () => {
  assert.doesNotMatch(html, /\son[a-z]+="/i);
  assert.doesNotMatch(main, /\son[a-z]+="/i);
  const headers = Object.fromEntries(vercel.headers[0].headers.map(({ key, value }) => [key, value]));
  assert.match(headers['Content-Security-Policy'], /script-src 'self';/);
  assert.match(headers['Content-Security-Policy'], /connect-src 'self' https:\/\/\*\.supabase\.co wss:\/\/\*\.supabase\.co/);
  assert.match(headers['Content-Security-Policy'], /frame-ancestors 'none'/);
  assert.ok(headers['Permissions-Policy']);
});

test('accessibility: labelled auth forms, dialogs, toast live region and boot splash', () => {
  assert.match(html, /<form id="loginForm"/);
  assert.match(html, /<label for="loginEmail">/);
  assert.match(html, /id="toast" class="toast" role="status" aria-live="polite"/);
  assert.match(html, /id="bootSplash"/);
  assert.match(html, /<section id="auth" class="auth hidden">/);
  assert.match(main, /function trapModalFocus/);
  assert.match(main, /aria-label="카피 비율"/);
  assert.match(theme, /\.toast \{[^}]*z-index: 80/s);
});

test('typography has no text below 11px and the check script covers new-operation.js', () => {
  assert.doesNotMatch(theme, /font-size: (?:[0-9]|10)px/);
  assert.match(pkg.scripts.check, /node --check src\/new-operation\.js/);
});
