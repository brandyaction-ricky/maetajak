import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const theme = readFileSync(new URL('../src/theme.css', import.meta.url), 'utf8');
const migration = readFileSync(new URL('../supabase/migrations/202608210005_member_trading_analysis.sql', import.meta.url), 'utf8');
const rangeMigration = readFileSync(new URL('../supabase/migrations/202608290005_admin_profit_range_and_master_pnl.sql', import.meta.url), 'utf8');

test('members and admins have dedicated trading analysis pages', () => {
  assert.match(main, /data-page="member-analysis">수익 분석/);
  assert.match(main, /data-page="admin-member-analysis">수익 관리/);
  assert.match(main, /get_my_trading_analysis/);
  assert.match(main, /get_admin_member_trading_analysis/);
  assert.match(main, /일별 손익 캘린더/);
  assert.doesNotMatch(main, /종목별 실현손익/);
});

test('admin profit management supports direct member and date-range selection', () => {
  assert.match(main, /data-analysis-member/);
  assert.match(main, /data-analysis-range="30"/);
  assert.match(main, /adminAnalysisStartDate/);
  assert.match(main, /get_admin_member_trading_analysis_range/);
  assert.match(rangeMigration, /trading_date between range_start and range_end/);
  assert.match(rangeMigration, /realised_pnl - performance\.fees \+ performance\.funding_pnl/);
  assert.match(rangeMigration, /DATE_RANGE_TOO_LARGE/);
  assert.doesNotMatch(main, /adminAnalysisMemberSort/);
  assert.doesNotMatch(main, /회원 순서/);
  assert.match(main, /renderAdminAnalysisMembers/);
});

test('member and admin profit management omit secondary metrics and ranking', () => {
  assert.doesNotMatch(main, /id="analysisProfitFactor"/);
  assert.doesNotMatch(main, /id="analysisFeesFunding"/);
  assert.doesNotMatch(main, /id="analysisSymbols"/);
  assert.doesNotMatch(main, /PNL RANKING/);
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

test('symbol rankings are pruned to the latest Gate snapshot', () => {
  const runner = readFileSync(new URL('../worker/trading-runner.js', import.meta.url), 'utf8');
  const syncMigration = readFileSync(new URL('../supabase/migrations/202608290003_sync_copy_performance.sql', import.meta.url), 'utf8');
  assert.match(runner, /prune_member_symbol_daily_performance/);
  assert.match(syncMigration, /delete from public\.member_symbol_daily_performance/);
  assert.match(syncMigration, /trim\(contract\)/);
});
