import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('current-state RPC uses the PostgREST service-role claim', async () => {
  const sql = await readFile(new URL('../supabase/migrations/202609030002_fix_current_state_service_role.sql', import.meta.url), 'utf8');

  assert.match(sql, /revoke all on function public\.upsert_copy_current_state\(jsonb\)[\s\S]*from public, anon, authenticated/i);
  assert.match(sql, /grant execute on function public\.upsert_copy_current_state\(jsonb\)[\s\S]*to service_role/i);
  assert.match(sql, /if auth\.role\(\) <> 'service_role' then[\s\S]*raise exception 'SERVICE_ROLE_REQUIRED'/i);
});
