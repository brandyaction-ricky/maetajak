import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const migration = fs.readFileSync(new URL('../supabase/migrations/202608280004_member_copy_onboarding_baseline.sql', import.meta.url), 'utf8');
const main = fs.readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../src/theme.css', import.meta.url), 'utf8');

test('new members persist a Master onboarding baseline while existing members keep prior behavior', () => {
  assert.match(migration, /member_copy_onboarding_baselines/);
  assert.match(migration, /alter table private\.member_copy_onboarding_baselines enable row level security/);
  assert.match(migration, /select id, '\[\]'::jsonb[\s\S]*account_role = 'MEMBER' and status = 'ACTIVE'/);
  assert.match(migration, /get_or_initialize_member_copy_baseline/);
  assert.match(migration, /clear_member_copy_baselines/);
  assert.match(migration, /create or replace function public\.update_my_copy_settings\(/);
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

test('dashboard omits the mixed fill and settlement performance card', () => {
  assert.doesNotMatch(main, /<h3>카피 거래 성과<\/h3>/);
});

test('open positions use a four-column desktop grid with symbol logos', () => {
  assert.match(main, /positionLogo\(position\.contract\)/);
  assert.match(css, /\.member-open-position-grid\s*\{[^}]*repeat\(4,/s);
  assert.match(css, /\.position-symbol-logo/);
});

test('copy settings expose only worker-backed risk controls and future-only onboarding policy', () => {
  assert.match(main, /연결 이후만 카피/);
  assert.match(main, /dailyLossLimitInput/);
  assert.match(main, /maxDrawdownInput/);
  assert.match(main, /copyRatioSelect" class="copy-range" type="range" min="50" max="200" step="10"/);
  assert.match(main, /maxPositionRatioSelect" class="copy-range" type="range" min="20" max="50" step="10"/);
  assert.match(main, /dailyLossLimitInput" type="number" value="15" disabled/);
  assert.match(main, /maxDrawdownInput" type="number" value="20" disabled/);
  assert.match(main, /maxLeverageInput/);
  assert.match(migration, /new_daily_loss_limit_pct/);
  assert.doesNotMatch(main, /Take Profit Per Position/);
});

test('risk limits are operator-fixed: members see disabled inputs and cannot send their own values', () => {
  const save = main.slice(main.indexOf('async function saveCopySettings'), main.indexOf('function escapeHtml'));
  assert.doesNotMatch(save, /dailyLossLimitInput|maxDrawdownInput/);
  assert.match(save, /currentProfile\.daily_loss_limit_pct/);
  assert.match(save, /currentProfile\.max_drawdown_pct/);
  assert.match(main, /운영자 고정/);
  const lock = fs.readFileSync(new URL('../supabase/migrations/20260924122342_fix_member_risk_limits_15_20.sql', import.meta.url), 'utf8');
  assert.match(lock, /alter column daily_loss_limit_pct set default 15/);
  assert.match(lock, /alter column max_drawdown_pct set default 20/);
  const fn = lock.slice(lock.indexOf('create or replace function public.update_my_copy_settings'));
  assert.ok(fn.length > 0);
  assert.doesNotMatch(fn, /daily_loss_limit_pct\s*=/);
  assert.doesNotMatch(fn, /max_drawdown_pct\s*=/);
});
