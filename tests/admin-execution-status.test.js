import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const main = fs.readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const theme = fs.readFileSync(new URL('../src/prototype-theme.css', import.meta.url), 'utf8');
const migration = fs.readFileSync(new URL('../supabase/migrations/202609020005_admin_execution_status.sql', import.meta.url), 'utf8');

test('admin audit page includes execution diagnostics with useful filters', () => {
  assert.match(main, /data-admin-log-tab="executions">체결 현황/);
  assert.match(main, /id="adminExecutionMember"/);
  assert.match(main, /id="adminExecutionContract"/);
  assert.match(main, /id="adminExecutionStatus"/);
  assert.match(main, /get_admin_execution_status/);
  assert.match(main, /회원이 직접 포지션을 변경하여 자동 주문이 차단되었습니다/);
  assert.match(theme, /\.admin-execution-filters/);
});

test('execution diagnostics RPC is admin-only and read-only', () => {
  assert.match(migration, /if not public\.is_approved_admin\(\)/i);
  assert.match(migration, /language plpgsql[\s\S]*stable[\s\S]*security definer/i);
  assert.match(migration, /private\.copy_order_intents/);
  assert.match(migration, /private\.copy_order_attempts/);
  assert.match(migration, /public\.copy_position_states/);
  assert.match(migration, /revoke all on function public\.get_admin_execution_status[\s\S]*from public, anon/i);
  assert.doesNotMatch(migration, /api_key|secret_key|safe_response/i);
  assert.doesNotMatch(migration, /\b(insert|update|delete|truncate)\b/i);
});
