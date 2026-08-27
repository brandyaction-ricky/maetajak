import test from 'node:test';
import assert from 'node:assert/strict';
import { sendWorkerAlert } from './alerts.js';

test('worker alert is disabled safely without a destination', async () => {
  assert.deepEqual(await sendWorkerAlert({ event: 'TEST' }), { sent: false, reason: 'ALERT_DESTINATION_NOT_CONFIGURED' });
});

test('worker alert sends only safe operational details', async () => {
  let request;
  const result = await sendWorkerAlert({
    webhookUrl: 'https://alerts.example.test/hook', bearerToken: 'token', event: 'WORKER_CYCLE_FAILED',
    details: { error_code: 'GATE_TIMEOUT\nsecret-like-line' },
    fetchImpl: async (url, options) => { request = { url, options }; return { ok: true, status: 200 }; },
  });
  assert.equal(result.sent, true);
  assert.equal(result.provider, 'webhook');
  assert.equal(request.options.headers.Authorization, 'Bearer token');
  const body = JSON.parse(request.options.body);
  assert.equal(body.event, 'WORKER_CYCLE_FAILED');
  assert.equal(body.details.error_code, 'GATE_TIMEOUT secret-like-line');
  assert.doesNotMatch(request.options.body, /api_key|secret_key|service_role/i);
});

test('worker alert sends Telegram messages without leaking the bot token into the body', async () => {
  let request;
  const botToken = '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdef';
  const result = await sendWorkerAlert({
    telegramBotToken: botToken,
    telegramChatId: '-1001234567890',
    event: 'COPY_SYSTEM_AUTO_HALTED',
    severity: 'CRITICAL',
    details: { failures: 3, error_code: 'GATE_TIMEOUT\nretry stopped' },
    fetchImpl: async (url, options) => { request = { url, options }; return { ok: true, status: 200 }; },
  });
  assert.deepEqual(result, { sent: true, provider: 'telegram' });
  assert.equal(request.url, `https://api.telegram.org/bot${botToken}/sendMessage`);
  const body = JSON.parse(request.options.body);
  assert.equal(body.chat_id, '-1001234567890');
  assert.match(body.text, /\[CRITICAL\] maetajak copy worker/);
  assert.match(body.text, /GATE_TIMEOUT retry stopped/);
  assert.doesNotMatch(request.options.body, new RegExp(botToken.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('worker alert fails closed for incomplete or invalid Telegram configuration', async () => {
  assert.deepEqual(
    await sendWorkerAlert({ telegramBotToken: '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdef', event: 'TEST' }),
    { sent: false, provider: 'telegram', reason: 'TELEGRAM_CONFIGURATION_INCOMPLETE' },
  );
  assert.deepEqual(
    await sendWorkerAlert({ telegramBotToken: 'bad-token', telegramChatId: '123', event: 'TEST' }),
    { sent: false, provider: 'telegram', reason: 'TELEGRAM_CONFIGURATION_INVALID' },
  );
});
