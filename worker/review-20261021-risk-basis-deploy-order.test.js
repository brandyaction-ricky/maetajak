import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateAccountRisk, withRiskContext } from './trading-runner.js';

// Review 2026-10-21 (R3): the D5 worker evaluates risk on MTM equity (classic wallet + unrealised PnL). Peak and
// day-start are only on that basis after 20261021033000 has been applied AND the new worker has written one cycle.
// When get_copy_risk_context is unavailable (worker deployed before the migration, or the RPC failing since the
// worker started) riskContext stays null, withRiskContext() leaves stored_risk_basis unset and evaluateAccountRisk()
// compares MTM equity with WALLET-basis peak/day-start: every member with an open unrealised loss above the limit
// gets a (confirmed after 2-3 cycles, then sticky) DAILY_LOSS_LIMIT / MAX_DRAWDOWN_LIMIT.
// FIXED: until get_copy_risk_context loads, risk is evaluated on the wallet basis (todo marker removed).

// Wallet-basis row written by worker 0.5.0 / a DB without 20261021033000: day start = peak = wallet 1000.
const legacyContextMember = { trading_account_id: 'm1', day_start_equity: 1000, peak_equity: 1000, fund_flow_net: 0,
  daily_loss_limit_pct: 5, max_drawdown_pct: 15 };
// Gate classic summary now: wallet unchanged (nothing realised today), open position -8 % unrealised.
const summary = { total: 1000, available: 600, unrealisedPnl: -80, equityIncludesUnrealised: false };

test('R3 setup: with the basis known (RPC present, row still WALLET_V0) no decision is made', () => {
  const context = withRiskContext({ members: [legacyContextMember] },
    { risk_basis: 'MTM_V1', accounts: [{ trading_account_id: 'm1', risk_basis: 'WALLET_V0' }] });
  const risk = evaluateAccountRisk({ ...context.members[0], ...summary });
  assert.equal(risk.risk_halt_reason, null);
});

test('R3 without get_copy_risk_context the MTM equity is never compared with a wallet-basis day start', () => {
    const context = withRiskContext({ members: [legacyContextMember] }, null);
    const risk = evaluateAccountRisk({ ...context.members[0], ...summary });
    assert.equal(risk.risk_halt_reason, null, `daily_loss_pct=${risk.daily_loss_pct}`);
  });
