import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const migration = readFileSync(new URL('../supabase/migrations/20260910052000_supersede_stale_planned_intents.sql', import.meta.url), 'utf8');

test('fresh cycles atomically supersede only never-submitted plans for the same member leg', () => {
  assert.match(migration, /before insert on private\.copy_order_intents/i);
  assert.match(migration, /existing_intent\.trading_account_id=new\.trading_account_id/i);
  assert.match(migration, /existing_intent\.contract=new\.contract/i);
  assert.match(migration, /existing_intent\.position_side=new\.position_side/i);
  assert.match(migration, /existing_intent\.resume_version is not distinct from new\.resume_version/i);
  assert.match(migration, /existing_intent\.status in \('PLANNED','QUEUED'\)/i);
  assert.match(migration, /existing_intent\.submit_attempts=0/i);
  assert.match(migration, /existing_intent\.gate_order_id is null/i);
  assert.match(migration, /last_error_code='SUPERSEDED_BY_FRESH_PLAN'/i);
  assert.doesNotMatch(migration, /existing_intent\.status in \([^)]*SUBMITTING/i);
});

test('migration can only clean stale plans while real execution is halted', () => {
  assert.match(migration, /not execution_enabled and emergency_halted/i);
  assert.match(migration, /HALTED_DEPLOYMENT_REQUIRED/i);
  assert.match(migration, /SUPERSEDED_DURING_HALTED_MIGRATION/i);
});
