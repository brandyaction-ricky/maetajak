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

No Master order is copied directly. A missed event or Worker restart is repaired by the next position reconciliation.

## State priority

The first matching state wins:

1. `HALTED`: system or member kill switch
2. `ERROR`: API/data/risk calculation failure
3. `MANUAL_OVERRIDE`: actual-position movement cannot be explained by maetajak-tagged fills; the contract is paused as a consequence
4. `PAUSED`: member or administrator paused the contract without a detected manual position change
5. `REDUCE_ONLY`: risk threshold permits exposure reduction only
6. `SYNCED`: target and actual are within tolerance
7. `DRIFT`: a delta order is required

`MANUAL_OVERRIDE`, `PAUSED`, `ERROR`, and `HALTED` never create an order intent. `REDUCE_ONLY` only permits an order that reduces absolute exposure without reversing direction.

## Manual override

Every maetajak order uses a deterministic `t-mtj-...` Gate order text. At reconciliation:

`expected actual = previous actual + confirmed maetajak fill delta`

If the current actual position differs from the expected value beyond the contract tolerance and there is no unresolved maetajak order, the engine records `MANUAL_OVERRIDE`, pauses that member/contract, and does not re-enter automatically. The first observation creates a baseline and is never treated as an override.

## Idempotency and UNKNOWN orders

- An intent is unique for `(cycle, member account, contract)`.
- Its SHA-256 idempotency key and Gate order text are deterministic.
- Network timeout never means retry immediately. The intent becomes `UNKNOWN` and a reconciliation job queries Gate by order ID/text before any retry.
- All submission attempts have a request fingerprint and a redacted response record.

## Safe activation gates

The database migration creates the global control as:

- `execution_enabled = false`
- `emergency_halted = true`
- `halt_reason = TRADING_WORKER_NOT_CONFIGURED`

Browser RPCs cannot enable execution. Activation requires a deployment-only procedure after fixed-IP Worker provisioning and Gate TESTNET QA.
