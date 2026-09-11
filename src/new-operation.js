const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (value) => `${Number(value || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDT`;
const errors = {
  ADMIN_REQUIRED: '승인된 관리자만 새 운용을 시작할 수 있습니다.',
  MEMBER_NOT_ELIGIBLE: '승인된 회원의 중지 상태 계좌에서만 시작할 수 있습니다.',
  ACCOUNT_NOT_UNIQUE: '활성 회원 계좌를 하나로 확인할 수 없습니다.',
  ACCOUNT_NOT_VERIFIED: 'API 연결 또는 계좌 검증이 완료되지 않았습니다.',
  ACCOUNT_SNAPSHOT_STALE: '최신 계좌 확인이 필요합니다. 잠시 후 다시 조회해 주세요.',
  OPEN_POSITIONS: '보유 포지션이 있습니다. 포지션이 없는 계좌에서 새 운용을 시작할 수 있습니다.',
  UNRESOLVED_ORDERS: '결과가 확인되지 않은 주문이 남아 있습니다.',
  NEW_OPERATION_PENDING: '이미 새 운용 시작을 확인 중입니다. 중복 요청하지 않아도 됩니다.',
  INVALID_EQUITY: '현재 자산이 0이거나 확인되지 않았습니다.',
  PREVIEW_CHANGED: '조회 이후 자산이나 설정이 변경됐습니다. 다시 확인해 주세요.',
  CONFIRMATION_REQUIRED: '새 위험 기준 적용에 동의해 주세요.',
  REASON_REQUIRED: '새 운용을 시작하는 사유를 입력해 주세요.',
  REQUEST_ID_REUSED: '이미 다른 작업에 사용된 요청입니다. 다시 조회해 주세요.',
};
export function newOperationError(error) {
  const message = String(error?.message || error || '');
  return Object.entries(errors).find(([code]) => message.includes(code))?.[1]
    || '요청 결과를 확인하지 못했습니다. 같은 요청으로 다시 시도해 주세요.';
}

export function createNewOperationPanel({ root, rpc, onRequested }) {
  let generation = 0; let userId = null; let preview = null; let requestId = null; let busy = false;
  function clear() {
    generation++; userId = null; preview = null; requestId = null; busy = false;
    root.hidden = true; root.innerHTML = '';
  }
  async function open(id) {
    const ticket = ++generation;
    userId = id; preview = null; requestId = null; busy = false;
    root.hidden = false;
    root.innerHTML = '<p role="status">현재 자산과 새 운용 조건을 확인하고 있습니다.</p>';
    let result;
    try { result = await rpc('get_member_new_operation_preview', { p_user_id: id }); }
    catch (error) { result = { error }; }
    if (ticket !== generation) return;
    if (result.error) {
      root.innerHTML = `<p role="alert">${escape(newOperationError(result.error))}</p><button type="button" class="btn" data-new-operation-refresh>다시 조회</button>`;
      return;
    }
    preview = result.data; requestId = crypto.randomUUID();
    const reasons = preview.blockers || [];
    root.innerHTML = `<form class="new-operation-form">
      <div class="new-operation-heading"><h4>새 운용 시작</h4><button class="btn" type="button" data-new-operation-close>닫기</button></div>
      <p><strong>${escape(preview.member_name)}</strong> · ${escape(preview.member_email)}</p>
      <dl class="new-operation-values">
        <div><dt>새 시작 자산</dt><dd>${escape(money(preview.equity))}</dd></div>
        <div><dt>이전 위험 기준 최고 자산</dt><dd>${escape(money(preview.previous_peak_equity))}</dd></div>
        <div><dt>일일 손실 한도</dt><dd>${escape(preview.settings?.daily_loss_limit_pct)}%</dd></div>
        <div><dt>최대 낙폭 한도</dt><dd>${escape(preview.settings?.max_drawdown_pct)}%</dd></div>
        <div><dt>카피 비율</dt><dd>${escape(preview.settings?.copy_ratio)}%</dd></div>
        <div><dt>최대 포지션 비중</dt><dd>${escape(preview.settings?.max_position_ratio)}%</dd></div>
      </dl>
      <p>과거 거래·손익은 그대로 보관합니다. 이번 운용의 일일 손실과 최대 낙폭은 새 시작 자산부터 계산합니다.</p>
      <p>확인 후 거래소 미체결·포지션 검증을 통과하면, 마스터의 현재 전체 포지션을 새 시작 자산 비율과 카피 비율로 계산해 카피 주문을 시작합니다.</p>
      ${reasons.length ? `<p role="alert">${reasons.map((r) => escape(newOperationError(r))).join('<br>')}</p>` : ''}
      <label class="new-operation-field">시작 사유<textarea name="reason" rows="2" maxlength="200" required placeholder="예: 카피 중단 후 재입금, 새 운용 시작"></textarea></label>
      <label class="new-operation-consent"><input type="checkbox" name="confirmed" required>위 자산을 새 위험 기준으로 적용하고 카피 재개를 요청합니다.</label>
      <p class="new-operation-message" role="status" aria-live="polite"></p>
      <div class="actions"><button type="button" class="btn" data-new-operation-refresh>현재 자산 다시 확인</button><button type="submit" class="btn green" ${!preview.eligible ? 'disabled' : ''}>새 기준으로 재개 요청</button></div>
    </form>`;
  }
  root.addEventListener('click', (event) => {
    if (busy) return;
    if (event.target.closest('[data-new-operation-close]')) clear();
    if (event.target.closest('[data-new-operation-refresh]') && userId) void open(userId);
  });
  root.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (busy || !preview?.eligible || !userId) return;
    const form = event.target;
    if (!form.reportValidity()) return;
    const reason = form.elements.reason.value.trim();
    const consent = form.elements.confirmed.checked;
    const message = root.querySelector('.new-operation-message');
    if (!reason || !consent) { message.textContent = newOperationError(!reason ? 'REASON_REQUIRED' : 'CONFIRMATION_REQUIRED'); return; }
    const ticket = generation;
    const requestedUser = userId;
    busy = true;
    const controls = [...form.querySelectorAll('button,input,textarea')];
    controls.forEach((control) => { control.disabled = true; });
    message.textContent = '새 운용 기준을 기록하고 재개 확인을 요청하고 있습니다.';
    let result;
    try {
      result = await rpc('start_member_new_operation', { p_user_id: requestedUser,
        p_request_id: requestId, p_expected_equity: preview.equity,
        p_expected_observed_at: preview.observed_at, p_expected_fingerprint: preview.fingerprint,
        p_confirmation: `NEW_OPERATION:${preview.member_email}`, p_reason: reason });
    } catch (error) { result = { error }; }
    if (ticket !== generation) return;
    busy = false;
    if (result.error) {
      message.textContent = newOperationError(result.error);
      controls.forEach((control) => { control.disabled = false; });
      // Keep the same request ID after uncertain replies; the server returns
      // the original receipt instead of resetting the risk basis twice.
      return;
    }
    root.innerHTML = '<p role="status">새 운용 기준을 기록했습니다. 거래소 검증 후 카피가 활성화됩니다. 회원 상태에서 결과를 확인해 주세요.</p>';
    preview = null;
    await onRequested?.(requestedUser, result.data);
  });
  return { open, clear };
}
