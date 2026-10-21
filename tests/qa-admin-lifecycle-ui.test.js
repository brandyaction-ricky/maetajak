import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { adminApiLabel, adminCopyStatus, ADMIN_COPY_STATUS_META, MASTER_PAUSE_REASONS, resumeBlockerGuidance, RESUME_BLOCKER_GUIDANCE } from '../src/copy-status.js';

// 2026-10-21 QA UI (A1 A2 A3 A4 A6 A7 D3 D8 D9 D10, terms text).
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const main = read('src/main.js');
const theme = read('src/prototype-theme.css');
const migration = read('supabase/migrations/20261021032000_qa_admin_lifecycle.sql');
const rpcParams = (name) => {
  const match = main.match(new RegExp(`supabase\\.rpc\\('${name}', \\{([^}]*)\\}`));
  assert.ok(match, `${name} is called`);
  return [...match[1].matchAll(/(p_[a-z_]+):/g)].map((m) => m[1]);
};
const sqlParams = (name) => {
  const match = migration.match(new RegExp(`create or replace function public\\.${name}\\(([^)]*)\\)`));
  assert.ok(match, `${name} is defined`);
  return match[1].split(',').map((arg) => arg.trim().split(/\s+/)[0]);
};

test('A2 admin copy status: every RPC code has a Korean label; session and read-error states are not 카피 중', () => {
  for (const code of ['COPYING', 'NOT_STARTED', 'RESUME_REQUIRED', 'PAUSED', 'CLOSING', 'HALTED', 'REDUCE_ONLY', 'API_ERROR', 'READ_ERROR', 'ERROR', 'ATTENTION']) {
    assert.ok(ADMIN_COPY_STATUS_META[code], code);
    assert.match(migration, new RegExp(`'${code}'`), `${code} is produced by get_admin_operations_metrics`);
  }
  assert.deepEqual(adminCopyStatus({ copy_status: 'NOT_STARTED' }).slice(0, 2), ['미시작', 'chip muted']);
  assert.equal(adminCopyStatus({ copy_status: 'RESUME_REQUIRED', session_state: 'PAUSED', resume_blocker: 'MASTER_CREDENTIAL_CHANGED' })[0], 'Master 변경으로 정지');
  assert.equal(adminCopyStatus({ copy_status: 'RESUME_REQUIRED', session_state: 'BLOCKED', resume_blocker: 'RESUME_PREVIEW_NOT_ZERO' })[0], '재개 확인 필요');
  assert.equal(adminCopyStatus({ copy_status: 'RESUME_REQUIRED', session_state: 'REQUESTED' })[0], '재개 확인 중');
  assert.equal(adminCopyStatus({ copy_status: 'API_ERROR', read_error_code: 'MEMBER_ACCOUNT_READ_INVALID_CREDENTIALS' })[0], 'API 오류');
  assert.equal(adminCopyStatus({ copy_status: 'PAUSED', admin_paused: true })[0], '관리자 일시정지');
  assert.equal(adminCopyStatus({ copy_status: 'REDUCE_ONLY', admin_reduce_only: true })[0], '관리자 축소 전용');
  assert.equal(adminCopyStatus({}, { label: '연결 완료', className: 'chip yellow' })[0], '연결 완료');
  assert.deepEqual(adminApiLabel({ api_status: 'VERIFIED', copy_status: 'API_ERROR' }), { label: '조회 실패', ok: false });
  assert.deepEqual(adminApiLabel({ api_status: 'VERIFIED', copy_status: 'COPYING' }), { label: '정상', ok: true });
  assert.match(main, /const status = adminCopyStatus\(member, member\.fallback_progress \|\| undefined\);/);
  assert.match(main, /const api = adminApiLabel\(member\);/);
  assert.doesNotMatch(main, /COPYING: \['카피 중', 'chip'\], PAUSED:/, 'the old profile-only status map is gone');
});

test('A1 Master-caused pause: notice with the bulk resume action, pending key state on the Master API card', () => {
  for (const reason of MASTER_PAUSE_REASONS) assert.match(migration, new RegExp(`'${reason}'`));
  assert.deepEqual(rpcParams('admin_request_all_member_copy_resume'), ['p_confirmation']);
  assert.match(main, /p_confirmation: 'ADMIN_RESUME_MEMBERS_PAUSED_BY_MASTER'/);
  assert.match(migration, /'ADMIN_RESUME_MEMBERS_PAUSED_BY_MASTER'/);
  assert.match(main, /<button id="adminBulkResume" class="btn" type="button">전체 회원 카피 재개 요청<\/button>/);
  assert.match(main, /adminPausedByMaster = Number\(metricsResult\.data\?\.totals\?\.paused_by_master \|\| 0\)/);
  assert.match(main, /자동으로 재개되지 않습니다/);
  assert.match(main, /검증 중 · 검증이 끝날 때까지 기존 Key로 카피를 계속합니다\./);
  assert.match(main, /검증 실패: \$\{errorMessages\[connection\.pending_error_code\]/);
  assert.match(main, /Master UID를 \$\{storedUid\}에서 \$\{gateUid\}\(으\)로 바꿀까요\?/);
  assert.match(main, /MEMBERS_PAUSED_BY_MASTER: 'Master 변경으로 회원 카피 일시중지'/);
  assert.match(theme, /\.admin-master-pause-notice \{/);
  assert.match(theme, /\.admin-master-pending \{/);
});

test('A3 the admin member disconnect call matches the SQL signature', () => {
  assert.deepEqual(rpcParams('admin_disable_member_gate_api_connection'), sqlParams('admin_disable_member_gate_api_connection'));
  assert.match(main, /p_confirmation: 'ADMIN_DISCONNECT_MEMBER_GATE_API'/);
  assert.match(migration, /grant execute on function public\.admin_disable_member_gate_api_connection\(uuid, text\) to authenticated;/);
});

test('A4 UID release: withdrawn tab and member detail buttons call release_member_gate_uid with confirmation', () => {
  assert.deepEqual(rpcParams('release_member_gate_uid'), sqlParams('release_member_gate_uid'));
  assert.match(main, /p_confirmation: 'RELEASE_MEMBER_GATE_UID'/);
  assert.match(main, /data-member-release-uid="\$\{escapeHtml\(member\.id\)\}"/);
  assert.match(main, /data-member-release-uid="\$\{escapeHtml\(userId\)\}"/);
  assert.match(main, /UID 해제됨 · 다른 사람이 이 UID로 가입할 수 있습니다/);
  assert.match(main, /admin_paused,admin_reduce_only,released_gate_uid,created_at/);
  assert.match(main, /MEMBER_GATE_UID_RELEASED: '회원 가입 UID 해제'/);
});

test('A7/withdrawal dialogs tell the admin what the member can no longer see and what restore resets', () => {
  assert.match(main, /회원은 탈퇴 후 로그인할 수 없어 이 서비스에서 남은 포지션을 확인할 수 없습니다\. Gate\.io에서 직접 확인·정리하도록 미리 안내해 주세요\./);
  assert.match(main, /Gate API를 한 번도 검증하지 않은 계정은 가입 UID가 해제되어/);
  assert.match(main, /재개 시 보유 포지션은 모두 회원 개인 포지션으로 보호됩니다/);
});

test('D3 admin restrictions: member sees why and the admin is told only an admin RESUME lifts them', () => {
  assert.match(main, /if \(currentProfile\.admin_paused\) return withReason\(currentProfile\.member_halted \? 'ADMIN_HALT' : 'ADMIN_PAUSE'\);/);
  assert.match(main, /if \(currentProfile\.admin_reduce_only\) return withReason\('ADMIN_REDUCE_ONLY'\);/);
  assert.match(main, /ADMIN_PAUSED: '관리자가 일시중지한 계정입니다\. 재개는 관리자에게 문의해 주세요\.'/);
  assert.match(main, /관리자가 건 제한은 회원이 직접 풀 수 없고, 관리자 재개로만 해제됩니다\./);
});

test('D8 per-blocker guidance and the explicit reclassify action for RESUME_COPY_SOURCE_MISSING', () => {
  assert.equal(resumeBlockerGuidance('RESUME_COPY_SOURCE_MISSING').action, 'RECLASSIFY');
  assert.match(resumeBlockerGuidance('RESUME_POSITION_MODE_MISMATCH').detail, /양방향\(Hedge\)/);
  assert.match(resumeBlockerGuidance('RESUME_POSITION_MODE_MISMATCH').detail, /실거래\(LIVE\)/);
  assert.match(resumeBlockerGuidance('RESUME_PREVIEW_NOT_ZERO').detail, /초과 수량을 직접 줄이거나/);
  assert.match(resumeBlockerGuidance('SOMETHING_NEW').detail, /SOMETHING_NEW/);
  for (const reason of Object.keys(RESUME_BLOCKER_GUIDANCE)) assert.ok(RESUME_BLOCKER_GUIDANCE[reason].title && RESUME_BLOCKER_GUIDANCE[reason].detail, reason);
  assert.deepEqual(rpcParams('request_my_copy_resume_reclassify'), sqlParams('request_my_copy_resume_reclassify'));
  assert.match(main, /p_confirmation: 'RECLASSIFY_UNMATCHED_COPY_AS_PERSONAL'/);
  assert.match(main, /<button class="btn" type="button" data-copy-resume-reclassify hidden>남은 카피 포지션을 내 포지션으로 전환하고 재개<\/button>/);
  assert.match(main, /if \(reclassify\) reclassify\.hidden = guidance\.action !== 'RECLASSIFY';/);
  assert.match(main, /전환 내역은 기록되며 되돌릴 수 없습니다/);
  assert.match(main, /resumeBlockerGuidance\(waiting\.reason\)\.title/);
  assert.match(theme, /\.pause-resume-guidance \{/);
});

test('D9 the CLOSE confirmation states that every futures position, personal ones included, is closed', () => {
  assert.match(main, /직접 연 개인 포지션을 포함해 Gate 선물 계정의 모든 포지션을 시장가로 정리합니다\./);
  assert.match(main, /data-copy-pause="CLOSE">카피 중지 \+ 계정 전체 포지션 정리<\/button>/);
  assert.match(main, /data-copy-pause-confirm="CLOSE">카피 중지 및 전체 포지션 정리 실행<\/button>/);
});

test('D10 / A6 member notices: withdrawals shrink the cap and can sell copy, deposits refill; Hedge mode required', () => {
  assert.match(main, /종목당 최대 비중 한도도 함께 줄어, 한도를 넘는 카피 수량은 Master 변화가 없어도 매도될 수 있습니다\. 다시 입금하면 줄었던 수량이 Master 기준까지 다시 채워질 수 있습니다\./);
  assert.match(main, /Gate\.io 선물 포지션 모드는 양방향\(Hedge\)이어야 합니다\./);
  assert.match(theme, /\.copy-fund-policy/);
});

test('terms: direct trading keeps copying and the next copy entry re-applies the Master leverage', () => {
  const terms = main.slice(main.indexOf('<h3>3. 직접 거래와 MANUAL_OVERRIDE</h3>'), main.indexOf('<h3>4. 체결·시스템 위험</h3>'));
  assert.match(terms, /카피는 계속됩니다/);
  assert.match(terms, /다음 카피 진입 때 Master 레버리지가 다시 적용되며/);
  assert.doesNotMatch(terms, /카피를 중지하고 자동 재진입하지 않을 수 있습니다/);
  assert.doesNotMatch(main, /이 종목의 자동 카피를 멈췄습니다/);
});
