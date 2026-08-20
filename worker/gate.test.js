import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildGateHeaders, FUTURES_ACCOUNT_PATH, GateApiError, gateRequest,
  parseGateJson, placeFuturesOrder, summarizeGateOrder, verifyGateAccount,
} from './gate.js';

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

test('live delta order is a signed market IOC order with idempotent text', async () => {
  const result = await placeFuturesOrder({
    apiKey: 'api-key', secretKey: 'secret-key', contract: 'BTC_USDT', size: -3,
    reduceOnly: true, text: 't-mtj-12345678901234567890', slippageRatio: 0.005,
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://api.gateio.ws/api/v4/futures/usdt/orders');
      assert.match(options.headers.SIGN, /^[a-f0-9]{128}$/);
      assert.deepEqual(JSON.parse(options.body), {
        contract: 'BTC_USDT', size: -3, price: '0', tif: 'ioc', reduce_only: true,
        text: 't-mtj-12345678901234567890', market_order_slip_ratio: '0.005',
      });
      return new Response(JSON.stringify({ id: '9223372036854775807', size: -3, left: 0, status: 'finished', finish_as: 'filled' }), { status: 201 });
    },
  });
  assert.equal(result.status, 201);
});

test('write timeout is UNKNOWN and must not be blindly retried', async () => {
  await assert.rejects(
    gateRequest({ apiKey: 'key', secretKey: 'secret', method: 'POST', path: '/api/v4/futures/usdt/orders', body: {}, fetchImpl: async () => { throw new DOMException('timeout', 'TimeoutError'); } }),
    (error) => error instanceof GateApiError && error.code === 'GATE_TIMEOUT' && error.outcomeUnknown,
  );
});

test('partial fills preserve signed fill size for reconciliation', () => {
  assert.deepEqual(summarizeGateOrder({ id: '10', size: -10, left: -4, status: 'finished', finish_as: 'ioc' }), {
    gateOrderId: '10', filledSize: -6, averageFillPrice: null, finalStatus: 'PARTIALLY_FILLED', finishAs: 'ioc', left: -4,
  });
});

test('Gate int64 order IDs are preserved as strings', () => {
  assert.equal(parseGateJson('{"id":9223372036854775807,"status":"open"}').id, '9223372036854775807');
});
