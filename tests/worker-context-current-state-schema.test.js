import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const migration = readFileSync(
  new URL('../supabase/migrations/202609040001_worker_context_current_state.sql', import.meta.url),
  'utf8',
);

test('worker context reads risk baselines from bounded Current State', () => {
  assert.match(migration, /left join private\.copy_current_accounts current_account/i);
  assert.match(migration, /'day_start_equity', current_account\.day_start_equity/i);
  assert.match(migration, /'peak_equity', current_account\.peak_equity/i);
  assert.doesNotMatch(migration, /from private\.copy_account_snapshots/i);
});

test('worker context keeps service-role-only access', () => {
  assert.match(migration, /set search_path = public, extensions, pg_temp/i);
  assert.match(migration, /if auth\.role\(\) <> 'service_role'/i);
  assert.match(migration, /revoke all on function public\.get_copy_worker_context\(\) from public, anon, authenticated/i);
  assert.match(migration, /grant execute on function public\.get_copy_worker_context\(\) to service_role/i);
});

test('worker context keeps hedge legs and fill reconciliation side-specific', () => {
  assert.match(migration, /'position_side', state\.position_side/i);
  assert.match(migration, /intent\.position_side = state\.position_side/i);
  assert.match(migration, /order by state\.contract, state\.position_side/i);
});

test('worker context adds indexes for correlated order-state checks', () => {
  assert.match(migration, /copy_order_intents_account_contract_updated_idx/i);
  assert.match(migration, /include \(filled_size, status\)/i);
  assert.match(migration, /copy_order_intents_unresolved_account_contract_idx/i);
  assert.match(migration, /where status in \('SUBMITTING', 'ACKNOWLEDGED', 'PARTIALLY_FILLED', 'UNKNOWN'\)/i);
});
