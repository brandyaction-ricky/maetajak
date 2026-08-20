import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const migration = readFileSync(new URL('../supabase/migrations/202608210007_strict_gate_readiness.sql', import.meta.url), 'utf8');

test('strict Gate verification is bound to the current fixed Worker IP', () => {
  assert.match(migration, /verification_version/);
  assert.match(migration, /verified_worker_ip/);
  assert.match(migration, /g\.verified_worker_ip=runtime\.public_ip/);
  assert.match(migration, /g\.verified_worker_ip=r\.public_ip/g);
});

test('readiness can only be recorded by DRY_RUN', () => {
  assert.match(migration, /p_test_passed and p_mode<>'DRY_RUN'/);
  assert.match(migration, /DRY_RUN_REQUIRED_FOR_READINESS/);
});

test('stale SUBMITTING intents enter reconciliation instead of being retried', () => {
  assert.match(migration, /i\.status='SUBMITTING'/);
  assert.match(migration, /i\.updated_at<now\(\)-interval '30 seconds'/);
  assert.match(migration, /on conflict\(intent_id\) do nothing/);
});
