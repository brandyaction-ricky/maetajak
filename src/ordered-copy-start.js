// Administrator "가입 순서대로 카피 시작" panel (2026-10-30).
// Data: public.get_admin_ordered_copy_start() (supabase/migrations/20261030010000_admin_ordered_copy_start.sql).
import { accountDisplayId } from './account-id.js';
import { resumeBlockerGuidance } from './copy-status.js';

export const ORDERED_COPY_CONFIRMATION = 'ADMIN_ORDERED_COPY_START';
export const ORDERED_COPY_CANCEL_CONFIRMATION = 'ADMIN_ORDERED_COPY_START_CANCEL';

const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (value) => (value == null || !Number.isFinite(Number(value)) ? '-'
  : `$${Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const date = (value) => (value ? new Date(value).toLocaleDateString('ko-KR') : '-');
const time = (value) => (value ? new Date(value).toLocaleString('ko-KR') : '-');

// Queue item states: [label, chip class].
export const ORDERED_COPY_STATE_META = {
  QUEUED: ['대기', 'chip muted'],
  REQUESTED: ['시작 요청', 'chip yellow'],
  ACTIVE: ['카피 중', 'chip'],
  SKIPPED: ['건너뜀', 'chip muted'],
  FAILED: ['실패', 'chip red'],
  CANCELLED: ['취소됨', 'chip muted'],
};

// Readiness / queue reason codes (copy_start_readiness, advance_copy_start_queue). Resume blockers fall back to
// the member-facing resume guidance titles.
export const ORDERED_COPY_REASON_LABELS = {
  NOT_MEMBER: '회원 계정이 아님',
  WITHDRAWN: '탈퇴한 회원',
  NOT_APPROVED: '가입 승인 전',
  MEMBER_HALTED: '카피 중단 상태',
  ADMIN_PAUSED: '관리자 일시정지',
  ADMIN_REDUCE_ONLY: '관리자 축소 전용',
  TRADING_ACCOUNT_NOT_ACTIVE: '거래 계정 비활성',
  GATE_API_NOT_VERIFIED: 'Gate API 검증 전',
  ALREADY_ACTIVE: '이미 카피 중',
  MEMBER_CLOSING: '회원이 포지션 정리를 요청함',
  MEMBER_PAUSED: '회원이 직접 일시중지함',
  NEW_OPERATION_PENDING: '새 운용 시작을 확인 중',
  ADMIN_CANCELLED: '관리자가 취소함',
  STARTED_OUTSIDE_QUEUE: '회원 또는 관리자가 직접 시작함',
  WAITING_FOR_LIVE: '실거래(LIVE)를 기다린 뒤 다시 시작',
  RETRY_AFTER_EXPIRY: '확인 시간이 지나 다시 시작',
  RETRY_TRANSIENT: '일시적인 잠금으로 잠시 후 다시 시작',
  RESUME_SESSION_MISSING: '카피 세션 없음',
  RESUME_REQUIRED: '재개 확인 필요',
  RESUME_PAUSED: '카피 일시중지',
  RESUME_CLOSING: '포지션 정리 중',
  COPY_SETTINGS_CHANGED: '확인 중 회원 리스크 설정 변경',
  MEMBER_CONTROL_CHANGED: '회원 카피 상태 변경',
  MEMBER_WITHDRAWN: '탈퇴한 회원',
  MEMBER_HALTED_OR_NOT_APPROVED: '카피 중단 또는 승인 전',
  ACTIVE_MEMBER_ACCOUNT_REQUIRED: '거래 계정 비활성',
};

export function orderedCopyReasonLabel(reason) {
  if (!reason) return '';
  return ORDERED_COPY_REASON_LABELS[reason] || resumeBlockerGuidance(reason).title;
}

// Why requests wait (copy_start_live_state).
export const ORDERED_COPY_LIVE_LABELS = {
  SYSTEM_CONTROL_MISSING: '실거래 설정 없음',
  EMERGENCY_HALTED: '긴급 중단 상태',
  EXECUTION_DISABLED: '실거래 실행이 꺼져 있음',
  WORKER_NOT_LIVE: 'Trading Worker가 LIVE 모드가 아님',
  WORKER_OFFLINE: 'Trading Worker 응답 없음',
  MASTER_NOT_ACTIVE: 'Master API가 검증·활성 상태가 아님',
};
export const orderedCopyLiveLabel = (reason) => ORDERED_COPY_LIVE_LABELS[reason] || '실거래 준비 안 됨';

const ERRORS = {
  ORDERED_COPY_START_RUNNING: '이미 진행 중인 순서 시작이 있습니다. 끝나거나 대기 회원을 취소한 뒤 다시 시작해 주세요.',
  NO_READY_MEMBERS: '지금 시작할 수 있는 회원이 없습니다. 회원 상태를 다시 확인해 주세요.',
  NO_MEMBERS_SELECTED: '시작할 회원을 선택해 주세요.',
  MASTER_NOT_ACTIVE: 'Master API가 검증·활성 상태가 된 뒤 다시 시도해 주세요.',
  CONFIRMATION_REQUIRED: '확인 절차가 완료되지 않았습니다. 다시 시도해 주세요.',
  ADMIN_REQUIRED: '관리자만 처리할 수 있습니다.',
};
export function orderedCopyError(error, fallback = '요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.') {
  const message = String(error?.message || error || '');
  return Object.entries(ERRORS).find(([code]) => message.includes(code))?.[1] || fallback;
}

export function orderedCopyConfirmText(count, status = {}) {
  const waiting = status && status.live_ready === false
    ? `\n\n지금은 실거래(LIVE) 상태가 아니어서(${orderedCopyLiveLabel(status.live_reason)}) LIVE가 켜질 때까지 대기한 뒤 시작합니다.` : '';
  return `선택한 회원 ${count}명의 카피를 가입 순서대로 시작할까요?\n\n`
    + '• 마스터가 이미 보유한 포지션은 사지 않습니다. 시작한 뒤의 마스터 거래(신규 진입·추가·축소·청산)만 회원 현재 자산 비율대로 따라갑니다.\n'
    + '• 가입이 빠른 회원부터 한 명씩 시작합니다. 앞 회원의 카피가 시작되거나 실패로 끝난 뒤 다음 회원을 시작합니다.\n'
    + '• 차례가 왔을 때 준비되지 않은 회원(API 미검증, 일시중지 등)은 기다리지 않고 건너뜁니다.\n'
    + '• 회원은 지금처럼 직접 카피를 시작할 수도 있습니다.'
    + waiting;
}

export function orderedCopyCancelText(queued) {
  return `대기 중인 회원 ${queued}명의 카피 시작을 취소할까요?\n\n이미 시작을 요청한 회원은 취소되지 않고 결과까지 확인합니다.`;
}

function memberCell(row) {
  const name = row.full_name || accountDisplayId(row.gate_uid, row.email) || '회원';
  return `<b>${escape(name)}</b><small>${escape(accountDisplayId(row.gate_uid, row.email) || '-')}</small>`;
}

function sessionLabel(row) {
  if (row.session_state === 'REQUESTED' || row.session_state === 'VALIDATED') return '재개 확인 중';
  if (row.session_state === 'BLOCKED') return `재개 확인 필요 · ${resumeBlockerGuidance(row.session_blocker).title}`;
  if (row.session_state === 'PAUSED') return row.session_blocker ? `일시정지 · ${resumeBlockerGuidance(row.session_blocker).title}` : '일시정지';
  return '미시작';
}

// What the item is doing right now (REQUESTED: the resume safety check of the worker).
function itemDetail(item) {
  if (item.state === 'REQUESTED') {
    if (item.session_state === 'VALIDATED') return '확인 완료 · 실행 대기';
    return item.session_blocker ? `안전 확인 중 · ${resumeBlockerGuidance(item.session_blocker).title}` : '안전 확인 중';
  }
  if (item.state === 'QUEUED') return item.reason ? orderedCopyReasonLabel(item.reason) : '차례를 기다리는 중';
  if (item.state === 'ACTIVE') return item.reason ? orderedCopyReasonLabel(item.reason) : '카피 시작됨';
  return orderedCopyReasonLabel(item.reason);
}

function progressTable(items) {
  const rows = items.map((item) => {
    const [label, chip] = ORDERED_COPY_STATE_META[item.state] || [item.state, 'chip muted'];
    const at = item.resolved_at || item.requested_at;
    return `<tr class="ordered-copy-item" data-state="${escape(item.state)}"><td data-label="순서">${escape(item.seq)}</td>`
      + `<td data-label="회원">${memberCell(item)}</td>`
      + `<td data-label="상태"><span class="${chip}">${escape(label)}</span></td>`
      + `<td data-label="내용" class="ordered-copy-reason">${escape(itemDetail(item) || '-')}</td>`
      + `<td data-label="시각">${escape(time(at))}</td></tr>`;
  }).join('');
  return `<div class="table"><table class="ordered-copy-table ordered-copy-progress"><thead><tr><th>순서</th><th>회원</th><th>상태</th><th>내용</th><th>시각</th></tr></thead><tbody>${rows || '<tr><td colspan="5" class="empty-cell">진행 내역이 없습니다.</td></tr>'}</tbody></table></div>`;
}

function selectionTable(ready, selected, balances) {
  let order = 0;
  const rows = ready.map((member) => {
    const checked = selected.has(member.user_id);
    const position = checked ? ++order : null;
    const name = member.full_name || accountDisplayId(member.gate_uid, member.email) || '회원';
    return `<tr><td data-label="선택" class="ordered-copy-check"><input type="checkbox" data-ordered-copy-select="${escape(member.user_id)}" aria-label="${escape(`${name} 선택`)}"${checked ? ' checked' : ''}></td>`
      + `<td data-label="시작 순서">${position == null ? '-' : escape(position)}</td>`
      + `<td data-label="회원">${memberCell(member)}</td>`
      + `<td data-label="가입일">${escape(date(member.signup_at))}</td>`
      + `<td data-label="총 자산">${escape(money(balances.get(member.user_id)))}</td>`
      + `<td data-label="현재 상태" class="ordered-copy-reason">${escape(sessionLabel(member))}</td></tr>`;
  }).join('');
  const all = ready.length > 0 && ready.every((member) => selected.has(member.user_id));
  return `<div class="table"><table class="ordered-copy-table ordered-copy-select"><thead><tr><th class="ordered-copy-check"><input type="checkbox" data-ordered-copy-all aria-label="전체 선택"${all ? ' checked' : ''}></th><th>시작 순서</th><th>회원</th><th>가입일</th><th>총 자산</th><th>현재 상태</th></tr></thead><tbody>${rows || '<tr><td colspan="6" class="empty-cell">지금 카피를 시작할 수 있는 회원이 없습니다.</td></tr>'}</tbody></table></div>`;
}

// HTML of the whole panel. selected: Set of user ids; balances: Map user id → 총 자산 (balance_equity).
export function renderOrderedCopyStart(data, { selected = new Set(), balances = new Map(), busy = false, now = Date.now() } = {}) {
  const ready = Array.isArray(data?.ready_members) ? data.ready_members : [];
  const notReady = Array.isArray(data?.not_ready_members) ? data.not_ready_members : [];
  const items = Array.isArray(data?.items) ? data.items : [];
  const running = Boolean(data?.running);
  const queued = items.filter((item) => item.state === 'QUEUED').length;
  const done = items.filter((item) => !['QUEUED', 'REQUESTED'].includes(item.state)).length;
  const selectedCount = ready.filter((member) => selected.has(member.user_id)).length;
  const chip = running ? `<span class="chip yellow">진행 중 ${done}/${items.length}</span>`
    : `<span class="${ready.length ? 'chip' : 'chip muted'}">시작 가능 ${ready.length}명</span>`;
  const head = `<div class="panel-title"><div><h3>가입 순서대로 카피 시작</h3><p>카피를 시작하지 않은 회원을 가입이 빠른 순서대로 한 명씩 시작합니다.</p></div>${chip}</div>`
    + '<p class="ordered-copy-policy">마스터가 이미 보유한 포지션은 사지 않고, 시작한 뒤의 마스터 거래만 회원 자산 비율대로 따라갑니다. 앞 회원의 카피가 시작되거나 실패로 끝나면 다음 회원을 시작하고, 준비되지 않은 회원은 건너뜁니다.</p>';
  let live = '';
  if (data && data.live_ready === false) {
    live = `<div class="notice warn-box ordered-copy-live" role="status"><b>${running ? '실거래(LIVE) 대기 중' : '지금은 실거래(LIVE)가 아닙니다'}</b> · ${escape(orderedCopyLiveLabel(data.live_reason))}. `
      + `${running ? 'LIVE가 켜지면 대기 중인 회원부터 이어서 시작합니다.' : '시작하면 LIVE가 켜질 때까지 대기합니다.'}</div>`;
  }
  // A progress check the session trigger had to skip (it never fails the worker); the per-minute job catches up.
  const triggerError = data?.trigger_error;
  if (running && triggerError?.at && now - Date.parse(triggerError.at) < 10 * 60_000) {
    live += `<p class="ordered-copy-trace" role="status">최근 자동 진행 확인이 한 번 지연되었습니다(${escape(triggerError.code || '-')}). 1분마다 다시 확인합니다.</p>`;
  }
  let body;
  if (running) {
    body = progressTable(items)
      + `<div class="ordered-copy-actions">${queued ? `<button id="orderedCopyCancel" class="btn red" type="button"${busy ? ' disabled' : ''}>대기 중인 ${queued}명 취소</button>` : ''}`
      + '<small>진행 중에는 새로 시작할 수 없습니다. 목록은 자동으로 새로고침됩니다.</small></div>';
  } else {
    body = selectionTable(ready, selected, balances)
      + `<div class="ordered-copy-actions"><button id="orderedCopyStart" class="btn green" type="button"${busy || !selectedCount ? ' disabled' : ''}>선택한 ${selectedCount}명 카피 시작</button>`
      + '<small>가입일 순서대로 한 명씩 시작합니다. 회원이 직접 시작할 수도 있습니다.</small></div>';
    if (items.length) body += `<details class="ordered-copy-history"><summary>최근 진행 결과 (${items.length}명)</summary>${progressTable(items)}</details>`;
  }
  const blocked = notReady.length ? `<details class="ordered-copy-not-ready"><summary>준비되지 않은 회원 ${notReady.length}명</summary><ul>${notReady.map((member) => `<li>${memberCell(member)}<span>${escape(orderedCopyReasonLabel(member.reason))}</span></li>`).join('')}</ul></details>` : '';
  return head + live + body + blocked;
}
