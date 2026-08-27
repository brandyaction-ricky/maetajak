import test from 'node:test';
import assert from 'node:assert/strict';
import { sendWorkerAlert, shouldSendFailureAlert } from './alerts.js';

test('continuous worker failures alert only once before and once at auto-halt', () => {
  assert.equal(shouldSendFailureAlert(1), true);
  assert.equal(shouldSendFailureAlert(3), true);
  for (const failures of [2, 4, 10, 20, 60, 77, 100]) {
    assert.equal(shouldSendFailureAlert(failures), false);
  }
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
    telegramBotToken: botToken,
    telegramChatId: '-1001234567890',
    event: 'COPY_SYSTEM_AUTO_HALTED',
    severity: 'CRITICAL',
    details: { failures: 3, error_code: 'GATE_TIMEOUT\nretry stopped' },
    fetchImpl: async (url, options) => { request = { url, options }; return { ok: true, status: 200 }; },
  });
  assert.deepEqual(result, { sent: trvÛŞm¢G§²ÚîÆ­yØÛRY\Ù\’YÛÛ˜Xİ\™Ù]Ú^™KXİX[Ú^™WK›X\
İš[™ÊKš›Ú[Š	ß	ÊNÂˆ™]\›ˆÜ™X]R\Ú
	ÜÚLM‰ÊK\]JÛİ\˜ÙJK™YÙ\İ
	Ú^	ÊNÂŸB‚™^Ü[˜İ[ÛˆZ[Ø]SÜ™\•^
Y[\İ[˜ŞRÙ^JHÂˆÛÛœİ›Ü›X[^™YHİš[™ÊY[\İ[˜ŞRÙ^JKœ™\XÙJÖ×˜K^KVŒNWKÙË	ÉÊKÓİÙ\Ø\ÙJ
NÂˆYˆ
›Ü›X[^™Y›[™İLŠH›İÈ™]È˜[™ÙQ\œ›ÜŠ	ÚY[\İ[˜ŞRÙ^H\ÈÛÈÚÜ	ÊNÂˆ™]\›ˆ[]‹IÛ›Ü›X[^™YœÛXÙJŒ
_XÂŸB