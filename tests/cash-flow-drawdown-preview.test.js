import test from 'node:test';
import assert from 'node:assert/strict';
import { previewCashFlowDrawdown as preview } from '../scripts/preview-cash-flow-drawdown.js';

const at = (seconds) => new Date(Date.UTC(2026, 0, 1, 0, 0, seconds)).toISOString();
const value = (seconds, equity) => ({ id: `v${seconds}`, at: at(seconds), type: 'valuation', equity });
const flow = (seconds, before, change, after = before + change) => ({ id: `f${seconds}`, at: at(seconds),
  type: 'transfer', equityBefore: before, change, equityAfter: after, ledgerReference: `TEST_ONLY_${seconds}` });
const run = (events, baseline = { equity: 10000, peakEquity: 10000, at: at(0) }) =>
  preview({ ledgerComplete: true, baseline, events });
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);

test('withdrawal and redeposit of less capital create no investment loss', () => {
  const result = run([flow(1, 10000, -10000), flow(2, 0, 1500), value(3, 1500)]);
  near(result.drawdownPct, 0);
  assert.equal(result.equity, 1500);
  assert.equal(result.operationalChanges, false);
});
test('partial withdrawal and additional deposit do not change existing drawdown', () => {
  const result = run([value(1, 9000), flow(2, 9000, -4500), flow(3, 4500, 9000)]);
  near(result.drawdownPct, 10);
  near(result.trace[1].drawdownPct, 10);
});
test('full withdrawal and redeposit must not erase actual pre-withdrawal losses', () => {
  const result = run([value(1, 7000), flow(2, 7000, -7000), flow(3, 0, 1500)]);
  near(result.drawdownPct, 30);
  assert.ok(result.drawdownPct > 20);
});
test('fresh trading loss after redeposit is measured against the preserved NAV peak', () => {
  near(run([flow(1, 10000, -10000), flow(2, 0, 1500), value(3, 1350)]).drawdownPct, 10);
});
test('profits before a transfer raise the NAV peak and later losses remain visible', () => {
  const result = run([flow(1, 12000, -6000), value(2, 5400)]);
  near(result.peakUnitNav, 1.2);
  near(result.drawdownPct, 10);
});
test('dust left by a full withdrawal does not distort a later deposit', () => {
  const dust = 9.793e-9;
  const result = run([flow(1, 10000, -10000 + dust, dust), value(2, dust), flow(3, dust, 1500), value(4, 1500 + dust)]);
  near(result.drawdownPct, 0);
});
test('an already verified baseline drawdown survives transfers', () => {
  near(run([flow(1, 8000, -8000), flow(2, 0, 1000)], { equity: 8000, peakEquity: 10000, at: at(0) }).drawdownPct, 20);
});
test('exact duplicate transfer observations are applied once; conflicts are rejected', () => {
  const f = flow(1, 10000, -5000);
  const result = run([f, { ...f, change: '-5000' }, value(2, 5000)]);
  assert.equal(result.eventsApplied, 2);
  assert.equal(result.withdrawals, 5000);
  assert.throws(() => run([f, { ...f, ledgerReference: 'DIFFERENT' }]), /CONFLICTING_DUPLICATE/);
});
test('incomplete historical ledger cannot manufacture a corrected risk number', () => {
  assert.throws(() => preview({ ledgerComplete: false }), /INCOMPLETE_CASH_FLOW_EVIDENCE/);
  assert.throws(() => run([], { equity: 0, peakEquity: 10000, at: at(0) }), /INVALID_BASELINE/);
});
test('ambiguous order, unsupported events and missing provenance fail closed', () => {
  assert.throws(() => run([value(2, 9000), value(1, 9000)]), /OUT_OF_ORDER/);
  assert.throws(() => run([value(1, 9000), flow(1, 9000, -1000)]), /AMBIGUOUS/);
  assert.throws(() => run([{ ...value(1, 9000), type: 'rebate' }]), /UNSUPPORTED/);
  assert.throws(() => run([{ ...flow(1, 10000, -1000), ledgerReference: null }]), /MISSING_LEDGER/);
});
test('invalid or inconsistent amounts cannot be treated as zero cash flows', () => {
  for (const equity of [null, undefined, '', true, Infinity, NaN]) {
    assert.throws(() => run([value(1, equity)]), /INVALID_AMOUNT/);
  }
  assert.throws(() => run([flow(1, 10000, -5000, 9000)]), /TRANSFER_EQUITY_MISMATCH/);
  assert.throws(() => run([flow(1, 10000, -11000)]), /TRANSFER_EQUITY_MISMATCH/);
  assert.throws(() => run([value(1, -1)]), /NEGATIVE_EQUITY/);
});
test('loss of all capital cannot be erased by a new deposit', () => {
  near(run([value(1, 0)]).drawdownPct, 100);
  assert.throws(() => run([value(1, 0), flow(2, 0, 1500)]), /CAPITAL_LOSS_REQUIRES_REVIEW/);
});
test('unexplained balance reappearance after withdrawal cannot be counted as trading profit', () => {
  assert.throws(() => run([flow(1, 10000, -10000), value(2, 1500)]), /UNEXPLAINED_EQUITY/);
});
test('equivalent capital scales produce the same drawdown', () => {
  for (const scale of [0.01, 1, 1000]) {
    const result = run([value(1, 8000 * scale), flow(2, 8000 * scale, -4000 * scale),
      flow(3, 4000 * scale, 10000 * scale), value(4, 12600 * scale)],
    { equity: 10000 * scale, peakEquity: 10000 * scale, at: at(0) });
    near(result.drawdownPct, 28);
  }
});
