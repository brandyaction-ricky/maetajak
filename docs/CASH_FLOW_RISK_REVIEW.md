# Cash-flow-neutral drawdown review

Status: offline calculation draft. No worker integration, database migration,
risk-limit change, LIVE activation, or member resume is included.

## Confirmed defect

`TradingRunner.readAccount` calculates drawdown using the nominal historical
`peak_equity` and current account equity. `copy_current_accounts` preserves that
peak with `greatest(previous_peak, current_equity)`. Transfers out of the futures
wallet therefore look like investment losses. A later smaller deposit does not
repair the risk basis. The daily performance report records `dnw` cash movements,
but the risk check does not use those records. Daily opening equity has the same
cash-flow sensitivity and needs a separate boundary-aware treatment.

A raw balance decline is not evidence of trading loss. Conversely, evidence of
a withdrawal is not evidence that all earlier trading losses should be erased.
Resetting the peak to the latest deposit would remove legitimate risk history.

## Tested correction principle

The offline replay script tracks fund units and net asset value (NAV) per unit.
A deposit issues units at the pre-transfer NAV; a withdrawal redeems them. NAV
and its historical peak change only with investment performance. A full
withdrawal preserves the last NAV and peak while units are zero. Redepositing
does not erase an existing drawdown. A wiped-out investment remains subject to
review, even if fresh money arrives.

Run `node --test tests/cash-flow-drawdown-preview.test.js` for synthetic cases.
Run `node scripts/preview-cash-flow-drawdown.js <evidence.json>` for an offline
review. The CLI reads one local file and prints a simulation; it cannot access
the network, mutate the database, cancel orders or activate a member.

The baseline requires a positive account equity and a cash-flow-consistent peak
from a verified starting point. Replay events require strictly ordered times,
stable IDs and exchange references for external transfers. Exact duplicate
events are ignored; conflicting duplicates, incomplete ledgers and ambiguous
ordering are rejected. USDT dust at or below 1e-8 is treated as exhausted capital
only when a validated transfer accounts for it.

## Evidence still required for a production correction

1. Complete transfer ledger covering the period from the verified starting
   point through all withdrawals and redeposits, including periods missing from
   `member_daily_performance`. Day aggregates alone do not establish flow order.
2. Total equity immediately before and after each transfer. A wallet balance
   alone is insufficient with open positions because unrealised PnL is absent.
3. Replay reconciliation against actual account observations, including the
   pre-withdrawal balance and all trading PnL. Preserve prior genuine losses.
4. A durable, account-scoped risk state with deduplicated ledger IDs, atomic
   checkpoints, strict completeness/freshness checks and versioned migration.
5. Separate treatment for daily loss, midnight boundaries, fees, funding,
   missing pages, late ledger entries and concurrent transfers/order fills.
6. Worker and database integration tests showing that missing evidence continues
   to block activation, and that deployments never reset risk or auto-resume.

This draft deliberately does not calculate a corrected production drawdown from
an incomplete history, and does not modify the configured loss limits. Production
integration remains pending the verified ledger and equity evidence.
