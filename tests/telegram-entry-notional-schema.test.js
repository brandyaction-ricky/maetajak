import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const migration = readFileSync(
  new URL('../supabase/migrations/20260909034000_entry_alert_usdt_notional.sql', import.meta.url),
  'utf8',
);

test('entry Telegram payload reports USDT notional instead of contract quantity', () => {
  assert.match(migration, /abs\(new\.filled_size\) \* new\.average_fill_price \* contract_multiplier/);
  assert.match(migration, /'체결 금액 \(USDT\)'/);
  assert.doesNotMatch(migration, /'filled_size',abs\(new\.filled_size\)/);
});
