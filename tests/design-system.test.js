import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const main = readFileSync('src/main.js', 'utf8');
const design = readFileSync('src/design-system.css', 'utf8');
const bridge = readFileSync('src/design-system-bridge.css', 'utf8');
const index = readFileSync('index.html', 'utf8');
const theme = readFileSync('src/theme.css', 'utf8');

test('portable MAETAJAK design system is loaded after the legacy theme', () => {
  assert.ok(main.indexOf("import './theme.css'") < main.indexOf("import './design-system.css'"));
  assert.ok(main.indexOf("import './design-system.css'") < main.indexOf("import './design-system-bridge.css'"));
});

test('design tokens and existing application components are bridged', () => {
  for (const token of ['--ds-bg:', '--ds-surface-1:', '--ds-border:', '--ds-text-primary:', '--ds-green:', '--ds-red:']) {
    assert.match(design, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  for (const selector of ['.sidebar', '.top', '.card', '.btn', '.chip', '.table', '.status']) {
    assert.match(bridge, new RegExp(selector.replace('.', '\\.')));
  }
});

test('redundant member positions page is removed while dashboard positions remain', () => {
  assert.doesNotMatch(index, /data-page="member-positions"/);
  assert.doesNotMatch(index, /id="member-positions"/);
  assert.doesNotMatch(main, /'member-positions':/);
  assert.match(main, /memberOpenPositionCards/);
});

test('admin dashboard follows the member dashboard visual hierarchy', () => {
  assert.match(main, /admin-operations-kpis/);
  assert.match(main, /회원 누적 PNL/);
  assert.match(main, /Gate Broker 거래량/);
  assert.match(main, /admin-copy-health/);
  assert.match(theme, /\.admin-operations-main/);
  assert.match(theme, /\.admin-broker-chart/);
});
