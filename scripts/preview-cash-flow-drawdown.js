// Offline review only. This module does not access the exchange/database and is
// intentionally not imported by the live worker. Input evidence must be checked
// against the exchange ledger before any production risk migration is designed.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const DUST = 1e-8;
function fail(code) { throw new Error(code); }
function numeric(value) {
  if (value === null || value === undefined || typeof value === 'boolean'
    || (typeof value === 'string' && !value.trim())) fail('INVALID_AMOUNT');
  const n = Number(value);
  if (!Number.isFinite(n)) fail('INVALID_AMOUNT');
  return n;
}
function timestamp(value) {
  if (typeof value !== 'string' || !/(Z|[+-]\d{2}:\d{2})$/.test(value)) fail('INVALID_TIMESTAMP');
  const t = Date.parse(value);
  if (!Number.isFinite(t)) fail('INVALID_TIMESTAMP');
  return t;
}
function equal(a, b) { return Math.abs(a - b) <= Math.max(DUST, Math.abs(a) * 1e-12, Math.abs(b) * 1e-12); }

/**
 * Replay an explicitly complete sequence of equity observations and external
 * cash flows. Transfers buy/redeem units at the immediately preceding unit NAV.
 * They do not change NAV, its high-water mark, or an existing trading drawdown.
 *
 * equityBefore must include unrealised PnL immediately before each transfer.
 * A wallet-only account-book balance cannot stand in for total equity while
 * positions are open. Event IDs are caller-normalised stable exchange IDs.
 * Full withdrawal preserves the last NAV and peak; redeposit is not a reset.
 */
export function previewCashFlowDrawdown(input) {
  if (input?.ledgerComplete !== true) fail('INCOMPLETE_CASH_FLOW_EVIDENCE');
  if (!input.baseline || !Array.isArray(input.events)) fail('INVALID_INPUT');
  let equity = numeric(input.baseline.equity);
  const peakEquity = numeric(input.baseline.peakEquity);
  if (!(equity > DUST) || peakEquity < equity) fail('INVALID_BASELINE');
  // Baseline peakEquity must already have a consistent cash-flow basis. The
  // raw production all-time peak is not automatically a valid replay seed.
  let lastAt = timestamp(input.baseline.at);
  let nav = 1;
  let units = equity;
  let peakNav = peakEquity / equity;
  let deposits = 0; let withdrawals = 0;
  const seen = new Map();
  const trace = [];
  const mark = (value) => {
    if (value < 0) fail('NEGATIVE_EQUITY_REQUIRES_REVIEW');
    if (units === 0) {
      if (Math.abs(value) > DUST) fail('UNEXPLAINED_EQUITY_WITHOUT_CAPITAL');
    } else {
      nav = value / units;
      peakNav = Math.max(peakNav, nav);
    }
    equity = value;
  };
  for (const event of input.events) {
    if (typeof event?.id !== 'string' || !event.id.trim()) fail('MISSING_EVENT_ID');
    const at = timestamp(event.at);
    const type = event.type;
    if (!['valuation', 'transfer'].includes(type)) fail('UNSUPPORTED_EVENT_TYPE');
    const normalized = type === 'valuation'
      ? { at, type, equity: numeric(event.equity) }
      : { at, type, change: numeric(event.change), before: numeric(event.equityBefore),
        after: numeric(event.equityAfter), reference: event.ledgerReference };
    const signature = JSON.stringify(normalized);
    if (seen.has(event.id)) {
      if (seen.get(event.id) !== signature) fail('CONFLICTING_DUPLICATE_EVENT');
      continue;
    }
    if (at <= lastAt) fail('AMBIGUOUS_OR_OUT_OF_ORDER_EVENT');
    if (type === 'valuation') {
      mark(normalized.equity);
    } else {
      if (typeof normalized.reference !== 'string' || !normalized.reference.trim()) fail('MISSING_LEDGER_REFERENCE');
      const { before, after, change } = normalized;
      if (before < 0 || after < 0 || change === 0 || !equal(after, before + change)) fail('TRANSFER_EQUITY_MISMATCH');
      // Account for trading PnL since the previous observation before changing
      // units. Never attribute the whole equity change to the transfer.
      mark(before);
      if (!(nav > 0)) fail('CAPITAL_LOSS_REQUIRES_REVIEW');
      if (units === 0 && change < 0) fail('WITHDRAWAL_WITHOUT_CAPITAL');
      const nextUnits = units + change / nav;
      if (nextUnits < 0 && Math.abs(nextUnits * nav) > DUST) fail('EXCESS_WITHDRAWAL');
      // USDT settlement dust must not manufacture a near-infinite unit price
      // when capital is later returned to a fully withdrawn account.
      units = Math.abs(after) <= DUST ? 0 : nextUnits;
      if (units < 0 || !Number.isFinite(units)) fail('INVALID_UNIT_BALANCE');
      equity = units === 0 ? 0 : after;
      if (change > 0) deposits += change; else withdrawals -= change;
    }
    if (![equity, nav, peakNav, units, deposits, withdrawals].every(Number.isFinite)) fail('NONFINITE_CALCULATION');
    seen.set(event.id, signature);
    lastAt = at;
    trace.push({ id: event.id, at: event.at, type, equity, unitNav: nav,
      peakUnitNav: peakNav, drawdownPct: Math.max(0, (peakNav - nav) / peakNav * 100) });
  }
  return { mode: 'OFFLINE_PREVIEW', operationalChanges: false, equity,
    unitNav: nav, peakUnitNav: peakNav,
    drawdownPct: Math.max(0, (peakNav - nav) / peakNav * 100),
    deposits, withdrawals, eventsApplied: seen.size, trace };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 3) fail('USAGE: node scripts/preview-cash-flow-drawdown.js <evidence.json>');
    const input = JSON.parse(readFileSync(process.argv[2], 'utf8'));
    process.stdout.write(`${JSON.stringify(previewCashFlowDrawdown(input), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
