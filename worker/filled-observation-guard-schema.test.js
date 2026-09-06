import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const migration = readFileSync(
  new URL('../supabase/migrations/202609060001_confirm_filled_order_observation.sql', import.meta.url),
  'utf8',
);

test('a filled order stays unresolved until its signed quantity is observed', () => {
  assert.match(migration, /intent\.status = 'FILLED'/);
  assert.match(migration, /state\.last_observed_at <= intent\.resolved_at/);
  assert.match(
    migration,
    /state\.actual_size\s*-\s*\(intent\.actual_size_at_plan \+ intent\.filled_size\)/,
  );
});

test('filled-order guards only consider orders from the current activation window', () => {
  assert.match(migration, /intent\.created_at >= control\.updated_at/);
  assert.match(migration, /cross join public\.copy_system_control control/);
});

test('the observation guard has a partial index for the worker hot path', () => {
  assert.match(migration, /copy_order_intents_filled_observation_guard_idx/);
  assert.match(migration, /where status = 'FILLED' and filled_size <> 0/);
});

test('the guard RPC exposes no exchange credentials', () => {
  assert.match(migration, /get_copy_order_observation_guards/);
  assert.doesNotMatch(migration, /api_key|secret_key|decrypted_secret|pgp_sym_decrypt/);
  assert.match(migration, /grant execute on function public\.get_copy_order_observation_guards\(\) to service_role/);
});
