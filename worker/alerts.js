function safeAlertText(value, limit = 300) {
  return String(value || '').replace(/[\r\n\t]+/g, ' ').slice(0, limit);
}

export async function sendWorkerAlert({ webhookUrl, bearerToken, event, severity = 'WARNING', details = {}, fetchImpl = fetch }) {
  if (!webhookUrl) return { sent: false, reason: 'WEBHOOK_NOT_CONFIGURED' };
  const payload = {
    source: 'maetajak-worker',
    event: safeAlertText(event, 80),
    severity: safeAlertText(severity, 20),
    occurred_at: new Date().toISOString(),
    details: Object.fromEntries(Object.entries(details).slice(0, 10).map(([key, value]) => [safeAlertText(key, 50), safeAlertText(value)])),
  };
  const headers = { 'Content-Type': 'application/json' };
  if (bearerToken) headers.Authorization = `Bearer ${bearerToken}`;
  try {
    const response = await fetchImpl(webhookUrl, { method: 'POST', headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(5_000) });
    return response.ok ? { sent: true } : { sent: false, reason: `HTTP_${response.status}` };
  } catch (error) {
    return { sent: false, reason: error?.name === 'TimeoutError' ? 'TIMEOUT' : 'NETWORK_ERROR' };
  }
}
