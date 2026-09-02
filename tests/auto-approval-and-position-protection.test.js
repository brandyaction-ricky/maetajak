import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const migration = readFileSync(new URL('../supabase/migrations/202609020002_auto_approval_and_member_position_baseline.sql', import.meta.url), 'utf8');
const runner = readFileSync(new URL('../worker/trading-runner.js', import.meta.url), 'utf8');

test('confirmed email automatically approves only pending members', () => {
  assert.match(migration, /update of email_confirmed_at on auth\.users/i);
  assert.match(migration, /new\.email_confirmed_at is not null/i);
  assert.match(migration, /role = 'MEMBER'[\s\S]*approval_status = 'PENDING'/i);
  assert.match(migration, /USER_AUTO_APPROVED_EMAIL_CONFIRMED/);
});

test('first copy cycle stores and uses member positions as protected exposure', () => {
  assert.match(migration, /member_positions jsonb not null default '\[\]'::jsonb/i);
  assert.match(migration, /get_or_initialize_member_copy_baselines/);
  assert.match(runner, /p_member_positions: member\.positions\.map/);
  assert.match(runner, /target\.targetSize \+= protectedMemberSize/);
});
