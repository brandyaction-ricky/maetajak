import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const script = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const migration = readFileSync(new URL('../supabase/migrations/202608200001_auth_profiles.sql', import.meta.url), 'utf8');

test('authentication controls are wired without demo credentials', () => {
  for (const id of ['loginEmail', 'loginPassword', 'signupName', 'signupPhone', 'signupEmail', 'signupPassword', 'signupTerms', 'pendingStatusLabel']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.doesNotMatch(html, /ricky@example\.com|value="12345678"/);
  assert.match(html, /<script type="module" src="\/src\/main\.js"><\/script>/);
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
});

test('browser code contains no privileged credentials or local storage secret handling', () => {
  assert.doesNotMatch(script, /service[_-]?role/i);
  assert.doesNotMatch(script, /gate.*secret|secret.*gate/i);
  assert.doesNotMatch(script, /localStorage\.(setItem|getItem)/);
});

test('database migration enforces RLS and approved-admin authorization', () => {
  assert.match(migration, /alter table public\.profiles enable row level security/i);
  assert.match(migration, /role = 'ADMIN' and approval_status = 'APPROVED'/i);
  assert.match(migration, /security definer/gi);
  assert.match(migration, /admin_audit_logs/i);
});
