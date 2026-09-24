import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const migration = readFileSync(new URL('../supabase/migrations/202609010001_admin_operations_metrics.sql', import.meta.url), 'utf8');
const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');

test('admin operations metrics are admin-only and sourced from actual worker ledgers', () => {
  assert.match(migration, /security definer/i);
  assert.match(migration, /public\.is_approved_admin\(\)/i);
  assert.match(migration, /private\.copy_account_snapshots/i);
  assert.match(migration, /public\.member_daily_performance/i);
  assert.match(migration, /sum\(performance\.trading_volume\)/i);
  assert.match(migration, /sum\(performance\.fees\)/i);
  assert.doesNotMatch(migration, /generate_series|random\(\)/i);
  assert.match(migration, /revoke all on function public\.get_admin_operations_metrics/i);
});

test('admin dashboard keeps real member metrics after broker section removal', () => {
  assert.match(main, /get_admin_operations_metrics/);
  assert.doesNotMatch(main, /adminBrokerVolume/);
  assert.doesNotMatch(main, /adminBrokerFees/);
  assert.match(main, /adminTotalAssets/);
  assert.match(main, /adminPeriodPnl/);
  assert.match(main, /adminMembersCache/);
});

test('admin member table shows current equity next to the balance and pins the Master account', () => {
  const current = readFileSync(new URL('../supabase/migrations/20260924123930_admin_metrics_current_equity.sql', import.meta.url), 'utf8');
  assert.match(current, /security definer/i);
  assert.match(current, /public\.is_approved_admin\(\)/i);
  // classic Gate balance excludes unrealised PnL; unified equity already includes it
  assert.match(current, /when account\.equity_includes_unrealised then account\.total_equity\s+else account\.total_equity \+ coalesce\(account\.unrealised_pnl, 0\)/);
  assert.match(current, /'current_equity', current_equity/);
  assert.match(current, /'master', \(select jsonb_build_object/);
  assert.match(current, /equity\.account_role = 'MASTER'/);
  assert.match(main, /<th title="거래소 잔고 · 미실현 손익 제외">총 자산<\/th><th title="총 자산 \+ 미실현 손익">현재 자산<\/th>/);
  assert.match(main, /renderAdminEquityCells\(member\)/);
  assert.match(main, /renderAdminMasterRow\(adminMasterAccount\)/);
  assert.match(main, /adminMasterAccount = data\?\.master \|\| null/);
  assert.match(main, /<tbody id="memberList"><tr><td colspan="10"/);
  assert.match(main, /<tr><td colspan="10" class="empty-cell">조건에 맞는 회원이 없습니다\./);
});
