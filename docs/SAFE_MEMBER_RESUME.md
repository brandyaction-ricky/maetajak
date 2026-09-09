# Safe member resume (worker 0.4.0)

Resuming a member now preserves that member's existing signed contract quantities and follows subsequent changes in the master's exposure. A resume request starts validation; it does not immediately enable orders. USDT display values and mark-price changes do not define position identity. Contract, LONG/SHORT side and contract quantity do.

## Seven stages

1. Pause the member and allocate a resume version. Repeated pending requests retain the version. Cancel only unsubmitted plans; never label a possibly submitted order as cancelled without evidence.
2. Resolve historical outstanding orders against the exchange. Unknown or active partial fills keep this member waiting. Never replay an ambiguous submission automatically.
3. Read master and member positions and open orders. Require complete, valid responses, snapshots no older than 15 seconds and observation skew no greater than 3 seconds.
4. Store the master and member protected baseline with the resume version and current risk settings. Settings or credential changes invalidate validation.
5. Compute a zero-order preview. The initial target must equal the member's protected holdings exactly. DRY_RUN can validate but cannot activate.
6. Re-read positions and require unchanged quantities, eligible credentials, matching version/settings and a healthy, explicitly enabled LIVE system. Only then enable this member. Pausing during validation prevents activation.
7. Authorize each order once immediately before submission. Require the resulting terminal fill to appear in two fresh exchange observations at least two seconds apart before another order for that position.

## Handling variable conditions

| Condition | Response |
| --- | --- |
| Price or displayed USDT value changes without quantity changes | Keep the same protected quantity; do not treat the display difference as a new position. Normal target calculations still use current equity and configured exposure limits. |
| The master reduces pre-resume exposure, then adds again | Decrease the remaining master baseline; never increase it. For example, a baseline of 100 falling to 50 then rising to 80 makes the subsequent 30 eligible for proportional copying. |
| The member reduces protected holdings manually | Pause the affected position as a manual override. Do not repurchase the protected holding automatically. |
| Existing holdings already consume the position limit | Count them toward the limit and allow no additional copied exposure beyond it. Do not liquidate protected holdings to make room. |
| Opposing protected position in single-direction mode | Hold the affected position. Do not offset the protected holding by opening the opposite side. |
| Unsupported/delisting contract, malformed or incomplete positions, mode mismatch | Wait for this member or affected position; do not submit using assumed empty positions. |
| Open exchange order, unknown submission or active partial fill | Keep the member/position locked and reconcile. A timeout is not proof that the exchange rejected the order. |
| Terminal partial fill | Preserve the authoritative filled quantity, confirm it in fresh positions, then replan the remaining difference. |
| The database response fails after an exchange fill | Preserve uncertainty and reconcile; do not overwrite a successful fill as a rejection. |
| Duplicate claim, old worker, stale plan or repeated submission authorization | Database version, freshness and single-use checks reject additional submission. |
| Pause, administrative halt, setting change or credential replacement | Invalidate eligibility. The submission check rechecks controls immediately before the exchange request. |
| Fill quantity exceeds the order or has the wrong sign | Disable global execution, latch the emergency halt and send a critical safety alert. |
| Database unavailable | Fail the current cycle closed; send an independent Telegram failure alert with a cooldown. Do not claim a database halt write succeeded if the database is unreachable. |
| Ordinary resume validation delay | Hold the member rather than repeatedly halting the whole service. Warning alerts are limited by member/version and a five-minute cooldown. |

The exchange may fill an order already accepted before a pause or network failure. A database and a remote exchange cannot share one atomic transaction. The worker uses short order expiry, fresh observations and reconciliation to handle this boundary; it cannot undo an exchange fill or guarantee that every external failure is observable immediately.

## Deployment and operation

Apply the migration while execution is disabled and the emergency halt is set. The migration asserts those conditions and initializes existing accounts as requiring validation. Deploy the worker and UI afterward. Worker version 0.4.0 and the new database guards are required to claim orders.

Automated deployment ends in DRY_RUN and verifies the worker before testing its configured alert destination. It does not restore LIVE mode. The legacy promotion processor also requires explicit operator opt-in. Starting real copying remains a separate operator decision; no resume is part of this change's deployment.

Snapshot reads are concurrent, contract metadata is cached, settled performance is sampled, and guards use targeted partial indexes. Failed or slow reads remain visible and never become executable empty-position plans.

## Verification

Run `npm test`, `npm run check` and `npm run build`. The suite includes an isolated PostgreSQL database executing the same migration used for deployment with synthetic fixtures. It covers resume version changes, old orders, protected baselines, settings changes, access control, repeated claims/authorization, terminal partial fills, observation confirmation and invalid fill halts. The embedded database tests use one connection; repeated-claim coverage is not a multi-connection load test. Gate requests are mocked; no test sends a live order.

At implementation review, 242 tests passed, zero failed and two existing historical-schema checks were skipped. Those skips do not verify the missing historical migration. Final operational verification must separately check the deployed version, fresh heartbeat, DRY_RUN mode, halt controls and absence of new exchange submissions.
