import { createClient } from '@supabase/supabase-js';
import { getAccessDecision } from './access.js';
import { createNewOperationPanel } from './new-operation.js';
import { accountDisplayId, isValidGateUid, loginIdToEmail } from './account-id.js';
import './prototype-theme.css';

// The prototype stylesheet is the single visual source of truth.
document.head.querySelector(':scope > style')?.remove();

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
const configured = Boolean(supabaseUrl && supabaseAnonKey);
const workerPublicIp = import.meta.env.VITE_TRADING_WORKER_IP || '';
const LEGAL_VERSION = '2026-08-21-v1';
const supabase = configured
  ? createClient(supabaseUrl, supabaseAnonKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    })
  : null;

const pages = {
  'member-dashboard': ['대시보드', '카피 상태와 계정 현황을 확인합니다.'],
  'member-trades': ['현재 포지션', '내 계정에 복사된 실제 포지션과 카피 상태를 확인합니다.'],
  'member-analysis': ['수익 분석', '카피 시작일 이후 실제 선물 거래 성과를 분석합니다.'],
  'member-copy': ['카피트레이딩 설정', '카피 비율과 리스크 한도를 관리합니다.'],
  'member-account': ['계정 설정', 'API 연결·보안·계정을 관리합니다.'],
  'admin-dashboard': ['대시보드', 'Master와 전체 회원의 운영 상태를 확인합니다.'],
  'admin-members': ['회원 관리', '가입 승인과 회원 리스트를 관리합니다.'],
  'admin-member-analysis': ['수익 관리', '회원별·기간별 카피트레이딩 수익을 조회합니다.'],
  'admin-api': ['API 연결 현황', '회원별 Gate.io API 상태를 확인합니다.'],
  'admin-audit': ['감사 기록', '관리자 작업 이력과 회원별 주문 체결·차단 현황을 확인합니다.'],
  'admin-settings': ['운영 상태', '실거래 실행 상태, Trading Worker, 긴급 중단을 관리합니다.'],
};

// All business dates (daily PnL, "today", "this month") are cut in Korea Standard Time.
// The server RPCs use (now() at time zone 'Asia/Seoul')::date, so the client must match.
const KST_DATE_FORMAT = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' });
function kstDate(date = new Date()) {
  const parts = Object.fromEntries(KST_DATE_FORMAT.formatToParts(date).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
function kstDateOffset(days, from = new Date()) {
  return kstDate(new Date(from.getTime() + days * 86_400_000));
}
function toKstDate(value) {
  if (!value) return '';
  const text = String(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? text.slice(0, 10) : kstDate(date);
}

// Share in-flight (and very recent) read RPCs so one screen transition never fires the
// same heavy query several times in parallel.
const sharedRpcCache = new Map();
function sharedRpc(name, params = undefined, { maxAgeMs = 1500 } = {}) {
  const key = `${name}:${JSON.stringify(params ?? null)}`;
  const cached = sharedRpcCache.get(key);
  if (cached && (cached.pending || Date.now() - cached.at < maxAgeMs)) return cached.promise;
  const entry = { pending: true, at: Date.now(), promise: null };
  entry.promise = Promise.resolve(params === undefined ? supabase.rpc(name) : supabase.rpc(name, params))
    .then((result) => {
      entry.pending = false;
      entry.at = Date.now();
      if (result?.error) sharedRpcCache.delete(key);
      return result;
    }, (error) => {
      sharedRpcCache.delete(key);
      return { data: null, error };
    });
  sharedRpcCache.set(key, entry);
  return entry.promise;
}
function invalidateSharedRpc(...names) {
  for (const key of [...sharedRpcCache.keys()]) if (!names.length || names.some((name) => key.startsWith(`${name}:`))) sharedRpcCache.delete(key);
}

const byId = (id) => document.getElementById(id);
let currentProfile = null;
let authBusy = false;
let gateApiBusy = false;
let gateStatusTimer = null;
let memberDetailBusy = false;
let adminMasterPositions = [];
let adminMasterFilter = 'ALL';
let adminPositionOwner = 'MASTER';
let adminMemberPositions = [];
let adminPositionMembers = [];
let adminGateApiBusy = false;
let memberAnalysisBusy = false;
let memberTradingAnalysisData = null;
let adminAnalysisSelectedUserId = '';
let adminAnalysisRangeDays = 30;
let adminAnalysisMembers = [];
let copySystemTimer = null;
let selectedMemberId = null;
let passwordBusy = false;
let passwordRecoveryMode = false;
let adminPasswordResetBusy = false;
let memberDashboardRange = 30;
let memberDashboardMetric = 'PNL';
let memberDashboardPerformance = null;
let memberCumulativePerformance = null;
let memberMonthPerformance = null;
let memberLiveSnapshot = null;
let adminOperationsRange = 30;
let adminOperationsMetrics = null;
let adminMembersCache = [];
let adminMasterAccount = null;
let adminMemberSearch = '';
let adminWithdrawnCache = [];
let adminMemberTab = 'active';
let adminWithdrawBusy = false;
let newOperationPanel = null;
let copySettingsBaseline = null;
let copySettingsBusy = false;
let copyPauseBusy = false;
let memberGateConnection = null;
let memberGateConnectionLoaded = false;
let memberSystemStatus = null;
let memberResumeWaiting = null;
let memberLiveLoadFailed = false;
let adminLiveActions = null;
let adminControlBusy = false;
let adminWeightBusy = false;
let disconnectBusy = false;
let adminExecutionRequestSeq = 0;
let adminAnalysisRequestSeq = 0;
let adminOperationsRequestSeq = 0;
let adminMembersRequestSeq = 0;
let recoveryPasswordBusy = false;
const modalReturnFocus = new Map();

function extendCopySettingOptions() {
  const selects = [...document.querySelectorAll('select')];
  const addOption = (select, label) => {
    if (select && ![...select.options].some((option) => option.textContent.trim() === label)) {
      select.add(new Option(label, label));
    }
  };
  const copyRatio = selects.find((select) => [...select.options].some((option) => option.textContent.trim() === '150%'));
  const maxPositionRatio = selects.find((select) => [...select.options].some((option) => option.textContent.trim() === '40%'));
  addOption(copyRatio, '200%');
  addOption(maxPositionRatio, '20%');
  if (copyRatio) copyRatio.id = 'copyRatioSelect';
  if (maxPositionRatio) maxPositionRatio.id = 'maxPositionRatioSelect';
  const saveButton = document.querySelector('#member-copy .form > .btn.primary');
  if (saveButton) {
    saveButton.id = 'copySettingsSave';
    saveButton.type = 'button';
  }
}

function enhanceGateApiForm() {
  const cards = document.querySelectorAll('#member-account .card');
  const connectionCard = cards[0];
  const securityCard = cards[1];
  const accountCard = cards[3];
  if (!connectionCard || !securityCard) return;

  connectionCard.innerHTML = `
    <div class="section-head"><h3>Gate.io API 연결</h3><span id="gateConnectionStatus" class="chip yellow">미연결</span></div>
    <form id="gateApiForm" class="form" autocomplete="off">
      <div class="field"><label for="gateUid">Gate.io UID</label><input id="gateUid" inputmode="numeric" autocomplete="off" placeholder="Gate.io UID 입력" aria-describedby="gateUidHint" required><small id="gateUidHint" class="field-hint hidden">가입한 Gate.io UID로 고정됩니다. 이 UID 계정에서 발급한 API만 연결할 수 있습니다.</small></div>
      <div class="field"><label for="gateApiKey">API Key</label><input id="gateApiKey" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="API Key 입력" required></div>
      <div class="field"><label for="gateSecretKey">Secret Key</label><input id="gateSecretKey" type="password" autocomplete="new-password" autocapitalize="off" spellcheck="false" placeholder="Secret Key 입력" required></div>
      <label class="permission-check"><input id="gatePermissionConfirmed" type="checkbox" required><span>Trading Account · Perpetual Futures Read/Write만 허용하고 출금 권한은 사용하지 않았습니다.</span></label>
      <div class="credential-actions"><button id="gateApiConnect" class="btn primary" type="submit">저장 및 연결 검증</button><button id="gateApiDisconnect" class="btn red" type="button">API 연결 해제</button></div>
    </form>
    <p class="secret-warning">Secret Key는 화면이나 브라우저 저장소에 보관하지 않고 서버에서 암호화해 저장합니다.</p>
  `;

  securityCard.innerHTML = `
    <div class="section-head"><h3>API 보안 체크</h3></div>
    <div class="metric"><span>Futures Read</span><b id="gateFuturesRead" class="warn">확인 대기</b></div>
    <div class="metric"><span>Futures Trade</span><b id="gateFuturesTrade" class="warn">사용자 확인 필요</b></div>
    <div class="metric"><span>Worker IP 접속</span><b id="gateIpWhitelist" class="warn">검증 대기</b></div>
    <div class="metric"><span>Withdrawal</span><b id="gateWithdrawal" class="warn">사용자 확인 필요</b></div>
    <p id="gateVerificationDetail" class="verification-detail">실제 연결 검증 전입니다.</p>
  `;
  const notificationCard = cards[2];
  if (notificationCard) notificationCard.remove();
  if (accountCard) accountCard.innerHTML = `
    <div class="section-head"><div><h3>계정 정보</h3><p>회원정보와 로그인 비밀번호를 관리합니다.</p></div></div>
    <div class="field"><label for="accountName">이름</label><input id="accountName" readonly></div>
    <div class="field"><label for="accountEmail">아이디</label><input id="accountEmail" readonly></div>
    <form id="nicknameForm" class="form account-nickname-form" autocomplete="off"><div class="field"><label for="accountNickname">닉네임</label><input id="accountNickname" minlength="2" maxlength="20" placeholder="2~20자 닉네임" required></div><button id="nicknameSaveButton" class="btn" type="submit">닉네임 저장</button></form>
    <div class="account-password-divider"></div>
    <div id="passwordRecoveryNotice" class="notice password-recovery-notice hidden">재설정 링크가 확인되었습니다. 새 비밀번호를 입력해 주세요.</div>
    <p class="account-password-help">관리자에게 임시 비밀번호를 받았다면 현재 비밀번호 칸에 입력하고 새 비밀번호로 변경해 주세요. 비밀번호를 잊으셨다면 관리자에게 문의하세요.</p>
    <form id="passwordChangeForm" class="form password-change-form" autocomplete="off">
      <div id="currentPasswordField" class="field"><label for="currentPassword">현재 비밀번호</label><input id="currentPassword" type="password" autocomplete="current-password" minlength="8" placeholder="현재 비밀번호"></div>
      <div class="field"><label for="newPassword">새 비밀번호</label><input id="newPassword" type="password" autocomplete="new-password" minlength="8" placeholder="8자 이상 새 비밀번호" required></div>
      <div class="field"><label for="newPasswordConfirm">새 비밀번호 확인</label><input id="newPasswordConfirm" type="password" autocomplete="new-password" minlength="8" placeholder="새 비밀번호 다시 입력" required></div>
      <button id="passwordChangeButton" class="btn primary" type="submit">비밀번호 변경</button>
    </form>`;
}

function enhancePauseModal() {
  const modal = document.querySelector('#pauseModal .modal');
  if (!modal || byId('pauseModalClose')) return;
  modal.classList.add('pause-modal');
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-labelledby', 'pauseModalTitle');
  modal.insertAdjacentHTML('afterbegin', '<button id="pauseModalClose" class="modal-close" type="button" aria-label="일시중지 창 닫기" data-pause-close>×</button>');
  const title = modal.querySelector('h3');
  if (title) {
    title.id = 'pauseModalTitle';
    title.textContent = '카피 관리';
  }
  const description = title?.nextElementSibling;
  if (description?.tagName === 'P') {
    description.removeAttribute('style');
    description.className = 'pause-modal-status';
    description.innerHTML = '<span class="pause-modal-status-label">현재 상태</span><b id="pauseModalStatus">확인 중</b><small id="pauseModalPositions">보유 포지션 확인 중</small>';
  }
  const actions = modal.querySelector('.form');
  if (actions) {
    actions.id = 'pauseModalActions';
    actions.innerHTML = `
    <button class="btn" type="button" data-copy-pause="HOLD">신규 카피만 중지 · 현재 포지션 유지</button>
    <button class="btn red" type="button" data-copy-pause="CLOSE">카피 중지 + 현재 포지션 정리</button>
    <button class="btn green" type="button" data-copy-pause="RESUME">카피 재개</button>`;
    actions.insertAdjacentHTML('afterend', `<div id="pauseCloseConfirm" class="pause-close-confirm hidden" role="alertdialog" aria-labelledby="pauseCloseConfirmTitle" aria-describedby="pauseCloseConfirmDetail">
      <b id="pauseCloseConfirmTitle">포지션 정리를 한 번 더 확인해 주세요</b>
      <p id="pauseCloseConfirmDetail">-</p>
      <div class="actions"><button class="btn" type="button" data-copy-pause-cancel>취소</button><button class="btn red" type="button" data-copy-pause-confirm="CLOSE">카피 중지 및 포지션 정리 실행</button></div>
    </div>`);
  }
}

function enhanceNavigationAndHeader() {
  document.querySelector('[data-page="admin-master"]')?.remove();
  byId('admin-master')?.remove();
  document.querySelector('[data-page="admin-monitor"]')?.remove();
  byId('admin-monitor')?.remove();
  document.querySelector('[data-page="admin-events"]')?.remove();
  byId('admin-events')?.remove();
  const auditNav = document.querySelector('[data-page="admin-audit"]');
  if (auditNav) auditNav.textContent = '감사 기록 · 체결 현황';
  const settingsNav = document.querySelector('[data-page="admin-settings"]');
  if (settingsNav) settingsNav.textContent = '운영 상태';
  const tradesNav = document.querySelector('[data-page="member-trades"]');
  if (tradesNav) tradesNav.textContent = '현재 포지션';
  const leading = document.querySelector('.top > div:first-child');
  if (!leading || leading.classList.contains('top-leading')) return;
  const title = byId('title');
  const subtitle = byId('subtitle');
  if (!title || !subtitle) return;
  const copy = document.createElement('div');
  copy.className = 'top-copy';
  leading.classList.add('top-leading');
  copy.append(title, subtitle);
  leading.append(copy);
}

function enhanceOperationsStatusUi() {
  document.querySelector('[data-page="admin-risk"]')?.remove();
  const memberStatus = document.querySelector('#member-dashboard > .status');
  if (memberStatus) memberStatus.innerHTML = '<div><span id="memberSystemDot" class="dot"></span><b id="memberSystemTitle">운영 상태 확인 중</b><div><span id="memberSystemDetail">Worker와 주문 안전 상태를 불러오고 있습니다.</span></div></div><button class="btn red" type="button" data-open-pause>카피 관리</button>';
  const adminStatus = document.querySelector('#admin-dashboard > .status');
  if (adminStatus) adminStatus.innerHTML = '<div><span id="adminSystemDot" class="dot"></span><b id="adminSystemTitle">운영 상태 확인 중</b><div><span id="adminSystemDetail">Worker heartbeat를 확인하고 있습니다.</span></div></div>';
  const settings = byId('admin-settings');
  if (settings) settings.innerHTML = `
    <div class="grid half operations-grid">
      <div class="card section"><div class="section-head"><h3>실거래 실행 상태</h3><span id="opsExecutionChip" class="chip yellow">확인 중</span></div>
        <div class="metric"><span>주문 실행</span><b id="opsExecution">-</b></div><div class="metric"><span>비상 중단</span><b id="opsHalt">-</b></div><div class="metric"><span>중단 사유</span><b id="opsReason">-</b></div><div class="metric"><span>최종 변경</span><b id="opsUpdated">-</b></div></div>
      <div class="card section"><div class="section-head"><h3>Trading Worker</h3><span id="opsWorkerChip" class="chip yellow">미연결</span></div>
        <div class="metric"><span>모드</span><b id="opsWorkerMode">OBSERVE</b></div><div class="metric"><span>고정 IP</span><b id="opsWorkerIp">미설정</b></div><div class="metric"><span>브로커 채널</span><b id="opsBrokerChannel">미설정</b></div><div class="metric"><span>마지막 응답</span><b id="opsHeartbeat">없음</b></div><div class="metric"><span>마지막 정상 주기</span><b id="opsLastSuccess">없음</b></div><div class="metric"><span>연속 실패</span><b id="opsFailures">0</b></div><div class="metric"><span>준비 테스트</span><b id="opsTest">미완료</b></div></div>
    </div>
    <div class="card section operations-emergency"><div class="section-head"><div><h3>긴급 제어</h3><p>긴급 중단은 신규 주문을 즉시 차단합니다. 미확정 주문은 계속 조회합니다.</p></div></div><div class="actions"><button id="adminEmergencyHalt" class="btn red" type="button">전체 카피 긴급 중단</button></div></div>
    <div class="notice warn-box operations-note">브라우저에서는 실거래를 켤 수 없습니다. 고정 IP Worker, Master·회원 API 검증, 준비 테스트가 완료된 뒤 서버 배포 명령으로만 활성화됩니다.</div>`;
  const risk = byId('admin-risk');
  if (risk) risk.remove();
}

function enhanceLiveDataUi() {
  const memberDashboard = byId('member-dashboard');
  if (memberDashboard) memberDashboard.innerHTML = `<div class="status dashboard-live-status"><div><span id="memberSystemDot" class="dot"></span><b id="memberSystemTitle">운영 상태 확인 중</b><div><span id="memberSystemDetail">Worker와 주문 안전 상태를 불러오고 있습니다.</span></div></div><div class="dashboard-live-meta"><span id="memberCopyStartedAt">카피 시작일 확인 중</span><button class="btn red" type="button" data-open-pause>카피 관리</button></div></div>
    <div class="member-dashboard-kpis"><div class="card kpi"><label>누적 수익</label><strong id="memberCumulativePnl">-</strong><small>카피 시작일 이후</small></div><div class="card kpi"><label>이번 달 수익</label><strong id="memberMonthPnl">-</strong><small id="memberMonthPeriod">이번 달</small></div><div class="card kpi"><label>누적 수익률</label><strong id="memberCumulativeRoi">-</strong><small>입출금 효과 제외</small></div><div class="card kpi"><label>현재 계좌</label><strong id="memberLiveEquity">-</strong><small>USDT 기준</small></div><div class="card kpi"><label>증거금 사용률</label><strong id="memberDashboardMarginUsage">-</strong><div class="member-margin-track"><i id="memberMarginBar"></i></div><small id="memberUsedMargin">사용 증거금 -</small></div></div>
    <div class="member-dashboard-main"><section class="card member-pnl-panel"><div class="panel-title"><div><h3>누적 PNL</h3><p>카피 시작 이후 실제 트레이딩 손익</p></div><div class="member-period-tabs" role="group" aria-label="성과 조회 기간">${[7, 30, 90, 180].map((days) => `<button type="button" data-dashboard-range="${days}" class="${days === 30 ? 'active' : ''}" aria-pressed="${days === 30}">${days}일</button>`).join('')}</div></div><strong id="memberPerformanceValue" class="member-performance-value">집계 대기</strong><div id="memberPerformanceChart" class="member-performance-chart"><div class="member-chart-empty">Trading Worker가 성과를 집계하면 차트가 표시됩니다.</div></div><div class="member-performance-foot"><span id="memberPerformancePeriod">-</span><span>입출금 제외 · 수수료·펀딩 반영</span></div></section>
      <aside class="card member-risk-panel"><div class="panel-title"><div><h3>내 위험 상태</h3><p>현재 설정 대비 사용 수준</p></div></div><div class="risk-status-row"><div><b>종목당 최대 포지션</b><small id="memberPositionCapUsage">현재 사용 -</small></div><strong id="memberPositionCapLimit">-</strong></div><div class="risk-status-row"><div><b>일일 최대 손실</b><small id="memberDailyLossUsage">오늘 사용 -</small></div><strong id="memberDailyLossLimit">-</strong></div><div class="risk-status-row"><div><b>최대 드로우다운</b><small id="memberDrawdownUsage">현재 -</small></div><strong id="memberDrawdownLimit">-</strong></div><div class="risk-status-row"><div><b>카피 비율</b><small>Master 기준 비례 복사</small></div><strong id="memberCopyRatioLimit">-</strong></div></aside></div>
    <section class="member-position-section"><div class="member-position-head"><div><h3>현재 포지션 <span id="memberPositionBadge">0</span></h3><p>Gate.io Worker가 확인한 실제 무기한 선물 포지션입니다.</p></div></div><div id="memberOpenPositionCards" class="member-open-position-grid"><div class="master-position-empty">현재 포지션을 불러오는 중입니다.</div></div></section>`;
  const adminDashboard = byId('admin-dashboard');
  if (adminDashboard) adminDashboard.innerHTML = `<div class="admin-dashboard-heading"><div><h2>운영 대시보드</h2><p>전체 회원의 카피 상태, 계좌 규모, 장애 여부를 우선순위대로 확인합니다.</p></div><div class="admin-period-tabs" role="group" aria-label="운영 조회 기간">${[['today','오늘'],[7,'7일'],[30,'30일'],['month','이번 달']].map(([range,label]) => `<button type="button" data-admin-range="${range}" class="${range === 30 ? 'active' : ''}">${label}</button>`).join('')}<button type="button" data-admin-range="custom">직접 선택</button></div></div><form id="adminDateRangeForm" class="admin-date-range hidden"><label>시작일<input id="adminDateFrom" type="date" required></label><span>—</span><label>종료일<input id="adminDateTo" type="date" required></label><button class="btn" type="submit">조회</button></form>
    <div class="status admin-live-status"><div><span id="adminSystemDot" class="dot"></span><b id="adminSystemTitle">운영 상태 확인 중</b><div><span id="adminSystemDetail">Worker heartbeat를 확인하고 있습니다.</span></div></div><time id="adminOverviewObserved">실시간 데이터 확인 중</time></div>
    <div class="admin-operations-kpis"><div class="card kpi"><label>전체 회원</label><strong id="adminTotalMembers">0</strong><small id="adminMemberDelta">승인 회원 기준</small></div><div class="card kpi"><label>카피 중</label><strong id="adminCopyingMembers">0</strong><small id="adminCopyingRate">0% 정상 작동</small></div><div class="card kpi"><label>확인 필요</label><strong id="adminLiveActionCount" class="neg">0</strong><small id="adminAttentionBreakdown">API·주문 상태</small></div><div class="card kpi"><label>총 운용 자산</label><strong id="adminTotalAssets">-</strong><small>회원 최신 원장 합산</small></div><div class="card kpi"><label>기간 회원 PNL</label><strong id="adminPeriodPnl">-</strong><small id="adminPeriodLabel">선택 기간 합산</small></div></div>
    <div class="master-position-section admin-dashboard-positions"><div class="master-position-head"><div><div class="master-position-title"><h3 id="adminPositionTitle">현재 포지션</h3><span id="masterPositionBadge">0</span></div><p id="adminPositionDescription">Gate.io에서 Worker가 확인한 Master 무기한 선물 포지션입니다.</p></div><div class="admin-position-controls"><div class="master-filters" role="group" aria-label="포지션 방향 필터"><button class="active" type="button" data-master-filter="ALL">전체</button><button type="button" data-master-filter="LONG">Long</button><button type="button" data-master-filter="SHORT">Short</button></div><label class="admin-position-owner"><span>계정 선택</span><select id="adminPositionOwner" aria-label="포지션을 확인할 계정"><option value="MASTER">Master 포지션</option></select></label></div></div><div id="adminMasterPositionCards" class="master-position-grid"><div class="master-position-empty">Master 포지션을 불러오는 중입니다.</div></div></div>`;
  const trades = byId('member-trades');
  if (trades) trades.innerHTML = `<div class="member-trades-heading"><div><h2>내 카피 현황</h2><p>마스터 전략이 내 계정에 어떻게 복사되고 있는지 실제 회원 계정 기준으로 확인합니다.</p></div><span id="memberTradeStatus" class="chip yellow" title="카피 상태를 확인하고 있습니다.">상태 확인 중</span></div><section class="card member-gate-summary"><div class="gate-summary-logo">G</div><div><b>Gate.io 연결 계정</b><small id="memberTradeGateUid">UID 확인 중 · 선물 계정</small></div><div class="gate-summary-equity"><strong id="memberTradeEquity">-</strong><small>현재 자산</small></div></section><section class="card member-copy-position-table"><div class="panel-title"><div><h3>현재 카피 포지션</h3><p>실제 회원 계정 기준</p></div></div><div class="table"><table><thead><tr><th>종목</th><th>방향</th><th>포지션 규모</th><th>진입가</th><th>현재가</th><th>미실현 PNL</th><th>ROI</th><th>증거금 비중</th><th>상태</th></tr></thead><tbody id="memberTradePositions"><tr><td colspan="9" class="empty-cell">실제 포지션을 불러오는 중입니다.</td></tr></tbody></table></div></section>`;
  const auditPage = byId('admin-audit');
  if (auditPage) auditPage.innerHTML = `<div class="admin-log-tabs" role="tablist" aria-label="관리자 기록 종류"><button type="button" class="active" role="tab" aria-selected="true" data-admin-log-tab="audit">감사 기록</button><button type="button" role="tab" aria-selected="false" data-admin-log-tab="executions">체결 현황</button></div>
    <div data-admin-log-panel="audit" class="card section"><div class="section-head"><div><h3>감사 기록</h3><p>관리자 승인·API 연결·카피 제어의 주요 변경 이력입니다.</p></div><button class="btn" type="button" id="adminAuditRefresh">새로고침</button></div><div class="table"><table><thead><tr><th>시간</th><th>작업자</th><th>작업 내용</th><th>대상</th><th>상세 변경</th></tr></thead><tbody id="adminAuditRows"><tr><td colspan="5" class="empty-cell">감사 기록을 불러오는 중입니다.</td></tr></tbody></table></div></div>
    <div data-admin-log-panel="executions" class="card section hidden"><div class="section-head"><div><h3>체결 현황</h3><p>회원별 카피 주문 결과와 주문이 생성되지 않은 차단 사유를 확인합니다.</p></div><button class="btn" type="button" id="adminExecutionRefresh">새로고침</button></div><form id="adminExecutionFilters" class="admin-execution-filters"><label>기간<select id="adminExecutionHours"><option value="24">최근 24시간</option><option value="168">최근 7일</option><option value="720">최근 30일</option></select></label><label>회원<select id="adminExecutionMember"><option value="">전체 회원</option></select></label><label>종목<input id="adminExecutionContract" type="search" placeholder="예: BTC_USDT"></label><label>상태<select id="adminExecutionStatus"><option value="ALL">전체 상태</option><option value="FILLED">체결 완료</option><option value="PENDING">진행 중</option><option value="FAILED">실패</option><option value="BLOCKED">차단</option><option value="CHECK">확인 필요</option></select></label><button class="btn primary" type="submit">조회</button></form><div class="table"><table class="admin-execution-table"><thead><tr><th>시간</th><th>회원</th><th>종목·방향</th><th>목표 / 주문 / 체결</th><th>상태</th><th>주문번호</th><th>사유</th></tr></thead><tbody id="adminExecutionRows"><tr><td colspan="7" class="empty-cell">체결 현황 탭을 선택하면 조회합니다.</td></tr></tbody></table></div></div>`;
}

function enhanceCopySettingsUi() {
  const page = byId('member-copy');
  if (!page) return;
  page.innerHTML = `<div class="copy-settings-layout"><div class="copy-settings-primary">
    <section class="card section copy-control-card"><div class="section-head"><div><small class="copy-eyebrow">노출 비율</small><h3>카피 비율</h3><p>Master의 포지션 변화를 내 자산 기준으로 복제할 비율입니다.</p></div><strong id="copyRatioValue">100%</strong></div><input id="copyRatioSelect" class="copy-range" type="range" min="50" max="200" step="10" value="100" aria-label="카피 비율" aria-describedby="copyRatioValue"><div class="copy-range-labels"><span>50%</span><span>100%</span><span>150%</span><span>200%</span></div></section>
    <section class="card section copy-control-card"><div class="section-head"><div><small class="copy-eyebrow">종목 상한</small><h3>종목당 최대 포지션 비중</h3><p>한 종목이 내 총자산에서 차지할 수 있는 상한입니다.</p></div><strong id="maxPositionRatioValue">30%</strong></div><input id="maxPositionRatioSelect" class="copy-range" type="range" min="20" max="50" step="10" value="30" aria-label="종목당 최대 포지션 비중" aria-describedby="maxPositionRatioValue"><div class="copy-range-labels"><span>20% 안전</span><span>30% 균형</span><span>40% 적극</span><span>50% 최대</span></div></section>
    <section class="card section copy-risk-card"><div class="section-head"><div><small class="copy-eyebrow">리스크 한도</small><h3>계정 리스크 한도</h3><p>한도 도달 시 Worker가 신규 주문을 자동 차단합니다. 운영자가 전체 계정에 동일하게 고정한 값으로, 회원이 변경할 수 없습니다.</p></div><span class="chip yellow">운영자 고정</span></div><div class="copy-risk-inputs"><label><span>일일 최대 손실</span><div class="is-locked"><input id="dailyLossLimitInput" type="number" value="15" disabled aria-disabled="true" title="운영자가 고정한 한도입니다"><b>%</b></div></label><label><span>최대 Drawdown</span><div class="is-locked"><input id="maxDrawdownInput" type="number" value="20" disabled aria-disabled="true" title="운영자가 고정한 한도입니다"><b>%</b></div></label><label><span>레버리지 정책</span><div><b>Master 자동 추종</b></div></label></div><div class="notice">LONG·SHORT 각 포지션은 Master가 사용한 레버리지와 증거금 모드로 진입합니다.</div></section>
    </div><div class="copy-settings-secondary"><section class="card section copy-existing-policy"><div><small class="copy-eyebrow">기존 포지션</small><h3>기존 포지션 처리</h3><p>API 연결 시점에 Master가 이미 보유한 포지션은 진입하지 않고, 이후 추가·감소 및 신규 진입부터 카피합니다.</p></div><span class="chip">연결 이후만 카피</span></section>
    <aside class="card section copy-setting-summary"><small class="copy-eyebrow">설정 미리보기</small><h3>현재 설정 요약</h3><div class="metric"><span>카피 비율</span><b id="copyPreviewRatio">100%</b></div><div class="metric"><span>종목당 최대 비중</span><b id="copyPreviewCap">30%</b></div><div class="metric"><span>포지션 모드</span><b>롱·숏 양방향</b></div><div class="metric"><span>레버리지</span><b>Master 자동 추종</b></div><div class="metric"><span>리스크 차단</span><b id="copyPreviewRisk">-5% · -15%</b></div><div class="notice">설정 변경은 다음 Worker 주기부터 적용됩니다. 기존 포지션을 임의로 확대하지 않습니다.</div><button id="copySettingsSave" class="btn primary full" type="button">설정 저장</button></aside>
  </div></div>`;
}

// The member form remembers the values it was filled with so a save can detect that an
// administrator changed the weights in the meantime (item: admin-managed weights).
function populateCopySettingsForm(profile) {
  if (!profile) return;
  const copyRatio = Number(profile.copy_ratio ?? 100);
  const maxPositionRatio = Number(profile.max_position_ratio ?? 30);
  if (byId('copyRatioSelect')) byId('copyRatioSelect').value = String(copyRatio);
  if (byId('maxPositionRatioSelect')) byId('maxPositionRatioSelect').value = String(maxPositionRatio);
  if (byId('dailyLossLimitInput')) byId('dailyLossLimitInput').value = String(Number(profile.daily_loss_limit_pct ?? 15));
  if (byId('maxDrawdownInput')) byId('maxDrawdownInput').value = String(Number(profile.max_drawdown_pct ?? 20));
  copySettingsBaseline = { copy_ratio: copyRatio, max_position_ratio: maxPositionRatio };
  refreshCopySettingPreview();
}

async function refreshCopySettingsFromServer() {
  if (!supabase || currentProfile?.role !== 'MEMBER') return;
  try {
    const fresh = await loadProfile(currentProfile.id);
    currentProfile = { ...currentProfile, ...fresh };
    if (byId('member-copy')?.classList.contains('active') && !copySettingsBusy) populateCopySettingsForm(currentProfile);
    renderMemberRiskLimits();
  } catch (error) {
    console.error(error);
  }
}

function refreshCopySettingPreview() {
  const ratio = Number(byId('copyRatioSelect')?.value || 100);
  const cap = Number(byId('maxPositionRatioSelect')?.value || 30);
  const daily = Number(byId('dailyLossLimitInput')?.value || 15);
  const drawdown = Number(byId('maxDrawdownInput')?.value || 20);
  if (byId('copyRatioValue')) byId('copyRatioValue').textContent = `${ratio}%`;
  if (byId('maxPositionRatioValue')) byId('maxPositionRatioValue').textContent = `${cap}%`;
  if (byId('copyPreviewRatio')) byId('copyPreviewRatio').textContent = `${ratio}%`;
  if (byId('copyPreviewCap')) byId('copyPreviewCap').textContent = `${cap}%`;
  if (byId('copyPreviewRisk')) byId('copyPreviewRisk').textContent = `-${daily}% · -${drawdown}%`;
}

function enhanceAdminApiPage() {
  const page = byId('admin-api');
  if (!page) return;
  page.innerHTML = `
    <div class="admin-api-setup">
      <div class="card section admin-master-api-card">
        <div class="section-head"><div><h3>Master Gate.io API 연결</h3><p>Master 실제 포지션을 읽을 운영 계정을 연결합니다.</p></div><span id="adminMasterGateStatus" class="chip yellow">미연결</span></div>
        <form id="adminGateApiForm" class="form" autocomplete="off">
          <div class="admin-api-fields">
            <div class="field"><label for="adminGateUid">Gate.io UID</label><input id="adminGateUid" inputmode="numeric" autocomplete="off" placeholder="Master 계정 UID" required></div>
            <div class="field"><label for="adminGateApiKey">API Key</label><input id="adminGateApiKey" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="API Key 입력" required></div>
            <div class="field admin-secret-field"><label for="adminGateSecretKey">Secret Key</label><input id="adminGateSecretKey" type="password" autocomplete="new-password" autocapitalize="off" spellcheck="false" placeholder="Secret Key 입력" required></div>
          </div>
          <label class="permission-check"><input id="adminGatePermissionConfirmed" type="checkbox" required><span>Trading Account · Perpetual Futures Read Only만 허용했으며 출금 권한은 비활성화했습니다.</span></label>
          <div class="admin-api-submit-row"><div class="credential-actions"><button id="adminGateApiConnect" class="btn primary" type="submit">암호화 저장 및 검증 요청</button><button id="adminGateApiDisconnect" class="btn red" type="button">Master API 연결 해제</button></div><p id="adminGateCredentialHelp">Secret Key는 브라우저에 저장하지 않습니다.</p></div>
        </form>
      </div>
      <div class="card section admin-master-security">
        <div class="section-head"><div><h3>Master 연결 보안 상태</h3><p id="adminGateVerificationDetail">실제 연결 검증 전입니다.</p></div></div>
        <div class="metric"><span>Futures Read</span><b id="adminGateFuturesRead" class="warn">확인 대기</b></div>
        <div class="metric"><span>Master 주문 권한</span><b id="adminGateTrade" class="warn">DISABLED 확인 대기</b></div>
        <div class="metric"><span>Worker 고정 IP</span><b id="adminGateWorker" class="warn">미설정</b></div>
        <div class="metric"><span>Withdrawal</span><b id="adminGateWithdrawal" class="pos">DISABLED 확인 필요</b></div>
      </div>
    </div>
    <div class="grid kpis">
      <div class="card kpi"><label>전체 회원</label><strong id="adminApiTotal">0</strong></div>
      <div class="card kpi"><label>연결 정상</label><strong id="adminApiVerified" class="pos">0</strong></div>
      <div class="card kpi"><label>오류</label><strong id="adminApiErrors" class="warn">0</strong></div>
      <div class="card kpi"><label>미연결</label><strong id="adminApiDisconnected">0</strong></div>
    </div>
    <div class="card section admin-api-connections">
      <div class="section-head"><div><h3>회원 Gate.io API 연결 현황</h3><p>회원별 연결·권한·Worker 검증 상태입니다.</p></div></div>
      <div class="table"><table><thead><tr><th>회원</th><th>UID</th><th>상태</th><th>Futures 권한</th><th>Worker IP</th><th>최근 확인</th><th>관리</th></tr></thead>
      <tbody id="adminGateConnections"><tr><td colspan="7" class="empty-cell">API 연결 현황을 불러오는 중입니다.</td></tr></tbody></table></div>
    </div>`;
}

function enhanceAdminMembersPage() {
  const page = byId('admin-members');
  if (!page) return;
  page.innerHTML = `<div class="admin-period-tabs admin-member-tabs" role="tablist" aria-label="회원 구분"><button type="button" role="tab" data-member-tab="active" class="active" aria-selected="true">회원</button><button type="button" role="tab" data-member-tab="withdrawn" aria-selected="false">탈퇴 회원 <span id="withdrawnCount">0</span></button></div><section class="card admin-pending-members"><div class="panel-title"><div><h3>가입 승인 대기</h3><p>승인 전 회원을 확인하고 접근 권한을 관리합니다.</p></div><span id="pendingCount" class="chip yellow">대기 0명</span></div><div class="table"><table><thead><tr><th>신청자</th><th>아이디(UID)</th><th>휴대폰</th><th>신청시간</th><th>관리</th></tr></thead><tbody id="pendingMembers"><tr><td colspan="5" class="empty-cell">승인 대기 회원을 불러오는 중입니다.</td></tr></tbody></table></div></section><section class="card admin-member-directory" data-member-tab-panel="active"><div class="panel-title"><div><h3>전체 회원</h3><p id="memberDirectorySummary">회원 상태와 실제 계좌 지표를 확인합니다.</p></div><input id="adminMemberSearch" class="admin-member-search" type="search" placeholder="회원 검색" aria-label="회원 검색"></div><div class="table"><table class="admin-members-table"><thead><tr><th>회원</th><th>카피 상태</th><th title="거래소 잔고 · 미실현 손익 제외">총 자산</th><th title="총 자산 + 미실현 손익">현재 자산</th><th>오늘 PNL</th><th>카피 비율</th><th>증거금 사용</th><th>API 상태</th><th>마지막 동기화</th><th>관리</th></tr></thead><tbody id="memberList"><tr><td colspan="10" class="empty-cell">회원 목록을 불러오는 중입니다.</td></tr></tbody></table></div></section><section class="card admin-withdrawn-members hidden" data-member-tab-panel="withdrawn"><div class="panel-title"><div><h3>탈퇴 회원</h3><p>탈퇴 처리된 회원입니다. 거래·수익 기록은 보존되며, 복구하면 승인 대기로 돌아갑니다.</p></div></div><div class="table"><table class="admin-withdrawn-table"><thead><tr><th>회원</th><th>휴대폰</th><th>가입일</th><th>탈퇴일시</th><th>사유</th><th>관리</th></tr></thead><tbody id="withdrawnMembers"><tr><td colspan="6" class="empty-cell">탈퇴 회원을 불러오는 중입니다.</td></tr></tbody></table></div></section>`;
}

function enhanceMemberDetailModal() {
  if (byId('memberDetailModal')) return;
  document.body.insertAdjacentHTML('beforeend', `
    <div id="memberDetailModal" class="modal-bg" aria-hidden="true">
      <div class="modal member-detail-modal" role="dialog" aria-modal="true" aria-labelledby="memberDetailTitle">
        <button class="modal-close" type="button" aria-label="회원 상세 닫기" data-member-detail-close>×</button>
        <div class="member-detail-head">
          <div><small>회원 상세</small><h3 id="memberDetailTitle">-</h3><p id="memberDetailEmail">-</p></div>
          <span id="memberDetailStatus" class="chip">-</span>
        </div>
        <div class="member-detail-tabs" role="tablist" aria-label="회원 상세 정보 구분">
          <button type="button" class="active" role="tab" aria-selected="true" data-member-detail-tab="overview">기본·카피 설정</button>
          <button type="button" role="tab" aria-selected="false" data-member-detail-tab="performance">수익 내역</button>
          <button type="button" role="tab" aria-selected="false" data-member-detail-tab="security">계정 보안</button>
        </div>
        <section class="member-detail-panel" data-member-detail-panel="overview"><div id="memberDetailSummary" class="member-detail-summary"></div><section id="memberNewOperation" class="new-operation-panel" hidden></section></section>
        <section class="member-detail-panel hidden" data-member-detail-panel="performance">
          <div class="section-head member-performance-title"><div><h3>월별 수익</h3><p>실현손익·수수료·펀딩비가 반영된 집계입니다.</p></div></div>
          <div class="table"><table class="member-performance-table"><thead><tr><th>월</th><th>순손익</th><th>수익률</th><th>거래량</th><th>거래</th><th>승률</th></tr></thead><tbody id="memberMonthlyPerformance"><tr><td colspan="6" class="empty-cell">월별 수익을 불러오는 중입니다.</td></tr></tbody></table></div>
        </section>
        <section class="member-detail-panel hidden" data-member-detail-panel="security">
          <div id="memberPasswordResetActions" class="member-password-reset-actions hidden">
            <div><h3>로그인 비밀번호</h3><p>회원이 비밀번호를 잊은 경우 임시 비밀번호를 발급합니다. 기존 비밀번호는 즉시 사용할 수 없게 됩니다.</p></div>
            <button id="memberPasswordResetButton" class="btn" type="button">임시 비밀번호 발급</button>
          </div>
          <div id="memberTempPasswordResult" class="member-temp-password hidden" role="status" aria-live="polite">
            <div class="member-temp-password-head"><b>임시 비밀번호</b><small>이 화면을 닫으면 다시 볼 수 없습니다.</small></div>
            <div class="member-temp-password-row"><code id="memberTempPasswordValue" aria-label="임시 비밀번호"></code><button id="memberTempPasswordCopy" class="btn" type="button">복사</button></div>
            <p>문자 메시지·메신저 등 회원 본인에게만 안전하게 전달하고, 로그인 후 계정 설정에서 새 비밀번호로 변경하도록 안내해 주세요.</p>
          </div>
        </section>
      </div>
    </div>`);
}

// Password recovery for accounts without the member account page (administrators).
function enhancePasswordRecoveryModal() {
  if (byId('passwordRecoveryModal')) return;
  document.body.insertAdjacentHTML('beforeend', `
    <div id="passwordRecoveryModal" class="modal-bg" aria-hidden="true">
      <div class="modal password-recovery-modal" role="dialog" aria-modal="true" aria-labelledby="recoveryPasswordTitle" aria-describedby="recoveryPasswordDetail">
        <h3 id="recoveryPasswordTitle">새 비밀번호 설정</h3>
        <p id="recoveryPasswordDetail" class="password-recovery-detail">재설정 링크가 확인되었습니다. 새 비밀번호를 입력하면 모든 기기에서 로그아웃되고 새 비밀번호로 다시 로그인합니다.</p>
        <form id="recoveryPasswordForm" class="form" autocomplete="off">
          <div class="field"><label for="recoveryNewPassword">새 비밀번호</label><input id="recoveryNewPassword" type="password" autocomplete="new-password" minlength="8" placeholder="8자 이상 새 비밀번호" required></div>
          <div class="field"><label for="recoveryNewPasswordConfirm">새 비밀번호 확인</label><input id="recoveryNewPasswordConfirm" type="password" autocomplete="new-password" minlength="8" placeholder="새 비밀번호 다시 입력" required></div>
          <button id="recoveryPasswordButton" class="btn primary full" type="submit">비밀번호 변경</button>
        </form>
      </div>
    </div>`);
}

async function completePasswordRecovery() {
  if (!supabase || recoveryPasswordBusy) return;
  const newPassword = byId('recoveryNewPassword')?.value || '';
  const confirmPassword = byId('recoveryNewPasswordConfirm')?.value || '';
  if (newPassword.length < 8) return window.toast('새 비밀번호는 8자 이상 입력해 주세요.', { kind: 'error' });
  if (newPassword !== confirmPassword) return window.toast('새 비밀번호 확인이 일치하지 않습니다.', { kind: 'error' });
  recoveryPasswordBusy = true;
  const button = byId('recoveryPasswordButton');
  if (button) {
    button.disabled = true;
    button.textContent = '변경 중...';
  }
  try {
    const { error } = await supabase.auth.updateUser({ password: newPassword });
    if (error) return window.toast(error.message || '비밀번호 변경에 실패했습니다.', { kind: 'error' });
    passwordRecoveryMode = false;
    closeModal(byId('passwordRecoveryModal'));
    await supabase.auth.signOut({ scope: 'global' });
    currentProfile = null;
    showAuth('login');
    setAuthMessage('비밀번호가 변경되었습니다. 새 비밀번호로 다시 로그인해 주세요.', 'success');
  } finally {
    recoveryPasswordBusy = false;
    if (button) {
      button.disabled = false;
      button.textContent = '비밀번호 변경';
    }
    if (byId('recoveryNewPassword')) byId('recoveryNewPassword').value = '';
    if (byId('recoveryNewPasswordConfirm')) byId('recoveryNewPasswordConfirm').value = '';
  }
}

function enhanceLegalUi() {
  const checkbox = byId('signupTerms');
  const label = checkbox?.closest('label');
  if (label && !label.classList.contains('terms-consent')) {
    label.className = 'terms-consent';
    label.innerHTML = `<input id="signupTerms" type="checkbox"> <span><button type="button" class="legal-link" data-legal-open="terms">서비스 이용약관</button> 및 <button type="button" class="legal-link" data-legal-open="privacy">개인정보 처리방침</button>에 동의합니다.</span>`;
  }
  if (byId('legalModal')) return;
  document.body.insertAdjacentHTML('beforeend', `
    <div id="legalModal" class="modal-bg legal-modal-bg" aria-hidden="true">
      <div class="modal legal-modal" role="dialog" aria-modal="true" aria-labelledby="legalTitle">
        <button class="modal-close" type="button" aria-label="약관 닫기" data-legal-close>×</button>
        <div class="legal-head"><small>시행일 2026. 8. 21. · 버전 ${LEGAL_VERSION}</small><h2 id="legalTitle">서비스 이용약관</h2></div>
        <div class="legal-tabs"><button class="btn primary" type="button" data-legal-tab="terms">이용약관</button><button class="btn" type="button" data-legal-tab="privacy">개인정보 처리방침</button></div>
        <article id="legalTerms" class="legal-document">
          <section><h3>1. 서비스와 투자 위험</h3><p>maetajak은 Master 실제 포지션을 기준으로 회원의 목표 포지션을 계산하고 차이만큼 주문하는 카피트레이딩 기능을 제공합니다. 가상자산 선물은 원금 전부를 잃을 수 있는 고위험 거래이며 수익을 보장하지 않습니다.</p></section>
          <section><h3>2. 성공보수</h3><p>성공보수는 매월 확정된 순실현수익의 10%입니다. 순실현수익은 실현손익에 펀딩비를 더하고 거래 수수료를 차감해 계산하며, 입출금·미실현손익은 제외합니다. 해당 월 순실현수익이 0 이하이면 성공보수는 없습니다.</p></section>
          <section><h3>3. 직접 거래와 MANUAL_OVERRIDE</h3><p>카피 중인 종목의 주문, 포지션, 레버리지, 증거금, 익절·손절을 회원이 직접 변경하면 MANUAL_OVERRIDE로 판단해 해당 종목 카피를 중지하고 자동 재진입하지 않을 수 있습니다. 회원의 직접 변경으로 확대된 손실은 회원이 부담합니다.</p></section>
          <section><h3>4. 체결·시스템 위험</h3><p>급격한 가격 변동, 슬리피지, 유동성 부족, 부분 체결, 펀딩비, 거래소 장애, API 제한, 네트워크 지연, UNKNOWN 주문 조정 과정으로 Master와 다른 가격·수량이 체결되거나 손실이 발생할 수 있습니다.</p></section>
          <section><h3>5. 안전 제어</h3><p>서비스는 DRIFT, PAUSED, REDUCE_ONLY, ERROR, HALTED 등의 상태에서 주문을 제한할 수 있습니다. API 권한 이상, 미확인 주문 또는 비상 상황에는 사전 통지 없이 신규 주문을 중지할 수 있습니다.</p></section>
          <section><h3>6. 회원 의무</h3><p>회원은 본인 명의의 Gate.io 계정과 최소한의 Futures 권한만 사용하고, 출금 권한을 부여하지 않으며, API Key를 타인과 공유하지 않아야 합니다. 거래소 약관과 거주지 법령 준수 책임은 회원에게 있습니다.</p></section>
          <section><h3>7. 책임 범위</h3><p>서비스 운영자는 일반적인 시장 변동과 카피트레이딩으로 발생한 투자 손실을 보전하지 않습니다. 다만 운영자의 고의·중대한 과실 또는 관련 법령상 배제할 수 없는 책임까지 면제하는 것은 아닙니다.</p></section>
          <section><h3>8. 기록·변경·해지</h3><p>주문, 상태 변경, 관리자 작업은 감사 목적으로 기록될 수 있습니다. 중요한 약관 변경은 시행 전에 알리며, 회원은 카피를 중지하고 서비스 이용을 종료할 수 있습니다.</p></section>
          <p class="legal-review-warning">유료 실거래 서비스 시작 전 성공보수 구조와 카피트레이딩 운영에 대해 대한민국 금융·전자상거래 전문 변호사의 검토가 필요합니다.</p>
        </article>
        <article id="legalPrivacy" class="legal-document hidden">
          <section><h3>1. 수집 항목</h3><p>이름, 휴대폰 번호, 이메일, 인증·승인 기록, Gate.io UID와 API Key, 거래·포지션·수익 기록, 접속·감사 로그를 수집할 수 있습니다. Secret Key는 서버에서 암호화해 저장하며 브라우저 저장소에는 저장하지 않습니다.</p></section>
          <section><h3>2. 이용 목적</h3><p>회원 인증과 승인, API 연결 검증, 목표 포지션 계산과 주문 실행, 위험 통제, 월별 수익·성공보수 산정, 보안 사고 대응 및 법적 의무 이행에 이용합니다.</p></section>
          <section><h3>3. 보유와 파기</h3><p>회원 탈퇴 또는 목적 달성 시 지체 없이 파기하되, 거래·감사 기록 등 법령이나 분쟁 대응에 필요한 정보는 정해진 기간 동안 분리 보관할 수 있습니다.</p></section>
          <section><h3>4. 처리 위탁·국외 처리</h3><p>인증·DB는 Supabase, 웹 호스팅은 Vercel, 거래 기능은 Gate.io 및 별도 Trading Worker를 사용할 수 있으며 서비스 제공 과정에서 정보가 국외에서 처리될 수 있습니다. 실제 운영 전 사업자 정보와 상세 이전 항목·국가·보유기간을 고지합니다.</p></section>
          <section><h3>5. 이용자 권리와 보안</h3><p>회원은 개인정보 열람·정정·삭제·처리정지를 요청할 수 있습니다. 서비스는 암호화, 접근 통제, 최소 권한, 관리자 재인증, 감사 로그 등의 보호조치를 적용합니다.</p></section>
          <p class="legal-review-warning">운영 전 사업자명, 주소, 대표자, 개인정보 보호책임자 및 문의처를 확정해 이 문서에 반영해야 합니다.</p>
        </article>
      </div>
    </div>`);
}

function enhanceMemberAnalysisPage() {
  const memberNav = byId('memberNav')?.querySelector('.nav-group');
  const accountButton = memberNav?.querySelector('[data-page="member-account"]');
  if (memberNav && accountButton && !memberNav.querySelector('[data-page="member-analysis"]')) {
    accountButton.insertAdjacentHTML('beforebegin', '<button class="nav-btn" data-page="member-analysis">수익 분석</button>');
  }
  if (byId('member-analysis')) return;
  const dashboard = byId('member-dashboard');
  if (!dashboard) return;
  dashboard.insertAdjacentHTML('afterend', `
    <section id="member-analysis" class="page">
      <div class="analysis-hero card section">
        <div><small class="analysis-eyebrow">수익 분석</small><h2>선물 계좌 수익 분석</h2><p>카피트레이딩 시작일부터 Gate.io 선물 원장에서 집계한 실제 성과입니다.</p></div>
        <span id="analysisPeriod" class="analysis-period">집계 대기</span>
      </div>
      <div id="analysisEmpty" class="card section analysis-empty">Trading Worker가 거래 원장을 집계하면 분석 결과가 표시됩니다.</div>
      <div id="analysisContent" class="hidden">
        <div class="analysis-profit-loss card section"><div><small>총이익</small><strong id="analysisGrossProfit" class="pos">$0.00</strong></div><div class="analysis-balance"><i id="analysisProfitBar"></i><i id="analysisLossBar"></i></div><div class="analysis-loss"><small>총손실</small><strong id="analysisGrossLoss" class="neg">$0.00</strong></div></div>
        <div class="analysis-metrics">
          <div class="card"><small>순실현손익</small><b id="analysisNetPnl">$0.00</b></div>
          <div class="card"><small>승률</small><b id="analysisWinRate">-</b></div>
          <div class="card"><small>평균 이익</small><b id="analysisAverageProfit">-</b></div>
          <div class="card"><small>평균 손실</small><b id="analysisAverageLoss">-</b></div>
        </div>
        <div class="analysis-lower">
          <div class="card section analysis-calendar-card"><div class="section-head analysis-calendar-head"><div><small class="analysis-eyebrow">일별 손익</small><h3>일별 손익 캘린더</h3></div><label class="analysis-month-control"><span>조회 월</span><input id="analysisMonthSelect" type="month" aria-label="손익 조회 월"></label></div><div id="analysisCalendar" class="analysis-calendar"></div></div>
        </div>
        <p class="analysis-footnote">순손익은 실현손익에서 거래 수수료를 차감하고 펀딩비를 반영합니다. 입출금과 미실현손익은 제외됩니다.</p>
      </div>
    </section>`);
}

function enhanceAdminMemberAnalysisPage() {
  const adminNav = byId('adminNav')?.querySelector('.nav-group');
  const apiButton = adminNav?.querySelector('[data-page="admin-api"]');
  if (adminNav && apiButton && !adminNav.querySelector('[data-page="admin-member-analysis"]')) {
    apiButton.insertAdjacentHTML('beforebegin', '<button class="nav-btn" data-page="admin-member-analysis">수익 관리</button>');
  }
  if (byId('admin-member-analysis')) return;
  const source = byId('member-analysis');
  const anchor = byId('admin-api');
  if (!source || !anchor) return;
  const page = source.cloneNode(true);
  page.id = 'admin-member-analysis';
  page.classList.remove('active');
  page.querySelectorAll('[id^="analysis"]').forEach((element) => {
    element.id = `admin${element.id.charAt(0).toUpperCase()}${element.id.slice(1)}`;
  });
  page.querySelector('.analysis-hero h2').textContent = '회원별 카피 수익 분석';
  page.querySelector('.analysis-hero p').textContent = 'Worker가 수집한 실제 체결 원장을 회원과 기간별로 조회합니다.';
  page.insertAdjacentHTML('afterbegin', `<div class="card section admin-analysis-selector">
    <div><span class="admin-analysis-label">회원 선택</span><div id="adminAnalysisMemberList" class="admin-analysis-members"><span class="notice">회원 목록을 불러오는 중입니다.</span></div></div>
    <div class="admin-analysis-range">
      <div class="admin-analysis-preset-field"><span>조회 기간</span><div class="admin-analysis-presets" role="group" aria-label="조회 기간"><button type="button" data-analysis-range="7">7일</button><button type="button" class="active" data-analysis-range="30">30일</button><button type="button" data-analysis-range="90">90일</button><button type="button" data-analysis-range="180">180일</button></div></div>
      <form id="adminAnalysisDateForm" class="admin-analysis-dates"><label>시작일<input id="adminAnalysisStartDate" type="date" required></label><span>—</span><label>종료일<input id="adminAnalysisEndDate" type="date" required></label><button class="btn" type="submit">조회</button></form>
    </div>
  </div>`);
  anchor.insertAdjacentElement('beforebegin', page);
}

function setLegalTab(tab = 'terms') {
  const terms = tab === 'terms';
  byId('legalTerms')?.classList.toggle('hidden', !terms);
  byId('legalPrivacy')?.classList.toggle('hidden', terms);
  if (byId('legalTitle')) byId('legalTitle').textContent = terms ? '서비스 이용약관' : '개인정보 처리방침';
  document.querySelectorAll('[data-legal-tab]').forEach((button) => button.classList.toggle('primary', button.dataset.legalTab === tab));
}

const FOCUSABLE_SELECTOR = 'button:not([disabled]), [href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function modalFocusables(modal) {
  return [...modal.querySelectorAll(FOCUSABLE_SELECTOR)].filter((element) => element.offsetParent !== null || element === document.activeElement);
}

// Shared dialog behaviour: remember the opener, move focus inside, trap Tab, restore on close.
function openModal(modal, { focus } = {}) {
  if (!modal) return;
  if (modal.classList.contains('open')) return;
  modalReturnFocus.set(modal.id, document.activeElement);
  modal.classList.add('open');
  modal.setAttribute('aria-hidden', 'false');
  window.requestAnimationFrame(() => {
    const target = (focus && modal.querySelector(focus)) || modalFocusables(modal).find((element) => !element.classList.contains('modal-close')) || modalFocusables(modal)[0];
    target?.focus({ preventScroll: true });
  });
}

function closeModal(modal) {
  if (!modal || !modal.classList.contains('open')) return;
  modal.classList.remove('open');
  modal.setAttribute('aria-hidden', 'true');
  const opener = modalReturnFocus.get(modal.id);
  modalReturnFocus.delete(modal.id);
  if (opener && document.contains(opener) && typeof opener.focus === 'function') opener.focus({ preventScroll: true });
}

function topOpenModal() {
  const open = [...document.querySelectorAll('.modal-bg.open')];
  return open.at(-1) || null;
}

function trapModalFocus(event) {
  const modal = topOpenModal();
  if (!modal) return;
  const focusables = modalFocusables(modal);
  if (!focusables.length) return;
  const first = focusables[0];
  const last = focusables.at(-1);
  if (!modal.contains(document.activeElement)) {
    event.preventDefault();
    first.focus();
  } else if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function openLegal(tab) {
  setLegalTab(tab);
  openModal(byId('legalModal'), { focus: '[data-legal-tab].primary' });
}

function closeLegal() {
  closeModal(byId('legalModal'));
}

function setAuthMessage(message = '', kind = 'error') {
  const box = byId('authMessage');
  box.textContent = message;
  box.className = message ? `notice ${kind}` : 'notice hidden';
}

function setPendingMessage(status, detail) {
  byId('pendingStatus').textContent = status;
  byId('pendingStatusLabel').textContent = status;
  byId('pendingStatusLabel').className = status === '승인 대기' ? 'warn' : 'neg';
  byId('pendingDetail').textContent = detail;
}

function hideBootSplash() {
  byId('bootSplash')?.remove();
  document.body.classList.remove('booting');
}

function showAuth(view = 'login') {
  stopGateStatusPolling();
  stopCopySystemPolling();
  hideBootSplash();
  byId('app').classList.add('hidden');
  byId('auth').classList.remove('hidden');
  ['login', 'signup', 'pending'].forEach((id) => byId(id).classList.toggle('hidden', id !== view));
  byId('loginTab').classList.toggle('active', view === 'login');
  byId('signupTab').classList.toggle('active', view === 'signup');
}

function showApp(profile) {
  currentProfile = profile;
  const { role } = getAccessDecision(profile);
  hideBootSplash();
  byId('auth').classList.add('hidden');
  byId('app').classList.remove('hidden');
  byId('memberNav').classList.toggle('hidden', role !== 'member');
  byId('adminNav').classList.toggle('hidden', role !== 'admin');
  byId('accountName').value = profile.full_name || '';
  byId('accountEmail').value = accountDisplayId(profile.gate_uid, profile.email) || '';
  if (byId('accountNickname')) byId('accountNickname').value = profile.nickname || '';
  applyAccountGateUid();
  populateCopySettingsForm(profile);
  openPage(role === 'admin' ? 'admin-dashboard' : 'member-dashboard');
  loadCopySystemStatus();
  startCopySystemPolling();
  // The admin member list loads when its page opens; the dashboard already requests the
  // operations metrics and live data it needs.
  if (role === 'member') {
    loadGateConnection();
    loadMemberLiveData();
    loadMemberDashboardPerformance();
    loadMemberCumulativePerformance();
  }
  startGateStatusPolling();
}

async function loadProfile(userId) {
  const { data, error } = await supabase.from('profiles').select('*').eq('id', userId).single();
  if (error) throw error;
  return data;
}

// TOKEN_REFRESHED only renews the JWT. Refresh the profile in the background without
// navigating, re-rendering pages or refilling forms the member may be editing.
async function refreshProfileSilently(session) {
  if (!session?.user?.id || !currentProfile || session.user.id !== currentProfile.id) return routeSession(session);
  try {
    const profile = await loadProfile(session.user.id);
    const decision = getAccessDecision(profile);
    if (!decision.allowed || profile.role !== currentProfile.role) return routeSession(session);
    currentProfile = { ...currentProfile, ...profile };
    if (profile.role === 'MEMBER') renderMemberRiskLimits();
  } catch (error) {
    console.error(error);
  }
}

async function routeSession(session) {
  if (!session) {
    currentProfile = null;
    showAuth('login');
    return;
  }
  try {
    const profile = await loadProfile(session.user.id);
    const decision = getAccessDecision(profile);
    if (decision.allowed) {
      showApp(profile);
      return;
    }
    setPendingMessage(decision.status, decision.detail);
    showAuth('pending');
  } catch (error) {
    console.error(error);
    await supabase.auth.signOut();
    showAuth('login');
    setAuthMessage('회원 프로필을 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.');
  }
}

async function withAuthBusy(action) {
  if (authBusy) return;
  authBusy = true;
  document.querySelectorAll('[data-auth-action]').forEach((button) => { button.disabled = true; });
  try { await action(); }
  finally {
    authBusy = false;
    document.querySelectorAll('[data-auth-action]').forEach((button) => { button.disabled = false; });
  }
}

window.authTab = (tab) => {
  setAuthMessage();
  showAuth(tab);
};

const SIGNUP_ERRORS = {
  UID_TAKEN: '이미 가입 신청된 Gate.io UID입니다. 본인의 UID가 맞다면 관리자에게 문의해 주세요.',
  INVALID_INPUT: '입력값을 확인해 주세요. UID는 숫자 4~15자리, 휴대폰은 숫자 8자리 이상, 비밀번호는 8~72자입니다.',
};

// Edge Function errors arrive as a non-2xx Response; read its { error } code without throwing.
async function functionErrorCode(error) {
  try {
    const body = await error?.context?.json?.();
    return typeof body?.error === 'string' ? body.error : '';
  } catch {
    return '';
  }
}

window.signup = () => withAuthBusy(async () => {
  setAuthMessage();
  if (!configured) return setAuthMessage('Supabase 환경변수가 설정되지 않았습니다.');
  const uid = byId('signupUid').value.trim();
  const fullName = byId('signupName').value.trim();
  const phone = byId('signupPhone').value.trim();
  const password = byId('signupPassword').value;
  const passwordConfirm = byId('signupPasswordConfirm').value;
  const terms = byId('signupTerms').checked;
  if (!isValidGateUid(uid)) return setAuthMessage('Gate.io UID는 숫자 4~15자리로 입력해 주세요.');
  if (!fullName || [...fullName].length > 40) return setAuthMessage('이름을 40자 이내로 입력해 주세요.');
  if (!/^[0-9+\- ]{8,20}$/.test(phone)) return setAuthMessage('휴대폰 번호를 숫자로 정확히 입력해 주세요.');
  if (password.length < 8 || password.length > 72) return setAuthMessage('비밀번호는 8자 이상 72자 이하로 입력해 주세요.');
  if (password !== passwordConfirm) return setAuthMessage('비밀번호와 비밀번호 확인이 일치하지 않습니다.');
  if (!terms) return setAuthMessage('서비스 이용약관과 개인정보 처리방침에 동의해 주세요.');
  const body = {
    uid,
    password,
    full_name: fullName,
    phone,
    terms_accepted_at: new Date().toISOString(),
    terms_version: LEGAL_VERSION,
    privacy_version: LEGAL_VERSION,
  };
  let result;
  try {
    result = await supabase.functions.invoke('uid-signup', { body });
  } catch (error) {
    result = { data: null, error };
  }
  if (result.error || !result.data?.ok) {
    const code = result.data?.error || await functionErrorCode(result.error);
    return setAuthMessage(SIGNUP_ERRORS[code] || '가입 신청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.');
  }
  // No auto-login: the account waits for administrator approval.
  byId('signupForm').reset();
  showAuth('login');
  byId('loginId').value = uid;
  byId('loginPassword').value = '';
  setAuthMessage('가입 신청이 접수되었습니다. 관리자 승인 후 로그인할 수 있습니다.', 'success');
});

window.login = () => withAuthBusy(async () => {
  setAuthMessage();
  if (!configured) return setAuthMessage('Supabase 환경변수가 설정되지 않았습니다.');
  const loginId = byId('loginId').value.trim();
  const password = byId('loginPassword').value;
  if (!loginId || !password) return setAuthMessage('아이디와 비밀번호를 입력해 주세요.');
  if (!loginId.includes('@') && !isValidGateUid(loginId)) return setAuthMessage('아이디는 가입한 Gate.io UID(숫자 4~15자리)입니다.');
  const email = loginIdToEmail(loginId);
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return setAuthMessage('아이디 또는 비밀번호를 확인해 주세요. 비밀번호를 잊으셨다면 관리자에게 문의하세요.');
  await routeSession(data.session);
});

window.logout = () => withAuthBusy(async () => {
  stopGateStatusPolling();
  if (supabase) await supabase.auth.signOut();
  currentProfile = null;
  showAuth('login');
});

async function changeMyPassword() {
  if (!supabase || passwordBusy) return;
  const currentPassword = byId('currentPassword')?.value || '';
  const newPassword = byId('newPassword')?.value || '';
  const newPasswordConfirm = byId('newPasswordConfirm')?.value || '';
  if (!passwordRecoveryMode && currentPassword.length < 8) return window.toast('현재 비밀번호를 입력해 주세요.');
  if (newPassword.length < 8) return window.toast('새 비밀번호는 8자 이상 입력해 주세요.');
  if (newPassword !== newPasswordConfirm) return window.toast('새 비밀번호 확인이 일치하지 않습니다.');
  if (!passwordRecoveryMode && currentPassword === newPassword) return window.toast('현재 비밀번호와 다른 비밀번호를 입력해 주세요.');

  passwordBusy = true;
  const button = byId('passwordChangeButton');
  if (button) {
    button.disabled = true;
    button.textContent = '변경 중...';
  }
  try {
    if (!passwordRecoveryMode) {
      const email = currentProfile?.email || '';
      const { error: verificationError } = await supabase.auth.signInWithPassword({ email, password: currentPassword });
      if (verificationError) return window.toast('현재 비밀번호가 올바르지 않습니다.');
    }
    const { error } = await supabase.auth.updateUser({ password: newPassword });
    if (error) return window.toast(error.message || '비밀번호 변경에 실패했습니다.');
    passwordRecoveryMode = false;
    await supabase.auth.signOut({ scope: 'global' });
    currentProfile = null;
    showAuth('login');
    setAuthMessage('비밀번호가 변경되었습니다. 새 비밀번호로 다시 로그인해 주세요.', 'success');
  } finally {
    passwordBusy = false;
    if (button) {
      button.disabled = false;
      button.textContent = '비밀번호 변경';
    }
  }
}

async function saveMyNickname() {
  if (!supabase || !currentProfile) return;
  const nickname = byId('accountNickname')?.value.trim() || '';
  if (nickname.length < 2 || nickname.length > 20) return window.toast('닉네임은 2~20자로 입력해 주세요.');
  const button = byId('nicknameSaveButton');
  if (button) button.disabled = true;
  const { data, error } = await supabase.rpc('update_my_nickname', { new_nickname: nickname });
  if (button) button.disabled = false;
  if (error) return window.toast('닉네임을 저장하지 못했습니다.');
  currentProfile = data;
  byId('accountNickname').value = data.nickname || '';
  window.toast('닉네임을 저장했습니다.');
}

const TEMP_PASSWORD_ERRORS = {
  ADMIN_REQUIRED: '승인된 관리자만 임시 비밀번호를 발급할 수 있습니다.',
  AUTH_REQUIRED: '로그인이 만료되었습니다. 다시 로그인해 주세요.',
  MEMBER_NOT_FOUND: '회원을 찾을 수 없습니다.',
};

function clearMemberTempPassword() {
  const box = byId('memberTempPasswordResult');
  if (!box) return;
  box.classList.add('hidden');
  if (byId('memberTempPasswordValue')) byId('memberTempPasswordValue').textContent = '';
  if (byId('memberTempPasswordCopy')) byId('memberTempPasswordCopy').textContent = '복사';
}

// No email is sent: the administrator gets a one-time temporary password to hand over.
async function issueMemberTemporaryPassword() {
  if (!supabase || currentProfile?.role !== 'ADMIN' || !selectedMemberId || adminPasswordResetBusy) return;
  const name = byId('memberDetailTitle')?.textContent?.trim() || '이 회원';
  if (!window.confirm(`${name} 회원의 임시 비밀번호를 발급할까요?\n\n기존 비밀번호는 즉시 사용할 수 없게 됩니다. 발급된 비밀번호는 한 번만 표시됩니다.`)) return;
  const userId = selectedMemberId;
  const button = byId('memberPasswordResetButton');
  adminPasswordResetBusy = true;
  clearMemberTempPassword();
  if (button) {
    button.disabled = true;
    button.textContent = '발급 중...';
  }
  try {
    let result;
    try {
      result = await supabase.functions.invoke('admin-reset-password', { body: { user_id: userId } });
    } catch (error) {
      result = { data: null, error };
    }
    const password = result.data?.temporary_password;
    if (result.error || !password) {
      const code = result.data?.error || await functionErrorCode(result.error);
      return window.toast(TEMP_PASSWORD_ERRORS[code] || '임시 비밀번호를 발급하지 못했습니다.', { kind: 'error' });
    }
    // The detail modal may have moved to another member meanwhile: never show it there.
    if (selectedMemberId !== userId) return window.toast('임시 비밀번호가 발급되었지만 다른 회원 화면으로 바뀌어 표시하지 않았습니다. 다시 발급해 주세요.', { kind: 'error' });
    byId('memberTempPasswordValue').textContent = password;
    byId('memberTempPasswordResult').classList.remove('hidden');
    byId('memberTempPasswordCopy')?.focus({ preventScroll: true });
    window.toast('임시 비밀번호를 발급했습니다. 회원에게 안전하게 전달해 주세요.', { kind: 'success' });
  } finally {
    adminPasswordResetBusy = false;
    if (button) {
      button.disabled = false;
      button.textContent = '임시 비밀번호 발급';
    }
  }
}

async function copyMemberTempPassword() {
  const value = byId('memberTempPasswordValue')?.textContent || '';
  if (!value) return;
  const button = byId('memberTempPasswordCopy');
  try {
    await navigator.clipboard.writeText(value);
    if (button) button.textContent = '복사됨';
  } catch {
    const range = document.createRange();
    range.selectNodeContents(byId('memberTempPasswordValue'));
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    window.toast('자동 복사가 차단되었습니다. 선택된 비밀번호를 직접 복사해 주세요.');
  }
}

window.openPage = (id) => {
  if (!pages[id]) return;
  document.querySelectorAll('.page').forEach((page) => page.classList.remove('active'));
  byId(id).classList.add('active');
  document.querySelectorAll('.nav-btn').forEach((button) => {
    const active = button.dataset.page === id;
    button.classList.toggle('active', active);
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  byId('title').textContent = pages[id][0];
  byId('subtitle').textContent = pages[id][1];
  byId('side').classList.remove('open');
  window.scrollTo(0, 0);
  if (id === 'admin-members' && currentProfile?.role === 'ADMIN') loadAdminMembers();
  if (id === 'member-analysis' && currentProfile?.role === 'MEMBER') loadTradingAnalysis();
  if (['member-dashboard', 'member-trades'].includes(id) && currentProfile?.role === 'MEMBER') loadMemberLiveData();
  if (id === 'member-copy' && currentProfile?.role === 'MEMBER') refreshCopySettingsFromServer();
  if (['member-account', 'member-trades'].includes(id) && currentProfile?.role === 'MEMBER') loadGateConnection(false);
  if (id === 'admin-member-analysis' && currentProfile?.role === 'ADMIN') loadAdminAnalysisMembers();
  if (id === 'admin-events' && currentProfile?.role === 'ADMIN') loadAdminOperationalEvents();
  if (id === 'admin-audit' && currentProfile?.role === 'ADMIN') loadAdminAuditLog();
  if (id === 'admin-api' && currentProfile?.role === 'ADMIN') {
    loadAdminMasterGateConnection();
    loadAdminGateConnections();
  }
  if ((id === 'admin-settings' || id === 'admin-risk') && currentProfile?.role === 'ADMIN') loadCopySystemStatus();
  if (id === 'admin-dashboard' && currentProfile?.role === 'ADMIN') loadAdminLiveData();
  if (id === 'admin-dashboard' && currentProfile?.role === 'ADMIN') loadAdminOperationsMetrics();
};

window.openPause = () => {
  setPauseCloseConfirm(false);
  renderPauseModalStatus();
  openModal(byId('pauseModal'));
};
window.closePause = () => {
  setPauseCloseConfirm(false);
  closeModal(byId('pauseModal'));
};

let toastTimer = null;
const TOAST_ERROR_PATTERN = /못했습니다|실패|확인해 주세요|입력해 주세요|일치하지 않습니다|올바르지 않습니다|오류/;
// One live region; every message restarts its own timer. Errors stay readable for longer.
window.toast = (message, { kind, duration } = {}) => {
  const element = byId('toast');
  if (!element) return;
  const isError = kind === 'error' || (kind !== 'success' && TOAST_ERROR_PATTERN.test(String(message)));
  element.textContent = message;
  element.classList.toggle('toast-error', isError);
  element.classList.add('show');
  element.style.opacity = 1;
  if (toastTimer) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    element.classList.remove('show');
    element.style.opacity = 0;
    toastTimer = null;
  }, duration || (isError ? 4200 : 2400));
};

const HALT_REASON_LABELS = {
  ADMIN_EMERGENCY_HALT: '관리자 긴급 중단',
  ADMIN_HALT: '관리자 중단',
  WORKER_NOT_READY: 'Trading Worker 준비 중',
  WORKER_REPEATED_FAILURE: 'Trading Worker 연속 오류',
  STALE_OR_INVALID_WORKER: 'Trading Worker 응답 지연',
  TRADING_WORKER_NOT_CONFIGURED: 'Trading Worker 미설정',
  MASTER_API_DISCONNECTED: 'Master API 연결 해제',
  DUPLICATE_ORDER_ANOMALY: '중복 주문 의심으로 안전 중단',
  ORDER_QUANTITY_MISMATCH: '주문 수량 불일치 확인 중',
  RECONCILIATION_QUANTITY_MISMATCH: '포지션 수량 대조 중',
  DAILY_LOSS_LIMIT: '일일 손실 한도 도달',
  MAX_DRAWDOWN_LIMIT: '최대 손실 한도 도달',
  MEMBER_PAUSED: '회원 일시중지',
  DB_TIMEOUT: '데이터베이스 응답 지연',
  LIVE_EXECUTION_ENABLED: '실거래 활성화',
  DEPLOYMENT_CHECKLIST_COMPLETED: '배포 점검 완료',
};

function haltReasonLabel(code, { withCode = false } = {}) {
  if (!code) return '안전 점검 중';
  const label = HALT_REASON_LABELS[code] || '안전 점검 중';
  return withCode ? `${label} (${code})` : label;
}

// Banner tone: live = green, halted = red, any other blocked state = amber.
function setStatusTone(dot, tone) {
  if (!dot) return;
  dot.classList.toggle('offline', tone !== 'live');
  dot.classList.toggle('halted', tone === 'halted');
  const banner = dot.closest('.status');
  if (!banner) return;
  banner.classList.toggle('status-warn', tone === 'warn');
  banner.classList.toggle('status-halted', tone === 'halted');
}

function renderCopySystemStatus(status) {
  const worker = status?.worker || {};
  const live = Boolean(status?.execution_enabled && !status?.emergency_halted && worker.healthy && worker.mode === 'LIVE');
  const tone = live ? 'live' : status?.emergency_halted ? 'halted' : 'warn';
  const title = live ? '카피트레이딩 실거래 실행 중' : status?.emergency_halted ? '카피트레이딩 안전 중단' : '카피트레이딩 준비 중';
  const reason = status?.halt_reason || 'WORKER_NOT_READY';
  for (const prefix of ['member', 'admin']) {
    const titleNode = byId(`${prefix}SystemTitle`);
    const detailNode = byId(`${prefix}SystemDetail`);
    const dot = byId(`${prefix}SystemDot`);
    const detail = live
      ? `고정 IP Worker 정상 · ${new Date(worker.heartbeat_at).toLocaleString('ko-KR')}`
      : `신규 주문 차단 · ${haltReasonLabel(reason, { withCode: prefix === 'admin' })}`;
    if (titleNode) titleNode.textContent = title;
    if (detailNode) detailNode.textContent = detail;
    setStatusTone(dot, tone);
  }
  if (!byId('opsExecution')) return;
  byId('opsExecution').textContent = status?.execution_enabled ? '활성' : '비활성';
  byId('opsExecution').className = live ? 'pos' : 'warn';
  byId('opsHalt').textContent = status?.emergency_halted ? '중단됨' : '해제';
  byId('opsHalt').className = status?.emergency_halted ? 'neg' : 'pos';
  byId('opsReason').textContent = status?.halt_reason ? haltReasonLabel(status.halt_reason, { withCode: true }) : '-';
  byId('opsUpdated').textContent = status?.updated_at ? new Date(status.updated_at).toLocaleString('ko-KR') : '-';
  byId('opsExecutionChip').textContent = live ? '실거래 실행' : '주문 잠금';
  byId('opsExecutionChip').className = live ? 'chip' : 'chip yellow';
  byId('opsWorkerMode').textContent = worker.mode || 'OBSERVE';
  byId('opsWorkerIp').textContent = worker.public_ip || '미설정';
  if (byId('opsBrokerChannel')) {
    const brokerChannelReady = Boolean(worker.broker_channel_id && worker.broker_channel_id === status?.broker_channel_id);
    byId('opsBrokerChannel').textContent = worker.broker_channel_id || status?.broker_channel_id || '미설정';
    byId('opsBrokerChannel').className = brokerChannelReady ? 'pos' : 'warn';
  }
  byId('opsHeartbeat').textContent = worker.heartbeat_at ? new Date(worker.heartbeat_at).toLocaleString('ko-KR') : '없음';
  byId('opsLastSuccess').textContent = worker.last_success_at ? new Date(worker.last_success_at).toLocaleString('ko-KR') : '없음';
  byId('opsFailures').textContent = String(worker.consecutive_failures || 0);
  byId('opsFailures').className = Number(worker.consecutive_failures || 0) > 0 ? 'neg' : 'pos';
  byId('opsTest').textContent = worker.test_passed_at ? new Date(worker.test_passed_at).toLocaleString('ko-KR') : '미완료';
  byId('opsWorkerChip').textContent = worker.healthy ? '정상' : '오프라인';
  byId('opsWorkerChip').className = worker.healthy ? 'chip' : 'chip red';
}

const RESUME_STATE_LABELS = {
  REQUIRED: '재개 확인 필요', REQUESTED: '재개 안전 확인 중', VALIDATED: '확인 완료 · 실행 대기',
  PAUSED: '회원 카피 일시중지', BLOCKED: '재개 확인 필요', CLOSING: '요청한 포지션 정리 대기',
};

async function loadCopySystemStatus() {
  if (!supabase || !currentProfile) return;
  const { data, error } = await supabase.rpc('get_copy_system_status');
  if (error) return;
  memberSystemStatus = data;
  renderCopySystemStatus(data);
  if (currentProfile.role === 'MEMBER') {
    const { data: resumes, error: resumeError } = await supabase.rpc('get_member_copy_resume_status', { p_user_id: currentProfile.id });
    if (!resumeError) memberResumeWaiting = (resumes || []).find((row) => row.state !== 'ACTIVE') || null;
    const waiting = memberResumeWaiting;
    if (!resumeError && waiting) {
      const detail = byId('memberSystemDetail');
      if (detail) detail.textContent += ' · ' + (RESUME_STATE_LABELS[waiting.state] || '재개 확인 중');
      if (waiting.reason === 'RESUME_UNRESOLVED_ORDERS' && detail) detail.textContent += ' · 이전 주문 결과 확인 대기';
      if (!data?.emergency_halted && byId('memberSystemTitle')) byId('memberSystemTitle').textContent = RESUME_STATE_LABELS[waiting.state] || '재개 안전 확인 중';
      if (!data?.emergency_halted) setStatusTone(byId('memberSystemDot'), 'warn');
    }
    renderMemberCopyStatusChip();
  }
}

function startCopySystemPolling() {
  stopCopySystemPolling();
  copySystemTimer = window.setInterval(() => {
    if (!document.hidden) loadCopySystemStatus();
  }, 10_000);
}

function stopCopySystemPolling() {
  if (copySystemTimer) window.clearInterval(copySystemTimer);
  copySystemTimer = null;
}

function isCopySystemLive(status) {
  const worker = status?.worker || {};
  return Boolean(status?.execution_enabled && !status?.emergency_halted && worker.healthy && worker.mode === 'LIVE');
}

// One definition of the member's own copy state, shared by the trades chip and the pause modal.
function getMemberSelfCopyStatus() {
  if (!currentProfile) return { label: '상태 확인 중', className: 'chip yellow', title: '카피 상태를 확인하고 있습니다.' };
  if (memberSystemStatus?.emergency_halted) {
    return { label: '전체 카피 중단', className: 'chip red', title: `운영자가 전체 신규 주문을 중단했습니다 · ${haltReasonLabel(memberSystemStatus.halt_reason)}` };
  }
  if (memberResumeWaiting) {
    return { label: RESUME_STATE_LABELS[memberResumeWaiting.state] || '재개 확인 중', className: 'chip yellow', title: '카피가 일시중지되었거나 재개 안전 확인이 진행 중입니다.' };
  }
  if (!memberGateConnectionLoaded) return { label: '상태 확인 중', className: 'chip yellow', title: '카피 상태를 확인하고 있습니다.' };
  const positions = Array.isArray(memberLiveSnapshot?.positions) ? memberLiveSnapshot.positions : [];
  const progress = getMemberCopyProgress(currentProfile, memberGateConnection, positions);
  if (progress.label === '카피 진행 중' && memberSystemStatus && !isCopySystemLive(memberSystemStatus)) {
    return { label: '시스템 준비 중', className: 'chip yellow', title: `신규 주문 대기 · ${haltReasonLabel(memberSystemStatus.halt_reason || 'WORKER_NOT_READY')}` };
  }
  return { label: progress.label === '카피 진행 중' ? '정상 카피 중' : progress.label, className: progress.className, title: progress.detail };
}

function renderMemberCopyStatusChip() {
  const chip = byId('memberTradeStatus');
  if (!chip) return;
  const status = getMemberSelfCopyStatus();
  chip.textContent = status.label;
  chip.className = status.className;
  chip.title = status.title || '';
}

function openPositionSummary() {
  if (!memberLiveSnapshot) return null;
  const positions = Array.isArray(memberLiveSnapshot.open_positions) ? memberLiveSnapshot.open_positions : [];
  const notional = positions.reduce((sum, position) => sum + Math.abs(Number(position.notional || 0)), 0);
  return { count: positions.length, notional };
}

function renderPauseModalStatus() {
  const status = getMemberSelfCopyStatus();
  const statusNode = byId('pauseModalStatus');
  if (statusNode) {
    statusNode.textContent = status.label;
    statusNode.className = status.className;
    statusNode.title = status.title || '';
  }
  const summary = openPositionSummary();
  const positionsNode = byId('pauseModalPositions');
  if (positionsNode) positionsNode.textContent = summary
    ? summary.count ? `보유 포지션 ${summary.count}개 · 총 규모 ${formatAmount(summary.notional)}` : '보유 포지션 없음'
    : '보유 포지션 정보를 아직 확인하지 못했습니다.';
}

function setPauseCloseConfirm(show) {
  byId('pauseModalActions')?.classList.toggle('hidden', show);
  byId('pauseCloseConfirm')?.classList.toggle('hidden', !show);
  if (!show) return;
  const summary = openPositionSummary();
  const detail = byId('pauseCloseConfirmDetail');
  if (detail) detail.textContent = summary
    ? summary.count
      ? `신규 카피를 중지하고 보유 중인 포지션 ${summary.count}개(총 규모 ${formatAmount(summary.notional)})의 정리 주문을 요청합니다. 정리된 포지션은 되돌릴 수 없습니다.`
      : '현재 확인된 보유 포지션은 없습니다. 신규 카피를 중지하고, 이후 남은 카피 포지션이 확인되면 정리합니다.'
    : '보유 포지션 정보를 확인하지 못했습니다. 신규 카피를 중지하고 남아 있는 카피 포지션의 정리 주문을 요청합니다. 정리된 포지션은 되돌릴 수 없습니다.';
  window.requestAnimationFrame(() => byId('pauseCloseConfirm')?.querySelector('[data-copy-pause-cancel]')?.focus());
}

function setPauseButtonsDisabled(disabled) {
  document.querySelectorAll('#pauseModal [data-copy-pause], #pauseModal [data-copy-pause-confirm], #pauseModal [data-copy-pause-cancel]').forEach((button) => { button.disabled = disabled; });
}

async function setCopyPause(mode) {
  if (!supabase || currentProfile?.role !== 'MEMBER' || copyPauseBusy) return;
  copyPauseBusy = true;
  setPauseButtonsDisabled(true);
  try {
    const { error } = await supabase.rpc('set_my_copy_pause', { p_mode: mode });
    if (error) return window.toast('카피 상태 변경에 실패했습니다.', { kind: 'error' });
    window.closePause();
    window.toast(mode === 'RESUME' ? '기존 보유 포지션을 유지하며 재개 안전 확인을 요청했습니다.' : mode === 'CLOSE' ? '신규 카피 중지와 포지션 정리를 요청했습니다.' : '신규 카피를 중지했습니다.', { kind: 'success' });
    await loadCopySystemStatus();
  } finally {
    copyPauseBusy = false;
    setPauseButtonsDisabled(false);
  }
}

async function emergencyHalt() {
  if (!supabase || currentProfile?.role !== 'ADMIN') return;
  if (!window.confirm('전체 신규 카피 주문을 즉시 중단할까요?')) return;
  const { error } = await supabase.rpc('set_copy_system_control', { p_execution_enabled: false, p_emergency_halted: true, p_reason: 'ADMIN_EMERGENCY_HALT' });
  if (error) return window.toast('긴급 중단에 실패했습니다.');
  await loadCopySystemStatus();
  window.toast('전체 카피 주문을 중단했습니다.');
}

// Raw worker/exchange codes are shown as short Korean labels; the title explains them.
const POSITION_STATE_META = {
  SYNCED: ['동기화됨', 'chip', 'Master 목표 수량과 실제 수량이 일치합니다.'],
  DRIFT: ['맞추는 중', 'chip yellow', '목표 수량과 차이가 있어 다음 주기에 맞춥니다.'],
  MANUAL_OVERRIDE: ['직접 거래 감지', 'chip yellow', '회원이 직접 포지션을 변경해 이 종목의 자동 카피를 멈췄습니다.'],
  PAUSED: ['일시중지', 'chip yellow', '이 종목의 카피가 일시중지되었습니다.'],
  REDUCE_ONLY: ['축소만 허용', 'chip yellow', '신규 진입은 막고 포지션 축소 주문만 허용합니다.'],
  HALTED: ['중단', 'chip red', '안전장치가 작동해 이 종목의 신규 주문이 차단되었습니다.'],
  ERROR: ['오류', 'chip red', '주문 또는 포지션 처리 중 오류가 발생했습니다.'],
  FILLED: ['체결 완료', 'chip', '주문이 모두 체결되었습니다.'],
  PARTIALLY_FILLED: ['일부 체결', 'chip yellow', '요청 수량 중 일부만 체결되었습니다.'],
  SUBMITTING: ['전송 중', 'chip yellow', '거래소로 주문을 전송하고 있습니다.'],
  ACKNOWLEDGED: ['접수됨', 'chip yellow', '거래소가 주문을 접수했습니다.'],
  PLANNED: ['대기', 'chip yellow', '주문 전송을 준비하고 있습니다.'],
  QUEUED: ['대기', 'chip yellow', '주문 전송을 기다리고 있습니다.'],
  REJECTED: ['거절', 'chip red', '거래소가 주문을 거절했습니다.'],
  CANCELLED: ['취소', 'chip red', '주문이 취소되었습니다.'],
  UNKNOWN: ['확인 필요', 'chip yellow', '주문 결과가 확정되지 않았습니다.'],
  INFO: ['정보', 'chip', '참고용 기록입니다.'],
  WARNING: ['경고', 'chip yellow', '확인이 필요한 기록입니다.'],
  CRITICAL: ['심각', 'chip red', '즉시 확인이 필요한 기록입니다.'],
};

function stateChip(state) {
  const meta = POSITION_STATE_META[state] || ['확인 필요', 'chip yellow', state ? `상태 코드: ${state}` : '상태 정보가 없습니다.'];
  return `<span class="${meta[1]}" title="${escapeHtml(meta[2])}">${escapeHtml(meta[0])}</span>`;
}

// Prices keep enough precision for low-priced contracts (e.g. 0.012345 vs 0.012401).
function formatMasterPrice(value) {
  const number = Number(value || 0);
  if (!(number > 0)) return '-';
  const options = number >= 100 ? { maximumFractionDigits: 2 } : number >= 1 ? { maximumFractionDigits: 4 } : { maximumSignificantDigits: 5 };
  return `$${number.toLocaleString('en-US', options)}`;
}

function renderAdminMasterPositions() {
  const selectedMember = adminPositionMembers.find((member) => member.user_id === adminPositionOwner);
  const isMaster = adminPositionOwner === 'MASTER';
  const positions = isMaster ? adminMasterPositions : adminMemberPositions.filter((position) => position.user_id === adminPositionOwner);
  const longCount = positions.filter((position) => Number(position.size) > 0).length;
  const shortCount = positions.filter((position) => Number(position.size) < 0).length;
  const latest = positions.reduce((value, position) => Math.max(value, new Date(position.observed_at || 0).getTime()), 0);
  if (byId('masterPositionCount')) byId('masterPositionCount').textContent = String(positions.length);
  if (byId('masterDirectionCount')) byId('masterDirectionCount').textContent = `Long ${longCount} · Short ${shortCount}`;
  if (byId('masterLongCount')) byId('masterLongCount').textContent = String(longCount);
  if (byId('masterShortCount')) byId('masterShortCount').textContent = String(shortCount);
  if (byId('masterPositionBadge')) byId('masterPositionBadge').textContent = String(positions.length);
  if (byId('adminPositionTitle')) byId('adminPositionTitle').textContent = isMaster ? '현재 포지션' : `${selectedMember?.name || accountDisplayId(selectedMember?.gate_uid, selectedMember?.email) || '회원'} 보유 포지션`;
  if (byId('adminPositionDescription')) byId('adminPositionDescription').textContent = isMaster
    ? 'Gate.io에서 Worker가 확인한 Master 무기한 선물 포지션입니다.'
    : 'Gate.io Worker가 확인한 선택 회원의 실제 무기한 선물 포지션입니다.';
  if (byId('masterLastObserved')) byId('masterLastObserved').textContent = latest ? new Date(latest).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }) : '-';
  const filtered = positions.filter((position) => adminMasterFilter === 'ALL' || (Number(position.size) > 0 ? 'LONG' : 'SHORT') === adminMasterFilter);
  const container = byId('adminMasterPositionCards');
  if (!container) return;
  container.innerHTML = filtered.length ? filtered.map((position) => {
    const size = Number(position.size || 0);
    const entry = Number(position.entry_price || 0);
    const mark = Number(position.mark_price || 0);
    const leverage = Number(position.leverage || 0);
    const side = size > 0 ? 'LONG' : 'SHORT';
    const priceMove = entry > 0 ? ((mark - entry) / entry) * (size > 0 ? 1 : -1) * 100 : 0;
    const estimatedRoe = priceMove * Math.max(leverage, 1);
    const unrealisedPnl = Number(position.unrealised_pnl ?? ((mark - entry) * size * Number(position.quanto_multiplier || 0)));
    const notional = Math.abs(Number(position.notional ?? (size * mark * Number(position.quanto_multiplier || 0))));
    const margin = position.margin == null ? null : Math.abs(Number(position.margin));
    const pnlClass = signClass(unrealisedPnl);
    return `<article class="master-position-card">
      <div class="master-position-card-head"><div class="master-symbol">${positionLogo(position.contract)}<div><b>${escapeHtml(position.contract)}</b><small>무기한 선물</small></div></div><div class="master-side"><span class="${side === 'LONG' ? 'long' : 'short'}">${side}</span><small>${leverage || '-'}x</small></div></div>
      <div class="master-position-pnl"><div><small>미실현 수익금</small><strong class="${pnlClass}">${formatUsd(unrealisedPnl)}</strong></div><b class="${signClass(estimatedRoe)}">${formatSignedPct(estimatedRoe)}</b></div>
      <div class="master-position-metrics"><div><span>진입가</span><b>${formatMasterPrice(entry)}</b></div><div><span>현재가</span><b>${formatMasterPrice(mark)}</b></div>${isMaster ? `<div><span>계약 수량</span><b>${Math.abs(size).toLocaleString()}</b></div><div><span>방향</span><b class="${side === 'LONG' ? 'pos' : 'neg'}">${side}</b></div>` : `<div><span>포지션 규모</span><b>${formatAmount(notional)}</b></div><div><span>증거금</span><b>${margin == null ? '-' : formatAmount(margin)}</b></div>`}</div>
      <div class="master-position-sync"><span>마지막 확인</span><time>${position.observed_at ? new Date(position.observed_at).toLocaleString('ko-KR') : '-'}</time></div>
    </article>`;
  }).join('') : `<div class="master-position-empty">${adminMasterFilter !== 'ALL' ? `${adminMasterFilter} 포지션이 없습니다.` : isMaster ? '현재 열린 Master 포지션이 없습니다.' : '선택한 회원의 열린 포지션이 없습니다.'}</div>`;
}

function renderAdminPositionOwnerOptions() {
  const select = byId('adminPositionOwner');
  if (!select) return;
  select.innerHTML = '<option value="MASTER">Master 포지션</option>' + adminPositionMembers.map((member) => `<option value="${escapeHtml(member.user_id)}">${escapeHtml(member.name || accountDisplayId(member.gate_uid, member.email) || '이름 없는 회원')}</option>`).join('');
  if (!['MASTER', ...adminPositionMembers.map((member) => member.user_id)].includes(adminPositionOwner)) adminPositionOwner = 'MASTER';
  select.value = adminPositionOwner;
}

window.setAdminMasterFilter = (filter, button) => {
  adminMasterFilter = ['ALL', 'LONG', 'SHORT'].includes(filter) ? filter : 'ALL';
  document.querySelectorAll('[data-master-filter]').forEach((item) => item.classList.toggle('active', item === button));
  renderAdminMasterPositions();
};

function renderMemberPerformance() {
  const data = memberDashboardPerformance;
  const days = Array.isArray(data?.days) ? data.days : [];
  const totals = data?.totals || {};
  const roiSeries = [];
  let compounded = 1;
  for (const day of days) {
    const dailyReturn = Number(day.daily_return_pct || 0);
    compounded *= Math.max(0, 1 + dailyReturn / 100);
    roiSeries.push({ date: day.date, value: (compounded - 1) * 100 });
  }
  const series = memberDashboardMetric === 'ROI'
    ? roiSeries
    : days.map((day, index) => ({ date: day.date, value: days.slice(0, index + 1).reduce((sum, row) => sum + Number(row.net_pnl || 0), 0) }));
  const value = memberDashboardMetric === 'ROI' ? Number(totals.roi || 0) : Number(totals.net_pnl || 0);
  const valueNode = byId('memberPerformanceValue');
  if (valueNode) {
    valueNode.textContent = memberDashboardMetric === 'ROI' ? formatSignedPct(value) : formatUsd(value);
    valueNode.className = `member-performance-value ${signClass(value)}`;
  }
  if (byId('memberPerformancePeriod')) byId('memberPerformancePeriod').textContent = data?.range_start ? `${data.range_start} → ${data.range_end}` : '-';
  const chart = byId('memberPerformanceChart');
  if (chart) {
    if (!series.length) chart.innerHTML = '<div class="member-chart-empty">선택한 기간에 집계된 거래 성과가 없습니다.</div>';
    else {
      const width = 900; const height = 250; const pad = 24;
      const values = series.map((point) => point.value);
      const min = Math.min(0, ...values); const max = Math.max(0, ...values);
      const span = Math.max(1, max - min);
      const points = series.map((point, index) => ({
        ...point,
        x: pad + (series.length === 1 ? 0 : index * (width - pad * 2) / (series.length - 1)),
        y: pad + (max - point.value) * (height - pad * 2) / span,
      }));
      const line = points.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ');
      const area = `${pad},${height - pad} ${line} ${points.at(-1).x.toFixed(1)},${height - pad}`;
      chart.innerHTML = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${memberDashboardMetric === 'ROI' ? '누적 수익률' : '누적 손익'} 추이"><defs><linearGradient id="memberChartFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#19c997" stop-opacity=".38"/><stop offset="1" stop-color="#19c997" stop-opacity=".02"/></linearGradient></defs><line x1="${pad}" y1="${height - pad}" x2="${width - pad}" y2="${height - pad}" class="member-chart-axis"/><polygon points="${area}" fill="url(#memberChartFill)"/><polyline points="${line}" class="member-chart-line"/>${points.length ? `<circle cx="${points.at(-1).x}" cy="${points.at(-1).y}" r="6" class="member-chart-point"/>` : ''}</svg>`;
    }
  }
  if (byId('memberWinRate')) byId('memberWinRate').textContent = totals.win_rate == null ? '-' : `${Number(totals.win_rate).toFixed(2)}%`;
  if (byId('memberTradeCount')) byId('memberTradeCount').textContent = Number(totals.trades || 0).toLocaleString();
  if (byId('memberWins')) byId('memberWins').textContent = Number(totals.wins || 0).toLocaleString();
  if (byId('memberLosses')) byId('memberLosses').textContent = Number(totals.losses || 0).toLocaleString();
  const decisions = Number(totals.wins || 0) + Number(totals.losses || 0);
  if (byId('memberWinBar')) byId('memberWinBar').style.width = `${decisions ? Number(totals.wins || 0) * 100 / decisions : 0}%`;
  if (byId('memberLossBar')) byId('memberLossBar').style.width = `${decisions ? Number(totals.losses || 0) * 100 / decisions : 0}%`;
  if (byId('memberStatsPnl')) byId('memberStatsPnl').textContent = formatUsd(totals.net_pnl);
  if (byId('memberMdd')) byId('memberMdd').textContent = `${Number(totals.mdd || 0).toFixed(2)}%`;
  if (byId('memberAverageTrades')) byId('memberAverageTrades').textContent = Number(totals.average_daily_trades || 0).toFixed(2);
  if (byId('memberLastTrade')) byId('memberLastTrade').textContent = totals.last_trade_at ? new Date(totals.last_trade_at).toLocaleString('ko-KR') : '-';
  if (byId('memberDrawdownUsage')) byId('memberDrawdownUsage').textContent = `현재 ${Number(totals.mdd || 0).toFixed(2)}%`;
}

function setNeutralDash(id) {
  const node = byId(id);
  if (!node) return;
  node.textContent = '-';
  node.className = '';
}

function inlineRetry(message, target) {
  return `<div class="inline-error" role="alert"><span>${escapeHtml(message)}</span><button class="btn" type="button" data-retry="${escapeHtml(target)}">다시 시도</button></div>`;
}

// "오늘" only when the last aggregated day really is today in KST; otherwise show its date.
function renderMemberDailyLossUsage() {
  const node = byId('memberDailyLossUsage');
  if (!node) return;
  const lastDay = memberMonthPerformance?.days?.at(-1);
  const equity = Number(memberLiveSnapshot?.account?.total_equity || 0);
  if (!lastDay) {
    node.textContent = memberMonthPerformance ? '오늘 0.00%' : '오늘 사용 -';
    return;
  }
  const pct = equity > 0 ? Number(lastDay.net_pnl || 0) * 100 / equity : 0;
  const label = lastDay.date === kstDate() ? '오늘' : `${String(lastDay.date).slice(5).replace('-', '/')} 기준`;
  node.textContent = `${label} ${pct.toFixed(2)}%`;
}

function renderMemberRiskLimits() {
  if (byId('memberPositionCapLimit')) byId('memberPositionCapLimit').textContent = `${Number(currentProfile?.max_position_ratio ?? 30)}%`;
  if (byId('memberDailyLossLimit')) byId('memberDailyLossLimit').textContent = `${Number(currentProfile?.daily_loss_limit_pct ?? 15)}%`;
  if (byId('memberDrawdownLimit')) byId('memberDrawdownLimit').textContent = `${Number(currentProfile?.max_drawdown_pct ?? 20)}%`;
  if (byId('memberCopyRatioLimit')) byId('memberCopyRatioLimit').textContent = `${Number(currentProfile?.copy_ratio ?? 100)}%`;
}

function renderMemberCumulativeStats() {
  const setSigned = (id, value, percent = false) => {
    const node = byId(id);
    if (!node) return;
    node.textContent = percent ? formatSignedPct(value) : formatUsd(value);
    node.className = signClass(value);
  };
  // A failed or missing response renders '-' instead of a misleading green $0.00.
  if (memberCumulativePerformance) {
    const cumulative = memberCumulativePerformance.totals || {};
    setSigned('memberCumulativePnl', Number(cumulative.net_pnl || 0));
    setSigned('memberCumulativeRoi', Number(cumulative.roi || 0), true);
  } else {
    setNeutralDash('memberCumulativePnl');
    setNeutralDash('memberCumulativeRoi');
  }
  if (memberMonthPerformance) setSigned('memberMonthPnl', Number(memberMonthPerformance.totals?.net_pnl || 0));
  else setNeutralDash('memberMonthPnl');
  const copyStart = currentProfile?.copy_started_at ? toKstDate(currentProfile.copy_started_at) : memberCumulativePerformance?.range_start;
  if (byId('memberCopyStartedAt')) byId('memberCopyStartedAt').textContent = `카피 시작일 ${copyStart || '-'}`;
  if (byId('memberMonthPeriod')) {
    const end = memberMonthPerformance?.range_end;
    byId('memberMonthPeriod').textContent = memberMonthPerformance?.range_start
      ? `${memberMonthPerformance.range_start} ~ ${!end || end === kstDate() ? '오늘' : end}`
      : '이번 달';
  }
  renderMemberDailyLossUsage();
}

async function loadMemberCumulativePerformance() {
  if (!supabase || currentProfile?.role !== 'MEMBER') return;
  const today = kstDate();
  const fallback = kstDateOffset(-364);
  const copyStart = currentProfile.copy_started_at ? toKstDate(currentProfile.copy_started_at) : fallback;
  const monthStart = `${today.slice(0, 7)}-01`;
  const [cumulativeResult, monthResult] = await Promise.all([
    supabase.rpc('get_my_dashboard_performance_range', { p_start_date: copyStart < fallback ? fallback : copyStart, p_end_date: today }),
    supabase.rpc('get_my_dashboard_performance_range', { p_start_date: monthStart, p_end_date: today }),
  ]);
  memberCumulativePerformance = cumulativeResult.error ? null : cumulativeResult.data;
  memberMonthPerformance = monthResult.error ? null : monthResult.data;
  renderMemberCumulativeStats();
}

function renderMemberPerformanceError() {
  const valueNode = byId('memberPerformanceValue');
  if (valueNode) {
    valueNode.textContent = '-';
    valueNode.className = 'member-performance-value';
  }
  const chart = byId('memberPerformanceChart');
  if (chart) chart.innerHTML = inlineRetry('성과 데이터를 불러오지 못했습니다.', 'member-performance');
  if (byId('memberPerformancePeriod')) byId('memberPerformancePeriod').textContent = '-';
}

async function loadMemberDashboardPerformance(days = memberDashboardRange) {
  if (!supabase || currentProfile?.role !== 'MEMBER') return;
  const { data, error } = await supabase.rpc('get_my_dashboard_performance', { p_days: days });
  if (error) {
    renderMemberPerformanceError();
    return window.toast('성과 데이터를 불러오지 못했습니다.', { kind: 'error' });
  }
  memberDashboardPerformance = data;
  renderMemberPerformance();
}

async function loadMemberDashboardPerformanceRange(startDate, endDate) {
  if (!supabase || currentProfile?.role !== 'MEMBER') return;
  const { data, error } = await supabase.rpc('get_my_dashboard_performance_range', { p_start_date: startDate, p_end_date: endDate });
  if (error) return window.toast('선택한 기간의 성과 데이터를 불러오지 못했습니다.');
  memberDashboardPerformance = data;
  renderMemberPerformance();
}

function renderMemberOpenPositions(openPositions, account) {
  const positions = Array.isArray(openPositions) ? openPositions : [];
  const totalEquity = Number(account?.total_equity || 0);
  if (byId('memberOpenPositionCount')) byId('memberOpenPositionCount').textContent = String(positions.length);
  if (byId('memberPositionBadge')) byId('memberPositionBadge').textContent = String(positions.length);
  const longs = positions.filter((position) => position.side === 'LONG').length;
  if (byId('memberPositionDirections')) byId('memberPositionDirections').textContent = `롱 ${longs} · 숏 ${positions.length - longs}`;
  const container = byId('memberOpenPositionCards');
  const maxExposure = positions.reduce((max, position) => Math.max(max, totalEquity > 0 ? Math.abs(Number(position.notional || 0)) * 100 / totalEquity : 0), 0);
  if (byId('memberPositionCapUsage')) byId('memberPositionCapUsage').textContent = `현재 최대 사용 ${maxExposure.toFixed(2)}%`;
  renderMemberRiskLimits();
  if (!container) return;
  container.innerHTML = positions.length ? positions.map((position) => {
    const pnl = Number(position.unrealised_pnl || 0); const roe = Number(position.roe || 0);
    const exposure = totalEquity > 0 ? Number(position.notional || 0) * 100 / totalEquity : 0;
    return `<article class="member-open-position-card"><div class="member-position-card-head"><div class="member-position-identity">${positionLogo(position.contract)}<div><b>${escapeHtml(position.contract)}</b><small>USDT 무기한 선물</small></div></div><span class="${position.side === 'LONG' ? 'long' : 'short'}">${escapeHtml(position.side)} · ${Number(position.leverage || 0)}x</span></div><div class="member-position-pnl"><div><small>미실현 손익</small><strong class="${signClass(pnl)}">${formatUsd(pnl)}</strong></div><b class="${signClass(roe)}">${formatSignedPct(roe)}</b></div><div class="member-position-metrics"><div><span>진입가</span><b>${formatMasterPrice(position.entry_price)}</b></div><div><span>현재가</span><b>${formatMasterPrice(position.mark_price)}</b></div><div><span>포지션 규모</span><b>${formatAmount(Math.abs(Number(position.notional || 0)))}</b></div><div><span>증거금</span><b>${position.margin == null ? '-' : formatAmount(Math.abs(Number(position.margin)))}</b></div></div><div class="member-exposure"><span>총자산 대비 포지션 비중 <b>${exposure.toFixed(2)}%</b></span><div><i style="width:${Math.min(100, Math.max(0, exposure))}%"></i></div></div></article>`;
  }).join('') : '<div class="master-position-empty">현재 열린 포지션이 없습니다.</div>';
}

function renderMemberLiveError() {
  memberLiveLoadFailed = true;
  for (const id of ['memberLiveEquity', 'memberDashboardMarginUsage', 'memberTradeEquity']) setNeutralDash(id);
  if (byId('memberUsedMargin')) byId('memberUsedMargin').textContent = '사용 증거금 -';
  if (byId('memberMarginBar')) byId('memberMarginBar').style.width = '0%';
  if (byId('memberPositionBadge')) byId('memberPositionBadge').textContent = '-';
  if (byId('memberPositionCapUsage')) byId('memberPositionCapUsage').textContent = '현재 사용 -';
  renderMemberRiskLimits();
  if (byId('memberOpenPositionCards')) byId('memberOpenPositionCards').innerHTML = inlineRetry('실제 포지션을 불러오지 못했습니다.', 'member-live');
  if (byId('memberTradePositions')) byId('memberTradePositions').innerHTML = `<tr><td colspan="9" class="empty-cell">${inlineRetry('실제 포지션을 불러오지 못했습니다.', 'member-live')}</td></tr>`;
  renderMemberCopyStatusChip();
}

function memberGateUidLabel() {
  if (memberGateConnectionLoaded && (!memberGateConnection || memberGateConnection.status === 'DISABLED' || memberGateConnection.gate_uid === 'DISABLED')) return 'Gate.io API 미연결';
  const uid = memberGateConnection?.gate_uid ? String(memberGateConnection.gate_uid) : '';
  return `UID ${uid ? `****${uid.slice(-4)}` : '연결 확인 중'} · 선물 계정`;
}

async function loadMemberLiveData() {
  if (!supabase || currentProfile?.role !== 'MEMBER') return;
  const { data, error } = await supabase.rpc('get_my_live_trading_data');
  if (error) {
    renderMemberLiveError();
    return window.toast('실제 거래 데이터를 불러오지 못했습니다.', { kind: 'error' });
  }
  memberLiveLoadFailed = false;
  const positions = Array.isArray(data?.positions) ? data.positions : [];
  const openPositions = Array.isArray(data?.open_positions) ? data.open_positions : [];
  const account = data?.account;
  memberLiveSnapshot = data;
  if (byId('memberLiveEquity')) byId('memberLiveEquity').textContent = account ? formatAmount(account.total_equity) : '-';
  if (byId('memberLiveAvailable')) byId('memberLiveAvailable').textContent = account ? formatAmount(account.available_equity) : '-';
  if (byId('memberLiveUnrealised')) byId('memberLiveUnrealised').textContent = account ? formatUsd(account.unrealised_pnl) : '-';
  if (byId('memberLiveObserved')) byId('memberLiveObserved').textContent = account?.observed_at ? `마지막 확인 ${new Date(account.observed_at).toLocaleTimeString('ko-KR')}` : '마지막 확인 -';
  if (byId('memberUsedMargin')) byId('memberUsedMargin').textContent = account ? `사용 증거금 ${formatAmount(Math.abs(Number(account.used_margin || 0)))}` : '사용 증거금 -';
  if (byId('memberMarginUsage')) byId('memberMarginUsage').textContent = account ? `사용률 ${Number(account.margin_usage_pct || 0).toFixed(2)}%` : '사용률 -';
  if (byId('memberDashboardMarginUsage')) byId('memberDashboardMarginUsage').textContent = account ? `${Number(account.margin_usage_pct || 0).toFixed(2)}%` : '-';
  renderMemberDailyLossUsage();
  if (byId('memberMarginBar')) byId('memberMarginBar').style.width = `${Math.min(100, Math.max(0, Number(account?.margin_usage_pct || 0)))}%`;
  renderMemberOpenPositions(openPositions, account);
  const detailedRows = positions.length ? positions.map((position) => `<tr><td>${escapeHtml(position.contract)}</td><td>${Number(position.target_size)}</td><td>${Number(position.actual_size)}</td><td>${Number(position.delta_size)}</td><td>${stateChip(position.state)}${position.pause_reason ? `<small>${escapeHtml(executionReasonLabel({ reason_code: position.pause_reason }))}</small>` : ''}</td><td>${position.observed_at ? new Date(position.observed_at).toLocaleString('ko-KR') : '-'}</td></tr>`).join('') : '<tr><td colspan="6" class="empty-cell">Worker가 확인한 실제 포지션이 아직 없습니다.</td></tr>';
  if (byId('memberLivePositions')) byId('memberLivePositions').innerHTML = detailedRows;
  if (byId('memberDashPositions')) byId('memberDashPositions').innerHTML = positions.length ? positions.map((position) => `<tr><td>${escapeHtml(position.contract)}</td><td>${Number(position.target_size)}</td><td>${Number(position.actual_size)}</td><td>${Number(position.delta_size)}</td><td>${stateChip(position.state)}</td></tr>`).join('') : '<tr><td colspan="5" class="empty-cell">Worker가 확인한 실제 포지션이 아직 없습니다.</td></tr>';
  if (byId('memberTradeEquity')) {
    byId('memberTradeEquity').textContent = account ? formatAmount(account.total_equity) : '-';
    byId('memberTradeEquity').className = '';
  }
  if (byId('memberTradeGateUid')) byId('memberTradeGateUid').textContent = memberGateUidLabel();
  renderMemberCopyStatusChip();
  const stateByContract = new Map(positions.map((position) => [position.contract, position]));
  if (byId('memberTradePositions')) byId('memberTradePositions').innerHTML = openPositions.length ? openPositions.map((position) => {
    const pnl = Number(position.unrealised_pnl || 0);
    const roe = Number(position.roe || 0);
    const notional = Math.abs(Number(position.notional || 0));
    const exposure = Number(account?.total_equity || 0) > 0 ? notional * 100 / Number(account.total_equity) : 0;
    const state = stateByContract.get(position.contract)?.state || 'SYNCED';
    return `<tr><td><div class="trade-symbol">${positionLogo(position.contract)}<b>${escapeHtml(position.contract)}</b></div></td><td class="${position.side === 'LONG' ? 'pos' : 'neg'}"><b>${escapeHtml(position.side)}</b></td><td>${formatAmount(notional)}</td><td>${formatMasterPrice(position.entry_price)}</td><td>${formatMasterPrice(position.mark_price)}</td><td class="${signClass(pnl)}"><b>${formatUsd(pnl)}</b></td><td class="${signClass(roe)}"><b>${formatSignedPct(roe)}</b></td><td>${exposure.toFixed(2)}%</td><td>${stateChip(state)}</td></tr>`;
  }).join('') : '<tr><td colspan="9" class="empty-cell">현재 열린 카피 포지션이 없습니다.</td></tr>';
}

async function loadAdminLiveData() {
  if (!supabase || currentProfile?.role !== 'ADMIN') return;
  const { data, error } = await sharedRpc('get_admin_live_trading_data');
  if (error) {
    if (byId('adminMasterPositionCards')) byId('adminMasterPositionCards').innerHTML = inlineRetry('Master 포지션을 불러오지 못했습니다.', 'admin-live');
    if (byId('adminOverviewObserved')) byId('adminOverviewObserved').textContent = '실시간 데이터 확인 실패';
    return window.toast('실제 운영 데이터를 불러오지 못했습니다.', { kind: 'error' });
  }
  const master = Array.isArray(data?.master_positions) ? data.master_positions : [];
  const memberPositions = Array.isArray(data?.member_positions) ? data.member_positions : [];
  const positionMembers = Array.isArray(data?.position_members) ? data.position_members : [];
  const states = Array.isArray(data?.member_states) ? data.member_states : [];
  const orders = Array.isArray(data?.orders) ? data.orders : [];
  const unknownOrders = orders.filter((order) => ['UNKNOWN', 'SUBMITTING', 'ACKNOWLEDGED', 'PARTIALLY_FILLED'].includes(order.status));
  const overrides = states.filter((state) => state.state === 'MANUAL_OVERRIDE');
  const actionStates = states.filter((state) => ['MANUAL_OVERRIDE', 'ERROR', 'HALTED'].includes(state.state));
  const stateGuides = {
    MANUAL_OVERRIDE: { label: '수동 거래로 카피 정지', guide: '회원 계정에서 직접 포지션을 변경해 해당 종목의 자동 카피가 정지됐습니다.' },
    HALTED: { label: '주문 정지', guide: '안전장치가 작동해 해당 종목의 신규 주문이 차단됐습니다.' },
    ERROR: { label: '처리 오류', guide: '주문 또는 포지션 처리 중 오류가 발생했습니다.' },
  };
  const orderGuides = {
    PARTIALLY_FILLED: { label: '일부만 체결', guide: '요청 수량 중 일부만 체결되어 남은 수량을 확인해야 합니다.' },
    UNKNOWN: { label: '주문 결과 확인 필요', guide: '거래소 주문 결과가 확정되지 않아 상태 확인이 필요합니다.' },
    SUBMITTING: { label: '주문 전송 중', guide: '거래소로 주문을 전송하고 있습니다.' },
    ACKNOWLEDGED: { label: '거래소 접수 완료', guide: '거래소가 주문을 접수했으며 체결 결과를 기다리고 있습니다.' },
  };
  const actions = [
    ...actionStates.map((state) => {
      const guide = stateGuides[state.state] || { label: '상태 확인 필요', guide: '현재 상태를 확인해야 합니다.' };
      return {
        title: `${state.name || accountDisplayId(state.gate_uid, state.email) || '-'} · ${state.contract} · ${guide.label}`,
        detail: `${guide.guide} 목표 수량 ${Number(state.target_size)} / 실제 수량 ${Number(state.actual_size)}`,
      };
    }),
    ...unknownOrders.map((order) => {
      const guide = orderGuides[order.status] || { label: '주문 확인 필요', guide: '주문 상태를 확인해야 합니다.' };
      return {
        title: `${order.name || accountDisplayId(order.gate_uid, order.email) || '-'} · ${order.contract} · ${guide.label}`,
        detail: `${guide.guide} 주문 수량 ${Number(order.delta_size)} / 체결 수량 ${Number(order.filled_size)}`,
      };
    }),
  ];
  if (byId('adminLiveMasterCount')) byId('adminLiveMasterCount').textContent = String(master.length);
  if (byId('adminLiveStateCount')) byId('adminLiveStateCount').textContent = String(states.length);
  if (byId('adminLiveUnknownCount')) byId('adminLiveUnknownCount').textContent = String(unknownOrders.length);
  if (byId('adminLiveOverrideCount')) byId('adminLiveOverrideCount').textContent = String(overrides.length);
  adminLiveActions = actions;
  renderAdminAttentionKpi();
  if (byId('adminLiveActions')) byId('adminLiveActions').innerHTML = actions.length ? actions.slice(0, 6).map((action) => `<div class="admin-attention-row"><div><b>${escapeHtml(action.title)}</b><small>${escapeHtml(action.detail)}</small></div><span class="chip yellow">확인 필요</span></div>`).join('') : '<div class="notice">현재 조치가 필요한 실제 상태가 없습니다.</div>';
  const syncedCount = states.filter((state) => state.state === 'SYNCED').length;
  const syncRate = states.length ? syncedCount * 100 / states.length : 100;
  if (byId('adminSyncRate')) {
    byId('adminSyncRate').textContent = `${syncRate.toFixed(2)}%`;
    byId('adminSyncRate').className = `member-performance-value ${actions.length ? 'warn' : 'pos'}`;
  }
  if (byId('adminSyncBar')) byId('adminSyncBar').style.width = `${Math.max(0, Math.min(100, syncRate))}%`;
  if (byId('adminSyncedCount')) byId('adminSyncedCount').textContent = String(syncedCount);
  if (byId('adminPausedCount')) byId('adminPausedCount').textContent = String(states.filter((state) => state.state === 'PAUSED').length);
  if (byId('adminOverviewChip')) {
    byId('adminOverviewChip').textContent = actions.length ? '확인 필요' : '정상 운영';
    byId('adminOverviewChip').className = actions.length ? 'chip yellow' : 'chip';
  }
  const latestObserved = master.reduce((latest, position) => Math.max(latest, new Date(position.observed_at || 0).getTime()), 0);
  if (byId('adminOverviewObserved')) byId('adminOverviewObserved').textContent = latestObserved ? `마지막 동기화 ${new Date(latestObserved).toLocaleString('ko-KR')}` : '동기화 기록 없음';
  adminMasterPositions = master;
  adminMemberPositions = memberPositions;
  adminPositionMembers = positionMembers;
  renderAdminPositionOwnerOptions();
  renderAdminMasterPositions();
  if (byId('adminMasterPreview')) byId('adminMasterPreview').innerHTML = master.length ? master.slice(0, 4).map((position) => {
    const size = Number(position.size || 0);
    const pnl = Number(position.unrealised_pnl || 0);
    return `<div class="admin-master-preview-card"><div>${positionLogo(position.contract)}<div><b>${escapeHtml(position.contract)}</b><small>무기한 선물</small></div></div><strong class="${signClass(pnl)}">${formatUsd(pnl)}</strong><span class="${size >= 0 ? 'pos' : 'neg'}">${size >= 0 ? 'LONG' : 'SHORT'} · ${Math.abs(size).toLocaleString()}</span></div>`;
  }).join('') : '<div class="member-chart-empty">현재 열린 마스터 포지션이 없습니다.</div>';
  if (byId('adminLiveStates')) byId('adminLiveStates').innerHTML = states.length ? states.map((state) => `<tr><td>${escapeHtml(state.name || accountDisplayId(state.gate_uid, state.email) || '-')}</td><td>${escapeHtml(state.contract)}</td><td>${Number(state.target_size)}</td><td>${Number(state.actual_size)}</td><td>${state.actual_notional == null ? '-' : formatAmount(Math.abs(Number(state.actual_notional)))}</td><td>${Number(state.delta_size)}</td><td>${stateChip(state.state)}${state.pause_reason ? `<small>${escapeHtml(state.pause_reason)}</small>` : ''}</td><td>${state.observed_at ? new Date(state.observed_at).toLocaleString('ko-KR') : '-'}</td></tr>`).join('') : '<tr><td colspan="8" class="empty-cell">회원 포지션 snapshot이 아직 없습니다.</td></tr>';
  if (byId('adminLiveOrders')) byId('adminLiveOrders').innerHTML = orders.length ? orders.map((order) => `<tr><td>${escapeHtml(order.name || accountDisplayId(order.gate_uid, order.email) || '-')}</td><td>${escapeHtml(order.contract)}</td><td>${Number(order.delta_size)}</td><td>${Number(order.filled_size)}</td><td>${stateChip(order.status)}${order.error_code ? `<small>${escapeHtml(order.error_code)}</small>` : ''}</td><td>${escapeHtml(order.gate_order_id || '-')}</td><td>${new Date(order.updated_at).toLocaleString('ko-KR')}</td></tr>`).join('') : '<tr><td colspan="7" class="empty-cell">실제 주문 내역이 아직 없습니다.</td></tr>';
}

// Single definition of the dashboard "확인 필요" KPI: approved members that are not copying
// normally (from the operations metrics). The live order/position issues are shown as a
// breakdown, so whichever response arrives last cannot overwrite the number with a
// different definition.
function renderAdminAttentionKpi() {
  const totals = adminOperationsMetrics?.totals;
  const attention = totals ? Math.max(0, Number(totals.members || 0) - Number(totals.copying_members || 0)) : null;
  const node = byId('adminLiveActionCount');
  if (node) {
    node.textContent = attention == null ? '-' : String(attention);
    node.className = attention ? 'neg' : '';
  }
  if (byId('adminAttentionCount')) byId('adminAttentionCount').textContent = attention == null ? '-' : String(attention);
  const breakdown = byId('adminAttentionBreakdown');
  if (breakdown) breakdown.textContent = Array.isArray(adminLiveActions)
    ? `회원 기준 · 주문·포지션 확인 ${adminLiveActions.length}건`
    : '카피 중이 아닌 회원 수';
}

function formatCompactUsd(value, signed = false) {
  const number = Number(value || 0);
  const absolute = Math.abs(number);
  const sign = number < 0 ? '-' : signed && number > 0 ? '+' : '';
  if (absolute >= 1_000_000) return `${sign}$${(absolute / 1_000_000).toFixed(2)}M`;
  if (absolute >= 1_000) return `${sign}$${(absolute / 1_000).toFixed(1)}K`;
  return signed ? formatUsd(number) : `$${absolute.toFixed(2)}`;
}

function renderOperationsChart(targetId, rows, key, { cumulative = false, feeKey = null } = {}) {
  const target = byId(targetId);
  if (!target) return;
  if (!rows.length) return void (target.innerHTML = '<div class="member-chart-empty">선택한 기간에 집계된 실제 데이터가 없습니다.</div>');
  const width = 960; const height = 260; const padX = 34; const padY = 24;
  let running = 0;
  const values = rows.map((row) => {
    const raw = Number(row[key] || 0);
    running = cumulative ? running + raw : raw;
    return running;
  });
  const max = Math.max(0, ...values); const min = Math.min(0, ...values); const span = Math.max(1, max - min);
  const points = values.map((value, index) => ({ value, x: padX + (rows.length === 1 ? 0 : index * (width - padX * 2) / (rows.length - 1)), y: padY + (max - value) * (height - padY * 2) / span }));
  const line = points.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ');
  const baseline = padY + (max - 0) * (height - padY * 2) / span;
  const area = `${points[0].x},${baseline} ${line} ${points.at(-1).x},${baseline}`;
  const feeMax = feeKey ? Math.max(1, ...rows.map((row) => Number(row[feeKey] || 0))) : 1;
  const bars = feeKey ? rows.map((row, index) => {
    const x = points[index].x; const fee = Number(row[feeKey] || 0); const barHeight = fee * 72 / feeMax;
    return `<rect x="${x - 7}" y="${height - padY - barHeight}" width="14" height="${barHeight}" rx="4" class="broker-fee-bar"><title>${escapeHtml(row.date)} 수수료 ${formatAmount(fee)}</title></rect>`;
  }).join('') : '';
  target.innerHTML = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="실제 운영 지표 추이"><defs><linearGradient id="${targetId}Fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#32d583" stop-opacity=".28"/><stop offset="1" stop-color="#32d583" stop-opacity=".02"/></linearGradient></defs>${[0,1,2,3].map((row) => `<line x1="${padX}" y1="${padY + row * (height - padY * 2) / 3}" x2="${width - padX}" y2="${padY + row * (height - padY * 2) / 3}" class="member-chart-axis"/>`).join('')}<polygon points="${area}" fill="url(#${targetId}Fill)"/><polyline points="${line}" class="member-chart-line"/>${bars}<circle cx="${points.at(-1).x}" cy="${points.at(-1).y}" r="5" class="member-chart-point"/></svg><div class="admin-chart-labels"><span>${escapeHtml(rows[0].date)}</span><span>${escapeHtml(rows.at(-1).date)}</span></div>`;
}

function adminRangeDates(range = adminOperationsRange) {
  const end = kstDate();
  if (range === 'today') return [end, end];
  if (range === 'month') return [`${end.slice(0, 7)}-01`, end];
  return [kstDateOffset(1 - Math.max(1, Number(range || 30))), end];
}

function renderAdminOperationsMetrics(data) {
  adminOperationsMetrics = data;
  const totals = data?.totals || {};
  const members = Array.isArray(data?.members) ? data.members : [];
  const daily = Array.isArray(data?.daily) ? data.daily : [];
  const copying = Number(totals.copying_members || 0); const memberCount = Number(totals.members || 0);
  const rate = memberCount ? copying * 100 / memberCount : 0;
  if (byId('adminTotalMembers')) byId('adminTotalMembers').textContent = memberCount.toLocaleString();
  if (byId('adminCopyingMembers')) byId('adminCopyingMembers').textContent = copying.toLocaleString();
  if (byId('adminCopyingRate')) byId('adminCopyingRate').textContent = `${rate.toFixed(1)}% 정상 작동`;
  if (byId('adminTotalAssets')) byId('adminTotalAssets').textContent = formatCompactUsd(totals.total_assets);
  if (byId('adminPeriodPnl')) {
    const pnl = Number(totals.period_pnl || 0);
    byId('adminPeriodPnl').textContent = formatCompactUsd(pnl, true);
    byId('adminPeriodPnl').className = signClass(pnl);
  }
  if (byId('adminPeriodLabel')) byId('adminPeriodLabel').textContent = `${data.range_start} → ${data.range_end}`;
  if (byId('adminCopyDonut')) {
    byId('adminCopyDonut').style.setProperty('--copy-rate', `${rate.toFixed(2)}%`);
    byId('adminCopyDonut').querySelector('strong').textContent = `${Math.round(rate)}%`;
  }
  if (byId('adminSyncedCount')) byId('adminSyncedCount').textContent = String(copying);
  renderAdminAttentionKpi();
  if (byId('adminPausedCount')) byId('adminPausedCount').textContent = String(members.filter((member) => member.copy_status === 'PAUSED').length);
  if (byId('adminLiveOverrideCount')) byId('adminLiveOverrideCount').textContent = String(members.filter((member) => member.copy_status === 'HALTED').length);
  if (byId('adminLiveUnknownCount')) byId('adminLiveUnknownCount').textContent = String(members.filter((member) => ['API_ERROR', 'ERROR'].includes(member.copy_status)).length);
  renderOperationsChart('adminPnlChart', daily, 'pnl', { cumulative: true });
  adminMembersCache = members;
  adminMasterAccount = data?.master || null;
  renderAdminMemberRows();
}

async function loadAdminOperationsMetrics(startDate = null, endDate = null) {
  if (!supabase || currentProfile?.role !== 'ADMIN') return;
  const dates = startDate && endDate ? [startDate, endDate] : adminRangeDates();
  const ticket = ++adminOperationsRequestSeq;
  const operations = await sharedRpc('get_admin_operations_metrics', { p_start_date: dates[0], p_end_date: dates[1] });
  if (ticket !== adminOperationsRequestSeq) return;
  if (operations.error) {
    for (const id of ['adminTotalMembers', 'adminCopyingMembers', 'adminLiveActionCount', 'adminTotalAssets', 'adminPeriodPnl']) setNeutralDash(id);
    if (byId('adminCopyingRate')) byId('adminCopyingRate').textContent = '운영 지표 확인 실패';
    return window.toast('운영 지표를 불러오지 못했습니다. DB 마이그레이션 상태를 확인해 주세요.', { kind: 'error' });
  }
  renderAdminOperationsMetrics(operations.data);
}

function compactPayload(payload) {
  if (!payload || typeof payload !== 'object') return '-';
  const text = Object.entries(payload).slice(0, 4).map(([key, value]) => `${key}: ${typeof value === 'object' ? JSON.stringify(value) : value}`).join(' · ');
  return text || '-';
}

async function loadAdminOperationalEvents() {
  if (!supabase || currentProfile?.role !== 'ADMIN') return;
  const { data, error } = await supabase.rpc('get_admin_operational_events', { p_limit: 200 });
  const tbody = byId('adminOperationalEvents');
  if (!tbody) return;
  if (error) return void (tbody.innerHTML = '<tr><td colspan="6" class="empty-cell neg">운영 이벤트를 불러오지 못했습니다.</td></tr>');
  const events = Array.isArray(data) ? data : [];
  tbody.innerHTML = events.length ? events.map((event) => `<tr><td>${new Date(event.occurred_at).toLocaleString('ko-KR')}</td><td>${escapeHtml(event.name || accountDisplayId(event.gate_uid, event.email) || 'SYSTEM')}</td><td>${escapeHtml(event.contract || '-')}</td><td>${escapeHtml(event.type)}</td><td>${stateChip(event.severity)}</td><td class="payload-cell">${escapeHtml(compactPayload(event.payload))}</td></tr>`).join('') : '<tr><td colspan="6" class="empty-cell">아직 기록된 운영 이벤트가 없습니다.</td></tr>';
}

function auditDetail(log) {
  if (log?.action === 'MEMBER_COPY_SETTINGS_UPDATED') {
    const previous = log.previous_value || {};
    const next = log.next_value || {};
    const percent = (value) => (value == null ? '-' : `${Number(value)}%`);
    return `카피 비율 ${percent(previous.copy_ratio)} → ${percent(next.copy_ratio)} · 종목당 최대 비중 ${percent(previous.max_position_ratio)} → ${percent(next.max_position_ratio)}`;
  }
  return compactPayload(log?.next_value);
}

async function loadAdminAuditLog() {
  if (!supabase || currentProfile?.role !== 'ADMIN') return;
  const { data, error } = await supabase.rpc('get_admin_audit_log', { p_limit: 200 });
  const tbody = byId('adminAuditRows');
  if (!tbody) return;
  if (error) return void (tbody.innerHTML = '<tr><td colspan="5" class="empty-cell neg">감사 기록을 불러오지 못했습니다.</td></tr>');
  const logs = Array.isArray(data) ? data : [];
  tbody.innerHTML = logs.length ? logs.map((log) => `<tr><td>${new Date(log.created_at).toLocaleString('ko-KR')}</td><td>${escapeHtml(log.actor_name || accountDisplayId(log.actor_gate_uid, log.actor_email) || '시스템')}</td><td>${escapeHtml(auditActionLabel(log.action))}</td><td>${escapeHtml(log.target_name || accountDisplayId(log.target_gate_uid, log.target_email) || '-')}</td><td class="payload-cell">${escapeHtml(auditDetail(log))}</td></tr>`).join('') : '<tr><td colspan="5" class="empty-cell">아직 기록된 관리자 작업이 없습니다.</td></tr>';
}

function executionStatusMeta(status) {
  if (status === 'FILLED') return ['체결 완료', 'chip'];
  if (['PLANNED', 'QUEUED', 'SUBMITTING', 'ACKNOWLEDGED', 'PARTIALLY_FILLED'].includes(status)) return ['진행 중', 'chip yellow'];
  if (['REJECTED', 'CANCELLED'].includes(status)) return ['실패', 'chip red'];
  if (status === 'BLOCKED') return ['차단', 'chip red'];
  if (status === 'UNKNOWN') return ['확인 필요', 'chip yellow'];
  return ['확인 필요', 'chip yellow'];
}

function executionReasonLabel(row) {
  const code = String(row.reason_code || row.gate_label || row.attempt_status || '').toUpperCase();
  const labels = {
    MANUAL_OVERRIDE: '회원이 직접 포지션을 변경하여 자동 주문이 차단되었습니다.',
    MANUAL_OVERRIDE_DETECTED: '회원이 직접 포지션을 변경하여 자동 주문이 차단되었습니다.',
    MEMBER_POSITION_RECONCILING: '회원이 직접 매매한 수량을 개인 보유분으로 반영하는 중입니다(해당 종목 잠시 보류).',
    MEMBER_REDUCED_COPY_POSITION: '회원이 카피분까지 매도해 이 종목의 카피를 멈췄습니다. 다시 따라가려면 재개가 필요합니다.',
    MEMBER_REDUCED_COPY_ACCEPTED: '회원이 카피분까지 매도했습니다. 판 수량은 다시 사지 않고, 이후 마스터 거래는 계속 따라갑니다.',
    MEMBER_POSITION_CHANGED: '회원이 직접 매매해 전송 전 주문 계획을 취소했습니다(거래소 미전송).',
    BASELINE_INIT_FAILED: '신규 카피 기준선 초기화에 실패했습니다.',
    DUAL_MODE_REQUIRED: '회원 계정에서 양방향 포지션 설정이 필요합니다.',
    DAILY_LOSS_LIMIT: '일일 손실 한도에 도달했습니다.',
    MAX_DRAWDOWN_LIMIT: '최대 손실 제한에 도달했습니다.',
    INSUFFICIENT_BALANCE: '주문 가능한 증거금이 부족합니다.',
    SYMBOL_PAUSED: '해당 종목의 카피가 일시중지되었습니다.',
    MEMBER_HALTED: '회원 카피가 중단되었습니다.',
    ADMIN_HALT: '관리자가 회원 카피를 중단했습니다.',
    ADMIN_PAUSE: '관리자가 신규 카피를 일시중지했습니다.',
    REJECTED: 'Gate.io가 주문을 거절했습니다.',
    NETWORK_ERROR: 'Gate.io 연결 중 네트워크 오류가 발생했습니다.',
    TIMEOUT: 'Gate.io 응답 시간이 초과되어 결과 확인이 필요합니다.',
    UNKNOWN: '주문 결과를 확정하지 못해 확인이 필요합니다.',
  };
  if (row.status === 'FILLED') return '정상 체결';
  return labels[code] || (code ? `확인 코드: ${code}` : row.status === 'BLOCKED' ? '현재 상태에서 자동 주문이 차단되었습니다.' : '-');
}

function setAdminLogTab(tab) {
  document.querySelectorAll('[data-admin-log-tab]').forEach((button) => {
    const active = button.dataset.adminLogTab === tab;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  });
  document.querySelectorAll('[data-admin-log-panel]').forEach((panel) => panel.classList.toggle('hidden', panel.dataset.adminLogPanel !== tab));
}

async function loadAdminExecutionStatus() {
  if (!supabase || currentProfile?.role !== 'ADMIN') return;
  const tbody = byId('adminExecutionRows');
  if (!tbody) return;
  const ticket = ++adminExecutionRequestSeq;
  tbody.innerHTML = '<tr><td colspan="7" class="empty-cell">체결 현황을 불러오는 중입니다.</td></tr>';
  const params = {
    p_hours: Number(byId('adminExecutionHours')?.value || 24),
    p_user_id: byId('adminExecutionMember')?.value || null,
    p_contract: byId('adminExecutionContract')?.value.trim() || null,
    p_status: byId('adminExecutionStatus')?.value || 'ALL',
    p_limit: 300,
  };
  const { data, error } = await supabase.rpc('get_admin_execution_status', params);
  // A slower, older response must not overwrite the result of a newer filter.
  if (ticket !== adminExecutionRequestSeq) return;
  if (error) return void (tbody.innerHTML = '<tr><td colspan="7" class="empty-cell neg">체결 현황을 불러오지 못했습니다. DB 마이그레이션 상태를 확인해 주세요.</td></tr>');
  const memberSelect = byId('adminExecutionMember');
  const selectedMember = memberSelect?.value || '';
  const members = Array.isArray(data?.members) ? data.members : [];
  if (memberSelect) {
    memberSelect.innerHTML = `<option value="">전체 회원</option>${members.map((member) => `<option value="${escapeHtml(member.id)}">${escapeHtml(member.name || accountDisplayId(member.gate_uid, member.email))}${member.name && (member.gate_uid || member.email) ? ` · ${escapeHtml(accountDisplayId(member.gate_uid, member.email))}` : ''}</option>`).join('')}`;
    memberSelect.value = selectedMember;
  }
  const rows = Array.isArray(data?.rows) ? data.rows : [];
  tbody.innerHTML = rows.length ? rows.map((row) => {
    const [statusLabel, statusClass] = executionStatusMeta(row.status);
    const side = row.position_side === 'SHORT' ? '<span class="neg">SHORT</span>' : '<span class="pos">LONG</span>';
    const sizes = `${Number(row.target_size || 0).toLocaleString()} / ${Number(row.delta_size || 0).toLocaleString()} / ${Number(row.filled_size || 0).toLocaleString()}`;
    const orderId = row.gate_order_id || (row.record_type === 'STATE' ? '주문 미생성' : '-');
    return `<tr><td>${new Date(row.occurred_at).toLocaleString('ko-KR')}</td><td><b>${escapeHtml(row.member_name || '-')}</b><small class="execution-member-email">${escapeHtml(accountDisplayId(row.member_gate_uid, row.member_email))}</small></td><td><b>${escapeHtml(row.contract || '-')}</b><small class="execution-side">${side}</small></td><td>${escapeHtml(sizes)}</td><td><span class="${statusClass}" title="${escapeHtml(row.status || '')}">${escapeHtml(statusLabel)}</span></td><td>${escapeHtml(orderId)}</td><td class="execution-reason">${escapeHtml(executionReasonLabel(row))}</td></tr>`;
  }).join('') : '<tr><td colspan="7" class="empty-cell">선택한 조건에 해당하는 체결·차단 기록이 없습니다.</td></tr>';
}

function auditActionLabel(action) {
  const labels = {
    USER_APPROVAL_CHANGED: '회원 승인 상태 변경',
    COPY_SYSTEM_CONTROL_UPDATED: '전체 카피 제어 변경',
    MEMBER_COPY_CONTROL_UPDATED: '회원 카피 상태 변경',
    MEMBER_COPY_SETTINGS_UPDATED: '회원 비중 변경',
    MEMBER_WITHDRAWN: '회원 탈퇴 처리',
    MEMBER_RESTORED: '탈퇴 회원 복구',
    MEMBER_NEW_OPERATION_STARTED: '회원 새 운용 기준 설정',
    LIVE_COPY_ENABLED: '실거래 카피 활성화',
    LIVE_COPY_HALTED: '실거래 카피 중단',
    GATE_API_CREDENTIALS_SAVED: '회원 API 정보 저장',
    GATE_API_VERIFIED: '회원 API 검증 완료',
    GATE_API_VERIFICATION_FAILED: '회원 API 검증 실패',
    MEMBER_GATE_API_REVERIFICATION_REQUESTED: '회원 API 재검증 요청',
    MEMBER_GATE_API_DISCONNECTED: '회원 API 연결 해제',
    MASTER_GATE_API_CREDENTIALS_SAVED: 'Master API 정보 저장',
    MASTER_GATE_API_DISCONNECTED: 'Master API 연결 해제',
    MEMBER_PASSWORD_RESET_REQUESTED: '회원 비밀번호 재설정 요청',
  };
  return labels[action] || String(action || '알 수 없는 작업').replaceAll('_', ' ').toLowerCase();
}

function weightOptions(min, max, selected) {
  const options = [];
  for (let value = min; value <= max; value += 10) {
    options.push(`<option value="${value}"${value === selected ? ' selected' : ''}>${value}%</option>`);
  }
  return options.join('');
}

const ADMIN_WEIGHT_NOTICE = '저장해도 카피는 계속되며 마스터의 다음 진입·증액부터 새 비중이 적용됩니다. 단, 재개 확인(검증 중)이 진행 중이면 그 재개 요청은 취소되어 회원이 다시 요청해야 합니다. 종목당 최대 비중을 낮추면 초과분을 즉시 줄이고, 높이면 이전에 상한 때문에 덜 산 종목을 원래 목표까지 채울 수 있습니다. 일시중지된 회원은 새 상한보다 현재 보유 비중이 크면 보유분을 줄이기 전까지 재개가 거절됩니다.';

// Administrator-managed member weights (2026-10-20). The member can still change their own setting; the
// last saved value applies. Ranges match the member setting and the DB check.
function renderAdminMemberWeightSettings(member) {
  const copyRatio = Number(member.copy_ratio ?? 100);
  const maxPositionRatio = Number(member.max_position_ratio ?? 30);
  return `<div class="member-control-actions member-weight-settings"><small>비중 관리</small>
    <div class="actions">
      <label class="member-weight-field"><span>카피 비율</span><select id="adminMemberCopyRatio" aria-label="카피 비율">${weightOptions(50, 200, copyRatio)}</select></label>
      <label class="member-weight-field"><span>종목당 최대 비중</span><select id="adminMemberMaxPositionRatio" aria-label="종목당 최대 비중">${weightOptions(20, 50, maxPositionRatio)}</select></label>
      <button class="btn" type="button" data-member-weight-save>비중 저장</button>
    </div>
    <p class="muted member-weight-notice">${ADMIN_WEIGHT_NOTICE}</p></div>`;
}

function setMemberDetailActionsDisabled(disabled) {
  document.querySelectorAll('#memberDetailModal [data-member-control], #memberDetailModal [data-member-weight-save], #memberDetailModal [data-new-operation-open], #memberDetailModal [data-member-withdraw], #adminMemberCopyRatio, #adminMemberMaxPositionRatio')
    .forEach((element) => { element.disabled = disabled; });
}

async function saveAdminMemberWeights() {
  if (!selectedMemberId || currentProfile?.role !== 'ADMIN' || adminWeightBusy || adminControlBusy) return;
  const copyRatio = Number(byId('adminMemberCopyRatio')?.value);
  const maxPositionRatio = Number(byId('adminMemberMaxPositionRatio')?.value);
  const validCopyRatio = copyRatio >= 50 && copyRatio <= 200 && copyRatio % 10 === 0;
  const validPositionRatio = maxPositionRatio >= 20 && maxPositionRatio <= 50 && maxPositionRatio % 10 === 0;
  if (!validCopyRatio || !validPositionRatio) return window.toast('비중 범위를 확인해 주세요.');
  if (!window.confirm(`카피 비율 ${copyRatio}%, 종목당 최대 비중 ${maxPositionRatio}%로 저장할까요?\n${ADMIN_WEIGHT_NOTICE}`)) return;
  adminWeightBusy = true;
  setMemberDetailActionsDisabled(true);
  const button = document.querySelector('[data-member-weight-save]');
  if (button) button.textContent = '저장 중...';
  let error = null;
  try {
    ({ error } = await supabase.rpc('admin_update_member_copy_settings', {
      p_user_id: selectedMemberId, p_copy_ratio: copyRatio, p_max_position_ratio: maxPositionRatio,
    }));
  } finally {
    adminWeightBusy = false;
    setMemberDetailActionsDisabled(false);
    if (button) button.textContent = '비중 저장';
  }
  if (error) return window.toast('회원 비중을 저장하지 못했습니다.', { kind: 'error' });
  window.toast('회원 비중을 저장했습니다.', { kind: 'success' });
  invalidateSharedRpc('get_admin_operations_metrics', 'get_admin_live_trading_data');
  await openMemberDetail(selectedMemberId);
  await loadAdminMembers();
}

async function setAdminMemberControl(mode) {
  if (!selectedMemberId || currentProfile?.role !== 'ADMIN' || adminControlBusy || adminWeightBusy) return;
  const labels = { PAUSE: '일시중지', REDUCE_ONLY: '축소 전용', HALT: '중단', RESUME: '재개' };
  if (!window.confirm(`이 회원의 카피 상태를 ${labels[mode]}로 변경할까요?`)) return;
  adminControlBusy = true;
  setMemberDetailActionsDisabled(true);
  let error = null;
  try {
    ({ error } = await supabase.rpc('set_member_copy_control', { p_user_id: selectedMemberId, p_mode: mode, p_reason: `ADMIN_${mode}` }));
  } finally {
    adminControlBusy = false;
    setMemberDetailActionsDisabled(false);
  }
  if (error) return window.toast('회원 카피 상태를 변경하지 못했습니다.', { kind: 'error' });
  window.toast(mode === 'RESUME' ? '회원의 기존 포지션 보호와 재개 안전 확인을 요청했습니다.' : `회원 카피 상태를 ${labels[mode]}로 변경했습니다.`, { kind: 'success' });
  closeMemberDetail();
  invalidateSharedRpc('get_admin_operations_metrics', 'get_admin_live_trading_data');
  await loadAdminMembers();
}

// Runs a disconnect RPC once: a second click while it is pending is ignored and the
// triggering button stays disabled until the request settles.
async function withDisconnectBusy(button, action) {
  if (disconnectBusy) return;
  disconnectBusy = true;
  const label = button?.textContent;
  if (button) {
    button.disabled = true;
    button.textContent = '해제 중...';
  }
  try { await action(); }
  finally {
    disconnectBusy = false;
    if (button && document.contains(button)) {
      button.disabled = false;
      button.textContent = label;
    }
  }
}

async function disconnectMemberGateApi() {
  if (disconnectBusy || currentProfile?.role !== 'MEMBER' || !window.confirm('API 연결을 해제하면 카피가 즉시 중단되고 저장된 Key가 폐기됩니다. 계속할까요?')) return;
  await withDisconnectBusy(byId('gateApiDisconnect'), async () => {
    const { error } = await supabase.rpc('disable_my_gate_api_connection', { p_confirmation: 'DISCONNECT_GATE_API' });
    if (error) return window.toast('API 연결을 해제하지 못했습니다.', { kind: 'error' });
    invalidateSharedRpc('get_my_gate_api_connection');
    byId('gateUid').value = '';
    delete byId('gateUid').dataset.dirty;
    byId('gateApiKey').placeholder = 'API Key 입력';
    memberGateConnection = null;
    memberGateConnectionLoaded = true;
    renderGateConnection(null);
    renderMemberCopyStatusChip();
    window.toast('API 연결을 해제하고 저장된 Key를 폐기했습니다.', { kind: 'success' });
  });
}

async function disconnectAdminMasterGateApi() {
  if (disconnectBusy || currentProfile?.role !== 'ADMIN' || !window.confirm('Master API를 해제하면 전체 실거래가 즉시 중단되고 저장된 Key가 폐기됩니다. 계속할까요?')) return;
  await withDisconnectBusy(byId('adminGateApiDisconnect'), async () => {
    const { error } = await supabase.rpc('disable_admin_master_gate_api_connection', { p_confirmation: 'DISCONNECT_MASTER_GATE_API' });
    if (error) return window.toast('Master API 연결을 해제하지 못했습니다.', { kind: 'error' });
    byId('adminGateUid').value = '';
    delete byId('adminGateUid').dataset.dirty;
    byId('adminGateApiKey').placeholder = 'API Key 입력';
    renderAdminMasterGateConnection(null);
    await loadCopySystemStatus();
    window.toast('Master API 연결을 해제하고 전체 카피를 중단했습니다.', { kind: 'success' });
  });
}

// A Gate UID account can connect only its signup UID: prefill it and lock the field.
function applyAccountGateUid() {
  const input = byId('gateUid');
  if (!input) return;
  const accountUid = currentProfile?.role === 'MEMBER' ? String(currentProfile.gate_uid || '') : '';
  input.readOnly = Boolean(accountUid);
  if (accountUid) {
    input.value = accountUid;
    delete input.dataset.dirty;
  }
  byId('gateUidHint')?.classList.toggle('hidden', !accountUid);
}

// Polling must never overwrite what the user is typing: skip focused or edited inputs.
function setInputIfIdle(input, value) {
  if (!input || document.activeElement === input || input.dataset.dirty === 'true') return;
  input.value = value;
}

function renderGateConnection(connection) {
  const status = byId('gateConnectionStatus');
  if (!status) return;
  const disconnected = !connection || connection.status === 'DISABLED' || connection.gate_uid === 'DISABLED';
  if (disconnected) {
    status.textContent = '미연결';
    status.className = 'chip yellow';
    byId('gateVerificationDetail').textContent = 'UID, API Key, Secret Key를 입력해 연결을 검증해 주세요.';
    byId('gateApiForm').dataset.hasStoredCredential = 'false';
    byId('gateApiKey').placeholder = 'API Key 입력';
    byId('gateApiKey').required = true;
    byId('gateSecretKey').required = true;
    if (!gateApiBusy) byId('gateApiConnect').textContent = '저장 및 연결 검증';
    byId('gateFuturesRead').textContent = '확인 대기';
    byId('gateFuturesRead').className = 'warn';
    byId('gateFuturesTrade').textContent = '확인 대기';
    byId('gateFuturesTrade').className = 'warn';
    byId('gateIpWhitelist').textContent = '검증 대기';
    byId('gateIpWhitelist').className = 'warn';
    byId('gateWithdrawal').textContent = '확인 대기';
    byId('gateWithdrawal').className = 'warn';
    if (byId('memberTradeGateUid')) byId('memberTradeGateUid').textContent = 'Gate.io API 미연결';
    applyAccountGateUid();
    return;
  }
  setInputIfIdle(byId('gateUid'), connection.gate_uid || '');
  applyAccountGateUid();
  if (byId('memberTradeGateUid')) byId('memberTradeGateUid').textContent = `UID ${connection.gate_uid ? `****${String(connection.gate_uid).slice(-4)}` : '-'} · 선물 계정`;
  byId('gateApiKey').placeholder = connection.api_key_last4 ? `저장됨 ····${connection.api_key_last4}` : 'API Key 입력';
  const hasStoredCredential = Boolean(connection.api_key_last4);
  byId('gateApiForm').dataset.hasStoredCredential = String(hasStoredCredential);
  byId('gateApiKey').required = !hasStoredCredential;
  byId('gateSecretKey').required = !hasStoredCredential;
  if (!gateApiBusy) byId('gateApiConnect').textContent = hasStoredCredential ? '저장된 API 재검증' : '저장 및 연결 검증';
  const verified = connection.status === 'VERIFIED';
  const statusLabels = { VERIFIED: '연결됨', VERIFYING: '검증 중', ERROR: '연결 오류', DISABLED: '비활성', PENDING_VERIFICATION: '검증 대기' };
  status.textContent = statusLabels[connection.status] || '검증 대기';
  status.className = verified ? 'chip' : connection.status === 'ERROR' ? 'chip red' : 'chip yellow';
  byId('gateFuturesRead').textContent = verified && connection.futures_read ? 'PASS' : '확인 대기';
  byId('gateFuturesRead').className = verified && connection.futures_read ? 'pos' : 'warn';
  byId('gateFuturesTrade').textContent = verified && connection.futures_trade ? 'PASS' : '확인 대기';
  byId('gateFuturesTrade').className = verified && connection.futures_trade ? 'pos' : 'warn';
  byId('gateIpWhitelist').textContent = connection.ip_whitelisted ? '접속 통과' : '검증 대기';
  byId('gateIpWhitelist').className = connection.ip_whitelisted ? 'pos' : 'warn';
  byId('gateWithdrawal').textContent = verified && connection.withdrawal_disabled ? 'DISABLED' : '확인 대기';
  byId('gateWithdrawal').className = verified && connection.withdrawal_disabled ? 'pos' : 'warn';
  const errorMessages = {
    INVALID_CREDENTIALS: 'API Key 또는 Secret Key를 확인해 주세요.',
    UID_MISMATCH: '입력한 UID와 API Key 계정이 일치하지 않습니다.',
    WORKER_IP_NOT_CONFIGURED: '고정 IP Trading Worker 연결이 먼저 필요합니다.',
    IP_NOT_ALLOWED: 'Trading Worker 고정 IP를 Gate.io Whitelist에 등록해 주세요.',
    FUTURES_READ_REQUIRED: 'Perpetual Futures Read 권한을 확인해 주세요.',
    FUTURES_TRADE_REQUIRED: 'Perpetual Futures 권한을 Read-Write로 설정해 주세요.',
    API_KEY_DETAILS_UNAVAILABLE: 'API Key 상태와 권한 정보를 확인할 수 없습니다.',
    API_PERMISSION_LOOKUP_DENIED: '선물 계정 접속은 성공했지만 Gate.io가 API 권한 정보 조회를 거부했습니다.',
    API_PERMISSION_LOOKUP_FAILED: '선물 계정 접속은 성공했지만 Gate.io API 권한 정보 조회에 실패했습니다.',
    EXCESS_API_PERMISSIONS: 'Futures 외의 쓰기 권한을 모두 비활성화해 주세요.',
    GATE_UNREACHABLE: 'Gate.io 연결이 지연되고 있습니다. 잠시 후 다시 검증해 주세요.',
    GATE_API_ERROR: 'Gate.io API 응답을 확인하지 못했습니다.',
  };
  const detail = byId('gateVerificationDetail');
  detail.textContent = verified
    ? `Gate.io Futures 계정 검증 완료${connection.last_checked_at ? ` · ${new Date(connection.last_checked_at).toLocaleString('ko-KR')}` : ''}`
    : connection.status === 'ERROR'
      ? (errorMessages[connection.last_error_code] || '연결 검증에 실패했습니다. 입력 정보와 권한을 확인해 주세요.')
      : '암호화 저장 완료 · 고정 IP Trading Worker의 검증을 기다리고 있습니다.';
  detail.className = `verification-detail ${connection.status === 'ERROR' ? 'neg' : verified ? 'pos' : ''}`;
}

function renderAdminMasterGateConnection(connection) {
  const status = byId('adminMasterGateStatus');
  if (!status) return;
  const setState = (id, text, className = 'warn') => {
    const element = byId(id);
    if (!element) return;
    element.textContent = text;
    element.className = className;
  };
  if (!connection) {
    status.textContent = '미연결';
    status.className = 'chip yellow';
    setState('adminGateFuturesRead', '확인 대기');
    setState('adminGateTrade', '확인 대기');
    setState('adminGateWorker', workerPublicIp ? '검증 대기' : '미설정');
    setState('adminGateWithdrawal', 'DISABLED 확인 필요');
    byId('adminGateVerificationDetail').textContent = 'UID와 API Key, Secret Key를 입력해 주세요.';
    byId('adminGateApiForm').dataset.hasStoredCredential = 'false';
    byId('adminGateApiKey').required = true;
    byId('adminGateSecretKey').required = true;
    if (!adminGateApiBusy) byId('adminGateApiConnect').textContent = '암호화 저장 및 검증 요청';
    byId('adminGateCredentialHelp').textContent = 'Secret Key는 브라우저에 저장하지 않습니다.';
    return;
  }
  setInputIfIdle(byId('adminGateUid'), connection.gate_uid || '');
  byId('adminGateApiKey').placeholder = connection.api_key_last4 ? `저장됨 ····${connection.api_key_last4}` : 'API Key 입력';
  const hasStoredCredential = Boolean(connection.api_key_last4);
  byId('adminGateApiForm').dataset.hasStoredCredential = String(hasStoredCredential);
  byId('adminGateApiKey').required = !hasStoredCredential;
  byId('adminGateSecretKey').required = !hasStoredCredential;
  if (!adminGateApiBusy) byId('adminGateApiConnect').textContent = hasStoredCredential ? '저장된 Master API 재검증' : '암호화 저장 및 검증 요청';
  byId('adminGateCredentialHelp').textContent = hasStoredCredential
    ? '저장된 암호화 Key로 재검증합니다. Key를 교체할 때만 두 값을 다시 입력하세요.'
    : 'Secret Key는 브라우저에 저장하지 않습니다.';
  const verified = connection.status === 'VERIFIED';
  const errored = connection.status === 'ERROR';
  const labels = { VERIFIED: '연결됨', VERIFYING: '검증 중', ERROR: '연결 오류', DISABLED: '비활성', PENDING_VERIFICATION: '검증 대기' };
  status.textContent = labels[connection.status] || '검증 대기';
  status.className = verified ? 'chip' : errored ? 'chip red' : 'chip yellow';
  setState('adminGateFuturesRead', verified && connection.futures_read ? 'PASS' : '확인 대기', verified && connection.futures_read ? 'pos' : 'warn');
  setState('adminGateTrade', verified && !connection.futures_trade ? 'DISABLED' : '확인 대기', verified && !connection.futures_trade ? 'pos' : 'warn');
  setState('adminGateWorker', connection.ip_whitelisted ? '접속 통과' : workerPublicIp ? '검증 대기' : '미설정', connection.ip_whitelisted ? 'pos' : 'warn');
  setState('adminGateWithdrawal', connection.withdrawal_disabled ? 'DISABLED' : '확인 필요', connection.withdrawal_disabled ? 'pos' : 'neg');
  const errorMessages = {
    INVALID_CREDENTIALS: 'API Key 또는 Secret Key를 확인해 주세요.',
    UID_MISMATCH: '입력한 UID와 API Key 계정이 일치하지 않습니다.',
    WORKER_IP_NOT_CONFIGURED: '고정 IP Trading Worker 연결이 먼저 필요합니다.',
    IP_NOT_ALLOWED: 'Gate.io Whitelist에 Worker 고정 IP를 등록해 주세요.',
    FUTURES_READ_REQUIRED: 'Perpetual Futures Read 권한을 확인해 주세요.',
    FUTURES_TRADE_REQUIRED: 'Master API는 Perpetual Futures Read Only로 설정해야 합니다.',
    API_KEY_DETAILS_UNAVAILABLE: 'API Key 상태와 권한 정보를 확인할 수 없습니다.',
    EXCESS_API_PERMISSIONS: 'Futures 외의 쓰기 권한을 모두 비활성화해 주세요.',
    GATE_UNREACHABLE: 'Gate.io 연결이 지연되고 있습니다.',
  };
  byId('adminGateVerificationDetail').textContent = verified
    ? `Master Futures 계정 검증 완료${connection.last_checked_at ? ` · ${new Date(connection.last_checked_at).toLocaleString('ko-KR')}` : ''}`
    : errored
      ? (errorMessages[connection.last_error_code] || '연결 검증에 실패했습니다. 입력 정보와 권한을 확인해 주세요.')
      : workerPublicIp
        ? '암호화 저장 완료 · Trading Worker 검증을 기다리고 있습니다.'
        : '암호화 저장 완료 · Worker 고정 IP 연결 전까지 주문 실행은 중지됩니다.';
}

async function loadAdminMasterGateConnection(showError = true) {
  if (!supabase || currentProfile?.role !== 'ADMIN') return;
  const { data, error } = await supabase.rpc('get_admin_master_gate_api_connection');
  if (error) {
    if (showError) window.toast('Master API 연결 상태를 불러오지 못했습니다.');
    return;
  }
  renderAdminMasterGateConnection(data);
}

async function saveAdminGateApiCredentials() {
  if (!supabase || currentProfile?.role !== 'ADMIN' || adminGateApiBusy) return;
  const gateUid = byId('adminGateUid').value.trim();
  const apiKey = byId('adminGateApiKey').value.trim();
  const secretKey = byId('adminGateSecretKey').value.trim();
  const permissionConfirmed = byId('adminGatePermissionConfirmed').checked;
  if (!permissionConfirmed) return window.toast('Master의 Futures Read Only와 출금 비활성화 설정을 확인해 주세요.');
  const hasStoredCredential = byId('adminGateApiForm').dataset.hasStoredCredential === 'true';
  const isReverification = hasStoredCredential && !apiKey && !secretKey;
  if (!isReverification && (!gateUid || apiKey.length < 16 || secretKey.length < 16)) {
    return window.toast('Master UID와 API Key, Secret Key를 정확히 입력해 주세요.');
  }
  if ((apiKey && !secretKey) || (!apiKey && secretKey)) {
    return window.toast('API Key를 교체하려면 API Key와 Secret Key를 모두 입력해 주세요.');
  }
  adminGateApiBusy = true;
  const button = byId('adminGateApiConnect');
  button.disabled = true;
  button.textContent = isReverification ? '재검증 요청 중...' : '암호화 저장 중...';
  const { data, error } = isReverification
    ? await supabase.rpc('retry_admin_master_gate_api_verification', {
        p_permission_confirmed: permissionConfirmed,
      })
    : await supabase.rpc('save_admin_gate_api_credentials', {
        p_gate_uid: gateUid,
        p_api_key: apiKey,
        p_secret_key: secretKey,
        p_permission_confirmed: permissionConfirmed,
      });
  byId('adminGateApiKey').value = '';
  byId('adminGateSecretKey').value = '';
  button.disabled = false;
  button.textContent = isReverification ? '저장된 Master API 재검증' : '암호화 저장 및 검증 요청';
  adminGateApiBusy = false;
  if (error) return window.toast(isReverification
    ? '저장된 Master API의 재검증을 요청하지 못했습니다.'
    : 'Master API 정보를 저장하지 못했습니다. 입력값과 관리자 권한을 확인해 주세요.');
  delete byId('adminGateUid').dataset.dirty;
  renderAdminMasterGateConnection(data);
  window.toast(workerPublicIp
    ? `${isReverification ? '저장된 Master API' : '암호화 저장'} · Worker 검증을 요청했습니다.`
    : '암호화 저장 완료 · Worker 연결 전까지 안전 중지 상태입니다.');
  await loadAdminMasterGateConnection(false);
}

function stopGateStatusPolling() {
  if (gateStatusTimer) window.clearInterval(gateStatusTimer);
  gateStatusTimer = null;
}

// Poll the Gate connection only while its page is on screen and the tab is visible.
function startGateStatusPolling() {
  stopGateStatusPolling();
  gateStatusTimer = window.setInterval(() => {
    if (document.hidden) return;
    if (currentProfile?.role === 'MEMBER' && byId('member-account')?.classList.contains('active')) loadGateConnection(false);
    if (currentProfile?.role === 'ADMIN' && byId('admin-api')?.classList.contains('active')) {
      loadAdminMasterGateConnection(false);
      loadAdminGateConnections();
    }
  }, 5000);
}

async function loadGateConnection(showError = true) {
  if (!supabase || currentProfile?.role !== 'MEMBER') return;
  const { data, error } = await sharedRpc('get_my_gate_api_connection');
  if (error) {
    if (showError) window.toast('API 연결 상태를 불러오지 못했습니다.');
    return;
  }
  memberGateConnection = data;
  memberGateConnectionLoaded = true;
  renderGateConnection(data);
  if (byId('memberTradeGateUid')) byId('memberTradeGateUid').textContent = memberGateUidLabel();
  renderMemberCopyStatusChip();
}

async function saveGateApiCredentials() {
  if (!supabase || !currentProfile || gateApiBusy) return;
  const gateUid = String(currentProfile.gate_uid || '') || byId('gateUid').value.trim();
  const apiKey = byId('gateApiKey').value.trim();
  const secretKey = byId('gateSecretKey').value.trim();
  const permissionConfirmed = byId('gatePermissionConfirmed').checked;
  if (!permissionConfirmed) return window.toast('선물 권한과 출금 권한 설정을 확인해 주세요.');
  const hasStoredCredential = byId('gateApiForm').dataset.hasStoredCredential === 'true';
  const isReverification = hasStoredCredential && !apiKey && !secretKey;
  if (!isReverification && (!gateUid || apiKey.length < 16 || secretKey.length < 16)) {
    return window.toast('UID와 API Key, Secret Key를 정확히 입력해 주세요.');
  }
  if ((apiKey && !secretKey) || (!apiKey && secretKey)) {
    return window.toast('API Key를 교체하려면 API Key와 Secret Key를 모두 입력해 주세요.');
  }
  gateApiBusy = true;
  const button = byId('gateApiConnect');
  button.disabled = true;
  button.textContent = isReverification ? '재검증 요청 중...' : '암호화 저장 및 검증 요청 중...';
  const { data, error } = isReverification
    ? await supabase.rpc('retry_my_gate_api_verification', {
        p_permission_confirmed: permissionConfirmed,
      })
    : await supabase.rpc('save_gate_api_credentials', {
        p_gate_uid: gateUid,
        p_api_key: apiKey,
        p_secret_key: secretKey,
        p_permission_confirmed: permissionConfirmed,
      });
  byId('gateApiKey').value = '';
  byId('gateSecretKey').value = '';
  button.disabled = false;
  button.textContent = isReverification ? '저장된 API 재검증' : '저장 및 연결 검증';
  gateApiBusy = false;
  if (error && String(error.message || '').includes('GATE_UID_MUST_MATCH_ACCOUNT')) {
    return window.toast('가입한 Gate.io UID와 같은 계정의 API만 연결할 수 있습니다. UID를 확인해 주세요.', { kind: 'error' });
  }
  if (error) return window.toast(isReverification
    ? '저장된 API의 재검증을 요청하지 못했습니다.'
    : 'API 정보를 저장하지 못했습니다. 입력값을 확인해 주세요.');
  delete byId('gateUid').dataset.dirty;
  invalidateSharedRpc('get_my_gate_api_connection');
  renderGateConnection(data);
  window.toast(`${isReverification ? '저장된 API' : '암호화 저장 완료'} · Worker 검증을 요청했습니다.`);
  await loadGateConnection(false);
}

async function saveCopySettings() {
  if (!supabase || !currentProfile || copySettingsBusy) return;
  const copyRatio = Number(byId('copyRatioSelect').value);
  const maxPositionRatio = Number(byId('maxPositionRatioSelect').value);
  const validCopyRatio = copyRatio >= 50 && copyRatio <= 200 && copyRatio % 10 === 0;
  const validPositionRatio = maxPositionRatio >= 20 && maxPositionRatio <= 50 && maxPositionRatio % 10 === 0;
  if (!validCopyRatio || !validPositionRatio) {
    return window.toast('설정 범위를 확인해 주세요.');
  }
  const saveButton = byId('copySettingsSave');
  copySettingsBusy = true;
  saveButton.disabled = true;
  try {
    // An administrator may have changed the weights after this form was filled. Re-read the
    // stored values and never overwrite them silently.
    let latest;
    try {
      latest = await loadProfile(currentProfile.id);
    } catch (error) {
      console.error(error);
      return window.toast('최신 설정을 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.', { kind: 'error' });
    }
    currentProfile = { ...currentProfile, ...latest };
    const storedCopyRatio = Number(latest.copy_ratio ?? 100);
    const storedMaxPositionRatio = Number(latest.max_position_ratio ?? 30);
    const changedElsewhere = copySettingsBaseline
      && (storedCopyRatio !== copySettingsBaseline.copy_ratio || storedMaxPositionRatio !== copySettingsBaseline.max_position_ratio);
    if (changedElsewhere) {
      const overwrite = window.confirm(`관리자가 비중을 변경했습니다.\n현재 저장된 값: 카피 비율 ${storedCopyRatio}%, 종목당 최대 비중 ${storedMaxPositionRatio}%\n입력한 값: 카피 비율 ${copyRatio}%, 종목당 최대 비중 ${maxPositionRatio}%\n입력한 값으로 덮어쓸까요?`);
      if (!overwrite) {
        populateCopySettingsForm(currentProfile);
        renderMemberRiskLimits();
        return window.toast('관리자가 변경한 최신 비중으로 화면을 갱신했습니다.', { kind: 'success' });
      }
    }
    // Risk limits are fixed by the operator for every account and the RPC ignores
    // these two arguments. Send the stored values only for signature compatibility.
    const dailyLossLimit = Number(currentProfile.daily_loss_limit_pct ?? 15);
    const maxDrawdown = Number(currentProfile.max_drawdown_pct ?? 20);
    // Kept for RPC backwards compatibility only. Worker entries always inherit
    // the Master's leverage and no longer enforce a member-side leverage cap.
    const maxLeverage = Number(currentProfile.max_leverage ?? 10);
    const { data, error } = await supabase.rpc('update_my_copy_settings', {
      new_copy_ratio: copyRatio,
      new_max_position_ratio: maxPositionRatio,
      new_daily_loss_limit_pct: dailyLossLimit,
      new_max_drawdown_pct: maxDrawdown,
      new_max_leverage: maxLeverage,
    });
    if (error) return window.toast('카피 설정 저장에 실패했습니다.', { kind: 'error' });
    currentProfile = { ...currentProfile, ...data };
    populateCopySettingsForm(currentProfile);
    renderMemberRiskLimits();
    window.toast('카피 설정을 저장했습니다.', { kind: 'success' });
  } finally {
    copySettingsBusy = false;
    saveButton.disabled = false;
  }
}

function escapeHtml(value = '') {
  return String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
}

// Signed amount for profit and loss only (+$1.00 / -$1.00 / $0.00).
function formatUsd(value) {
  const number = Number(value || 0);
  const sign = number > 0 ? '+' : number < 0 ? '-' : '';
  return `${sign}$${Math.abs(number).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// Unsigned amount for balances, equity, margin and position size.
function formatAmount(value) {
  const number = Number(value || 0);
  return `${number < 0 ? '-' : ''}$${Math.abs(number).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// Zero is neutral: only gains are green and only losses are red.
function signClass(value) {
  const number = Number(value || 0);
  return number > 0 ? 'pos' : number < 0 ? 'neg' : '';
}

function formatSignedPct(value, digits = 2) {
  const number = Number(value || 0);
  return `${number > 0 ? '+' : ''}${number.toFixed(digits)}%`;
}

function positionLogo(contract) {
  const base = String(contract || '').split('_')[0].replace(/[^A-Z0-9]/gi, '').toUpperCase();
  const label = base.slice(0, 2) || '?';
  const hue = [...base].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 360;
  return `<span class="position-symbol-logo" style="--symbol-hue:${hue}" aria-hidden="true">${escapeHtml(label)}</span>`;
}

function analysisNode(prefix, suffix) {
  return byId(`${prefix}${suffix}`);
}

function renderTradingAnalysis(data, prefix = 'analysis') {
  const totals = data?.totals || {};
  const days = Array.isArray(data?.days) ? data.days : [];
  const symbols = Array.isArray(data?.symbols)
    ? data.symbols.filter((item) => String(item?.contract || '').trim() && (Number(item.trade_count || 0) > 0 || Math.abs(Number(item.net_pnl || 0)) > 0.00000001))
    : [];
  const hasData = days.length > 0 || Number(totals.trade_count || 0) > 0;
  analysisNode(prefix, 'Empty').classList.toggle('hidden', hasData);
  analysisNode(prefix, 'Content').classList.toggle('hidden', !hasData);
  analysisNode(prefix, 'Period').textContent = data?.started_on ? `${data.started_on} — ${data.ended_on}` : '카피 시작 전';
  if (!hasData) return;
  const grossProfit = Number(totals.gross_profit || 0);
  const grossLoss = Number(totals.gross_loss || 0);
  const netPnl = Number(totals.net_pnl || 0);
  analysisNode(prefix, 'GrossProfit').textContent = formatUsd(grossProfit);
  analysisNode(prefix, 'GrossLoss').textContent = formatUsd(grossLoss);
  analysisNode(prefix, 'NetPnl').textContent = formatUsd(netPnl);
  analysisNode(prefix, 'NetPnl').className = netPnl > 0 ? 'pos' : netPnl < 0 ? 'neg' : '';
  analysisNode(prefix, 'WinRate').textContent = totals.win_rate == null ? '-' : `${Number(totals.win_rate).toFixed(1)}%`;
  analysisNode(prefix, 'AverageProfit').textContent = totals.average_profit == null ? '-' : formatUsd(totals.average_profit);
  analysisNode(prefix, 'AverageProfit').className = totals.average_profit == null ? '' : signClass(totals.average_profit);
  // Average loss is a loss even when the RPC reports it as a positive magnitude.
  const averageLoss = totals.average_loss == null ? null : -Math.abs(Number(totals.average_loss));
  analysisNode(prefix, 'AverageLoss').textContent = averageLoss == null ? '-' : formatUsd(averageLoss);
  analysisNode(prefix, 'AverageLoss').className = averageLoss ? 'neg' : '';
  if (analysisNode(prefix, 'ProfitFactor')) analysisNode(prefix, 'ProfitFactor').textContent = totals.profit_factor == null ? '-' : `${Number(totals.profit_factor).toFixed(2)} : 1`;
  if (analysisNode(prefix, 'FeesFunding')) analysisNode(prefix, 'FeesFunding').textContent = formatUsd(Number(totals.funding_pnl || 0) - Number(totals.fees || 0));
  const totalAbs = grossProfit + Math.abs(grossLoss) || 1;
  analysisNode(prefix, 'ProfitBar').style.width = `${Math.max(4, grossProfit / totalAbs * 100)}%`;
  analysisNode(prefix, 'LossBar').style.width = `${Math.max(4, Math.abs(grossLoss) / totalAbs * 100)}%`;

  const latestDay = String(days.at(-1)?.date || data.ended_on || kstDate());
  const monthInput = prefix === 'analysis' ? byId('analysisMonthSelect') : null;
  const latestMonth = latestDay.slice(0, 7);
  const firstDate = String(days[0]?.date || data.started_on || data.ended_on || '').slice(0, 7);
  if (monthInput) {
    monthInput.min = firstDate || latestMonth;
    monthInput.max = String(data.ended_on || days.at(-1)?.date || '').slice(0, 7) || latestMonth;
    if (!monthInput.value || monthInput.value < monthInput.min || monthInput.value > monthInput.max) monthInput.value = latestMonth;
  }
  const selectedMonth = monthInput?.value || latestMonth;
  const [selectedYear, selectedMonthNumber] = selectedMonth.split('-').map(Number);
  const selectedDate = new Date(selectedYear, selectedMonthNumber - 1, 1);
  const year = selectedDate.getFullYear();
  const month = selectedDate.getMonth();
  if (analysisNode(prefix, 'MonthLabel')) analysisNode(prefix, 'MonthLabel').textContent = `${year}.${String(month + 1).padStart(2, '0')}`;
  const pnlByDate = new Map(days.map((day) => [day.date, Number(day.net_pnl || 0)]));
  const firstWeekday = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells = Array.from({ length: firstWeekday }, () => '<div class="blank"></div>');
  for (let day = 1; day <= daysInMonth; day += 1) {
    const key = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const pnl = pnlByDate.get(key);
    // Compact amounts keep large values (≥ $1,000) inside the calendar cell; the title keeps the exact value.
    cells.push(`<div class="${pnl > 0 ? 'gain' : pnl < 0 ? 'loss' : ''}"${pnl == null ? '' : ` title="${escapeHtml(`${key} ${formatUsd(pnl)}`)}"`}><span>${day}</span><b>${pnl == null ? '-' : formatCompactUsd(pnl, true)}</b></div>`);
  }
  analysisNode(prefix, 'Calendar').innerHTML = '<small>일</small><small>월</small><small>화</small><small>수</small><small>목</small><small>금</small><small>토</small>' + cells.join('');

  const maxSymbolPnl = Math.max(...symbols.map((item) => Math.abs(Number(item.net_pnl || 0))), 1);
  const symbolsNode = analysisNode(prefix, 'Symbols');
  if (symbolsNode) symbolsNode.innerHTML = symbols.length ? symbols.slice(0, 10).map((item, index) => {
    const pnl = Number(item.net_pnl || 0);
    return `<div class="analysis-symbol"><div><span>${index + 1}</span><b>${escapeHtml(item.contract)}</b><strong class="${pnl > 0 ? 'pos' : pnl < 0 ? 'neg' : ''}">${formatUsd(pnl)}</strong></div><i><em class="${pnl < 0 ? 'negative' : ''}" style="width:${Math.max(4, Math.abs(pnl) / maxSymbolPnl * 100)}%"></em></i><small>정산 ${Number(item.trade_count || 0).toLocaleString('ko-KR')}건</small></div>`;
  }).join('') : '<div class="empty-cell">종목별 집계 데이터가 없습니다.</div>';
}

async function loadTradingAnalysis() {
  if (!supabase || currentProfile?.role !== 'MEMBER' || memberAnalysisBusy) return;
  memberAnalysisBusy = true;
  const { data, error } = await supabase.rpc('get_my_trading_analysis');
  memberAnalysisBusy = false;
  const empty = byId('analysisEmpty');
  if (error) {
    if (empty && !memberTradingAnalysisData) {
      empty.innerHTML = inlineRetry('수익 분석을 불러오지 못했습니다.', 'member-analysis');
      empty.classList.remove('hidden');
      byId('analysisContent')?.classList.add('hidden');
      if (byId('analysisPeriod')) byId('analysisPeriod').textContent = '-';
    }
    return window.toast('수익 분석을 불러오지 못했습니다.', { kind: 'error' });
  }
  if (empty) empty.textContent = 'Trading Worker가 거래 원장을 집계하면 분석 결과가 표시됩니다.';
  memberTradingAnalysisData = data;
  renderTradingAnalysis(data);
}

async function loadAdminAnalysisMembers() {
  if (!supabase || currentProfile?.role !== 'ADMIN') return;
  const list = byId('adminAnalysisMemberList');
  if (!list || list.dataset.loaded === 'true') return;
  const { data, error } = await supabase.from('profiles').select('id,full_name,email,gate_uid').eq('role', 'MEMBER').eq('approval_status', 'APPROVED');
  if (error) return window.toast('수익 조회 회원을 불러오지 못했습니다.');
  list.dataset.loaded = 'true';
  adminAnalysisMembers = Array.isArray(data) ? data : [];
  renderAdminAnalysisMembers();
  const firstMemberId = list.querySelector('[data-analysis-member]')?.dataset.analysisMember;
  if (!adminAnalysisSelectedUserId && firstMemberId) await loadAdminMemberTradingAnalysis(firstMemberId);
}

function renderAdminAnalysisMembers() {
  const list = byId('adminAnalysisMemberList');
  if (!list) return;
  const members = [...adminAnalysisMembers].sort((left, right) => String(left.full_name || accountDisplayId(left.gate_uid, left.email)).localeCompare(String(right.full_name || accountDisplayId(right.gate_uid, right.email)), 'ko'));
  list.innerHTML = members.length ? members.map((member) => `<button type="button" data-analysis-member="${escapeHtml(member.id)}" class="${member.id === adminAnalysisSelectedUserId ? 'active' : ''}" aria-pressed="${member.id === adminAnalysisSelectedUserId}"><b>${escapeHtml(member.full_name || '-')}</b><small>${escapeHtml(accountDisplayId(member.gate_uid, member.email) || '-')}</small></button>`).join('') : '<span class="notice">조회할 승인 회원이 없습니다.</span>';
}

function setAdminAnalysisDateRange(days = adminAnalysisRangeDays) {
  adminAnalysisRangeDays = Number(days);
  if (byId('adminAnalysisStartDate')) byId('adminAnalysisStartDate').value = kstDateOffset(-Math.max(0, adminAnalysisRangeDays - 1));
  if (byId('adminAnalysisEndDate')) byId('adminAnalysisEndDate').value = kstDate();
  document.querySelectorAll('[data-analysis-range]').forEach((button) => button.classList.toggle('active', Number(button.dataset.analysisRange) === adminAnalysisRangeDays));
}

// Latest selection wins: clicking member B while A is loading loads B and ignores A's reply.
async function loadAdminMemberTradingAnalysis(userId = adminAnalysisSelectedUserId, useCurrentDates = false) {
  if (!supabase || currentProfile?.role !== 'ADMIN') return;
  if (!userId) return window.toast('조회할 회원을 선택해 주세요.');
  adminAnalysisSelectedUserId = userId;
  if (!useCurrentDates || !byId('adminAnalysisStartDate')?.value) setAdminAnalysisDateRange(adminAnalysisRangeDays);
  const startDate = byId('adminAnalysisStartDate')?.value;
  const endDate = byId('adminAnalysisEndDate')?.value;
  if (!startDate || !endDate || startDate > endDate) return window.toast('조회 기간을 확인해 주세요.');
  document.querySelectorAll('[data-analysis-member]').forEach((button) => {
    button.classList.toggle('active', button.dataset.analysisMember === userId);
    button.setAttribute('aria-pressed', String(button.dataset.analysisMember === userId));
  });
  const ticket = ++adminAnalysisRequestSeq;
  if (byId('adminAnalysisPeriod')) byId('adminAnalysisPeriod').textContent = '불러오는 중';
  const { data, error } = await supabase.rpc('get_admin_member_trading_analysis_range', {
    p_user_id: userId,
    p_start_date: startDate,
    p_end_date: endDate,
  });
  if (ticket !== adminAnalysisRequestSeq) return;
  if (error) return window.toast('회원 수익 분석을 불러오지 못했습니다.');
  renderTradingAnalysis(data, 'adminAnalysis');
}

function closeMemberDetail() {
  newOperationPanel?.clear();
  const modal = byId('memberDetailModal');
  if (!modal) return;
  clearMemberTempPassword();
  closeModal(modal);
  selectedMemberId = null;
}

function setMemberDetailTab(tab = 'overview') {
  const selected = ['overview', 'performance', 'security'].includes(tab) ? tab : 'overview';
  document.querySelectorAll('[data-member-detail-tab]').forEach((button) => {
    const active = button.dataset.memberDetailTab === selected;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  });
  document.querySelectorAll('[data-member-detail-panel]').forEach((panel) => {
    panel.classList.toggle('hidden', panel.dataset.memberDetailPanel !== selected);
  });
}

async function openMemberDetail(userId) {
  if (!supabase || currentProfile?.role !== 'ADMIN' || memberDetailBusy) return;
  newOperationPanel?.clear();
  const modal = byId('memberDetailModal');
  selectedMemberId = userId;
  openModal(modal, { focus: '[data-member-detail-tab].active' });
  byId('memberDetailTitle').textContent = '불러오는 중...';
  byId('memberDetailEmail').textContent = '';
  byId('memberDetailSummary').innerHTML = '';
  setMemberDetailTab('overview');
  byId('memberPasswordResetActions')?.classList.add('hidden');
  clearMemberTempPassword();
  byId('memberMonthlyPerformance').innerHTML = '<tr><td colspan="6" class="empty-cell">월별 수익을 불러오는 중입니다.</td></tr>';
  memberDetailBusy = true;
  const { data, error } = await supabase.rpc('get_admin_member_monthly_performance', {
    p_user_id: userId,
    p_months: 12,
  });
  memberDetailBusy = false;
  if (error) {
    byId('memberDetailTitle').textContent = '조회 실패';
    byId('memberMonthlyPerformance').innerHTML = '<tr><td colspan="6" class="empty-cell neg">회원 수익 정보를 불러오지 못했습니다.</td></tr>';
    return;
  }
  const member = data?.member || {};
  const months = Array.isArray(data?.months) ? data.months : [];
  byId('memberDetailTitle').textContent = member.full_name || '-';
  byId('memberDetailEmail').textContent = accountDisplayId(member.gate_uid, member.email) || '-';
  byId('memberDetailStatus').textContent = APPROVAL_STATUS_LABELS[member.approval_status] || (member.approval_status ? '확인 필요' : '-');
  byId('memberDetailStatus').className = member.approval_status === 'APPROVED' ? 'chip' : member.approval_status === 'REJECTED' ? 'chip red' : 'chip yellow';
  byId('memberDetailSummary').innerHTML = `
    <div><small>권한</small><b>${escapeHtml(ROLE_LABELS[member.role] || member.role || '-')}</b></div>
    <div><small>카피 비율</small><b>${Number(member.copy_ratio ?? 100)}%</b></div>
    <div><small>최대 포지션 비중</small><b>${Number(member.max_position_ratio ?? 30)}%</b></div>
    <div><small>가입일</small><b>${member.created_at ? new Date(member.created_at).toLocaleDateString('ko-KR') : '-'}</b></div>
    ${member.role === 'MEMBER' ? renderAdminMemberWeightSettings(member) : ''}
    ${member.role === 'MEMBER' ? '<div class="member-control-actions"><small>관리자 카피 제어</small><div class="actions"><button class="btn" type="button" data-member-control="PAUSE">일시중지</button><button class="btn" type="button" data-member-control="REDUCE_ONLY">축소 전용</button><button class="btn red" type="button" data-member-control="HALT">중단</button><button class="btn green" type="button" data-member-control="RESUME">재개</button><button class="btn" type="button" data-new-operation-open>새 운용 시작</button></div></div>' : ''}
    ${member.role === 'MEMBER' && !member.withdrawn_at ? '<div class="member-control-actions member-withdraw-actions"><small>회원 탈퇴</small><div class="actions"><button class="btn red" type="button" data-member-withdraw>회원 탈퇴 처리</button></div><p class="muted">카피 중단·로그인 차단·API 키 폐기. 기록은 보존되고 탈퇴 회원 탭에서 복구할 수 있습니다.</p></div>' : ''}`;
  byId('memberPasswordResetActions')?.classList.toggle('hidden', member.role !== 'MEMBER');
  byId('memberMonthlyPerformance').innerHTML = months.length ? months.map((month) => {
    const netPnl = Number(month.net_pnl || 0);
    const returnPct = month.return_pct == null ? null : Number(month.return_pct);
    const winRate = month.win_rate == null ? null : Number(month.win_rate);
    const monthLabel = /^\d{4}-\d{2}/.test(String(month.month)) ? `${String(month.month).slice(0, 4)}년 ${Number(String(month.month).slice(5, 7))}월` : '-';
    return `<tr><td data-label="월">${escapeHtml(monthLabel)}</td><td data-label="순손익" class="${netPnl > 0 ? 'pos' : netPnl < 0 ? 'neg' : ''}">${formatUsd(netPnl)}</td><td data-label="수익률" class="${returnPct > 0 ? 'pos' : returnPct < 0 ? 'neg' : ''}">${returnPct == null ? '-' : `${returnPct > 0 ? '+' : ''}${returnPct.toFixed(2)}%`}</td><td data-label="거래량">${formatCompactUsd(month.trading_volume)}</td><td data-label="거래">${Number(month.trade_count || 0).toLocaleString('ko-KR')}건</td><td data-label="승률">${winRate == null ? '-' : `${winRate.toFixed(1)}%`}</td></tr>`;
  }).join('') : '<tr><td colspan="6" class="empty-cell">아직 집계된 월별 수익 데이터가 없습니다.<small>Trading Worker 연결 후 실제 거래 데이터를 기준으로 자동 집계됩니다.</small></td></tr>';
}

const APPROVAL_STATUS_LABELS = { APPROVED: '승인됨', PENDING: '승인 대기', REJECTED: '거절됨', SUSPENDED: '이용 정지' };
const ROLE_LABELS = { MEMBER: '회원', ADMIN: '관리자' };

function getMemberCopyProgress(profile, connection, positionStates = []) {
  if (profile.role !== 'MEMBER') return { label: '해당 없음', detail: '관리자 계정', className: 'chip muted' };
  if (profile.approval_status !== 'APPROVED') return { label: '미시작', detail: '승인 필요', className: 'chip muted' };
  if (connection?.status !== 'VERIFIED') return { label: connection?.status === 'ERROR' ? 'API 연결 오류' : 'API 연결 필요', detail: '카피 주문 불가', className: connection?.status === 'ERROR' ? 'chip red' : 'chip muted' };
  if (profile.member_halted) return { label: '카피 중단', detail: 'API 연결 정상 · 주문 중단', className: 'chip red' };
  if (profile.copy_paused) return { label: '카피 일시중지', detail: 'API 연결 정상 · 포지션 유지', className: 'chip yellow' };
  if (profile.reduce_only) return { label: '포지션 축소만 가능', detail: 'API 연결 정상 · 신규 진입 차단', className: 'chip yellow' };

  const priority = ['HALTED', 'ERROR', 'MANUAL_OVERRIDE', 'PAUSED', 'REDUCE_ONLY', 'DRIFT'];
  const currentState = priority.find((state) => positionStates.some((position) => position.state === state));
  const stateLabels = {
    HALTED: ['중단', 'chip red'],
    ERROR: ['오류', 'chip red'],
    MANUAL_OVERRIDE: ['일부 종목 카피 정지', 'chip yellow'],
    PAUSED: ['일시중지', 'chip yellow'],
    REDUCE_ONLY: ['축소 전용', 'chip yellow'],
    DRIFT: ['동기화 중', 'chip yellow'],
  };
  if (currentState) return { label: stateLabels[currentState][0], detail: currentState === 'MANUAL_OVERRIDE' ? 'API 연결 정상 · 종목별 확인 필요' : `API 연결 정상 · ${POSITION_STATE_META[currentState][2]}`, className: stateLabels[currentState][1] };
  if (!positionStates.length) return { label: '연결 완료', detail: 'API 연결 정상 · Worker 확인 대기', className: 'chip yellow' };
  return { label: '카피 진행 중', detail: 'API 연결 정상 · 포지션 동기화', className: 'chip' };
}

function renderAdminWithdrawnRows() {
  if (byId('withdrawnCount')) byId('withdrawnCount').textContent = String(adminWithdrawnCache.length);
  const body = byId('withdrawnMembers');
  if (!body) return;
  body.innerHTML = adminWithdrawnCache.length ? adminWithdrawnCache.map((member) => {
    const accountId = accountDisplayId(member.gate_uid, member.email);
    const name = member.full_name || accountId || '회원';
    return `<tr><td><div class="admin-member-identity"><span>${escapeHtml(String(name).slice(0, 1))}</span><div><b>${escapeHtml(member.full_name || '-')}</b><small>${escapeHtml(accountId || '-')}</small></div></div></td>`
      + `<td>${escapeHtml(member.phone || '-')}</td>`
      + `<td>${member.created_at ? escapeHtml(new Date(member.created_at).toLocaleDateString('ko-KR')) : '-'}</td>`
      + `<td>${member.withdrawn_at ? escapeHtml(new Date(member.withdrawn_at).toLocaleString('ko-KR')) : '-'}</td>`
      + `<td class="withdrawal-reason">${escapeHtml(member.withdrawal_reason || '-')}</td>`
      + `<td class="table-actions"><button class="btn" type="button" data-member-restore="${escapeHtml(member.id)}" data-member-name="${escapeHtml(name)}">복구</button></td></tr>`;
  }).join('') : '<tr><td colspan="6" class="empty-cell">탈퇴 회원이 없습니다.</td></tr>';
}

function setAdminMemberTab(tab) {
  adminMemberTab = tab === 'withdrawn' ? 'withdrawn' : 'active';
  document.querySelectorAll('[data-member-tab]').forEach((button) => {
    const active = button.dataset.memberTab === adminMemberTab;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  });
  document.querySelectorAll('[data-member-tab-panel]').forEach((panel) => {
    panel.classList.toggle('hidden', panel.dataset.memberTabPanel !== adminMemberTab);
  });
  document.querySelector('#admin-members .admin-pending-members')?.classList.toggle('hidden', adminMemberTab === 'withdrawn');
}

const WITHDRAW_ERRORS = {
  MEMBER_HAS_UNRESOLVED_ORDERS: '결과를 확인 중인 주문이 있어 지금은 탈퇴 처리할 수 없습니다. 1~2분 뒤 다시 시도해 주세요.',
  MEMBER_ALREADY_WITHDRAWN: '이미 탈퇴 처리된 회원입니다.',
  MEMBER_NOT_FOUND: '회원을 찾을 수 없습니다.',
  ADMIN_REQUIRED: '관리자만 처리할 수 있습니다.',
};

async function withdrawAdminMember() {
  if (!selectedMemberId || currentProfile?.role !== 'ADMIN' || adminWithdrawBusy || adminControlBusy || adminWeightBusy) return;
  const name = byId('memberDetailTitle')?.textContent?.trim() || '회원';
  if (!window.confirm(`${name} 회원을 탈퇴 처리할까요?\n\n• 카피가 즉시 중단되고 로그인할 수 없게 됩니다.\n• 저장된 Gate API 키가 폐기됩니다.\n• Gate에 남은 포지션은 시스템이 더 이상 관리하지 않습니다(회원이 직접 정리).\n• 거래·수익·감사 기록은 보존되며 '탈퇴 회원' 탭에서 복구할 수 있습니다.`)) return;
  const typed = window.prompt(`확인을 위해 회원 이름 "${name}"을(를) 입력해 주세요.`);
  if (typed == null) return;
  if (typed.trim() !== name) return window.toast('이름이 일치하지 않아 취소했습니다.', { kind: 'error' });
  const reason = window.prompt('탈퇴 사유를 입력해 주세요. (선택, 비워도 됩니다)') ?? '';
  adminWithdrawBusy = true;
  setMemberDetailActionsDisabled(true);
  let data = null; let error = null;
  try {
    ({ data, error } = await supabase.rpc('admin_withdraw_member', {
      p_user_id: selectedMemberId, p_confirmation: 'ADMIN_WITHDRAW_MEMBER', p_reason: reason.trim() || null,
    }));
  } finally {
    adminWithdrawBusy = false;
    setMemberDetailActionsDisabled(false);
  }
  if (error) {
    const code = Object.keys(WITHDRAW_ERRORS).find((key) => String(error.message || '').includes(key));
    return window.toast(code ? WITHDRAW_ERRORS[code] : '탈퇴 처리하지 못했습니다.', { kind: 'error' });
  }
  const openPositions = Number(data?.open_positions || 0);
  window.toast(openPositions > 0
    ? `탈퇴 처리했습니다. Gate에 남은 포지션 ${openPositions}개는 회원이 직접 정리해야 합니다.`
    : '탈퇴 처리했습니다.', { kind: 'success' });
  invalidateSharedRpc('get_admin_operations_metrics', 'get_admin_live_trading_data', 'get_admin_gate_api_connections');
  closeMemberDetail();
  await loadAdminMembers();
}

async function restoreAdminMember(userId, name, button) {
  if (!userId || currentProfile?.role !== 'ADMIN' || adminWithdrawBusy) return;
  if (!window.confirm(`${name || '회원'} 회원을 복구할까요?\n\n로그인이 다시 가능해지고 '가입 승인 대기'로 돌아갑니다. 승인 후 회원이 Gate API를 다시 연결하고 카피를 재개해야 합니다.`)) return;
  adminWithdrawBusy = true;
  if (button) button.disabled = true;
  let error = null;
  try {
    ({ error } = await supabase.rpc('admin_restore_withdrawn_member', { p_user_id: userId }));
  } finally {
    adminWithdrawBusy = false;
    if (button) button.disabled = false;
  }
  if (error) return window.toast('회원을 복구하지 못했습니다.', { kind: 'error' });
  window.toast('복구했습니다. 가입 승인 대기에서 승인해 주세요.', { kind: 'success' });
  await loadAdminMembers();
  setAdminMemberTab('active');
}

async function loadAdminMembers() {
  if (!supabase || currentProfile?.role !== 'ADMIN') return;
  const ticket = ++adminMembersRequestSeq;
  const today = kstDate();
  const [profilesResult, connectionsResult, liveResult, metricsResult] = await Promise.all([
    supabase.from('profiles').select('id,email,gate_uid,full_name,phone,approval_status,role,copy_ratio,max_position_ratio,copy_paused,member_halted,reduce_only,created_at,withdrawn_at,withdrawal_reason').order('created_at', { ascending: false }),
    sharedRpc('get_admin_gate_api_connections'),
    sharedRpc('get_admin_live_trading_data'),
    sharedRpc('get_admin_operations_metrics', { p_start_date: today, p_end_date: today }),
  ]);
  if (ticket !== adminMembersRequestSeq) return;
  const { data, error } = profilesResult;
  if (error) {
    if (byId('pendingMembers')) byId('pendingMembers').innerHTML = `<tr><td colspan="5" class="empty-cell">${inlineRetry('승인 대기 회원을 불러오지 못했습니다.', 'admin-members')}</td></tr>`;
    if (byId('memberList')) byId('memberList').innerHTML = `<tr><td colspan="10" class="empty-cell">${inlineRetry('회원 목록을 불러오지 못했습니다.', 'admin-members')}</td></tr>`;
    return window.toast('회원 목록을 불러오지 못했습니다.', { kind: 'error' });
  }
  const connections = Array.isArray(connectionsResult.data) ? connectionsResult.data : [];
  const positionStates = Array.isArray(liveResult.data?.member_states) ? liveResult.data.member_states : [];
  const connectionByUserId = new Map(connections.map((connection) => [connection.user_id, connection]));
  const statesByEmail = positionStates.reduce((map, state) => {
    const key = String(state.email || '').toLowerCase();
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(state);
    return map;
  }, new Map());
  adminWithdrawnCache = data.filter((profile) => profile.role === 'MEMBER' && profile.withdrawn_at)
    .sort((a, b) => String(b.withdrawn_at).localeCompare(String(a.withdrawn_at)));
  renderAdminWithdrawnRows();
  const pending = data.filter((profile) => profile.approval_status === 'PENDING' && !profile.withdrawn_at);
  byId('pendingCount').textContent = `대기 ${pending.length}명`;
  byId('pendingMembers').innerHTML = pending.length ? pending.map((profile) => `
    <tr><td>${escapeHtml(profile.full_name || '-')}</td><td>${escapeHtml(accountDisplayId(profile.gate_uid, profile.email) || '-')}</td><td>${escapeHtml(profile.phone || '-')}</td><td>${new Date(profile.created_at).toLocaleString('ko-KR')}</td><td class="table-actions"><button class="btn green" type="button" data-approval="APPROVED" data-user-id="${escapeHtml(profile.id)}" data-member-name="${escapeHtml(profile.full_name || accountDisplayId(profile.gate_uid, profile.email) || '신청자')}">승인</button> <button class="btn red" type="button" data-approval="REJECTED" data-user-id="${escapeHtml(profile.id)}" data-member-name="${escapeHtml(profile.full_name || accountDisplayId(profile.gate_uid, profile.email) || '신청자')}">거절</button></td></tr>
  `).join('') : '<tr><td colspan="5" class="empty-cell">승인 대기 회원이 없습니다.</td></tr>';
  const metricRows = new Map((Array.isArray(metricsResult.data?.members) ? metricsResult.data.members : []).map((member) => [member.id, member]));
  adminMasterAccount = metricsResult.data?.master || null;
  adminMembersCache = data.filter((profile) => profile.role === 'MEMBER' && profile.approval_status !== 'PENDING' && !profile.withdrawn_at).map((profile) => {
    const metric = metricRows.get(profile.id) || {};
    const progress = getMemberCopyProgress(profile, connectionByUserId.get(profile.id), statesByEmail.get(String(profile.email || '').toLowerCase()) || []);
    return { ...profile, ...metric, fallback_progress: progress, connection: connectionByUserId.get(profile.id) || null };
  });
  renderAdminMemberRows();
}

// 총 자산 = exchange balance without unrealised PnL; 현재 자산 = balance + unrealised PnL.
// The metrics RPC normalises classic vs unified Gate accounts (balance_equity / current_equity).
function renderAdminEquityCells(account) {
  const balance = account.balance_equity ?? account.total_equity;
  const current = account.current_equity;
  const unrealised = account.unrealised_pnl == null ? null : Number(account.unrealised_pnl);
  const unrealisedNote = unrealised == null || unrealised === 0 ? ''
    : `<small class="${signClass(unrealised)}">미실현 ${formatUsd(unrealised)}</small>`;
  return `<td><b>${balance == null ? '-' : formatAmount(balance)}</b></td>`
    + `<td class="admin-equity-cell"><b>${current == null ? '-' : formatAmount(current)}</b>${unrealisedNote}</td>`;
}

function renderAdminMasterRow(master) {
  const observed = master.last_observed_at ? new Date(master.last_observed_at).toLocaleString('ko-KR') : '-';
  return `<tr class="admin-master-row"><td><div class="admin-member-identity"><span>M</span><div><b>Master · 내 계정</b><small>${escapeHtml(accountDisplayId(master.gate_uid, master.email) || master.full_name || '-')}</small></div></div></td><td><span class="chip">마스터</span></td>${renderAdminEquityCells(master)}<td>-</td><td>-</td><td>-</td><td>-</td><td>${observed}</td><td class="table-actions">-</td></tr>`;
}

function renderAdminMemberRows() {
  const tableBody = byId('memberList');
  if (!tableBody) return;
  const query = adminMemberSearch.trim().toLowerCase();
  const rows = adminMembersCache.filter((member) => !query || `${member.full_name || ''} ${member.gate_uid || ''} ${accountDisplayId(member.gate_uid, member.email)}`.toLowerCase().includes(query));
  const statusMeta = {
    COPYING: ['카피 중', 'chip'], PAUSED: ['일시 정지', 'chip yellow'], HALTED: ['중단', 'chip red'],
    REDUCE_ONLY: ['축소 전용', 'chip yellow'], API_ERROR: ['API 오류', 'chip red'], ERROR: ['주문 오류', 'chip red'],
    ATTENTION: ['확인 필요', 'chip yellow'],
  };
  tableBody.innerHTML = rows.length ? rows.map((member) => {
    const fallback = member.fallback_progress || { label: '상태 확인', className: 'chip yellow' };
    const status = statusMeta[member.copy_status] || [fallback.label, fallback.className];
    const pnl = member.today_pnl == null ? null : Number(member.today_pnl);
    const apiStatus = member.api_status || member.connection?.status || 'NOT_CONNECTED';
    const apiLabel = apiStatus === 'VERIFIED' ? '정상' : apiStatus === 'ERROR' ? '권한 오류' : apiStatus === 'DISABLED' ? '연결 해제' : '확인 필요';
    return `<tr><td><div class="admin-member-identity"><span>${escapeHtml(String(member.full_name || accountDisplayId(member.gate_uid, member.email) || '?').slice(0, 1))}</span><div><b>${escapeHtml(member.full_name || '-')}</b><small>${escapeHtml(accountDisplayId(member.gate_uid, member.email) || '-')}</small></div></div></td><td><span class="${status[1]}">${escapeHtml(status[0])}</span></td>${renderAdminEquityCells(member)}<td class="${pnl == null ? '' : signClass(pnl)}"><b>${pnl == null ? '-' : formatUsd(pnl)}</b></td><td>${Number(member.copy_ratio ?? 100)}%</td><td><div class="member-margin-cell"><b>${Number(member.margin_usage_pct || 0).toFixed(1)}%</b><div><i style="width:${Math.min(100, Math.max(0, Number(member.margin_usage_pct || 0)))}%"></i></div></div></td><td class="${apiStatus === 'VERIFIED' ? 'pos' : 'neg'}">${escapeHtml(apiLabel)}</td><td>${member.last_observed_at ? new Date(member.last_observed_at).toLocaleString('ko-KR') : '-'}</td><td class="table-actions"><button class="btn" type="button" data-member-detail="${escapeHtml(member.id)}" aria-label="${escapeHtml(`${member.full_name || accountDisplayId(member.gate_uid, member.email) || '회원'} 상세 보기`)}">상세</button></td></tr>`;
  }).join('') : '<tr><td colspan="10" class="empty-cell">조건에 맞는 회원이 없습니다.</td></tr>';
  if (adminMasterAccount && !query) tableBody.insertAdjacentHTML('afterbegin', renderAdminMasterRow(adminMasterAccount));
  if (byId('memberDirectorySummary')) byId('memberDirectorySummary').textContent = `${adminMembersCache.length}명 · 카피 중 ${adminMembersCache.filter((member) => member.copy_status === 'COPYING').length}명 · 확인 필요 ${adminMembersCache.filter((member) => member.copy_status !== 'COPYING').length}명`;
}

async function loadAdminGateConnections() {
  if (!supabase || currentProfile?.role !== 'ADMIN') return;
  const { data, error } = await sharedRpc('get_admin_gate_api_connections');
  if (error) return window.toast('API 연결 현황을 불러오지 못했습니다.');
  const connections = Array.isArray(data) ? data : [];
  const tableBody = byId('adminGateConnections');
  if (!tableBody) return;
  tableBody.innerHTML = connections.length ? connections.map((connection) => {
    const statusClass = connection.status === 'VERIFIED' ? 'chip' : connection.status === 'ERROR' ? 'chip red' : 'chip yellow';
    const statusLabel = { VERIFIED: '연결됨', ERROR: '연결 오류', VERIFYING: '검증 중', PENDING_VERIFICATION: '검증 대기', NOT_CONNECTED: '미연결', DISABLED: '연결 해제' }[connection.status] || '확인 필요';
    const disconnect = connection.status !== 'NOT_CONNECTED' && connection.status !== 'DISABLED'
      ? `<button class="btn red admin-api-disconnect" type="button" data-admin-disconnect-member="${escapeHtml(connection.user_id)}" data-member-name="${escapeHtml(connection.full_name || accountDisplayId(connection.gate_uid, connection.email) || '회원')}">연결 해지</button>` : '-';
    return `<tr><td>${escapeHtml(connection.full_name || '-')}<small>${escapeHtml(accountDisplayId(null, connection.email))}</small></td><td>${escapeHtml(connection.gate_uid || '-')}</td><td><span class="${statusClass}" title="${escapeHtml(connection.status || '')}">${escapeHtml(statusLabel)}</span></td><td>${connection.futures_read ? '읽기 확인' : connection.permissions_confirmed ? '사용자 확인' : '-'}</td><td>${connection.status === 'VERIFIED' ? 'Worker 접속 통과' : '-'}</td><td>${connection.last_checked_at ? new Date(connection.last_checked_at).toLocaleString('ko-KR') : '-'}</td><td class="table-actions">${disconnect}</td></tr>`;
  }).join('') : '<tr><td colspan="7" class="empty-cell">승인 회원의 API 연결 정보가 없습니다.</td></tr>';
  const verifiedCount = connections.filter((item) => item.status === 'VERIFIED').length;
  const errorCount = connections.filter((item) => item.status === 'ERROR').length;
  const disconnectedCount = connections.filter((item) => item.status === 'NOT_CONNECTED').length;
  byId('adminApiTotal').textContent = String(connections.length);
  byId('adminApiVerified').textContent = String(verifiedCount);
  byId('adminApiErrors').textContent = String(errorCount);
  byId('adminApiDisconnected').textContent = String(disconnectedCount);
}

async function disconnectAdminMemberGateApi(userId, memberName, button = null) {
  if (!supabase || currentProfile?.role !== 'ADMIN' || disconnectBusy) return;
  if (!window.confirm(`${memberName} 회원의 Gate.io API 연결을 해지할까요? 해당 회원의 신규 카피 주문이 즉시 중단되고 저장된 API Key는 폐기됩니다.`)) return;
  await withDisconnectBusy(button, async () => {
    const { error } = await supabase.rpc('admin_disable_member_gate_api_connection', {
      p_user_id: userId,
      p_confirmation: 'ADMIN_DISCONNECT_MEMBER_GATE_API',
    });
    if (error) return window.toast('회원 API 연결을 해지하지 못했습니다.', { kind: 'error' });
    window.toast(`${memberName} 회원의 API 연결을 해지했습니다.`, { kind: 'success' });
    invalidateSharedRpc('get_admin_gate_api_connections', 'get_admin_operations_metrics', 'get_admin_live_trading_data');
    await Promise.all([loadAdminGateConnections(), loadAdminMembers()]);
  });
}

async function setUserApproval(button) {
  if (!button || currentProfile?.role !== 'ADMIN' || button.disabled) return;
  const approve = button.dataset.approval === 'APPROVED';
  const name = button.dataset.memberName || '신청자';
  if (!approve && !window.confirm(`${name}님의 가입 신청을 거절할까요? 거절된 계정은 서비스를 이용할 수 없습니다.`)) return;
  // Disable both buttons of the row so approve and reject cannot race each other.
  const rowButtons = [...(button.closest('tr')?.querySelectorAll('[data-approval]') || [button])];
  rowButtons.forEach((item) => { item.disabled = true; });
  const { error } = await supabase.rpc('set_user_approval', {
    target_user_id: button.dataset.userId,
    new_status: button.dataset.approval,
  });
  if (error) {
    rowButtons.forEach((item) => { item.disabled = false; });
    return window.toast('승인 상태 변경에 실패했습니다.', { kind: 'error' });
  }
  window.toast(approve ? '회원 가입을 승인했습니다.' : '회원 가입을 거절했습니다.', { kind: 'success' });
  await loadAdminMembers();
}

async function retryLoad(target) {
  if (target === 'member-live') await loadMemberLiveData();
  if (target === 'member-performance') await Promise.all([loadMemberDashboardPerformance(memberDashboardRange), loadMemberCumulativePerformance()]);
  if (target === 'admin-live') {
    invalidateSharedRpc('get_admin_live_trading_data');
    await loadAdminLiveData();
  }
  if (target === 'admin-members') await loadAdminMembers();
  if (target === 'member-analysis') await loadTradingAnalysis();
}

document.addEventListener('click', async (event) => {
  if (event.target.id === 'pauseModal') window.closePause();
  if (event.target.closest('[data-pause-close]')) window.closePause();
  if (event.target.closest('[data-open-pause]')) window.openPause();
  if (event.target.closest('.top .mobile')) byId('side')?.classList.toggle('open');
  const authTabButton = event.target.closest('[data-auth-tab]');
  if (authTabButton) window.authTab(authTabButton.dataset.authTab);
  if (event.target.closest('[data-logout]')) await window.logout();
  if (event.target.id === 'legalModal' || event.target.closest('[data-legal-close]')) closeLegal();
  const legalOpen = event.target.closest('[data-legal-open]');
  if (legalOpen) openLegal(legalOpen.dataset.legalOpen);
  const legalTab = event.target.closest('[data-legal-tab]');
  if (legalTab) setLegalTab(legalTab.dataset.legalTab);
  if (event.target.id === 'memberDetailModal' || event.target.closest('[data-member-detail-close]')) closeMemberDetail();
  const navButton = event.target.closest('.nav-btn[data-page]');
  if (navButton) window.openPage(navButton.dataset.page);
  const memberDetailTab = event.target.closest('[data-member-detail-tab]');
  if (memberDetailTab) setMemberDetailTab(memberDetailTab.dataset.memberDetailTab);
  const retryButton = event.target.closest('[data-retry]');
  if (retryButton) {
    retryButton.disabled = true;
    await retryLoad(retryButton.dataset.retry);
    if (document.contains(retryButton)) retryButton.disabled = false;
  }
  const adminLogTab = event.target.closest('[data-admin-log-tab]');
  if (adminLogTab) {
    setAdminLogTab(adminLogTab.dataset.adminLogTab);
    if (adminLogTab.dataset.adminLogTab === 'executions') await loadAdminExecutionStatus();
  }
  // "카피 중지 + 포지션 정리" is irreversible: the first click only opens an in-modal confirmation.
  const pauseButton = event.target.closest('[data-copy-pause]');
  if (pauseButton && !copyPauseBusy) {
    if (pauseButton.dataset.copyPause === 'CLOSE') setPauseCloseConfirm(true);
    else await setCopyPause(pauseButton.dataset.copyPause);
  }
  if (event.target.closest('[data-copy-pause-cancel]') && !copyPauseBusy) {
    setPauseCloseConfirm(false);
    byId('pauseModal')?.querySelector('[data-copy-pause="CLOSE"]')?.focus();
  }
  const pauseConfirm = event.target.closest('[data-copy-pause-confirm]');
  if (pauseConfirm) await setCopyPause(pauseConfirm.dataset.copyPauseConfirm);
  if (event.target.closest('#adminEmergencyHalt')) await emergencyHalt();
  if (event.target.closest('#gateApiDisconnect')) await disconnectMemberGateApi();
  if (event.target.closest('#adminGateApiDisconnect')) await disconnectAdminMasterGateApi();
  if (event.target.closest('#adminAuditRefresh')) await loadAdminAuditLog();
  if (event.target.closest('#adminExecutionRefresh')) await loadAdminExecutionStatus();
  if (event.target.closest('#memberPasswordResetButton')) await issueMemberTemporaryPassword();
  if (event.target.closest('#memberTempPasswordCopy')) await copyMemberTempPassword();
  if (event.target.closest('#copySettingsSave')) await saveCopySettings();
  const adminRange = event.target.closest('[data-admin-range]');
  if (adminRange) {
    document.querySelectorAll('[data-admin-range]').forEach((button) => {
      button.classList.toggle('active', button === adminRange);
      button.setAttribute('aria-pressed', String(button === adminRange));
    });
    if (adminRange.dataset.adminRange === 'custom') {
      byId('adminDateRangeForm')?.classList.remove('hidden');
    } else {
      adminOperationsRange = /^\d+$/.test(adminRange.dataset.adminRange) ? Number(adminRange.dataset.adminRange) : adminRange.dataset.adminRange;
      byId('adminDateRangeForm')?.classList.add('hidden');
      await loadAdminOperationsMetrics();
    }
  }
  const dashboardRange = event.target.closest('[data-dashboard-range]');
  if (dashboardRange) {
    memberDashboardRange = Number(dashboardRange.dataset.dashboardRange);
    document.querySelectorAll('[data-dashboard-range]').forEach((button) => {
      button.classList.toggle('active', button === dashboardRange);
      button.setAttribute('aria-pressed', String(button === dashboardRange));
    });
    await loadMemberDashboardPerformance(memberDashboardRange);
  }
  const dashboardMetric = event.target.closest('[data-dashboard-metric]');
  if (dashboardMetric) {
    memberDashboardMetric = dashboardMetric.dataset.dashboardMetric;
    document.querySelectorAll('[data-dashboard-metric]').forEach((button) => button.classList.toggle('active', button === dashboardMetric));
    renderMemberPerformance();
  }
  const analysisMember = event.target.closest('[data-analysis-member]');
  if (analysisMember) await loadAdminMemberTradingAnalysis(analysisMember.dataset.analysisMember);
  const analysisRange = event.target.closest('[data-analysis-range]');
  if (analysisRange) {
    setAdminAnalysisDateRange(analysisRange.dataset.analysisRange);
    if (adminAnalysisSelectedUserId) await loadAdminMemberTradingAnalysis(adminAnalysisSelectedUserId, true);
  }
  const masterFilter = event.target.closest('[data-master-filter]');
  if (masterFilter) window.setAdminMasterFilter(masterFilter.dataset.masterFilter, masterFilter);
  const disconnectMemberButton = event.target.closest('[data-admin-disconnect-member]');
  if (disconnectMemberButton) await disconnectAdminMemberGateApi(disconnectMemberButton.dataset.adminDisconnectMember, disconnectMemberButton.dataset.memberName, disconnectMemberButton);
  const memberDetailButton = event.target.closest('[data-member-detail]');
  if (memberDetailButton) await openMemberDetail(memberDetailButton.dataset.memberDetail);
  if (event.target.closest('[data-member-weight-save]')) await saveAdminMemberWeights();
  if (event.target.closest('[data-member-withdraw]')) await withdrawAdminMember();
  const memberTabButton = event.target.closest('[data-member-tab]');
  if (memberTabButton) setAdminMemberTab(memberTabButton.dataset.memberTab);
  const restoreButton = event.target.closest('[data-member-restore]');
  if (restoreButton) await restoreAdminMember(restoreButton.dataset.memberRestore, restoreButton.dataset.memberName, restoreButton);
  const memberControlButton = event.target.closest('[data-member-control]');
  if (memberControlButton) await setAdminMemberControl(memberControlButton.dataset.memberControl);
  if (event.target.closest('[data-new-operation-open]') && selectedMemberId && currentProfile?.role === 'ADMIN' && !adminControlBusy && !adminWeightBusy) {
    newOperationPanel ||= createNewOperationPanel({ root: byId('memberNewOperation'),
      rpc: (name, params) => supabase.rpc(name, params), onRequested: () => loadAdminMembers() });
    // Never restart the panel (new request ID) while a submission is still in flight.
    if (newOperationPanel.isBusy()) return window.toast('새 운용 요청을 처리하고 있습니다. 잠시 후 다시 확인해 주세요.');
    await newOperationPanel.open(selectedMemberId);
  }
  const approvalButton = event.target.closest('[data-approval]');
  if (approvalButton) await setUserApproval(approvalButton);
});

document.addEventListener('change', (event) => {
  if (event.target.id === 'analysisMonthSelect' && memberTradingAnalysisData) renderTradingAnalysis(memberTradingAnalysisData);
  if (event.target.id === 'adminPositionOwner') {
    adminPositionOwner = event.target.value || 'MASTER';
    renderAdminMasterPositions();
  }
});

document.addEventListener('input', (event) => {
  if (event.target.matches('#copyRatioSelect, #maxPositionRatioSelect, #dailyLossLimitInput, #maxDrawdownInput, #maxLeverageInput')) {
    refreshCopySettingPreview();
  }
  if (event.target.id === 'adminMemberSearch') {
    adminMemberSearch = event.target.value;
    renderAdminMemberRows();
  }
  // Mark edited Gate UID fields so the status polling leaves them alone.
  if (event.target.matches('#gateUid, #adminGateUid')) event.target.dataset.dirty = 'true';
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Tab') trapModalFocus(event);
  if (event.key === 'Escape' && byId('passwordRecoveryModal')?.classList.contains('open')) closeModal(byId('passwordRecoveryModal'));
  if (event.key === 'Escape' && byId('pauseModal')?.classList.contains('open')) window.closePause();
  if (event.key === 'Escape' && byId('memberDetailModal')?.classList.contains('open')) closeMemberDetail();
  if (event.key === 'Escape' && byId('legalModal')?.classList.contains('open')) closeLegal();
});

document.addEventListener('submit', async (event) => {
  if (event.target.id === 'loginForm') {
    event.preventDefault();
    await window.login();
  }
  if (event.target.id === 'signupForm') {
    event.preventDefault();
    await window.signup();
  }
  if (event.target.id === 'recoveryPasswordForm') {
    event.preventDefault();
    await completePasswordRecovery();
  }
  if (event.target.id === 'adminExecutionFilters') {
    event.preventDefault();
    await loadAdminExecutionStatus();
  }
  if (event.target.id === 'adminDateRangeForm') {
    event.preventDefault();
    const startDate = byId('adminDateFrom').value;
    const endDate = byId('adminDateTo').value;
    if (!startDate || !endDate || startDate > endDate) return window.toast('날짜 범위를 확인해 주세요.');
    await loadAdminOperationsMetrics(startDate, endDate);
  }
  if (event.target.id === 'adminAnalysisDateForm') {
    event.preventDefault();
    document.querySelectorAll('[data-analysis-range]').forEach((button) => button.classList.remove('active'));
    await loadAdminMemberTradingAnalysis(adminAnalysisSelectedUserId, true);
  }
  if (event.target.id === 'gateApiForm') {
    event.preventDefault();
    await saveGateApiCredentials();
  }
  if (event.target.id === 'adminGateApiForm') {
    event.preventDefault();
    await saveAdminGateApiCredentials();
  }
  if (event.target.id === 'passwordChangeForm') {
    event.preventDefault();
    await changeMyPassword();
  }
  if (event.target.id === 'nicknameForm') {
    event.preventDefault();
    await saveMyNickname();
  }
  if (event.target.id === 'memberDateRangeForm') {
    event.preventDefault();
    const startDate = byId('memberDateFrom').value;
    const endDate = byId('memberDateTo').value;
    if (!startDate || !endDate || startDate > endDate) return window.toast('날짜 범위를 확인해 주세요.');
    document.querySelectorAll('[data-dashboard-range]').forEach((button) => button.classList.remove('active'));
    await loadMemberDashboardPerformanceRange(startDate, endDate);
  }
});

async function boot() {
  extendCopySettingOptions();
  enhanceNavigationAndHeader();
  enhanceGateApiForm();
  enhancePauseModal();
  enhanceOperationsStatusUi();
  enhanceLiveDataUi();
  enhanceCopySettingsUi();
  enhanceAdminApiPage();
  enhanceAdminMembersPage();
  enhanceMemberDetailModal();
  enhancePasswordRecoveryModal();
  enhanceLegalUi();
  enhanceMemberAnalysisPage();
  enhanceAdminMemberAnalysisPage();
  if (!configured) {
    showAuth('login');
    setAuthMessage('Supabase 환경변수를 설정하면 실제 회원가입과 로그인이 활성화됩니다.', 'warn-box');
    return;
  }
  supabase.auth.onAuthStateChange((event, session) => {
    if (event === 'SIGNED_OUT') showAuth('login');
    // A token refresh must not navigate or refill forms; only refresh the profile quietly.
    if (event === 'TOKEN_REFRESHED' && session) refreshProfileSilently(session);
    if (event === 'PASSWORD_RECOVERY' && session) {
      passwordRecoveryMode = true;
      window.setTimeout(async () => {
        await routeSession(session);
        if (currentProfile?.role === 'MEMBER') {
          openPage('member-account');
          byId('currentPasswordField')?.classList.add('hidden');
          byId('passwordRecoveryNotice')?.classList.remove('hidden');
          byId('newPassword')?.focus();
        }
        // Administrators have no member account page: use the dedicated recovery dialog.
        if (currentProfile?.role === 'ADMIN') openModal(byId('passwordRecoveryModal'), { focus: '#recoveryNewPassword' });
      }, 0);
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && currentProfile) loadCopySystemStatus();
  });
  const { data } = await supabase.auth.getSession();
  await routeSession(data.session);
}

boot();
