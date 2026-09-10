import { GateApiError, summarizeGateOrder } from './gate.js';

export function positionSide(position) {
  return position.positionSide || position.position_side || (Number(position.size) < 0 ? 'SHORT' : 'LONG');
}

export function assertFreshAccount(account, now = Date.now()) {
  const start = Date.parse(account?.observed_started_at);
  const end = Date.parse(account?.observed_at);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start
    || now - start > 15000 || end > now + 1000 || !Array.isArray(account.positions)
    || !Array.isArray(account.open_orders)) {
    throw new GateApiError('최신 계좌 상태를 확인할 수 없습니다.', { code: 'ACCOUNT_SNAPSHOT_STALE' });
  }
}

export function assertOrderIdentity(job, order) {
  if (order?.id == null || order.contract !== job.contract
    || String(order.text) !== String(job.gate_order_text)
    || (job.reduce_only && order.reduce_only !== true)
    || (job.gate_order_id != null && String(order.id) !== String(job.gate_order_id))) {
    throw new GateApiError('거래소 주문 식별자가 일치하지 않습니다.', { code: 'ORDER_IDENTITY_MISMATCH', outcomeUnknown: true });
  }
  const summary = summarizeGateOrder(order);
  if (!Number.isFinite(Number(job.delta_size)) || Number(order.size) !== Number(job.delta_size)
    || Math.abs(summary.filledSize) > Math.abs(Number(job.delta_size))) {
    throw new GateApiError('거래소 주문 수량이 일치하지 않습니다.', { code: 'ORDER_QUANTITY_MISMATCH', outcomeUnknown: true });
  }
  return summary;
}

export function assertSubmissionSnapshot(job, account, master) {
  assertFreshAccount(account);
  assertFreshAccount(master);
  if (account.open_orders.length) throw new GateApiError('미체결 주문 확인이 필요합니다.', { code: 'OPEN_EXCHANGE_ORDER' });
  const actual = account.positions.find((position) => position.contract === job.contract && positionSide(position) === job.position_side);
  const masterPosition = master.positions.find((position) => position.contract === job.contract && positionSide(position) === job.position_side);
  if (!Number.isFinite(Number(job.actual_size_at_plan))
    || Number(actual?.size || 0) !== Number(job.actual_size_at_plan)) {
    throw new GateApiError('계획 이후 회원 포지션이 바뀌었습니다.', { code: 'MEMBER_POSITION_CHANGED_BEFORE_SUBMIT' });
  }
  if (!Number.isFinite(Number(job.master_size_at_plan))
    || Number(masterPosition?.size || 0) !== Number(job.master_size_at_plan)) {
    throw new GateApiError('계획 이후 마스터 포지션이 바뀌었습니다.', { code: 'MASTER_POSITION_CHANGED_BEFORE_SUBMIT' });
  }
  const delta = Number(job.delta_size);
  const actualSize = Number(actual?.size || 0);
  const gap = Number(job.target_size) - actualSize;
  if (!Number.isFinite(delta) || delta === 0 || !Number.isFinite(gap)
    || Math.sign(delta) !== Math.sign(gap) || Math.abs(delta) > Math.abs(gap) + 1e-9) {
    throw new GateApiError('주문 변화량이 목표 수량과 다릅니다.', { code: 'ORDER_PLAN_QUANTITY_INVALID' });
  }
  if (job.reduce_only) {
    if (!actualSize || Math.sign(delta) === Math.sign(actualSize) || Math.abs(delta) > Math.abs(actualSize) + 1e-9) {
      throw new GateApiError('청산 수량이 실제 포지션을 초과합니다.', { code: 'REDUCTION_QUANTITY_INVALID' });
    }
    return;
  }
  if (!masterPosition || Number(masterPosition.size) === 0
    || Math.sign(Number(job.delta_size)) !== Math.sign(Number(masterPosition.size))) {
    throw new GateApiError('마스터와 다른 포지션 진입을 차단했습니다.', { code: 'MASTER_POSITION_NOT_FOUND' });
  }
  if (account.positionMode === 'single' && account.positions.some((position) => position.contract === job.contract
    && positionSide(position) !== job.position_side && Number(position.size) !== 0)) {
    throw new GateApiError('반대 방향 포지션 확인이 필요합니다.', { code: 'OPPOSITE_POSITION_EXISTS' });
  }
  if (account.halted || account.reduce_only) {
    throw new GateApiError('회원 위험 한도로 신규 진입을 차단했습니다.', { code: 'MEMBER_RISK_LIMIT' });
  }
  const leverage = Number(job.risk_leverage ?? job.target_leverage);
  const multiplier = Number(job.quanto_multiplier);
  const price = Number(masterPosition.markPrice);
  const fee = Number(job.taker_fee_rate ?? 0.001);
  const slippage = Number(job.slippage_ratio ?? 0.005);
  if (!(leverage >= 1 && leverage <= 100) || !(multiplier > 0) || !(price > 0)
    || !Number.isFinite(fee) || fee < 0 || !Number.isFinite(slippage) || slippage < 0) {
    throw new GateApiError('주문 증거금 조건을 확인할 수 없습니다.', { code: 'ORDER_RISK_METADATA_INVALID' });
  }
  const required = Math.abs(Number(job.delta_size)) * price * multiplier * (1 + slippage) * (1 / leverage + fee);
  if (!(Number(account.available) >= required)) {
    throw new GateApiError('최신 가용 증거금이 부족합니다.', { code: 'INSUFFICIENT_AVAILABLE_MARGIN' });
  }
}

export function exchangeTradeAlert(job, order, trades = []) {
  assertOrderIdentity(job, order);
  const summary = summarizeGateOrder(order, trades);
  if (!summary.terminal || summary.finalStatus !== job.result_status
    || Math.abs(summary.filledSize - Number(job.filled_size)) > 1e-9) {
    throw new GateApiError('거래소 체결 결과와 알림 기록이 다릅니다.', { code: 'ALERT_EXCHANGE_RESULT_MISMATCH' });
  }
  const multiplier = Number(job.quanto_multiplier);
  if (summary.filledSize && (!(summary.averageFillPrice > 0) || !(multiplier > 0))) {
    throw new GateApiError('체결 금액을 계산할 수 없습니다.', { code: 'ALERT_FILL_VALUE_UNVERIFIED' });
  }
  return {
    ...job.details,
    side: Number(job.delta_size) > 0 ? 'BUY' : 'SELL',
    filled_size: Math.abs(summary.filledSize),
    fill_notional_usdt: summary.filledSize ? Math.abs(summary.filledSize) * summary.averageFillPrice * multiplier : 0,
    average_fill_price: summary.averageFillPrice,
    result_status: summary.finalStatus,
    error_code: summary.filledSize ? null : summary.finishAs || job.error_code || 'UNFILLED',
    gate_order_id: summary.gateOrderId,
    evidence: 'GATE_ORDER_QUERY',
  };
}
