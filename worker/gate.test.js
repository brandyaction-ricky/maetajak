import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGateHeaders, FUTURES_ACCOUNT_PATH, verifyGateAccount } from './gate.js';

test('Gate API v4 signature is deterministic and keeps secrets out of the URL', () => {
  const headers = buildGateHeaders({ apiKey: 'api-key', secretKey: 'secret-key', path: FUTURES_ACCOUNT_PATH, timestamp: 1_700_000_000 });
  assert.equal(headers.KEY, 'api-key');
  assert.equal(headers.Timestamp, '1700000000');
  assert.match(headers.SIGN, /^[a-f0-9]{128}$/);
  assert.doesNotMatch(FUTURES_ACCOUNT_PATH, /api-key|secret-key/);
});

test('Gate account verification rejects a mismatched UID', async () => {
  const result = await verifyGateAccount({ gateUid: '1234', apiKey: 'api-key', secretKey: 'secret-key', fetchImpl: async () => new Response(JSON.stringify({ user: 9999 }), { status: 200 }) });
  assert.equal(result.success, false);
  assert.equal(result.errorCode, 'UID_MISMATCH');
});

test('Gate account verification accepts a signed Futures account response', async () => {
  const result = await verifyGateAccount({
    gateUid: '45997867', apiKey: 'api-key', secretKey: 'secret-key',
    fetchImpl: async (_url, options) => {
      assert.equal(options.method, 'GET');
      assert.match(options.headers.SIGN, /^[a-f0-9]{128}$/);
      return new Response(JSON.stringify({ user: 45997867, total: '0' }), { status: 200 });
    },
  });
  assert.equal(result.success, true);
  assert.equal(result.gateUserId, '45997867');
});
