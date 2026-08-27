function safeAlertText(value, limit = 300) {
  return String(value || '').replace(/[\r\n\t]+/g, ' ').slice(0, limit);
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
  const detailLines = Object.entries(payload.details).map(([key, value]) => `- ${key}: ${value}`);
  return [
    `[${payload.severity}] maetajak copy worker`,
    `Event: ${payload.event}`,
    `Time: ${payload.occurred_at}`,
    ...detailLines,
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
