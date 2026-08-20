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

test('Gate API v4 signature matches the official authentication example', () => {
  const headers = buildGateHeaders({
    apiKey: 'key',
    secretKey: 'secret',
    path: '/api/v4/futures/orders',
    query: 'contract=BTC_USD&status=finished&limit=50',
    timestamp: 1541993715,
  });
  assert.equal(headers.SIGN, '55f84ea195d6fe57ce62464daaa7c3c02fa9d1dde954e4c898289c9a2407a3d6fb3faf24deff16790d726b66ac9f74526668b13bd01029199cc4fcc522418b8a');
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
