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

test('F-NEWOP fixed (Q3): "새 운용 시작" is no longer next to "재개"; it sits in a collapsed danger section and says what it buys', () => {
  const controls = main.match(/<div class="member-control-actions"><small>관리자 카피 제어<\/small><div class="actions">(.*?)<\/div><\/div>/);
  assert.ok(controls, 'normal admin controls');
  assert.doesNotMatch(controls[1], /data-new-operation-open|새 운용/);
  assert.match(main, /<details class="member-control-actions member-danger-zone"><summary>고급 · 위험<\/summary>/);
  assert.doesNotMatch(main, /<details[^>]*member-danger-zone[^>]*\bopen\b/, 'collapsed by default');
  assert.match(main, /<button class="btn red" type="button" data-new-operation-open>새 운용 시작 \(마스터 현재 포지션 전부 매수\)<\/button>/);
  assert.match(newOperation, /마스터의 현재 전체 포지션을 새 시작 자산 비율과 카피 비율로 계산해 카피 주문을 시작합니다/);
  // Server-side behaviour unchanged: the resume context still marks the generation as current-Master sync.
  assert.match(sql('20260914154037_resume_requires_explicit_rebalance_consent.sql'),
    /'sync_current_master',coalesce\(s\.sync_current_master,false\) or private\.copy_resume_operation_id\(a\.id,s\.version\) is not null/);
});

test('F-MEMBER-START fixed (P2-5): member start/resume asks for confirmation with the start-time FUTURE_ONLY sentence', () => {
  const sentence = '카피를 시작(재개)하는 시점에 Master가 이미 보유한 포지션은 사지 않고, 이후 Master의 변화만 현재 자산 비율로 따라갑니다.';
  assert.match(main, /if \(pauseButton\.dataset\.copyPause === 'CLOSE'\) setPauseCloseConfirm\(true\);\s*else if \(pauseButton\.dataset\.copyPause === 'RESUME'\) \{ if \(confirmMemberCopyStart\(\)\) await setCopyPause\('RESUME'\); \}/);
  assert.ok(main.includes(`const COPY_START_POLICY = '${sentence}';`));
  const confirmFn = main.slice(main.indexOf('function confirmMemberCopyStart'), main.indexOf('function renderPauseModalStatus'));
  assert.match(confirmFn, /window\.confirm\(`\$\{label\} 요청을 보낼까요\?\\n\\n• \$\{COPY_START_POLICY\}/);
  assert.doesNotMatch(main, /API 연결 시점에 Master가 이미 보유한 포지션은 진입하지 않고/);
  assert.match(main, /<p>\$\{COPY_START_POLICY\}<\/p><\/div><span class="chip">시작 이후만 카피<\/span>/);
});
