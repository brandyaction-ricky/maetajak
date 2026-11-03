import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePreflightEnvironment } from '../scripts/worker-preflight.js';

const base = {
  SUPABASE_URL: 'https://projectref.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_example',
  GATE_API_BASE_URL: 'https://api.gateio.ws',
  GATE_CHANNEL_ID: 'maetajak',
  WORKER_PUBLIC_IP: '1.1.1.1',
  TRADING_MODE: 'OBSERVE',
  RUN_READINESS_CHECK: 'false',
};

test('worker preflight accepts the approved production broker configuration', () => {
  assert.equal(validatePreflightEnvironment(base).ok, true);
});

test('worker preflight rejects placeholders, wrong channels, and LIVE without alerts', () => {
  const result = validatePreflightEnvironment({ ...base, WORKER_PUBLIC_IP: '203.0.113.10', GATE_CHANNEL_ID: 'wrongchannel', TRADING_MODE: 'LIVE' });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((message) => message.includes('fixed public IPv4')));
  assert.ok(result.errors.some((message) => message.includes('approved Channel ID')));
  assert.ok(result.errors.some((message) => message.includes('Telegram')));
});

test('worker preflight accepts complete Telegram alerts for LIVE', () => {
  const result = validatePreflightEnvironment({
    ...base,
    TRADING_MODE: 'LIVE',
    TELEGRAM_BOT_TOKEN: '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdef',
    TELEGRAM_CHAT_ID: '-1001234567890',
  });
  assert.equal(result.ok, true);
  assert.equal(result.alerts_configured, true);
  assert.equal(result.alert_provider, 'telegram');
});

test('worker preflight rejects incomplete Telegram alert credentials', () => {
  const result = validatePreflightEnvironment({
    ...base,
    TELEGRAM_BOT_TOKEN: '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdef',
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((message) => message.includes('configured together')));
});

test('worker preflight rejects webhook-only LIVE because critical alerts require Telegram', () => {
  const result = validatePreflightEnvironment({
    ...base,
    TRADING_MODE: 'LIVE',
    ALERT_WEBHOOK_URL: 'https://alerts.example.test/hook',
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((message) => message.includes('Telegram')));
});

// 2026-11-03 review F4: a 0.6.x worker refuses to start on a database without the 2026-11-03 migrations.
import { runPreflight, checkDatabaseCompatibility, preflightWorkerVersion } from '../scripts/worker-preflight.js';
const dbFetch = ({ version = { worker_build_version_gate: 1 }, legs = { legs: [] }, status = 200, fail = null } = {}) => {
  const urls = [];
  const impl = async (url, request) => {
    urls.push([new URL(url).pathname, request.method, request.headers.Authorization]);
    if (fail) throw new Error(fail);
    const name = new URL(url).pathname.split('/').at(-1);
    const body = name === 'get_copy_safety_version' ? version : legs;
    return new Response(JSON.stringify(body), { status: name === 'get_copy_last_master_legs' ? status : 200 });
  };
  return { impl, urls };
};

test('F4 preflight: 0.6.x worker passes only with worker_build_version_gate >= 1 and get_copy_last_master_legs', async () => {
  const env = { ...base, WORKER_VERSION: '0.6.0+7026ad2ce098' };
  const ok = dbFetch();
  const passed = await runPreflight(env, { fetchImpl: ok.impl });
  assert.equal(passed.ok, true, passed.errors.join());
  assert.equal(passed.database_checked, true);
  assert.deepEqual(ok.urls.map(([p, m, a]) => [p, m, a]), [
    ['/rest/v1/rpc/get_copy_safety_version', 'POST', 'Bearer sb_secret_example'],
    ['/rest/v1/rpc/get_copy_last_master_legs', 'POST', 'Bearer sb_secret_example']]);
  for (const [label, options, pattern] of [
    ['gate missing', { version: { schema_version: 3, worker_version: '0.5.0' } }, /20261103020000/],
    ['gate 0', { version: { worker_build_version_gate: 0 } }, /20261103020000/],
    ['legs RPC missing', { status: 404 }, /20261103030000/],
    ['legs shape', { legs: { positions: [] } }, /20261103030000/],
    ['network', { fail: 'ECONNREFUSED' }, /could not be read/],
  ]) {
    const result = await runPreflight(env, { fetchImpl: dbFetch(options).impl });
    assert.equal(result.ok, false, label);
    assert.ok(result.errors.some((e) => pattern.test(e)), `${label}: ${result.errors.join(' | ')}`);
  }
});

test('F4 preflight: 0.5.0 / dev builds are not DB-checked; an invalid environment makes no request', async () => {
  for (const version of ['0.5.0', 'dev']) {
    const probe = dbFetch({ fail: 'SHOULD_NOT_BE_CALLED' });
    assert.deepEqual(await checkDatabaseCompatibility({ env: base, workerVersion: version, fetchImpl: probe.impl }), { checked: false, errors: [] });
    assert.equal(probe.urls.length, 0);
  }
  const probe = dbFetch({ fail: 'SHOULD_NOT_BE_CALLED' });
  const result = await runPreflight({ ...base, WORKER_VERSION: '0.6.0+abc1234', SUPABASE_URL: 'http://localhost' }, { fetchImpl: probe.impl });
  assert.equal(result.ok, false);
  assert.equal(probe.urls.length, 0);
  assert.equal(preflightWorkerVersion({ WORKER_VERSION: '0.6.0+x' }), '0.6.0+x');
  assert.equal(preflightWorkerVersion({}), '0.6.0', 'package.json fallback, as worker/index.js');
});
