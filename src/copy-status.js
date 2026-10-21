// Copy status wording shared by the admin member list and the member page (2026-10-21 QA A2, A1, D8).
// Codes come from get_admin_operations_metrics.copy_status and copy_resume_sessions.blocker_reason.

export const MASTER_PAUSE_REASONS = new Set(['MASTER_TRADING_ACCOUNT_CHANGED', 'MASTER_CREDENTIAL_CHANGED',
  'MASTER_ACCOUNT_CHANGED', 'MASTER_ACCOUNT_CHANGE_PENDING']);

export const ADMIN_COPY_STATUS_META = {
  COPYING: ['카피 중', 'chip', 'Master를 따라 카피하고 있습니다.'],
  NOT_STARTED: ['미시작', 'chip muted', '아직 카피를 시작하지 않았습니다(재개 요청 전).'],
  RESUME_REQUIRED: ['재개 확인 필요', 'chip yellow', '카피 세션이 멈춰 있어 재개 요청과 안전 확인이 필요합니다.'],
  PAUSED: ['일시 정지', 'chip yellow', '회원 또는 관리자가 카피를 일시중지했습니다.'],
  CLOSING: ['정리 중', 'chip yellow', '회원이 요청한 포지션 정리를 진행하고 있습니다.'],
  HALTED: ['중단', 'chip red', '관리자 중단 또는 안전장치로 신규 주문이 중단되었습니다.'],
  REDUCE_ONLY: ['축소 전용', 'chip yellow', '신규 진입은 막고 포지션 축소만 허용합니다.'],
  API_ERROR: ['API 오류', 'chip red', 'Gate API 연결이 확인되지 않거나 키·권한·IP 오류로 계좌 조회가 계속 실패합니다.'],
  READ_ERROR: ['조회 지연', 'chip yellow', '최근 Gate 계좌 조회가 실패했습니다. 계속되면 API 오류로 표시됩니다.'],
  ERROR: ['주문 오류', 'chip red', '주문 또는 포지션 처리 중 오류가 발생했습니다.'],
  ATTENTION: ['확인 필요', 'chip yellow', '회원이 직접 변경한 종목이 있습니다.'],
};

// Status chip for one admin member row: [label, className, title].
export function adminCopyStatus(member, fallback = { label: '상태 확인', className: 'chip yellow' }) {
  const meta = ADMIN_COPY_STATUS_META[member?.copy_status];
  if (!meta) return [fallback.label, fallback.className, fallback.detail || ''];
  if (member.copy_status === 'RESUME_REQUIRED') {
    const checking = ['REQUESTED', 'VALIDATED'].includes(member.session_state) && !member.resume_blocker;
    if (checking) return ['재개 확인 중', 'chip yellow', '재개 안전 확인이 진행 중입니다.'];
    const reason = member.resume_blocker ? ` · ${resumeBlockerGuidance(member.resume_blocker).title}` : '';
    return [MASTER_PAUSE_REASONS.has(member.resume_blocker) ? 'Master 변경으로 정지' : meta[0], meta[1], `${meta[2]}${reason}`];
  }
  if (member.copy_status === 'PAUSED' && member.admin_paused) return ['관리자 일시정지', meta[1], '관리자가 일시중지했습니다. 관리자 재개로만 풀립니다.'];
  if (member.copy_status === 'REDUCE_ONLY' && member.admin_reduce_only) return ['관리자 축소 전용', meta[1], '관리자가 축소 전용으로 설정했습니다. 관리자 재개로만 풀립니다.'];
  if (member.copy_status === 'API_ERROR' && member.read_error_code) return [meta[0], meta[1], `${meta[2]} (${member.read_error_code})`];
  return meta;
}

// API column of the admin member list: a VERIFIED key whose reads keep failing is not "정상".
export function adminApiLabel(member) {
  const status = member?.api_status || member?.connection?.status || 'NOT_CONNECTED';
  if (status === 'VERIFIED' && member?.copy_status === 'API_ERROR') return { label: '조회 실패', ok: false };
  if (status === 'VERIFIED') return { label: '정상', ok: true };
  return { label: status === 'ERROR' ? '권한 오류' : status === 'DISABLED' ? '연결 해제' : '확인 필요', ok: false };
}

const POSITION_MODE_GUIDE = 'Gate.io 선물 설정에서 포지션 모드를 양방향(Hedge)으로 바꾼 뒤 다시 재개를 요청해 주세요. 포지션이나 미체결 주문이 있으면 모드를 바꿀 수 없으니 먼저 정리해야 합니다. 보유 포지션이 없으면 실거래(LIVE) 중 재개 요청 시 자동으로 전환됩니다.';

// Member-facing guidance per resume blocker: { title, detail, action? }.
export const RESUME_BLOCKER_GUIDANCE = {
  RESUME_COPY_SOURCE_MISSING: { title: 'Master가 정리한 카피 포지션이 남아 있음',
    detail: '일시중지 동안 Master가 청산하거나 방향을 바꾼 종목의 카피 포지션이 계정에 남아 있어 재개할 수 없습니다. 그 포지션을 직접 정리한 뒤 다시 요청하거나, 남은 수량을 내 개인 포지션으로 전환하고 재개할 수 있습니다(개인 포지션은 카피가 사고팔지 않습니다).',
    action: 'RECLASSIFY' },
  RESUME_POSITION_MODE_MISMATCH: { title: '포지션 모드가 단방향', detail: POSITION_MODE_GUIDE },
  RESUME_PREVIEW_NOT_ZERO: { title: '재개 시 바로 주문이 필요한 상태',
    detail: '현재 보유 수량이 설정(종목당 최대 비중 등)과 맞지 않아 재개하는 순간 주문이 나가야 합니다. 출금으로 자산이 줄었거나 비중이 바뀐 경우입니다. 초과 수량을 직접 줄이거나 입금·비중 조정 후 다시 요청해 주세요.' },
  RESUME_UNRESOLVED_ORDERS: { title: '이전 주문 결과 확인 대기', detail: '이전 카피 주문의 체결 결과를 확인하고 있습니다. 1~2분 뒤 자동으로 다시 확인합니다.' },
  RESUME_UNRESOLVED_OWNERSHIP: { title: '이전 주문 결과 확인 대기', detail: '이전 카피 주문의 체결 결과를 확인하고 있습니다. 1~2분 뒤 자동으로 다시 확인합니다.' },
  RESUME_OPEN_EXCHANGE_ORDERS: { title: '대기 중인 카피 주문 있음', detail: '거래소에 남은 카피 주문이 정리된 뒤 다시 확인합니다.' },
  RESUME_COPY_OWNERSHIP_UNKNOWN: { title: '카피·개인 수량 구분 불가', detail: '카피 수량과 직접 거래 수량을 구분할 수 없습니다. 관리자에게 문의해 주세요.' },
  RESUME_MEMBER_RISK_HALT: { title: '리스크 한도 도달', detail: '일일 손실 또는 최대 낙폭 한도에 도달한 상태입니다. 한도 기준은 재개 요청 시 현재 자산으로 다시 잡힙니다. 다시 요청해 주세요.' },
  RESUME_CONTRACT_UNAVAILABLE: { title: '거래할 수 없는 종목 보유', detail: '상장폐지 예정 등 거래할 수 없는 종목이 있습니다. 해당 포지션을 정리한 뒤 다시 요청해 주세요.' },
  RESUME_REQUEST_EXPIRED: { title: '재개 요청 시간 초과', detail: '5분 안에 확인을 끝내지 못했습니다. 다시 요청해 주세요.' },
  RESUME_SNAPSHOT_STALE: { title: '계좌 조회 지연', detail: '거래소 조회가 늦어 확인을 마치지 못했습니다. 잠시 후 자동으로 다시 시도합니다.' },
  RESUME_SNAPSHOT_SKEW: { title: '계좌 조회 지연', detail: '거래소 조회가 늦어 확인을 마치지 못했습니다. 잠시 후 자동으로 다시 시도합니다.' },
  RESUME_SNAPSHOT_CHANGED: { title: '확인 중 포지션 변경', detail: '확인하는 동안 포지션이 바뀌었습니다. 자동으로 다시 확인합니다.' },
  RESUME_INVALID_EQUITY: { title: '자산 확인 필요', detail: 'Gate 선물 계정 자산이 0이거나 조회되지 않습니다. 선물 계정에 USDT가 있는지 확인해 주세요.' },
  MASTER_TRADING_ACCOUNT_CHANGED: { title: 'Master 계정 변경으로 일시중지', detail: '운영자의 Master 계정 설정이 바뀌어 카피가 멈췄습니다. 재개를 요청하면 현재 보유 포지션을 유지한 채 다시 시작합니다.' },
  MASTER_CREDENTIAL_CHANGED: { title: 'Master 계정 변경으로 일시중지', detail: '운영자의 Master API 설정이 바뀌어 카피가 멈췄습니다. 재개를 요청하면 현재 보유 포지션을 유지한 채 다시 시작합니다.' },
  MASTER_ACCOUNT_CHANGED: { title: 'Master 계정 교체로 일시중지', detail: 'Master 계정이 바뀌었습니다. 재개하면 현재 보유 포지션은 모두 내 개인 포지션으로 보호되고, 새 Master의 이후 진입부터 카피합니다.' },
  MASTER_ACCOUNT_CHANGE_PENDING: { title: 'Master 계정 교체 중', detail: '새 Master 계정 확인이 끝나면 재개를 요청할 수 있습니다.' },
  ADMIN_PAUSE: { title: '관리자 일시중지', detail: '관리자가 카피를 일시중지했습니다. 재개는 관리자에게 문의해 주세요.' },
  ADMIN_HALT: { title: '관리자 중단', detail: '관리자가 카피를 중단했습니다. 재개는 관리자에게 문의해 주세요.' },
  ADMIN_REDUCE_ONLY: { title: '관리자 축소 전용', detail: '관리자가 축소 전용으로 설정했습니다. 신규 진입은 관리자가 해제해야 가능합니다.' },
  MEMBER_PAUSED: { title: '회원 일시중지', detail: '직접 일시중지했습니다. 카피 재개를 요청하면 다시 시작합니다.' },
  MEMBER_RESTORED: { title: '복구된 계정', detail: 'API를 다시 연결한 뒤 카피 재개를 요청해 주세요. 보유 포지션은 모두 개인 포지션으로 보호됩니다.' },
  GATE_ACCOUNT_CHANGED: { title: 'Gate 계정 변경', detail: '연결한 Gate 계정이 바뀌었습니다. 카피 재개를 요청해 주세요.' },
  GATE_CREDENTIAL_CHANGED: { title: 'API Key 변경', detail: 'API Key가 바뀌었습니다. 검증이 끝나면 카피 재개를 요청해 주세요.' },
  TRADING_ACCOUNT_CHANGED: { title: '계정 상태 변경', detail: '계정 연결 상태가 바뀌었습니다. 카피 재개를 요청해 주세요.' },
};

export function resumeBlockerGuidance(reason) {
  if (!reason) return { title: '재개 확인 필요', detail: '카피 재개를 요청하면 안전 확인 후 다시 시작합니다.' };
  return RESUME_BLOCKER_GUIDANCE[reason]
    || { title: '재개 확인 필요', detail: `재개 안전 확인을 통과하지 못했습니다(${reason}). 잠시 후 다시 요청하거나 관리자에게 문의해 주세요.` };
}
