import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const theme = readFileSync(new URL('../src/theme.css', import.meta.url), 'utf8');
const migration = readFileSync(new URL('../supabase/migrations/202608210005_member_trading_analysis.sql', import.meta.url), 'utf8');

test('members and admins have dedicated trading analysis pages', () => {
  assert.match(main, /data-page="member-analysis">수익 분석/);
  assert.match(main, /data-page="admin-member-analysis">회원 수익 관리/);
  assert.match(main, /get_my_trading_analysis/);
  assert.match(main, /get_admin_member_trading_analysis/);
  assert.match(main, /일별 손익 캘린더/);
  assert.match(main, /종목별 실현손익/);
});

test('analysis starts at the copy start date and uses net realised pnl', () => {
  assert.match(migration, /copy_started_at/);
  assert.match(migration, /realised_pnl - performance\.fees \+ performance\.funding_pnl/);
  assert.match(migration, /started_on is null or performance\.trading_date >= started_on/);
  assert.match(migration, /if not public\.is_approved_admin\(\)/);
  assert.match(migration, /SERVICE_ROLE_REQUIRED/);
});

test('analysis cards and calendars reflow on mobile', () => {
  assert.match(theme, /\.analysis-calendar\s*\{[^}]*grid-template-columns:\s*repeat\(7/s);
  assert.match(theme, /@media \(max-width: 950px\)[\s\S]*\.analysis-metrics\s*\{[^}]*repeat\(2/s);
  assert.match(theme, /@media \(max-width: 950px\)[\s\S]*\.analysis-lower\s*\{[^}]*minmax\(0, 1fr\)/s);
});
