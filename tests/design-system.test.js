import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const main = readFileSync('src/main.js', 'utf8');
const index = readFileSync('index.html', 'utf8');
const theme = readFileSync('src/prototype-theme.css', 'utf8');

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

test('redundant member positions page is removed while dashboard positions remain', () => {
  assert.doesNotMatch(index, /data-page="member-positions"/);
  assert.doesNotMatch(index, /id="member-positions"/);
  assert.doesNotMatch(main, /'member-positions':/);
  assert.match(main, /memberOpenPositionCards/);
});

test('member copy positions and events use accessible tabs', () => {
  assert.match(main, /data-member-trade-tab="positions"/);
  assert.match(main, /data-member-trade-tab="events"/);
  assert.match(main, /data-member-trade-panel="positions"/);
  assert.match(main, /aria-selected/);
  assert.match(theme, /\.member-trade-tabs/);
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

test('redundant admin operational menus are removed at startup', () => {
  assert.doesNotMatch(main, /'admin-master':/);
  assert.doesNotMatch(main, /'admin-monitor':/);
  assert.doesNotMatch(main, /'admin-events':/);
  assert.ok(main.includes('document.querySelector(\'[data-page="admin-master"]\')?.remove()'));
  assert.ok(main.includes('document.querySelector(\'[data-page="admin-monitor"]\')?.remove()'));
  assert.ok(main.includes('document.querySelector(\'[data-page="admin-events"]\')?.remove()'));
});
