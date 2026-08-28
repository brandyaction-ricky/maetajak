import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const migration = readFileSync(new URL('../supabase/migrations/202608280005_hedge_mode_master_leverage.sql', import.meta.url), 'utf8');

test('hedge legs are independently keyed in snapshots, states, and intents', () => {
  assert.match(migration, /unique\(account_snapshot_id, contract, position_side\)/);
  assert.match(migration, /unique\(trading_account_id, contract, position_side\)/);
  assert.match(migration, /unique\(cycle_id, trading_account_id, contract, position_side\)/);
  assert.match(migration, /s\.position_side=i\.position_side/);
});

test('worker context and order claims carry side and Master leverage', () => {
  assert.match(migration, /'position_side',s\.position_side/);
  assert.match(migration, /target_leverage numeric,margin_mode text,position_mode text/);
  assert.match(migration, /clear_member_copy_baseline_legs/);
});
