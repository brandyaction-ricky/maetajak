import test from 'node:test';
import assert from 'node:assert/strict';
import { sendWorkerAlert, shouldSendFailureAlert } from './alerts.js';

test('continuous worker failures alert only once before and once at auto-halt', () => {
  assert.equal(shouldSendFailureAlert(1), true);
  assert.equal(shouldSendFailureAlert(3), true);
  for (const failures of [2, 4, 10, 20, 60, 77, 100]) assert.equal(shouldSendFailureAlert(failures), false);
});

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
    telegramBotToken: botToken, telegramChatId: '-1001234567890', event: 'COPY_SYSTEM_AUTO_HALTED', severity: 'CRITICAL',
    details: { failures: 3, error_code: 'GATE_TIMEOUT\nretry stopped' },
    fetchImpl: async (url, options) => { request = { url, options }; return { ok: true, status: 200 }; },
  });
  assert.deepEqual(result, { sent: true, provider: 'telegram' });
  assert.equal(request.url, `https://api.telegram.org/bot${botToken}/sendMessage`);
  const body = JSON.parse(request.options.body);
  assert.equal(body.chat_id, '-1001234567890');
  assert.match(body.text, /매타작 · 카피트레이딩 자동 중단/);
  assert.match(body.text, /상태: 전체 카피 중단/);
  assert.match(body.text, /오류 원인: GATE_TIMEOUT retry stopped/);
  assert.match(body.text, /대응:/);
  assert.doesNotMatch(request.options.body, new RegExp(botToken.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('position entry alert explains the fill in Korean', async () => {
  let request;
  await sendWorkerAlert({
    telegramBotToken: '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdef', telegramChatId: '-1001234567890',
    event: 'COPY_POSITION_ENTRY_FILLED', severity: 'INFO',
    details: { member: '테스트 회원', contract: 'BTC_USDT', position_side: 'LONG', filled_size: 12,
      average_fill_price: 100000, target_leverage: 5, margin_mode: 'cross', result_status: 'FILLED' },
    fetchImpl: async (url, options) => { request = { url, options }; return { ok: true, status: 200 }; },
  });
  const message = JSON.parse(request.options.body).text;
  assert.match(message, /포지션 진입 체결/);
  assert.match(message, /회원: 테스트 회원/);
  assert.match(message, /방향: 롱/);
  assert.match(message, /레버리지: 5배/);
  assert.match(message, /증거금 모드: 교차/);
  assert.match(message, /체결 상태: 전체 체결/);
});

test('worker alert fails closed for incomplete or invalid Telegram configuration', async () => {
  assert.deepEqual(await sendWorkerAlert({ telegramBotToken: '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdef', event: 'TEST' }), { sent: false, provider: 'telegram', reason: 'TELEGRAM_CONFIGURATION_INCOMPLETE' });
  assert.deepEqual(await sendWorkerAlert({ telegramBotToken: 'bad-token', telegramChatId: '123', event: 'TEST' }), { sent: false, provider: 'telegram', reason: 'TELEGRAM_CONFIGURATION_INVALID' });
});
