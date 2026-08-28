import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const migration = fs.readFileSync(new URL('../supabase/migrations/202608280004_member_copy_onboarding_baseline.sql', import.meta.url), 'utf8');
const main = fs.readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../src/theme.css', import.meta.url), 'utf8');

test('new members persist a Master onboarding baseline while existing members keep prior behavior', () => {
  assert.match(migration, /member_copy_onboarding_baselines/);
  assert.match(migration, /select id, '\[\]'::jsonb[\s\S]*account_role = 'MEMBER' and status = 'ACTIVE'/);
  assert.match(migration, /get_or_initialize_member_copy_baseline/);
  assert.match(migration, /clear_member_copy_baselines/);
});

test('member dashboard reads real performance, margin usage, and open positions', () => {
  assert.match(migration, /get_my_dashboard_performance/);
  assert.match(migration, /margin_usage_pct/);
  assert.match(migration, /'open_positions'/);
  assert.match(main, /data-dashboard-range="\$\{days\}"/);
  assert.match(main, /memberPerformanceChart/);
  assert.match(main, /memberOpenPositionCards/);
  assert.match(css, /\.member-open-position-grid/);
});

test('copy settings expose only worker-backed risk controls and future-only onboarding policy', () => {
  assert.match(main, /연결 이후만 카피/);
  assert.match(main, /dailyLossLimitInput/);
  assert.match(main, /maxDrawdownInput/);
  assert.match(main, /maxLeverageInput/);
  assert.match(migration, /new_daily_loss_limit_pct/);
  assert.doesNotMatch(main, /Take Profit Per Position/);
});
