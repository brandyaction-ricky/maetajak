import { sendWorkerAlert } from '../worker/alerts.js';

const result = await sendWorkerAlert({
  webhookUrl: process.env.ALERT_WEBHOOK_URL || '',
  bearerToken: process.env.ALERT_WEBHOOK_BEARER || '',
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramChatId: process.env.TELEGRAM_CHAT_ID || '',
  event: 'WORKER_ALERT_TEST',
  severity: 'INFO',
  details: {
    worker_id: process.env.WORKER_ID || 'maetajak-worker',
    mode: process.env.TRADING_MODE || 'OBSERVE',
  },
});

console.log(JSON.stringify({ sent: result.sent, provider: result.provider || null, reason: result.reason || null }));
if (!result.sent) process.exitCode = 1;
