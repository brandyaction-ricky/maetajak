import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildGateHeaders, FUTURES_ACCOUNT_PATH, GateApiError, gateRequest, getFuturesAccount, getFuturesContracts,
  matchingKeyInfo, normalizeGatePermissions, normalizeGatePositions, parseGateJson, placeFuturesOrder, summarizeGateOrder,
  validateGateChannelId, verifyGateAccount,
} from './gate.js';

function verificationFetch({ user = 45997867, ipWhitelist = ['203.0.113.10'], permissions = [{ name: 'futures', read_only: false }], legacyKeyList = false, mainKeysStatus = 200, mainKeysLabel = 'FORBIDDEN' } = {}) {
  return async (url, options) => {
    assert.equal(options.method, 'GET');
    assert.match(options.headers.SIGN, /^[a-f0-9]{128}$/);
    if (url.endsWith('/futures/usdt/accounts')) return new Response(JSON.stringify({ user, total: '0' }), { status: 200 });
    if (url.endsWith('/account/detail')) return new Response(JSON.stringify({ user_id: user, ip_whitelist: ipWhitelist }), { status: 200 });
    if (url.endsWith('/account/main_keys')) {
      if (mainKeysStatus !== 200) return new Response(JSON.stringify({ label: mainKeysLabel }), { status: mainKeysStatus });
      const keyInfo = { state: 1, key: { mode: 1 }, perms: permissions };
      return new Response(JSON.stringify(legacyKeyList ? [{ ...keyInfo, key: 'api-key' }] : keyInfo), { status: 200 });
    }
    throw new Error(`unexpected URL: ${url}`);
  };
}

test('Gate key details support the current AccountKeyInfo object and legacy lists', () => {
  const current = { state: 1, key: { mode: 1 }, perms: [{ name: 'futures', read_only: false }] };
  assert.equal(matchingKeyInfo('api-key', current), current);
  assert.equal(matchingKeyInfo('api-key', [{ ...current, key: 'api-key' }])?.state, 1);
  assert.equal(matchingKeyInfo('api-key', [{ ...current, key: 'different-key' }]), null);
});

test('Gate permissions normalize REST, SDK, alias, and object-map response shapes', () => {
  assert.deepEqual(normalizeGatePermissions({ perms: [{ name: 'futures', read_only: false }] }), [
    { name: 'futures', readOnly: false },
  ]);
  assert.deepEqual(normalizeGatePermissions({ permissions: [{ type: 'Perpetual Futures', readOnly: false }] }), [
    { name: 'futures', readOnly: false },
  ]);
  assert.deepEqual(normalizeGatePermissions({ perms: { perpetual_contract: 'read_and_write', wallet: 'read_only' } }), [
    { name: 'futures', readOnly: false },
    { name: 'wallet', readOnly: true },
  ]);
  assert.deepEqual(normalizeGatePermissions({ key: { permissions: ['futures:read_write'] } }), [
    { name: 'futures', readOnly: false },
  ]);
});

test('Gate permission normalization does not guess an unknown write scope', () => {
  assert.deepEqual(normalizeGatePermissions({ permissions: ['futures'] }), [
    { name: 'futures', readOnly: null },
  ]);
});

test('Gate API v4 signature is deterministic and keeps secrets out of the URL', () => {
  const headers = buildGateHeaders({ apiKey: 'api-key', secretKey: 'secret-key', path: FUTURES_ACCOUNT_PATH, timestamp: 1_700_000_000 });
  assert.equal(headers.KEY, 'api-key');
  assert.equal(headers.Timestamp, '1700000000');
  assert.equal(headers['X-Gate-Size-Decimal'], '1');
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

test('Gate API Broker Channel ID follows the official format', () => {
  assert.equal(validateGateChannelId('maetajak'), 'maetajak');
  for (const invalid of ['', 'MAETAJAK', 'maetajak-copy-trading', 'maetajak_1']) {
    assert.throws(() => validateGateChannelId(invalid), (error) => error instanceof GateApiError && error.code === 'INVALID_GATE_CHANNEL_ID');
  }
});

test('Gate new classic futures account uses cross-margin equity when classic total is zero', async () => {
  const account = await getFuturesAccount({
    apiKey: 'api-key', secretKey: 'secret-key',
    fetchImpl: async () => new Response(JSON.stringify({
      user: 45997867,
      total: '0',
      margin_mode: 0,
      available: '17150.83563',
      cross_margin_balance: '17320.25',
      unrealized_pnl: '-4.75',
    }), { status: 200 }),
  });
  assert.equal(account.total, 17320.25);
  assert.equal(account.available, 17150.83563);
  assert.equal(account.unrealisedPnl, -4.75);
});

test('Gate unified futures account uses unified total equity', async () => {
  const account = await getFuturesAccount({
    apiKey: 'api-key', secretKey: 'secret-key',
    fetchImpl: async (url) => {
      if (url.endsWith('/futures/usdt/accounts')) return new Response(JSON.stringify({
        user: 45997867, total: '0', margin_mode: 3,
        available: '17150.85265', cross_margin_balance: '0.000000002075',
      }), { status: 200 });
      if (url.endsWith('/unified/accounts')) return new Response(JSON.stringify({
        unified_account_total_equity: '17160.25',
      }), { status: 200 });
      throw new Error(`unexpected URL: ${url}`);
    },
  });
  assert.equal(account.total, 17160.25);
  assert.equal(account.available, 17150.85265);
});

test('Gate futures account rejects implausibly small equity', async () => {
  await assert.rejects(() => getFuturesAccount({
    apiKey: 'api-key', secretKey: 'secret-key',
    fetchImpl: async () => new Response(JSON.stringify({
      user: 45997867, total: '0.000000002075', available: '17150.85265', margin_mode: 0,
    }), { status: 200 }),
  }), (error) => error instanceof GateApiError && error.code === 'INVALID_ACCOUNT_EQUITY');
});

test('Gate account verification rejects a mismatched UID', async () => {
  const result = await verifyGateAccount({ gateUid: '1234', apiKey: 'api-key', secretKey: 'secret-key', expectedPublicIp: '203.0.113.10', fetchImpl: verificationFetch({ user: 9999 }) });
  assert.equal(result.success, false);
  assert.equal(result.errorCode, 'UID_MISMATCH');
});

test('Gate account verification accepts a signed Futures account response', async () => {
  const result = await verifyGateAccount({
    gateUid: '45997867', apiKey: 'api-key', secretKey: 'secret-key', expectedPublicIp: '203.0.113.10',
    fetchImpl: verificationFetch(),
  });
  assert.equal(result.success, true);
  assert.equal(result.gateUserId, '45997867');
  assert.equal(result.withdrawalDisabled, true);
});

test('Gate account verification accepts a Perpetual Futures alias with explicit Read/Write', async () => {
  const result = await verifyGateAccount({
    gateUid: '45997867', apiKey: 'api-key', secretKey: 'secret-key', expectedPublicIp: '203.0.113.10',
    fetchImpl: verificationFetch({ permissions: [{ type: 'Perpetual Futures', readOnly: false }] }),
  });
  assert.equal(result.success, true);
  assert.equal(result.futuresTrade, true);
});

test('Gate main-keys denial is not misreported as missing Futures read permission', async () => {
  const result = await verifyGateAccount({
    gateUid: '45997867', apiKey: 'api-key', secretKey: 'secret-key', expectedPublicIp: '203.0.113.10',
    fetchImpl: verificationFetch({ mainKeysStatus: 403 }),
  });
  assert.equal(result.success, false);
  assert.equal(result.errorCode, 'API_PERMISSION_LOOKUP_DENIED');
  assert.equal(result.diagnostic.path, '/api/v4/account/main_keys');
  assert.equal(result.diagnostic.status, 403);
});

test('Master verification requires Futures Read Only', async () => {
  const accepted = await verifyGateAccount({
    gateUid: '45997867', apiKey: 'api-key', secretKey: 'secret-key', expectedPublicIp: '203.0.113.10',
    requiresTradingPermission: false,
    fetchImpl: verificationFetch({ permissions: [{ name: 'futures', read_only: true }] }),
  });
  assert.equal(accepted.success, true);
  assert.equal(accepted.futuresTrade, false);

  const rejected = await verifyGateAccount({
    gateUid: '45997867', apiKey: 'api-key', secretKey: 'secret-key', expectedPublicIp: '203.0.113.10',
    requiresTradingPermission: false,
    fetchImpl: verificationFetch({ permissions: [{ name: 'futures', read_only: false }] }),
  });
  assert.equal(rejected.success, false);
  assert.equal(rejected.errorCode, 'MASTER_READ_ONLY_REQUIRED');
});

test('Gate account verification requires the exact fixed Worker IP', async () => {
  const result = await verifyGateAccount({
    gateUid: '45997867', apiKey: 'api-key', secretKey: 'secret-key', expectedPublicIp: '203.0.113.11',
    fetchImpl: verificationFetch(),
  });
  assert.equal(result.success, false);
  assert.equal(result.errorCode, 'IP_NOT_ALLOWED');
});

test('Gate account verification rejects extra write permissions', async () => {
  const result = await verifyGateAccount({
    gateUid: '45997867', apiKey: 'api-key', secretKey: 'secret-key', expectedPublicIp: '203.0.113.10',
    fetchImpl: verificationFetch({ permissions: [{ name: 'futures', read_only: false }, { name: 'withdrawal', read_only: false }] }),
  });
  assert.equal(result.success, false);
  assert.equal(result.errorCode, 'EXCESS_API_PERMISSIONS');
});

test('live delta order is a signed market IOC order with idempotent text', async () => {
  const result = await placeFuturesOrder({
    apiKey: 'api-key', secretKey: 'secret-key', contract: 'BTC_USDT', size: -3,
    reduceOnly: true, text: 't-mtj-12345678901234567890', slippageRatio: 0.005, channelId: 'maetajak',
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://api.gateio.ws/api/v4/futures/usdt/orders');
      assert.match(options.headers.SIGN, /^[a-f0-9]{128}$/);
      assert.equal(options.headers['X-Gate-Channel-Id'], 'maetajak');
      assert.equal(options.headers['X-Gate-Size-Decimal'], '1');
      assert.ok(Number(options.headers['X-Gate-Exptime']) > Date.now());
      assert.deepEqual(JSON.parse(options.body), {
        contract: 'BTC_USDT', size: '-3', price: '0', tif: 'ioc', reduce_only: true,
        text: 't-mtj-12345678901234567890', market_order_slip_ratio: '0.005',
      });
      return new Response(JSON.stringify({ id: '9223372036854775807', size: -3, left: 0, status: 'finished', finish_as: 'filled' }), { status: 201 });
    },
  });
  assert.equal(result.status, 201);
});

test('live write is blocked when API Broker Channel ID is missing', async () => {
  await assert.rejects(
    placeFuturesOrder({ apiKey: 'api-key', secretKey: 'secret-key', contract: 'BTC_USDT', size: 1, text: 't-mtj-12345678901234567890' }),
    (error) => error instanceof GateApiError && error.code === 'INVALID_GATE_CHANNEL_ID',
  );
});

test('write timeout is UNKNOWN and must not be blindly retried', async () => {
  await assert.rejects(
    gateRequest({ apiKey: 'key', secretKey: 'secret', channelId: 'maetajak', method: 'POST', path: '/api/v4/futures/usdt/orders', body: {}, fetchImpl: async () => { throw new DOMException('timeout', 'TimeoutError'); } }),
    (error) => error instanceof GateApiError && error.code === 'GATE_TIMEOUT' && error.outcomeUnknown,
  );
});

test('Gate 5xx after an order request is UNKNOWN and must be reconciled', async () => {
  await assert.rejects(
    gateRequest({
      apiKey: 'key', secretKey: 'secret', channelId: 'maetajak', method: 'POST', path: '/api/v4/futures/usdt/orders', body: {},
      fetchImpl: async () => new Response(JSON.stringify({ label: 'INTERNAL' }), { status: 503 }),
    }),
    (error) => error instanceof GateApiError && error.status === 503 && error.outcomeUnknown,
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

test('decimal futures contracts use their minimum quantity as the lot step', async () => {
  const contracts = await getFuturesContracts({
    fetchImpl: async () => new Response(JSON.stringify([{ name: 'TEST_USDT', quanto_multiplier: '0.01', order_size_min: '0.001', order_size_max: '100', market_order_size_max: '25', enable_decimal: true }]), { status: 200 }),
  });
  assert.deepEqual(contracts.get('TEST_USDT'), {
    name: 'TEST_USDT', quantoMultiplier: 0.01, sizeStep: 0.001, orderSizeMin: 0.001,
    orderSizeMax: 100, marketOrderSizeMax: 25, inDelisting: false,
  });
});

test('dual position responses keep only the open side for a contract', () => {
  assert.deepEqual(normalizeGatePositions([
    { contract: 'BTC_USDT', size: '2', mark_price: '60000', entry_price: '58000', lever: '3', mode: 'dual_long' },
    { contract: 'BTC_USDT', size: '0', mark_price: '60000', entry_price: '0', lever: '3', mode: 'dual_short' },
  ]), [{
    contract: 'BTC_USDT', size: 2, markPrice: 60000, entryPrice: 58000,
    leverage: 3, mode: 'dual_long', posMarginMode: '',
  }]);
});

test('simultaneous long and short positions fail closed instead of being netted', () => {
  assert.throws(() => normalizeGatePositions([
    { contract: 'BTC_USDT', size: '2', mark_price: '60000', mode: 'dual_long' },
    { contract: 'BTC_USDT', size: '-1', mark_price: '60000', mode: 'dual_short' },
  ]), (error) => error instanceof GateApiError && error.code === 'HEDGED_POSITION_UNSUPPORTED');
});
