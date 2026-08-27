import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const migration = readFileSync(new URL('../supabase/migrations/202608270001_gate_broker_channel.sql', import.meta.url), 'utf8');
const worker = readFileSync(new URL('./index.js', import.meta.url), 'utf8');
const runner = readFileSync(new URL('./trading-runner.js', import.meta.url), 'utf8');

test('broker Channel ID is persisted and required for readiness and live activation', () => {
  assert.match(migration, /default 'maetajak'/);
  assert.match(migration, /\^\[a-z0-9\]\{1,19\}\$/);
  assert.match(migration, /BROKER_CHANNEL_ID_REQUIRED/);
  assert.match(migration, /r\.broker_channel_id=c\.broker_channel_id/);
});

test('worker passes Channel ID to heartbeat and every live order', () => {
  assert.match(worker, /GATE_CHANNEL_ID/);
  assert.match(worker, /approved Channel ID maetajak/);
  assert.match(worker, /DRY_RUN and LIVE modes require GATE_CHANNEL_ID/);
  assert.match(worker, /LIVE mode requires ALERT_WEBHOOK_URL/);
  assert.match(runner, /p_broker_channel_id: this\.channelId/);
  assert.match(runner, /channelId: this\.channelId/);
});

test('pre-activation and test-mode intents cannot become live orders later', () => {
  assert.match(migration, /i\.created_at>=control\.updated_at/);
  assert.match(runner, /suppressExecutableIntents/);
});
