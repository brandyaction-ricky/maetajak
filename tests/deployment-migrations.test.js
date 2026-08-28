import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { applySupabaseMigrations } from '../scripts/apply-supabase-migrations.js';

async function fixture(files) {
  const directory = await mkdtemp(`${tmpdir()}/maetajak-migrations-`);
  await Promise.all(Object.entries(files).map(([name, sql]) => writeFile(join(directory, name), sql)));
  return pathToFileURL(`${directory}/`);
}

test('deployment migration runner applies only untracked files transactionally', async () => {
  const requests = [];
  const migrationDir = await fixture({
    '202608280001_first.sql': 'create table if not exists public.first_table(id int);',
    '202608280002_second.sql': 'alter table public.first_table add column if not exists name text;',
  });
  const fetchImpl = async (_url, options) => {
    const body = JSON.parse(options.body);
    requests.push(body);
    return {
      ok: true,
      json: async () => body.read_only ? [{ version: '202608280001' }] : [],
    };
  };

  const result = await applySupabaseMigrations({
    accessToken: 'test-token', projectRef: 'abcdefghijklmnopqrst', fetchImpl, migrationDir,
  });

  assert.deepEqual(result, { tracked: 2, applied: ['202608280002_second.sql'] });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].read_only, true);
  assert.match(requests[1].query, /^begin;/);
  assert.match(requests[1].query, /202608280002/);
  assert.match(requests[1].query, /commit;$/);
  assert.equal(JSON.stringify(requests).includes('test-token'), false);
});

test('deployment migration runner dry-run never executes pending SQL', async () => {
  const migrationDir = await fixture({ '202608280010_pending.sql': 'select 1;' });
  let calls = 0;
  const result = await applySupabaseMigrations({
    accessToken: 'test-token', projectRef: 'abcdefghijklmnopqrst', migrationDir, dryRun: true,
    fetchImpl: async () => {
      calls += 1;
      return { ok: true, json: async () => [] };
    },
  });
  assert.deepEqual(result, { tracked: 0, pending: ['202608280010_pending.sql'] });
  assert.equal(calls, 1);
});
