import test from 'node:test';
import assert from 'node:assert/strict';
import { sendWorkerAlert } from './alerts.js';

test('worker alert is disabled safely without a webhook', async () => {
  assert.deepEqual(await sendWorkerAlert({ event: 'TEST' }), { sent: false, reason: 'WEBHOOK_NOT_CONFIGURED' });
});

test('worker alert sends only safe operational details', async () => {
  let request;
  const result = await sendWorkerAlert({
    webhookUrl: 'https://alerts.example.test/hook', bearerToken: 'token', event: 'WORKER_CYCLE_FAILED',
    details: { error_code: 'GATE_TIMEOUT\nsecret-like-line' },
    fetchImpl: async (url, options) => { request = { url, options }; return { ok: true, status: 200 }; },
  });
  assert.equal(result.sent, true);
  assert.equal(request.options.headers.Authorization, 'Bearer token');
  const body = JSON.parse(request.options.body);
  assert.equal(body.event, 'WORKER_CYCLE_FAILED');
  assert.equal(body.details.error_code, 'GATE_TIMEOUT secret-like-line');
  assert.doesNotMatch(request.options.body, /api_key|secret_key|service_role/i);
});
