import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const main = readFileSync('src/main.js', 'utf8');
const index = readFileSync('index.html', 'utf8');
const theme = readFileSync('src/prototype-theme.css', 'utf8');
const memberPositionMigration = readFileSync('supabase/migrations/202609020001_admin_member_position_selector.sql', 'utf8');

test('uploaded prototype is the single active visual theme', () => {
  assert.match(main, /import '\.\/prototype-theme\.css'/);
  assert.doesNotMatch(main, /import '\.\/theme\.css'/);
  assert.doesNotMatch(main, /design-system(?:-bridge)?\.css/);
  assert.match(main, /document\.head\.querySelector\(':scope > style'\)\?\.remove\(\)/);
});

test('prototype tokens and application components use the uploaded visual language', () => {
  for (const token of ['--bg:', '--panel:', '--line:', '--text:', '--green:', '--red:']) {
    assert.match(theme, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  for (const selector of ['.sidebar', '.top', '.card', '.btn', '.chip', '.table', '.status']) {
    assert.match(theme, new RegExp(selector.replace('.', '\\.')));
  }
});

test('member copy settings keep aligned cards and styled numeric controls', () => {
  assert.match(theme, /\.copy-settings-primary \{ grid-template-rows:/);
  assert.match(theme, /\.copy-settings-secondary \{ grid-template-rows:/);
  assert.match(theme, /\.copy-risk-inputs input\[type="number"\]/);
  assert.match(theme, /color-scheme: dark/);
  assert.match(theme, /\.copy-existing-policy \{[^}]*align-items: flex-start/s);
});

test('member dashboard positions use the prototype card layout', () => {
  assert.match(theme, /\.member-open-position-grid \{[^}]*repeat\(4,/s);
  for (const selector of ['.member-position-card-head', '.member-position-pnl', '.member-position-metrics', '.member-exposure']) {
    assert.match(theme, new RegExp(selector.replace('.', '\\.')));
  }
});

test('profit analysis omits settlement count labels', () => {
  assert.doesNotMatch(main, /이익 정산/);
  assert.doesNotMatch(main, /손실 정산/);
  assert.doesNotMatch(main, /analysisWinCount|analysisLossCount/);
});

test('member analysis calendar has a styled monthly selector', () => {
  assert.match(main, /id="analysisMonthSelect" type="month"/);
  assert.match(main, /memberTradingAnalysisData/);
  assert.match(main, /event\.target\.id === 'analysisMonthSelect'/);
  assert.match(theme, /\.analysis-month-control input/);
  assert.match(theme, /\.analysis-calendar-head/);
});

test('redundant member positions page is removed while dashboard positions remain', () => {
  assert.doesNotMatch(index, /data-page="member-positions"/);
  assert.doesNotMatch(index, /id="member-positions"/);
  assert.doesNotMatch(main, /'member-positions':/);
  assert.match(main, /memberOpenPositionCards/);
});

test('redundant member copy events are removed while current copy positions remain', () => {
  assert.match(main, /memberTradePositions/);
  assert.doesNotMatch(main, /data-member-trade-tab/);
  assert.doesNotMatch(main, /memberLiveEvents/);
  assert.doesNotMatch(main, /member-copy-events/);
  assert.doesNotMatch(theme, /\.member-copy-events/);
  assert.doesNotMatch(theme, /\.member-trade-tabs/);
});

test('member details are separated into accessible tabs', () => {
  for (const tab of ['overview', 'performance', 'security']) {
    assert.match(main, new RegExp(`data-member-detail-tab="${tab}"`));
    assert.match(main, new RegExp(`data-member-detail-panel="${tab}"`));
  }
  assert.match(main, /function setMemberDetailTab/);
  assert.match(theme, /\.member-detail-tabs/);
});

test('audit log is presented in clear Korean labels', () => {
  assert.match(main, /'admin-audit': \['감사 기록'/);
  assert.match(main, /회원 승인 상태 변경/);
  assert.match(main, /상세 변경/);
  assert.doesNotMatch(main, /<h3>Audit Log<\/h3>/);
});

test('admin dashboard consolidates full current positions and removes legacy sections', () => {
  assert.match(main, /admin-operations-kpis/);
  assert.match(main, /admin-dashboard-positions/);
  assert.match(main, /adminMasterPositionCards/);
  assert.match(main, /data-master-filter="LONG"/);
  assert.doesNotMatch(main, /admin-operations-main/);
  assert.doesNotMatch(main, /admin-broker-panel/);
  assert.doesNotMatch(main, /openPage\('admin-master'\)/);
});

test('admin dashboard applies compact prototype status and KPI styling', () => {
  assert.match(theme, /\.admin-live-status time \{[^}]*font-size: 10px/s);
  assert.match(theme, /\.admin-operations-kpis \.kpi \{/);
  assert.match(theme, /\.admin-dashboard-positions/);
  assert.match(theme, /@media \(max-width: 820px\)[\s\S]*\.admin-live-status \{[^}]*flex-direction: column/s);
});

test('admin custom date range stays compact and stacks on mobile', () => {
  assert.match(theme, /\.admin-date-range \{[^}]*width: fit-content/s);
  assert.match(theme, /\.admin-date-range input \{[^}]*width: 164px/s);
  assert.match(theme, /\.admin-date-range \.btn \{[^}]*min-height: 38px/s);
  assert.match(theme, /@media \(max-width: 820px\)[\s\S]*\.admin-date-range[^}]*flex-direction: column/s);
});

test('admin dashboard can switch from Master to member positions', () => {
  assert.match(main, /id="adminPositionOwner"/);
  assert.match(main, /data\?\.member_positions/);
  assert.match(main, /data\?\.position_members/);
  assert.match(main, /adminPositionOwner = event\.target\.value/);
  assert.match(theme, /\.admin-position-controls/);
  assert.match(theme, /\.admin-position-owner select/);
  assert.match(memberPositionMigration, /if not public\.is_approved_admin\(\)/);
  assert.match(memberPositionMigration, /'member_positions'/);
  assert.match(memberPositionMigration, /'position_members'/);
  assert.match(memberPositionMigration, /position\.account_snapshot_id=snapshot\.id and position\.size<>0/);
});

test('mobile header keeps the hamburger aligned with title copy', () => {
  assert.match(theme, /@media \(max-width: 820px\)[\s\S]*\.top-leading > \.mobile \{[^}]*width: 36px/s);
  assert.match(theme, /\.top-copy h2 \{[^}]*text-overflow: ellipsis/s);
  assert.match(theme, /\.top-copy small \{[^}]*white-space: nowrap/s);
});

test('admin operational pages use consistent section spacing', () => {
  assert.match(theme, /#admin-api\.page\.active, #admin-settings\.page\.active \{[^}]*display: grid;[^}]*gap: 12px/s);
  assert.match(theme, /\.operations-grid \{[^}]*gap: 12px;[^}]*margin: 0/s);
  assert.match(theme, /\.operations-emergency, \.operations-note \{[^}]*margin: 0/s);
  assert.match(main, /class="card section admin-api-connections"/);
  assert.doesNotMatch(main, /style="margin-top:14px"/);
});

test('member live status keeps copy metadata and action compact', () => {
  assert.match(theme, /\.dashboard-live-meta \{[^}]*align-items: center;[^}]*gap: 10px/s);
  assert.match(theme, /\.dashboard-live-meta \.btn \{[^}]*min-height: 34px/s);
  assert.match(theme, /@media \(max-width: 820px\)[\s\S]*\.dashboard-live-meta \{[^}]*width: calc\(100% - 19px\)/s);
});

test('admin profit filters share a compact aligned control row', () => {
  assert.match(main, /class="admin-analysis-preset-field"/);
  assert.doesNotMatch(main, /id="adminAnalysisMemberSort"/);
  assert.match(theme, /\.admin-analysis-dates \{[^}]*margin-bottom: 0/s);
  assert.match(theme, /\.admin-analysis-dates input \{[^}]*width: 164px/s);
  assert.match(theme, /\.admin-analysis-presets button \{[^}]*min-height: 32px/s);
});

test('member detail tabs share styled responsive panels', () => {
  assert.match(theme, /\.member-detail-modal \{[^}]*width: min\(920px, 100%\);[^}]*padding: 22px/s);
  assert.match(theme, /\.member-detail-summary \.member-control-actions \{[^}]*grid-column: 1 \/ -1/s);
  assert.match(theme, /\.member-performance-table \{[^}]*min-width: 680px/s);
  assert.match(theme, /\.member-password-reset-actions \{[^}]*grid-template-columns: minmax\(0, 1fr\) auto/s);
  assert.match(theme, /@media \(max-width: 560px\)[\s\S]*\.member-detail-tabs \{[^}]*repeat\(3,/s);
});

test('redundant admin operational menus are removed at startup', () => {
  assert.doesNotMatch(main, /'admin-master':/);
  assert.doesNotMatch(main, /'admin-monitor':/);
  assert.doesNotMatch(main, /'admin-events':/);
  assert.ok(main.includes('document.querySelector(\'[data-page="admin-master"]\')?.remove()'));
  assert.ok(main.includes('document.querySelector(\'[data-page="admin-monitor"]\')?.remove()'));
  assert.ok(main.includes('document.querySelector(\'[data-page="admin-events"]\')?.remove()'));
});
