import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const migration = readFileSync(
  new URL('../supabase/migrations/202608270003_pgcrypto_schema.sql', import.meta.url),
  'utf8',
);

const protectedFunctions = [
  'save_gate_api_credentials(text, text, text, boolean)',
  'save_admin_gate_api_credentials(text, text, text, boolean)',
  'claim_gate_api_verification_jobs(integer)',
  'get_copy_worker_context()',
  'claim_copy_order_intents(integer)',
  'claim_copy_reconciliation_jobs(integer)',
  'disable_my_gate_api_connection(text)',
  'disable_admin_master_gate_api_connection(text)',
];

test('pgcrypto-using security definer functions can resolve the managed extension', () => {
  for (const signature of protectedFunctions) {
    const escaped = signature.replace(/[()]/g, '\\$&');
    assert.match(
      migration,
      new RegExp(
        `alter function public\\.${escaped}\\s+set search_path = public, extensions, pg_temp`,
        'i',
      ),
      `missing hardened search_path for ${signature}`,
    );
  }
});

test('pg_temp remains last in every patched search path', () => {
  const statements = migration.match(/alter function[\s\S]*?pg_temp;/gi) ?? [];
  assert.equal(statements.length, protectedFunctions.length);
  for (const statement of statements) {
    assert.doesNotMatch(statement, /pg_temp\s*,/i);
  }
});
