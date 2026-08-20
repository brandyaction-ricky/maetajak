import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const migration = readFileSync(new URL('../supabase/migrations/202608210003_legal_acceptances.sql', import.meta.url), 'utf8');

test('signup exposes versioned terms and privacy documents', () => {
  assert.match(main, /서비스 이용약관/);
  assert.match(main, /개인정보 처리방침/);
  assert.match(main, /순실현수익의 10%/);
  assert.match(main, /MANUAL_OVERRIDE/);
  assert.match(main, /terms_version: LEGAL_VERSION/);
  assert.match(main, /privacy_version: LEGAL_VERSION/);
});

test('legal acceptance versions are persisted by the signup trigger', () => {
  assert.match(migration, /legal_acceptances/);
  assert.match(migration, /terms_version/);
  assert.match(migration, /privacy_version/);
  assert.match(migration, /raw_user_meta_data/);
});
