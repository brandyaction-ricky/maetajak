import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const theme = readFileSync(new URL('../src/theme.css', import.meta.url), 'utf8');
const migration = readFileSync(new URL('../supabase/migrations/202608210002_member_monthly_performance.sql', import.meta.url), 'utf8');

test('member detail button opens protected monthly performance query', () => {
  assert.match(main, /data-member-detail=/);
  assert.match(main, /get_admin_member_monthly_performance/);
  assert.match(main, /p_months:\s*12/);
  assert.match(main, /Trading Worker 연결 후 실제 거래 데이터를 기준으로 자동 집계/);
});

test('member performance modal has desktop and mobile layouts', () => {
  assert.match(theme, /\.member-detail-modal/);
  assert.match(theme, /\.member-detail-summary\s*\{[^}]*grid-template-columns:\s*repeat\(4/s);
  assert.match(theme, /@media \(max-width: 950px\)[\s\S]*\.member-detail-summary\s*\{[^}]*grid-template-columns:\s*repeat\(2/s);
});

test('monthly performance data is worker-written and admin-protected', () => {
  assert.match(migration, /current_setting\('request\.jwt\.claim\.role'/);
  assert.match(migration, /SERVICE_ROLE_REQUIRED/);
  assert.match(migration, /if not public\.is_approved_admin\(\)/);
  assert.match(migration, /revoke insert, update, delete .* from public, anon, authenticated/);
  assert.match(migration, /grant execute on function public\.upsert_member_daily_performance[\s\S]*to service_role/);
});

test('monthly return compounds daily returns and reports net pnl', () => {
  assert.match(migration, /exp\(sum\(ln\(1 \+ performance\.daily_return_pct \/ 100\)\)\)/);
  assert.match(migration, /monthly\.realised_pnl - monthly\.fees \+ monthly\.funding_pnl/);
});
