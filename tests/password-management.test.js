import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const migration = readFileSync(new URL('../supabase/migrations/202608220001_password_management.sql', import.meta.url), 'utf8');
const browser = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');

test('admin password reset requests require an approved admin and are audited', () => {
  assert.match(migration, /request_member_password_reset/);
  assert.match(migration, /public\.is_approved_admin\(\)/);
  assert.match(migration, /MEMBER_PASSWORD_RESET_REQUESTED/);
  assert.doesNotMatch(migration, /temporary_password|임시비밀번호/i);
});

test('member password recovery goes through an admin-issued temporary password, never email', () => {
  assert.doesNotMatch(browser, /resetPasswordForEmail/);
  assert.doesNotMatch(browser, /request_member_password_reset/);
  assert.match(browser, /functions\.invoke\('admin-reset-password', \{ body: \{ user_id: userId \} \}\)/);
  assert.match(browser, /비밀번호를 잊으셨다면 관리자에게 문의하세요/);
  // Administrators can still finish a recovery link they requested themselves.
  assert.match(browser, /PASSWORD_RECOVERY/);
  assert.doesNotMatch(browser, /service_role|SERVICE_ROLE_KEY/);
});

test('members verify the current password and invalidate sessions after changing it', () => {
  assert.match(browser, /signInWithPassword\(\{ email, password: currentPassword \}\)/);
  assert.match(browser, /updateUser\(\{ password: newPassword \}\)/);
  assert.match(browser, /signOut\(\{ scope: 'global' \}\)/);
  assert.match(browser, /id="newPasswordConfirm"/);
});
