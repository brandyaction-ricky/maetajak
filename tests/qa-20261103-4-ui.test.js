import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

// 2026-11-03 pre-go-live audit, area 4 (user-facing flows). Proof tests only: they document the current
// release-candidate behaviour that the audit findings refer to.
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const main = read('src/main.js');
const newOperation = read('src/new-operation.js');
const migrationDir = new URL('../supabase/migrations/', import.meta.url);
const migrations = readdirSync(migrationDir).filter((f) => f.endsWith('.sql')).sort();
const sql = (file) => readFileSync(new URL(file, migrationDir), 'utf8');

test('F-DEPLOY: admin member list selects profile columns that only 20261021032000 adds', () => {
  const select = main.match(/from\('profiles'\)\.select\('(id,email,gate_uid[^']*)'\)/);
  assert.ok(select, 'admin member list select');
  const columns = select[1].split(',');
  for (const column of ['admin_paused', 'admin_reduce_only', 'released_gate_uid']) {
    assert.ok(columns.includes(column), column);
    const adders = migrations.filter((f) => new RegExp(`add column if not exists ${column}\\b`).test(sql(f)));
    assert.deepEqual(adders, ['20261021032000_qa_admin_lifecycle.sql'], `${column} added only by the pending migration`);
  }
  // One query feeds BOTH the pending-approval table and the member list: a 400 blanks both.
  const body = main.slice(main.indexOf('async function loadAdminMembers'), main.indexOf('// 2026-10-30 가입 순서대로 카피 시작: READY'));
  assert.match(body, /pendingMembers'\)\.innerHTML = `<tr><td colspan="5" class="empty-cell">\$\{inlineRetry\('승인 대기 회원을 불러오지 못했습니다/);
});

test('F-DEPLOY: every RPC the web calls is defined by some migration (names exist after full apply)', () => {
  const names = new Set([...`${main}\n${newOperation}`.matchAll(/(?:supabase\.rpc|sharedRpc|rpc)\('([a-z_]+)'/g)].map((m) => m[1]));
  const all = migrations.map(sql).join('\n');
  const missing = [...names].filter((name) => !new RegExp(`function\\s+public\\.${name}\\s*\\(`, 'i').test(all));
  assert.deepEqual(missing, []);
});

test('F-NEWOP: admin member detail keeps a "새 운용 시작" button whose text promises CURRENT_MASTER buying', () => {
  assert.match(main, /data-member-control="RESUME">재개<\/button><button class="btn" type="button" data-new-operation-open>새 운용 시작<\/button>/);
  assert.match(newOperation, /마스터의 현재 전체 포지션을 새 시작 자산 비율과 카피 비율로 계산해 카피 주문을 시작합니다/);
  // The resume context marks a new-operation generation as current-Master sync (worker buys the Master book).
  assert.match(sql('20260914154037_resume_requires_explicit_rebalance_consent.sql'),
    /'sync_current_master',coalesce\(s\.sync_current_master,false\) or private\.copy_resume_operation_id\(a\.id,s\.version\) is not null/);
});

test('F-MEMBER-START: member "카피 재개" sends RESUME without a confirmation and without the FUTURE_ONLY sentence', () => {
  assert.match(main, /if \(pauseButton\.dataset\.copyPause === 'CLOSE'\) setPauseCloseConfirm\(true\);\s*else await setCopyPause\(pauseButton\.dataset\.copyPause\);/);
  const modal = main.slice(main.indexOf('function enhancePauseModal'), main.indexOf('function enhanceNavigationAndHeader'));
  assert.doesNotMatch(modal, /사지 않|진입하지 않/);
  // The only member-facing FUTURE_ONLY statement anchors it to the API connection time, not the start time.
  assert.match(main, /API 연결 시점에 Master가 이미 보유한 포지션은 진입하지 않고/);
});
