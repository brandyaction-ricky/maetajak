import { sendWorkerAlert } from '../worker/alerts.js';

// Operational notice from the deploy scripts (e.g. a worker update held back while LIVE).
const event = /^[A-Z0-9_]{3,60}$/.test(process.env.DEPLOY_NOTICE_EVENT || '')
  ? process.env.DEPLOY_NOTICE_EVENT : 'AUTO_DEPLOY_PENDING_LIVE';
const commit = String(process.env.DEPLOY_NOTICE_COMMIT || '').replace(/[^0-9a-f]/gi, '').slice(0, 12);

const result = await sendWorkerAlert({
  webhookUrl: process.env.ALERT_WEBHOOK_URL || '',
  bearerToken: process.env.ALERT_WEBHOOK_BEARER || '',
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramChatId: process.env.TELEGRAM_CHAT_ID || '',
  event,
  severity: 'WARNING',
  details: { commit: commit || '없음', mode: process.env.TRADING_MODE || 'OBSERVE' },
});

console.log(JSON.stringify({ sent: result.sent, provider: result.provider || null, reason: result.reason || null }));
if (!result.sent) process.exitCode = 1;
