# Copy engine architecture

## Scope

This phase establishes the copy-trading control plane and deterministic calculation engine. Live Gate.io order submission stays disabled until the fixed-IP Trading Worker, TESTNET run, administrator reauthentication, alerting, and rollback procedure are ready.

## Position model

1. The Worker reads the Master's actual Futures account equity and actual positions.
2. For every contract, it calculates the Master's signed exposure ratio:

   `master size × mark price × quanto multiplier ÷ master equity`

3. The member target notional is:

   `member equity × master exposure ratio × member copy ratio`

4. The target is capped by the member's Maximum Position Ratio and converted to Gate contract size, rounded toward zero to the contract step.
5. The engine compares target size with the member's actual size and plans only the delta order.

These equity calculations initialize a target and handle Master increases. Once a
target anchor exists for the current resume version, unchanged Master quantity
keeps the anchored target; a stricter current risk cap may reduce it.

For a reduction on the same Master position side, scale the copied quantity
actually held, bounded by the previous anchored target:

`copied basis = signed min(abs(previous target - protected holdings), max(0, abs(actual holdings) - abs(protected holdings)))`

`new target = protected holdings + round_to_step(copied basis × abs(new Master copyable size / previous Master copyable size))`

A Master reduction from 100 to 50 therefore reduces an anchored 50-contract copy
to 25, even when account equities have changed. The current risk cap may reduce
copied exposure further. A full close leaves only holdings protected at resume.
The reduced target is persisted in the existing atomic cycle/anchor transaction,
so later equity recovery alone cannot buy it back. LONG and SHORT legs use the
same proportional rule independently.

If only 30 of the intended 50 contracts filled, a 50% Master reduction targets
15 contracts. If the original entry never filled, the reduction cannot create a
late entry. Unresolved orders freeze anchor updates until position evidence is
confirmed, so the Master reduction remains available for the next valid plan.

The ratio is **notional exposure / equity**, not margin / equity. For a $20,000
Master holding $2,000 notional and a $5,000 member at 100% copy ratio, the target
is $500 notional (10% for both), before exchange rounding and risk limits.
Leverage is not multiplied into quantity a second time. The existing policy
copies Master leverage/margin mode for new holdings; protected existing holdings
retain their leverage. Different leverage therefore implies different margin
usage even when nominal exposure ratios match.

Use one reference mark price for the same Gate contract. A difference in entry
price or asynchronous member mark price must not generate extra contracts.
The latest member mark still governs risk caps. LONG and SHORT notionals count
gross toward the same per-symbol cap, including protected positions. Planned
increases reserve one shared available-margin budget, with configured slippage
and contract taker fees. Unfilled reductions do not fund a new entry. A cap or
insufficient balance is recorded in `sizing_reason`; minimum/chunking decisions
are recorded in `execution_reason`. An affordability cap stays anchored until
the Master quantity changes, so a deposit alone does not buy a missed entry.

A difference of exactly one contract step requires reconciliation, including the
last tradable contract on a close. Decimal subtraction noise is normalized within
machine precision before rounding; genuinely sub-step and below-minimum orders
remain non-executable. This does not guarantee liquidation of exchange dust below
the minimum order size.

No Master order is copied directly. Position reconciliation computes a fresh
delta only after outstanding orders and post-fill observations are resolved;
an ambiguous submission is never blindly replayed.

## State priority

The first matching state wins:

1. `HALTED`: system or member kill switch
2. `ERROR`: API/data/risk calculation failure
3. `MANUAL_OVERRIDE`: actual-position movement cannot be explained by maetajak-tagged fills; the contract is paused as a consequence
4. `PAUSED`: member or administrator paused the contract without a detected manual position change
5. `REDUCE_ONLY`: risk threshold permits exposure reduction only
6. `SYNCED`: target and actual match or differ by less than one contract step
7. `DRIFT`: a delta order is required

`MANUAL_OVERRIDE`, `PAUSED`, `ERROR`, and `HALTED` never create an order intent. `REDUCE_ONLY` only permits an order that reduces absolute exposure without reversing direction.

## Manual override

Every maetajak order uses a deterministic `t-mtj-...` Gate order text. At reconciliation:

`expected actual = previous actual + confirmed maetajak fill delta`

If the current actual position differs from the expected value beyond the contract tolerance and there is no unresolved maetajak order, the engine records `MANUAL_OVERRIDE`, pauses that member/contract, and does not re-enter automatically. The first observation creates a baseline and is never treated as an override.

## Idempotency and UNKNOWN orders

- An intent is unique for `(cycle, member account, contract, position side)`.
- Its SHA-256 idempotency key and Gate order text are deterministic.
- Network timeout never means retry immediately. The intent becomes `UNKNOWN` and a reconciliation job queries Gate by order ID/text before any retry.
- All submission attempts have a request fingerprint and a redacted response record.
- A custom Gate `text` is a lookup key, not an exchange idempotency guarantee.
- Only one unsettled order can be claimed per member account across symbols.
  Database advisory locks and the account guard serialize independent workers.
- Each submission re-reads Master and member holdings, open orders and available
  funds, checks the claimed quantities, then consumes one database authorization.
- Timeout, disconnected response, HTTP 408/429/5xx and malformed success bodies
  remain uncertain. Lookup uses the original ID/text and paged order history.
- Exchange completion and reconciliation persistence errors propagate without
  issuing a second failure update that could erase a committed fill.

## Verified Current State and alerts (worker 0.5.0, schema 3)

`record_verified_copy_worker_cycle` atomically writes and compares the complete
Gate observation, engine actual/target state, Current State, anchors and intents.
A mismatch rolls back the transaction. A failed member read preserves previous
holdings with verification status ERROR. Flat positions still produce zero
engine observations, preventing stale DB holdings after full closure. Every
claim requires a fresh verified cycle; authorization also compares its Current
State quantities. `npm run worker:audit` independently re-reads Gate and reports
disagreements, staleness, open orders and pending fill observations without writes.

The equality guarantee applies to a recorded observation. A remote exchange fill
cannot share a PostgreSQL transaction: two later position reads, at least two
seconds apart, confirm the new holdings before the account may order again.

Terminal entries, reductions and unfilled outcomes use a durable alert outbox.
Before sending a trade notification, query the exact Gate order and its trades;
check identity, signed requested size, status and filled quantity. Derive USDT
from actual average fill price and the contract multiplier saved with the intent.
The payload includes member, symbol, LONG/SHORT, BUY/SELL, filled USDT, fill price,
result, reason and Gate order ID. Local preflight rejections are explicitly marked
as having no confirmed exchange fill. An uncertain submission sends a warning,
without claiming zero fills or successful execution. Telegram delivery requires
`ok: true` and a message ID. Outbox retries can repeat a notification after a lost
Telegram/DB acknowledgement; they never cause an order retry.

## Safe activation gates

The database migration creates the global control as:

- `execution_enabled = false`
- `emergency_halted = true`
- `halt_reason = TRADING_WORKER_NOT_CONFIGURED`

Browser RPCs cannot enable execution. Activation requires a deployment-only procedure after fixed-IP Worker provisioning and Gate TESTNET QA.
