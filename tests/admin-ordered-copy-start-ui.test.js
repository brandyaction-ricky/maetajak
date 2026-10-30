import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ORDERED_COPY_CANCEL_CONFIRMATION, ORDERED_COPY_CONFIRMATION, ORDERED_COPY_LIVE_LABELS, ORDERED_COPY_REASON_LABELS,
  ORDERED_COPY_STATE_META, orderedCopyCancelText, orderedCopyConfirmText, orderedCopyError, orderedCopyReasonLabel,
  renderOrderedCopyStart } from '../src/ordered-copy-start.js';
import { migrationFiles } from './fixtures/verified-runtime.js';

// 2026-10-30 가입 순서대로 카피 시작 (administrator members page).
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const main = read('src/main.js');
const theme = read('src/prototype-theme.css');
const pkg = JSON.parse(read('package.json'));
const migration = read('supabase/migrations/20261030010000_admin_ordered_copy_start.sql');
const rpcParams = (name) => {
  const match = main.match(new RegExp(`supabase\\.rpc\\('${name}', \\{([^}]*)\\}`));
  assert.ok(match, `${name} is called`);
  return [...match[1].matchAll(/(p_[a-z_]+):/g)].map((m) => m[1]);
};
const sqlParams = (name) => {
  const match = migration.match(new RegExp(`create or replace function public\\.${name}\\(([^)]*)\\)`));
  assert.ok(match, `${name} is defined`);
  return match[1].split(',').map((arg) => arg.trim().split(/\s+/)[0]).filter(Boolean);
};

const ready = [
  { user_id: 'u1', full_name: '김가입', gate_uid: '71000001', signup_at: '2026-10-01T00:00:00Z', session_state: 'REQUIRED' },
  { user_id: 'u2', full_name: '이가입', gate_uid: '71000002', signup_at: '2026-10-02T00:00:00Z', session_state: 'PAUSED', session_blocker: 'MASTER_CREDENTIAL_CHANGED' },
  { user_id: 'u3', full_name: '박가입', gate_uid: '71000003', signup_at: '2026-10-03T00:00:00Z', session_state: 'REQUIRED' },
];

test('the RPC calls match the SQL signatures and confirmation phrases', () => {
  assert.deepEqual(rpcParams('admin_enqueue_ordered_copy_start'), ['p_user_ids', 'p_confirmation']);
  assert.deepEqual(sqlParams('admin_enqueue_ordered_copy_start'), ['p_user_ids', 'p_confirmation']);
  assert.deepEqual(rpcParams('admin_cancel_ordered_copy_start'), sqlParams('admin_cancel_ordered_copy_start'));
  assert.match(main, /supabase\.rpc\('get_admin_ordered_copy_start'\)/);
  assert.match(migration, new RegExp(`'${ORDERED_COPY_CONFIRMATION}'`));
  assert.match(migration, new RegExp(`'${ORDERED_COPY_CANCEL_CONFIRMATION}'`));
  assert.match(main, /p_confirmation: ORDERED_COPY_CONFIRMATION/);
  assert.match(main, /p_confirmation: ORDERED_COPY_CANCEL_CONFIRMATION/);
  assert.ok(migrationFiles.includes('20261030010000_admin_ordered_copy_start.sql'), 'the DB harness applies the migration');
  assert.match(pkg.scripts.check, /node --check src\/ordered-copy-start\.js/);
});

test('every state, readiness, queue and live code the migration produces has a Korean label', () => {
  for (const state of ['QUEUED', 'REQUESTED', 'ACTIVE', 'SKIPPED', 'FAILED', 'CANCELLED']) {
    assert.ok(ORDERED_COPY_STATE_META[state], state);
    assert.match(migration, new RegExp(`'${state}'`));
  }
  assert.deepEqual(Object.fromEntries(Object.entries(ORDERED_COPY_STATE_META).map(([k, v]) => [k, v[0]])),
    { QUEUED: '대기', REQUESTED: '시작 요청', ACTIVE: '카피 중', SKIPPED: '건너뜀', FAILED: '실패', CANCELLED: '취소됨' });
  const readiness = migration.slice(migration.indexOf('function private.copy_start_readiness'), migration.indexOf('function private.advance_copy_start_queue'));
  for (const [, code] of readiness.matchAll(/return '([A-Z_]+)'/g)) assert.ok(ORDERED_COPY_REASON_LABELS[code], code);
  for (const code of ['ADMIN_CANCELLED', 'STARTED_OUTSIDE_QUEUE', 'WAITING_FOR_LIVE', 'RETRY_AFTER_EXPIRY', 'RETRY_TRANSIENT', 'RESUME_SESSION_MISSING']) {
    assert.match(migration, new RegExp(`'${code}'`));
    assert.ok(ORDERED_COPY_REASON_LABELS[code], code);
  }
  const live = migration.slice(migration.indexOf('function private.copy_start_live_state'), migration.indexOf('function private.copy_start_readiness'));
  for (const [, code] of live.matchAll(/then '([A-Z_]+)'/g)) assert.ok(ORDERED_COPY_LIVE_LABELS[code], code);
  assert.equal(orderedCopyReasonLabel('RESUME_PREVIEW_NOT_ZERO'), '재개 시 바로 주문이 필요한 상태', 'resume blockers use the resume guidance');
  assert.equal(orderedCopyReasonLabel('GATE_API_NOT_VERIFIED'), 'Gate API 검증 전');
});

test('the confirm dialog explains FUTURE_ONLY, signup order one at a time, skipping, and waiting for LIVE', () => {
  const text = orderedCopyConfirmText(3, { live_ready: true });
  assert.match(text, /선택한 회원 3명의 카피를 가입 순서대로 시작할까요\?/);
  assert.match(text, /마스터가 이미 보유한 포지션은 사지 않습니다/);
  assert.match(text, /시작한 뒤의 마스터 거래\(신규 진입·추가·축소·청산\)만 회원 현재 자산 비율대로 따라갑니다/);
  assert.match(text, /가입이 빠른 회원부터 한 명씩 시작합니다/);
  assert.match(text, /준비되지 않은 회원\(API 미검증, 일시중지 등\)은 기다리지 않고 건너뜁니다/);
  assert.doesNotMatch(text, /LIVE가 켜질 때까지/);
  assert.match(orderedCopyConfirmText(1, { live_ready: false, live_reason: 'EXECUTION_DISABLED' }), /실거래 실행이 꺼져 있음\) LIVE가 켜질 때까지 대기한 뒤 시작합니다/);
  assert.match(orderedCopyCancelText(2), /대기 중인 회원 2명의 카피 시작을 취소할까요\?[\s\S]*이미 시작을 요청한 회원은 취소되지 않고/);
  assert.match(main, /window\.confirm\(orderedCopyConfirmText\(userIds\.length, adminOrderedCopy\)\)/);
  assert.match(main, /window\.confirm\(orderedCopyCancelText\(queued\)\)/);
  assert.equal(orderedCopyError({ message: 'ORDERED_COPY_START_RUNNING' }), '이미 진행 중인 순서 시작이 있습니다. 끝나거나 대기 회원을 취소한 뒤 다시 시작해 주세요.');
  assert.match(orderedCopyError({ message: 'NO_READY_MEMBERS' }), /시작할 수 있는 회원이 없습니다/);
  assert.equal(orderedCopyError({ message: 'x' }, 'fallback'), 'fallback');
});

test('selection view: ready members in signup order with checkboxes, balance, start button with the selected count', () => {
  const html = renderOrderedCopyStart({ live_ready: true, running: false, ready_members: ready, not_ready_members: [
    { user_id: 'n1', full_name: '정지회원', gate_uid: '71000009', reason: 'MEMBER_PAUSED' }], items: [] },
  { selected: new Set(['u1', 'u3']), balances: new Map([['u1', 1234.5]]) });
  assert.match(html, /<h3>가입 순서대로 카피 시작<\/h3>/);
  assert.match(html, /마스터가 이미 보유한 포지션은 사지 않고, 시작한 뒤의 마스터 거래만 회원 자산 비율대로 따라갑니다/);
  assert.ok(html.indexOf('김가입') < html.indexOf('이가입') && html.indexOf('이가입') < html.indexOf('박가입'), 'signup order is kept');
  assert.match(html, /data-ordered-copy-select="u1" aria-label="김가입 선택" checked/);
  assert.match(html, /data-ordered-copy-select="u2" aria-label="이가입 선택">/);
  assert.match(html, /<td data-label="시작 순서">2<\/td><td data-label="회원"><b>박가입<\/b>/, 'start order counts only the selected members');
  assert.match(html, /\$1,234\.50/);
  assert.match(html, /UID 71000001/);
  assert.match(html, /일시정지 · Master 계정 변경으로 일시중지/);
  assert.match(html, /<button id="orderedCopyStart" class="btn green" type="button">선택한 2명 카피 시작<\/button>/);
  assert.match(html, /data-ordered-copy-all aria-label="전체 선택">/, 'not every member is selected');
  assert.match(html, /준비되지 않은 회원 1명[\s\S]*정지회원[\s\S]*회원이 직접 일시중지함/);
  assert.doesNotMatch(html, /orderedCopyCancel|ordered-copy-live/);
  const none = renderOrderedCopyStart({ live_ready: true, ready_members: ready, items: [] }, { selected: new Set() });
  assert.match(none, /id="orderedCopyStart" class="btn green" type="button" disabled>선택한 0명 카피 시작/);
  const busy = renderOrderedCopyStart({ live_ready: true, ready_members: ready, items: [] }, { selected: new Set(['u1']), busy: true });
  assert.match(busy, /id="orderedCopyStart"[^>]* disabled>/);
});

test('progress view: per-member state labels and reasons, cancel button, waiting-for-LIVE notice', () => {
  const items = [
    { seq: 1, user_id: 'u1', full_name: '김가입', gate_uid: '71000001', state: 'ACTIVE', resolved_at: '2026-10-30T01:00:00Z' },
    { seq: 2, user_id: 'u2', full_name: '이가입', gate_uid: '71000002', state: 'SKIPPED', reason: 'ADMIN_PAUSED' },
    { seq: 3, user_id: 'u3', full_name: '박가입', gate_uid: '71000003', state: 'FAILED', reason: 'RESUME_PREVIEW_NOT_ZERO' },
    { seq: 4, user_id: 'u4', full_name: '최가입', gate_uid: '71000004', state: 'REQUESTED', session_state: 'REQUESTED', session_blocker: 'RESUME_SNAPSHOT_STALE' },
    { seq: 5, user_id: 'u5', full_name: '정가입', gate_uid: '71000005', state: 'QUEUED' },
    { seq: 6, user_id: 'u6', full_name: '한가입', gate_uid: '71000006', state: 'QUEUED', reason: 'WAITING_FOR_LIVE' },
  ];
  const html = renderOrderedCopyStart({ live_ready: true, running: true, items, ready_members: [] });
  assert.match(html, /<span class="chip yellow">진행 중 3\/6<\/span>/);
  for (const [state, label] of [['ACTIVE', '카피 중'], ['SKIPPED', '건너뜀'], ['FAILED', '실패'], ['REQUESTED', '시작 요청'], ['QUEUED', '대기']]) {
    assert.match(html, new RegExp(`data-state="${state}">[\\s\\S]*?<span class="[^"]+">${label}</span>`), state);
  }
  assert.match(html, /관리자 일시정지/);
  assert.match(html, /재개 시 바로 주문이 필요한 상태/);
  assert.match(html, /안전 확인 중 · 계좌 조회 지연/);
  assert.match(html, /차례를 기다리는 중/);
  assert.match(html, /실거래\(LIVE\)를 기다린 뒤 다시 시작/);
  assert.match(html, /<button id="orderedCopyCancel" class="btn red" type="button">대기 중인 2명 취소<\/button>/);
  assert.doesNotMatch(html, /id="orderedCopyStart"/, 'no second batch while one is running');
  const waiting = renderOrderedCopyStart({ live_ready: false, live_reason: 'WORKER_NOT_LIVE', waiting_for_live: true, running: true, items: items.slice(4), ready_members: [] });
  assert.match(waiting, /class="notice warn-box ordered-copy-live" role="status"><b>실거래\(LIVE\) 대기 중<\/b> · Trading Worker가 LIVE 모드가 아님\. LIVE가 켜지면 대기 중인 회원부터 이어서 시작합니다\./);
  const idle = renderOrderedCopyStart({ live_ready: false, live_reason: 'EMERGENCY_HALTED', running: false, items, ready_members: ready }, { selected: new Set(['u1']) });
  assert.match(idle, /지금은 실거래\(LIVE\)가 아닙니다<\/b> · 긴급 중단 상태\. 시작하면 LIVE가 켜질 때까지 대기합니다\./);
  assert.match(idle, /<details class="ordered-copy-history"><summary>최근 진행 결과 \(6명\)<\/summary>/);
});

test('a recent swallowed trigger error is shown while a batch runs, an old one is not', () => {
  const now = Date.parse('2026-10-30T01:05:00Z');
  const data = { live_ready: true, running: true, items: [{ seq: 1, user_id: 'u1', state: 'REQUESTED' }],
    trigger_error: { code: '55P03', at: '2026-10-30T01:00:00Z', count: 1 } };
  assert.match(renderOrderedCopyStart(data, { now }), /class="ordered-copy-trace" role="status">최근 자동 진행 확인이 한 번 지연되었습니다\(55P03\)\. 1분마다 다시 확인합니다\./);
  assert.doesNotMatch(renderOrderedCopyStart(data, { now: now + 20 * 60_000 }), /ordered-copy-trace/);
  assert.doesNotMatch(renderOrderedCopyStart({ ...data, running: false, ready_members: [] }, { now }), /ordered-copy-trace/);
  assert.match(migration, /'trigger_error'/);
});

test('rendering escapes member data', () => {
  const html = renderOrderedCopyStart({ live_ready: true, ready_members: [{ user_id: '"x', full_name: '<img src=x>', gate_uid: '7' }], items: [] }, { selected: new Set(['"x']) });
  assert.doesNotMatch(html, /<img src=x>/);
  assert.match(html, /&lt;img src=x&gt;/);
  assert.match(html, /data-ordered-copy-select="&quot;x"/);
});

test('main.js: panel on the active member tab, refreshed by the existing polling, wired buttons and checkboxes', () => {
  assert.match(main, /from '\.\/ordered-copy-start\.js'/);
  assert.match(main, /<section id="adminOrderedCopyStart" class="card admin-ordered-copy" data-member-tab-panel="active" aria-live="polite">/);
  assert.ok(main.indexOf('id="adminOrderedCopyStart"') > main.indexOf('id="pendingMembers"')
    && main.indexOf('id="adminOrderedCopyStart"') < main.indexOf('id="memberList"'), 'between pending approvals and the member directory');
  const polling = main.slice(main.indexOf('function startCopySystemPolling'), main.indexOf('function stopCopySystemPolling'));
  assert.match(polling, /byId\('admin-members'\)\?\.classList\.contains\('active'\)\) loadAdminOrderedCopyStart\(\);/);
  assert.match(polling, /10_000/);
  const load = main.slice(main.indexOf('async function loadAdminMembers'), main.indexOf('function syncAdminOrderedCopySelection'));
  assert.match(load, /loadAdminOrderedCopyStart\(\);/);
  assert.match(load, /renderAdminOrderedCopyStart\(\);/);
  assert.match(main, /if \(event\.target\.closest\('#orderedCopyStart'\)\) await startAdminOrderedCopy\(\);/);
  assert.match(main, /if \(event\.target\.closest\('#orderedCopyCancel'\)\) await cancelAdminOrderedCopy\(\);/);
  assert.match(main, /event\.target\.matches\('\[data-ordered-copy-select\]'\)/);
  assert.match(main, /event\.target\.matches\('\[data-ordered-copy-all\]'\)/);
  assert.match(main, /member\.balance_equity \?\? member\.total_equity/);
  assert.match(main, /ADMIN_ORDERED_COPY_START_ENQUEUED: '가입 순서대로 카피 시작 요청'/);
  assert.match(main, /ADMIN_ORDERED_COPY_START_REQUESTED: '가입 순서 카피 시작 · 회원 시작 요청'/);
  assert.match(main, /ADMIN_ORDERED_COPY_START_CANCELLED: '가입 순서 카피 시작 · 대기 회원 취소'/);
  for (const action of ['ADMIN_ORDERED_COPY_START_ENQUEUED', 'ADMIN_ORDERED_COPY_START_REQUESTED', 'ADMIN_ORDERED_COPY_START_CANCELLED']) {
    assert.match(migration, new RegExp(`'${action}'`));
  }
});

test('styles: panel, mobile card rows and touch targets', () => {
  assert.match(theme, /\.admin-ordered-copy \{/);
  assert.match(theme, /\.ordered-copy-actions \{/);
  const mobile = theme.slice(theme.indexOf('/* 2026-10-30 회원 관리: 가입 순서대로 카피 시작 */'));
  assert.match(mobile, /@media \(max-width: 560px\) \{[\s\S]*\.ordered-copy-table thead \{ display: none; \}/);
  assert.match(mobile, /\.ordered-copy-table td::before \{ content: attr\(data-label\);/);
  assert.match(mobile, /@media \(max-width: 820px\) \{[\s\S]*\.ordered-copy-actions \.btn \{ min-height: 44px; \}/);
});
