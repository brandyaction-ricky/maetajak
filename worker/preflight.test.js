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
  assert.ok(result.errors.some((message) => message.includes('Telegram or webhook')));
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
