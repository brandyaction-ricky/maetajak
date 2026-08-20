import { createClient } from '@supabase/supabase-js';
import { getAccessDecision } from './access.js';
import './theme.css';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
const configured = Boolean(supabaseUrl && supabaseAnonKey);
const supabase = configured
  ? createClient(supabaseUrl, supabaseAnonKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    })
  : null;

const pages = {
  'member-dashboard': ['대시보드', '카피 상태와 계정 현황을 확인합니다.'],
  'member-positions': ['현재 포지션', '실제 포지션과 Master Target을 비교합니다.'],
  'member-trades': ['거래 내역', '카피 주문과 체결 기록을 확인합니다.'],
  'member-copy': ['카피트레이딩 설정', '카피 비율과 리스크 한도를 관리합니다.'],
  'member-account': ['계정 설정', 'API 연결·보안·알림·계정을 관리합니다.'],
  'admin-dashboard': ['대시보드', 'Master와 전체 회원의 운영 상태를 확인합니다.'],
  'admin-master': ['Master 계정', 'Master 포지션 상태를 확인합니다.'],
  'admin-members': ['회원 관리', '가입 승인과 회원 리스트를 관리합니다.'],
  'admin-api': ['API 연결 현황', '회원별 Gate.io API 상태를 확인합니다.'],
  'admin-monitor': ['주문·포지션 모니터', '주문과 동기화 문제를 함께 확인합니다.'],
  'admin-events': ['Copy Events', 'Master 변경이 회원에게 미친 영향을 확인합니다.'],
  'admin-risk': ['Risk / Emergency', '전체 Trading Control을 관리합니다.'],
  'admin-audit': ['Audit Log', '관리자와 시스템 작업 이력을 확인합니다.'],
  'admin-settings': ['시스템 설정', '환경 및 기본값을 관리합니다.'],
};

const byId = (id) => document.getElementById(id);
let currentProfile = null;
let authBusy = false;
let gateApiBusy = false;

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
  if (!connectionCard || !securityCard) return;

  connectionCard.innerHTML = `
    <div class="section-head"><h3>Gate.io API 연결</h3><span id="gateConnectionStatus" class="chip yellow">미연결</span></div>
    <form id="gateApiForm" class="form" autocomplete="off">
      <div class="field"><label for="gateUid">Gate.io UID</label><input id="gateUid" inputmode="numeric" autocomplete="off" placeholder="Gate.io UID 입력" required></div>
      <div class="field"><label for="gateApiKey">API Key</label><input id="gateApiKey" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="API Key 입력" required></div>
      <div class="field"><label for="gateSecretKey">Secret Key</label><input id="gateSecretKey" type="password" autocomplete="new-password" autocapitalize="off" spellcheck="false" placeholder="Secret Key 입력" required></div>
      <label class="permission-check"><input id="gatePermissionConfirmed" type="checkbox" required><span>Trading Account · Perpetual Futures Read/Write만 허용하고 출금 권한은 사용하지 않았습니다.</span></label>
      <button id="gateApiConnect" class="btn primary" type="submit">API 연결 요청</button>
    </form>
    <details class="api-guide"><summary>Gate.io API 발급 설정 확인</summary><ol><li>Trading Account를 선택합니다.</li><li>Perpetual Futures의 Read and Write만 허용합니다.</li><li>출금 권한은 절대 활성화하지 않습니다.</li><li>Trading Worker 고정 IP를 Whitelist에 등록합니다.</li></ol></details>
    <p class="secret-warning">Secret Key는 화면이나 브라우저 저장소에 보관하지 않고 서버에서 암호화해 저장합니다.</p>
  `;

  securityCard.innerHTML = `
    <div class="section-head"><h3>API 보안 체크</h3></div>
    <div class="metric"><span>Futures Read</span><b id="gateFuturesRead" class="warn">확인 대기</b></div>
    <div class="metric"><span>Futures Trade</span><b id="gateFuturesTrade" class="warn">확인 대기</b></div>
    <div class="metric"><span>IP Whitelist</span><b id="gateIpWhitelist" class="warn">Worker 연결 필요</b></div>
    <div class="metric"><span>Withdrawal</span><b id="gateWithdrawal" class="pos">사용 금지</b></div>
  `;
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

function showAuth(view = 'login') {
  byId('app').classList.add('hidden');
  byId('auth').classList.remove('hidden');
  ['login', 'signup', 'pending'].forEach((id) => byId(id).classList.toggle('hidden', id !== view));
  byId('loginTab').classList.toggle('active', view === 'login');
  byId('signupTab').classList.toggle('active', view === 'signup');
}

function showApp(profile) {
  currentProfile = profile;
  const { role } = getAccessDecision(profile);
  byId('auth').classList.add('hidden');
  byId('app').classList.remove('hidden');
  byId('memberNav').classList.toggle('hidden', role !== 'member');
  byId('adminNav').classList.toggle('hidden', role !== 'admin');
  byId('accountName').value = profile.full_name || '';
  byId('accountEmail').value = profile.email || '';
  if (byId('copyRatioSelect')) byId('copyRatioSelect').value = `${Number(profile.copy_ratio ?? 100)}%`;
  if (byId('maxPositionRatioSelect')) byId('maxPositionRatioSelect').value = `${Number(profile.max_position_ratio ?? 30)}%`;
  openPage(role === 'admin' ? 'admin-dashboard' : 'member-dashboard');
  if (role === 'admin') loadAdminMembers();
  if (role === 'member') loadGateConnection();
}

async function loadProfile(userId) {
  const { data, error } = await supabase.from('profiles').select('*').eq('id', userId).single();
  if (error) throw error;
  return data;
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

window.signup = () => withAuthBusy(async () => {
  setAuthMessage();
  if (!configured) return setAuthMessage('Supabase 환경변수가 설정되지 않았습니다.');
  const fullName = byId('signupName').value.trim();
  const phone = byId('signupPhone').value.trim();
  const email = byId('signupEmail').value.trim();
  const password = byId('signupPassword').value;
  const passwordConfirm = byId('signupPasswordConfirm').value;
  const terms = byId('signupTerms').checked;
  if (!fullName || !phone || !email || password.length < 8) return setAuthMessage('이름, 휴대폰, 이메일과 8자 이상 비밀번호를 입력해 주세요.');
  if (password !== passwordConfirm) return setAuthMessage('비밀번호와 비밀번호 확인이 일치하지 않습니다.');
  if (!terms) return setAuthMessage('서비스 이용약관과 개인정보 처리방침에 동의해 주세요.');
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: { data: { full_name: fullName, phone, terms_accepted_at: new Date().toISOString() } },
  });
  if (error) return setAuthMessage(error.message);
  setPendingMessage('승인 대기', data.session
    ? '관리자가 가입 정보를 확인한 뒤 승인합니다.'
    : '이메일 인증 후 관리자 승인이 완료되어야 이용할 수 있습니다.');
  showAuth('pending');
});

window.login = () => withAuthBusy(async () => {
  setAuthMessage();
  if (!configured) return setAuthMessage('Supabase 환경변수가 설정되지 않았습니다.');
  const email = byId('loginEmail').value.trim();
  const password = byId('loginPassword').value;
  if (!email || !password) return setAuthMessage('이메일과 비밀번호를 입력해 주세요.');
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return setAuthMessage('이메일 또는 비밀번호를 확인해 주세요.');
  await routeSession(data.session);
});

window.logout = () => withAuthBusy(async () => {
  if (supabase) await supabase.auth.signOut();
  currentProfile = null;
  showAuth('login');
});

window.openPage = (id) => {
  if (!pages[id]) return;
  document.querySelectorAll('.page').forEach((page) => page.classList.remove('active'));
  byId(id).classList.add('active');
  document.querySelectorAll('.nav-btn').forEach((button) => button.classList.toggle('active', button.dataset.page === id));
  byId('title').textContent = pages[id][0];
  byId('subtitle').textContent = pages[id][1];
  byId('side').classList.remove('open');
  window.scrollTo(0, 0);
  if (id === 'admin-members' && currentProfile?.role === 'ADMIN') loadAdminMembers();
};

window.openPause = () => byId('pauseModal').classList.add('open');
window.closePause = () => byId('pauseModal').classList.remove('open');
window.preview = () => byId('previewModal').classList.add('open');
window.monitorTab = (id, button) => {
  document.querySelectorAll('.subpage').forEach((page) => page.classList.remove('active'));
  byId(id).classList.add('active');
  document.querySelectorAll('.tabs2 .btn').forEach((item) => item.classList.remove('primary'));
  button.classList.add('primary');
};
window.toast = (message) => {
  const element = byId('toast');
  element.textContent = message;
  element.style.opacity = 1;
  window.setTimeout(() => { element.style.opacity = 0; }, 1800);
};

function renderGateConnection(connection) {
  const status = byId('gateConnectionStatus');
  if (!status) return;
  if (!connection) {
    status.textContent = '미연결';
    status.className = 'chip yellow';
    return;
  }
  byId('gateUid').value = connection.gate_uid || '';
  byId('gateApiKey').placeholder = connection.api_key_last4 ? `저장됨 ····${connection.api_key_last4}` : 'API Key 입력';
  const verified = connection.status === 'VERIFIED';
  status.textContent = verified ? '연결됨' : '검증 대기';
  status.className = verified ? 'chip' : 'chip yellow';
  byId('gateFuturesRead').textContent = verified && connection.futures_read ? 'PASS' : '확인 대기';
  byId('gateFuturesRead').className = verified && connection.futures_read ? 'pos' : 'warn';
  byId('gateFuturesTrade').textContent = verified && connection.futures_trade ? 'PASS' : '확인 대기';
  byId('gateFuturesTrade').className = verified && connection.futures_trade ? 'pos' : 'warn';
  byId('gateIpWhitelist').textContent = connection.ip_whitelisted ? 'ENABLED' : 'Worker 연결 필요';
  byId('gateIpWhitelist').className = connection.ip_whitelisted ? 'pos' : 'warn';
  byId('gateWithdrawal').textContent = connection.withdrawal_disabled ? 'DISABLED' : '차단 필요';
  byId('gateWithdrawal').className = connection.withdrawal_disabled ? 'pos' : 'neg';
}

async function loadGateConnection() {
  if (!supabase || currentProfile?.role !== 'MEMBER') return;
  const { data, error } = await supabase.rpc('get_my_gate_api_connection');
  if (error) return window.toast('API 연결 상태를 불러오지 못했습니다.');
  renderGateConnection(data);
}

async function saveGateApiCredentials() {
  if (!supabase || !currentProfile || gateApiBusy) return;
  const gateUid = byId('gateUid').value.trim();
  const apiKey = byId('gateApiKey').value.trim();
  const secretKey = byId('gateSecretKey').value.trim();
  const permissionConfirmed = byId('gatePermissionConfirmed').checked;
  if (!gateUid || apiKey.length < 16 || secretKey.length < 16) return window.toast('UID와 API Key, Secret Key를 정확히 입력해 주세요.');
  if (!permissionConfirmed) return window.toast('선물 권한과 출금 권한 설정을 확인해 주세요.');
  gateApiBusy = true;
  const button = byId('gateApiConnect');
  button.disabled = true;
  button.textContent = '암호화 저장 중...';
  const { data, error } = await supabase.rpc('save_gate_api_credentials', {
    p_gate_uid: gateUid,
    p_api_key: apiKey,
    p_secret_key: secretKey,
    p_permission_confirmed: permissionConfirmed,
  });
  byId('gateApiKey').value = '';
  byId('gateSecretKey').value = '';
  button.disabled = false;
  button.textContent = 'API 연결 요청';
  gateApiBusy = false;
  if (error) return window.toast('API 정보를 저장하지 못했습니다. 입력값을 확인해 주세요.');
  renderGateConnection(data);
  window.toast('API 정보를 암호화해 저장했습니다. Worker 검증을 진행합니다.');
}

async function saveCopySettings() {
  if (!supabase || !currentProfile) return;
  const copyRatio = Number(byId('copyRatioSelect').value.replace('%', ''));
  const maxPositionRatio = Number(byId('maxPositionRatioSelect').value.replace('%', ''));
  const saveButton = byId('copySettingsSave');
  saveButton.disabled = true;
  const { data, error } = await supabase.rpc('update_my_copy_settings', {
    new_copy_ratio: copyRatio,
    new_max_position_ratio: maxPositionRatio,
  });
  saveButton.disabled = false;
  if (error) return window.toast('카피 설정 저장에 실패했습니다.');
  currentProfile = data;
  window.toast('카피 설정을 저장했습니다.');
}

function escapeHtml(value = '') {
  return String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
}

async function loadAdminMembers() {
  if (!supabase || currentProfile?.role !== 'ADMIN') return;
  const { data, error } = await supabase.from('profiles').select('id,email,full_name,phone,approval_status,role,copy_ratio,max_position_ratio,created_at').order('created_at', { ascending: false });
  if (error) return window.toast('회원 목록을 불러오지 못했습니다.');
  const pending = data.filter((profile) => profile.approval_status === 'PENDING');
  byId('pendingCount').textContent = `${pending.length} PENDING`;
  byId('pendingMembers').innerHTML = pending.length ? pending.map((profile) => `
    <tr><td>${escapeHtml(profile.full_name || '-')}</td><td>${escapeHtml(profile.email || '-')}</td><td>${escapeHtml(profile.phone || '-')}</td><td>${new Date(profile.created_at).toLocaleString('ko-KR')}</td><td><button class="btn green" data-approval="APPROVED" data-user-id="${profile.id}">승인</button> <button class="btn red" data-approval="REJECTED" data-user-id="${profile.id}">거절</button></td></tr>
  `).join('') : '<tr><td colspan="5" class="empty-cell">승인 대기 회원이 없습니다.</td></tr>';
  const members = data.filter((profile) => profile.approval_status !== 'PENDING');
  byId('memberList').innerHTML = members.length ? members.map((profile) => `
    <div class="member"><div><b>${escapeHtml(profile.full_name || '-')}</b><small>${escapeHtml(profile.email || '-')}</small></div><div><small>권한</small><b>${escapeHtml(profile.role)}</b></div><div><small>승인</small><b class="${profile.approval_status === 'APPROVED' ? 'pos' : 'warn'}">${escapeHtml(profile.approval_status)}</b></div><div><small>Copy Ratio</small><b>${Number(profile.copy_ratio ?? 100)}%</b></div><div><small>최대 포지션 비중</small><b>${Number(profile.max_position_ratio ?? 30)}%</b></div><div><small>가입일</small><b>${new Date(profile.created_at).toLocaleDateString('ko-KR')}</b></div><button class="btn" disabled>상세</button></div>
  `).join('') : '<div class="notice">표시할 회원이 없습니다.</div>';
}

document.addEventListener('click', async (event) => {
  const navButton = event.target.closest('.nav-btn[data-page]');
  if (navButton) window.openPage(navButton.dataset.page);
  if (event.target.closest('#copySettingsSave')) await saveCopySettings();
  const approvalButton = event.target.closest('[data-approval]');
  if (!approvalButton || currentProfile?.role !== 'ADMIN') return;
  approvalButton.disabled = true;
  const { error } = await supabase.rpc('set_user_approval', {
    target_user_id: approvalButton.dataset.userId,
    new_status: approvalButton.dataset.approval,
  });
  if (error) window.toast('승인 상태 변경에 실패했습니다.');
  else {
    window.toast(approvalButton.dataset.approval === 'APPROVED' ? '회원 가입을 승인했습니다.' : '회원 가입을 거절했습니다.');
    await loadAdminMembers();
  }
});

document.addEventListener('submit', async (event) => {
  if (event.target.id !== 'gateApiForm') return;
  event.preventDefault();
  await saveGateApiCredentials();
});

async function boot() {
  extendCopySettingOptions();
  enhanceGateApiForm();
  if (!configured) {
    showAuth('login');
    setAuthMessage('Supabase 환경변수를 설정하면 실제 회원가입과 로그인이 활성화됩니다.', 'warn-box');
    return;
  }
  const { data } = await supabase.auth.getSession();
  await routeSession(data.session);
  supabase.auth.onAuthStateChange((event, session) => {
    if (event === 'SIGNED_OUT') showAuth('login');
    if (event === 'TOKEN_REFRESHED' && session) routeSession(session);
  });
}

boot();
