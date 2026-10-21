import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { accountDisplayId, isValidGateUid, loginIdToEmail, uidFromEmail, UID_LOGIN_DOMAIN } from '../src/account-id.js';

// 2026-10-21: Gate UID accounts (UID login, no email, admin-issued temporary passwords).
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const html = read('index.html');
const main = read('src/main.js');
const theme = read('src/prototype-theme.css');
const signupFn = read('supabase/functions/uid-signup/index.ts');
const resetFn = read('supabase/functions/admin-reset-password/index.ts');

test('login id mapping: UID → synthetic email, email passes through (admin)', () => {
  assert.equal(UID_LOGIN_DOMAIN, 'uid.maetajak.trading');
  assert.equal(loginIdToEmail(' 12345678 '), '12345678@uid.maetajak.trading');
  assert.equal(loginIdToEmail('admin@example.invalid'), 'admin@example.invalid');
  assert.equal(loginIdToEmail(''), '');
  assert.equal(uidFromEmail('12345678@uid.maetajak.trading'), '12345678');
  assert.equal(uidFromEmail('12345678@example.invalid'), '');
  assert.ok(isValidGateUid('1234') && isValidGateUid('123456789012345'));
  assert.ok(!isValidGateUid('123') && !isValidGateUid('1234567890123456') && !isValidGateUid('12a45'));
});

test('admin display: UID instead of email, email fallback for admin/legacy', () => {
  assert.equal(accountDisplayId('55556666', '55556666@uid.maetajak.trading'), 'UID 55556666');
  assert.equal(accountDisplayId(null, '55556666@uid.maetajak.trading'), 'UID 55556666');
  assert.equal(accountDisplayId(null, 'admin@example.invalid'), 'admin@example.invalid');
  assert.equal(accountDisplayId(null, null), '');
});

test('auth forms: 아이디 login, Gate UID signup without email, admin-contact note', () => {
  assert.match(html, /<label for="loginId">아이디<\/label><input id="loginId" type="text" autocomplete="username"/);
  assert.match(html, /<label for="signupUid">Gate\.io UID<\/label><input id="signupUid"[^>]*inputmode="numeric"/);
  assert.doesNotMatch(html, /id="loginEmail"|id="signupEmail"|type="email"/);
  assert.match(html, /<form id="loginForm"[\s\S]*<form id="signupForm"/);
  assert.match(html, /비밀번호를 잊으셨다면 관리자에게 문의하세요\./);
  assert.match(html, /id="signupTerms"/);
  assert.match(theme, /\.field-hint \{/);
});

test('signup calls the uid-signup function and never auto-logs in', () => {
  assert.match(main, /supabase\.functions\.invoke\('uid-signup', \{ body \}\)/);
  assert.doesNotMatch(main, /auth\.signUp\(/);
  assert.match(main, /가입 신청이 접수되었습니다\. 관리자 승인 후 로그인할 수 있습니다\./);
  assert.match(main, /UID_TAKEN: '이미 가입 신청된 Gate\.io UID입니다/);
  assert.match(main, /INVALID_INPUT: '입력값을 확인해 주세요/);
  assert.match(main, /terms_version: LEGAL_VERSION,\n\s*privacy_version: LEGAL_VERSION/);
  const signup = main.slice(main.indexOf('window.signup ='), main.indexOf('window.login ='));
  assert.doesNotMatch(signup, /signInWithPassword|routeSession/);
  const login = main.slice(main.indexOf('window.login ='), main.indexOf('window.logout ='));
  assert.match(login, /const email = loginIdToEmail\(loginId\);/);
  assert.match(login, /signInWithPassword\(\{ email, password \}\)/);
});

test('admin temporary password: invoke, shown once with copy, no email reset for members', () => {
  assert.match(main, /supabase\.functions\.invoke\('admin-reset-password', \{ body: \{ user_id: userId \} \}\)/);
  assert.doesNotMatch(main, /resetPasswordForEmail|request_member_password_reset/);
  assert.match(main, /id="memberPasswordResetButton" class="btn" type="button">임시 비밀번호 발급<\/button>/);
  assert.match(main, /id="memberTempPasswordCopy" class="btn" type="button">복사<\/button>/);
  assert.match(main, /navigator\.clipboard\.writeText\(value\)/);
  // Cleared whenever the detail opens or closes, so it is shown only once.
  assert.ok(main.split('clearMemberTempPassword();').length - 1 >= 3);
  assert.doesNotMatch(main, /localStorage[^\n]*temp|sessionStorage[^\n]*temp/i);
});

test('member Gate API form: UID prefilled from the profile, read-only, Korean mismatch error', () => {
  assert.match(main, /input\.readOnly = Boolean\(accountUid\)/);
  assert.match(main, /String\(currentProfile\.gate_uid \|\| ''\) \|\| byId\('gateUid'\)\.value\.trim\(\)/);
  assert.match(main, /GATE_UID_MUST_MATCH_ACCOUNT/);
  assert.match(main, /가입한 Gate\.io UID와 같은 계정의 API만 연결할 수 있습니다/);
});

test('admin lists show the UID; email matching for live states is unchanged', () => {
  assert.match(main, /select\('id,email,gate_uid,full_name,phone,approval_status,role,/);
  assert.match(main, /select\('id,full_name,email,gate_uid'\)/);
  assert.match(main, /byId\('memberDetailEmail'\)\.textContent = accountDisplayId\(member\.gate_uid, member\.email\)/);
  assert.match(main, /statesByEmail\.get\(String\(profile\.email \|\| ''\)\.toLowerCase\(\)\)/);
  assert.match(main, /<th>아이디\(UID\)<\/th>/);
});

test('uid-signup function: strict validation, confirmed synthetic email, generic errors, no password logs', () => {
  assert.match(signupFn, /from 'jsr:@supabase\/supabase-js@2'/);
  assert.match(signupFn, /\/\^\\d\{4,15\}\$\//);
  assert.match(signupFn, /password\.length < 8 \|\| password\.length > 72/);
  assert.match(signupFn, /\/\^\[0-9\+\\- \]\{8,20\}\$\//);
  assert.match(signupFn, /email: `\$\{input\.uid\}@\$\{UID_LOGIN_DOMAIN\}`/);
  assert.match(signupFn, /email_confirm: true/);
  assert.match(signupFn, /\.eq\('gate_uid', input\.uid\)/);
  assert.match(signupFn, /'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'/);
  assert.match(signupFn, /request\.method === 'OPTIONS'/);
  for (const code of ['INVALID_INPUT', 'UID_TAKEN', 'SIGNUP_FAILED']) assert.match(signupFn, new RegExp(`'${code}'`));
  assert.doesNotMatch(signupFn, /console\.[a-z]+\([^\n]*[,(]\s*(input\.)?password\b/);
});

test('admin-reset-password function: approved ADMIN only, MEMBER target, random password never stored', () => {
  assert.match(resetFn, /SUPABASE_ANON_KEY/);
  assert.match(resetFn, /auth\.getUser\(token\)/);
  assert.match(resetFn, /\.eq\('role', 'ADMIN'\)\.eq\('approval_status', 'APPROVED'\)/);
  assert.match(resetFn, /\.eq\('role', 'MEMBER'\)/);
  assert.match(resetFn, /crypto\.getRandomValues/);
  assert.match(resetFn, /PASSWORD_LENGTH = 12/);
  assert.doesNotMatch(resetFn.match(/const ALPHABET = '([^']+)'/)[1], /[0O1lI]/);
  assert.match(resetFn, /updateUserById\(userId, \{ password \}\)/);
  assert.match(resetFn, /action: 'MEMBER_TEMP_PASSWORD_ISSUED'/);
  assert.match(resetFn, /next_value: \{ issued_at: issuedAt \}/);
  assert.doesNotMatch(resetFn, /console\.[a-z]+\([^\n]*[,(]\s*password\b/);
});
