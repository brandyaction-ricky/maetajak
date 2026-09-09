function safeAlertText(value, limit = 300) {
  return String(value || '').replace(/[\r\n\t]+/g, ' ').slice(0, limit);
}

const EVENT_MESSAGES = {
  WORKER_ALERT_TEST: { title: '알림 연결 테스트', state: '정상', description: '매타작 텔레그램 알림이 정상적으로 연결되었습니다.', action: '추가 조치는 필요하지 않습니다.' },
  GATE_API_VERIFICATION_FAILED: { title: 'Gate.io API 연결 확인 실패', state: '확인 필요', description: '회원 계정의 API 권한 또는 연결 상태를 확인하지 못했습니다.', action: 'Gate.io API 키, 선물 권한과 고정 IP 설정을 확인해 주세요.' },
  WORKER_CYCLE_FAILED: { title: '카피 동기화 오류', state: '이번 회차 중단', description: '포지션 확인 또는 카피 계산 중 오류가 발생해 이번 회차를 중단했습니다.', action: '다음 회차에서 자동 재시도합니다. 같은 알림이 반복되면 오류 원인을 확인해 주세요.' },
  COPY_SYSTEM_AUTO_HALTED: { title: '카피트레이딩 자동 중단', state: '전체 카피 중단', description: '연속 오류가 감지되어 신규 카피 주문을 자동으로 차단했습니다.', action: '서버와 거래소 연결을 확인한 뒤 운영자가 직접 재개해야 합니다.' },
  WORKER_DATABASE_UNREACHABLE: { title: '데이터베이스 연결 실패', state: '이번 회차 중단', description: '카피 워커가 데이터베이스에 연결되지 않아 주문 처리를 중단했습니다.', action: 'Supabase 연결과 서버 네트워크를 확인해 주세요.' },
  COPY_DUPLICATE_ORDER_AUTO_HALTED: { title: '중복 주문 위험 감지', state: '전체 카피 중단', description: '같은 포지션에 주문이 반복될 가능성을 감지해 신규 주문을 차단했습니다.', action: '해당 종목의 주문 내역과 실제 포지션을 대조한 뒤 재개해 주세요.' },
  COPY_ORDER_QUANTITY_AUTO_HALTED: { title: '주문 수량 불일치 감지', state: '전체 카피 중단', description: '계획한 수량과 거래소가 접수한 수량이 달라 신규 주문을 차단했습니다.', action: '해당 주문과 실제 포지션 수량을 확인한 뒤 재개해 주세요.' },
  MEMBER_COPY_RESUME_WAITING: { title: '회원 카피 재개 대기', state: '해당 회원 대기', description: '안전 확인 조건이 아직 충족되지 않아 회원 카피를 재개하지 않았습니다.', action: '표시된 대기 사유를 확인해 주세요. 조건이 정상화되면 다시 검증합니다.' },
  COPY_POSITION_ENTRY_FILLED: { title: '포지션 진입 체결', state: '체결 완료', description: '회원 계정의 신규 진입 또는 증액 주문이 체결되었습니다.', action: '워커가 실제 포지션 반영을 다시 확인한 뒤 다음 주문을 계산합니다.' },
  OPEN_ORDERS_CANCELLED: { title: '미체결 주문 취소 완료', state: '회원 카피 중단 유지', description: 'Gate.io의 일반 무기한 선물 미체결 주문을 모두 취소하고 0건을 재확인했습니다.', action: '현재 포지션은 유지됩니다. 해당 회원을 다시 안전 검증한 뒤 재개해 주세요.' },
  OPEN_ORDER_CANCEL_FAILED: { title: '미체결 주문 취소 실패', state: '회원 카피 중단 유지', description: 'Gate.io 미체결 주문을 모두 취소했는지 확인하지 못했습니다.', action: '해당 계정은 자동 재개하지 않습니다. 오류와 Gate.io 주문 화면을 확인해 주세요.' },
};

const DETAIL_LABELS = {
  member: '회원', contract: '종목', position_side: '방향', filled_size: '체결 수량', average_fill_price: '평균 체결가',
  target_leverage: '레버리지', margin_mode: '증거금 모드', result_status: '체결 상태', failures: '연속 실패',
  error_code: '오류 원인', reason: '감지 사유', duplicate_count: '중복 주문 수', mode: '실행 모드', action: '현재 처리',
  gate_uid: 'Gate UID', copy_event_id: '추적 ID', intent_id: '주문 추적 ID',
  cancelled_count: '취소 주문 수', remaining_count: '남은 미체결 주문 수',
};

const VALUE_LABELS = {
  LONG: '롱', SHORT: '숏', FILLED: '전체 체결', PARTIALLY_FILLED: '부분 체결',
  cross: '교차', isolated: '격리', DRY_RUN: '모의 실행', LIVE: '실거래',
  GATE_TIMEOUT: 'Gate.io 응답 시간 초과', ORDER_QUANTITY_MISMATCH: '계획 수량과 거래소 주문 수량 불일치',
  RESUME_UNRESOLVED_ORDERS: '확인되지 않은 이전 주문이 남아 있음', RESUME_OPEN_EXCHANGE_ORDERS: '거래소에 미체결 주문이 남아 있음',
  RESUME_SNAPSHOT_STALE: '포지션 조회 시간이 오래됨', RESUME_SNAPSHOT_CHANGED: '재확인 중 포지션 수량이 변경됨',
  OPEN_FUTURES_ORDERS_REMAIN: '취소 후에도 거래소에 미체결 주문이 남아 있음',
};

function koreanTime(value) {
  try { return new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'medium', timeStyle: 'medium' }).format(new Date(value)); }
  catch { return value; }
}

function readableValue(key, value) {
  const text = VALUE_LABELS[value] || value;
  if (key === 'target_leverage' && /^\d+(?:\.\d+)?$/.test(text)) return `${text}배`;
  return text;
}

export function shouldSendFailureAlert(consecutiveFailures) {
  const failures = Number(consecutiveFailures);
  // One warning and one auto-halt notice are enough for a continuous failure.
  // Do not resend the same critical message every ten polling cycles.
  return failures === 1 || failures === 3;
}

function alertPayload({ event, severity, details }) {
  return {
    source: 'maetajak-worker',
    event: safeAlertText(event, 80),
    severity: safeAlertText(severity, 20),
    occurred_at: new Date().toISOString(),
    details: Object.fromEntries(Object.entries(details).slice(0, 10).map(([key, value]) => [safeAlertText(key, 50), safeAlertText(value)])),
  };
}

function telegramMessage(payload) {
  const message = EVENT_MESSAGES[payload.event] || {
    title: '카피트레이딩 운영 알림', state: payload.severity === 'CRITICAL' ? '확인 필요' : '안내',
    description: `운영 이벤트가 발생했습니다: ${payload.event}`, action: '아래 상세 내용을 확인해 주세요.',
  };
  const icon = payload.severity === 'CRITICAL' ? '🚨' : payload.severity === 'WARNING' ? '⚠️' : '✅';
  const detailLines = Object.entries(payload.details).map(([key, value]) => `• ${DETAIL_LABELS[key] || key}: ${readableValue(key, value)}`);
  return [
    `${icon} 매타작 · ${message.title}`,
    '',
    `상태: ${message.state}`,
    `발생 시각: ${koreanTime(payload.occurred_at)}`,
    `내용: ${message.description}`,
    `대응: ${message.action}`,
    ...(detailLines.length ? ['', '상세 정보', ...detailLines] : []),
  ].join('\n').slice(0, 4096);
}

async function sendTelegramAlert({ botToken, chatId, payload, fetchImpl }) {
  if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(botToken || '') || !/^(?:-?\d+|@[A-Za-z0-9_]{5,})$/.test(chatId || '')) {
    return { sent: false, provider: 'telegram', reason: 'TELEGRAM_CONFIGURATION_INVALID' };
  }
  try {
    const response = await fetchImpl(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: telegramMessage(payload), disable_web_page_preview: true }),
      signal: AbortSignal.timeout(5_000),
    });
    return response.ok
      ? { sent: true, provider: 'telegram' }
      : { sent: false, provider: 'telegram', reason: `HTTP_${response.status}` };
  } catch (error) {
    return { sent: false, provider: 'telegram', reason: error?.name === 'TimeoutError' ? 'TIMEOUT' : 'NETWORK_ERROR' };
  }
}

async function sendWebhookAlert({ webhookUrl, bearerToken, payload, fetchImpl }) {
  const headers = { 'Content-Type': 'application/json' };
  if (bearerToken) headers.Authorization = `Bearer ${bearerToken}`;
  try {
    const response = await fetchImpl(webhookUrl, { method: 'POST', headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(5_000) });
    return response.ok ? { sent: true, provider: 'webhook' } : { sent: false, provider: 'webhook', reason: `HTTP_${response.status}` };
  } catch (error) {
    return { sent: false, provider: 'webhook', reason: error?.name === 'TimeoutError' ? 'TIMEOUT' : 'NETWORK_ERROR' };
  }
}

export async function sendWorkerAlert({
  webhookUrl,
  bearerToken,
  telegramBotToken,
  telegramChatId,
  event,
  severity = 'WARNING',
  details = {},
  fetchImpl = fetch,
}) {
  const payload = alertPayload({ event, severity, details });
  if (telegramBotToken || telegramChatId) {
    if (!telegramBotToken || !telegramChatId) return { sent: false, provider: 'telegram', reason: 'TELEGRAM_CONFIGURATION_INCOMPLETE' };
    return sendTelegramAlert({ botToken: telegramBotToken, chatId: telegramChatId, payload, fetchImpl });
  }
  if (webhookUrl) return sendWebhookAlert({ webhookUrl, bearerToken, payload, fetchImpl });
  return { sent: false, reason: 'ALERT_DESTINATION_NOT_CONFIGURED' };
}
