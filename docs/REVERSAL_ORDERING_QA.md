# CT-QA-REVERSAL-ORDERING-001 — observed COPY close before reversal

Severity: P1, release blocker. Follow-up to the independent QA failure on
`9e316df414888e4ca3dc6350270989fd65cf79b4` in draft PR #51.
The earlier resume-ownership regression passes; it remains a required regression.
This document contains synthetic cases only. It does not certify production holdings.

## Root cause and scope

The planner generated opposite hedge legs independently. Same-cycle candidates
had equal creation times, and claim ordering used random UUIDs as a tie-breaker.
Neither final SQL authorization nor the dual-mode fresh-account preflight
required the retiring COPY leg to close. An opening candidate could therefore
execute first. Sorting reductions first would not cover partial/unknown fills,
restart, stale candidates or a later independent claim.

The unchanged independent QA assertion fails on the parent commit: confirmed
COPY LONG 10, ordinary HOLD/RESUME, Master LONG 40 -> SHORT -40, entry UUID first:
the first reversal POST is SHORT -10, non-reduce-only, leaving LONG 10 / SHORT -10.
After this fix it is LONG -10, reduce-only, leaving both COPY legs flat. The same
assertions now also complete the SHORT -> LONG loop successfully.

This confirms the candidate defect, not its first introduction or an actual
production occurrence. Independent planning existed at d4a1dce, claim ordering
appears in 8b9c918 and later definitions, and final admission remained insufficient
at the parent SHA. Historical runtime reproduction would be needed to identify
the first affected release. This is not evidence establishing the parent P0's cause.

## Change and execution dependency

- Planning pauses a new opposite entry with `COPY_REVERSAL_CLOSE_REQUIRED` while
  the retired leg differs from its protected holding or has unresolved platform
  orders. A blocked plan does not lock an entry target or reserve its margin.
- A server-owned admission function checks complete, fresh Master/member
  observations from the intent cycle, signed per-leg ownership, and outstanding
  opposite fills. A zero exchange position alone is insufficient: the terminal
  close must be observed and consumed by the ownership journal.
- Claim filters ineligible entries **before LIMIT**. A submission trigger also
  rejects direct status transitions. Final authorization repeats admission under
  the existing global execution advisory lock. UUID order has no safety meaning.
- Immediately before submission, a fresh member opposite holding without a
  corresponding fresh Master leg requires an identity-bound server ownership
  proof: COPY zero, actual equal to protected. This also covers a Master dropping
  one leg between normal dual planning and submission.
- Normal Master dual operation is preserved. Protected residual/personal and
  member-only holdings are retained; they are not adopted, netted, or liquidated.

Migration `20260914172954_require_observed_copy_close_before_reversal.sql` adds
function/trigger definitions only. It has no backfill, control writes, member
activation, exchange actions, or production data repair. The new RPC is service
role only; private admission is not directly executable by service role.

## Reproduction and validation

`tests/qa-reversal-close-first.test.js` is the independent QA harness with only
the fixture import paths changed. Its assertions are unchanged. RED was captured
before product changes at the parent SHA, GREEN afterward.

Local tests use Node 24.19.0, empty environment, a network-denial preload, PGlite,
synthetic accounts and a dual-leg mock exchange. No worker entrypoint is started.

```sh
env -i PATH="$PATH" NODE_OPTIONS='--import=./tests/fixtures/deny-network.js' node --test tests/qa-reversal-close-first.test.js tests/reversal-ordering.test.js
env -i PATH="$PATH" NODE_OPTIONS='--import=./tests/fixtures/deny-network.js' npm test
env -i PATH="$PATH" NODE_OPTIONS='--import=./tests/fixtures/deny-network.js' npm run check
env -i PATH="$PATH" NODE_OPTIONS='--import=./tests/fixtures/deny-network.js' npm run build
node --check worker/trading-runner.js
node --check worker/execution-safety.js
git diff --check
```

Local full suite: **441 PASS, 0 FAIL, 2 SKIP**. Includes the original reversal
harness (one test, both directions) and 35 additional regression tests. The two
existing skipped historical migration static checks are not counted as PASS.
The existing independent ownership/ratio/resume harness also passes all 20
assertion-preserving cases in a separate evidence directory. Build/check pass.

Additional reversal cases cover both directions and both UUID orders with legacy
concurrent candidates and claim limit 1; direct status bypass; terminal and
nonterminal partial fills; accepted-but-timeout/disconnect/429/500/malformed
responses; before/after DB completion loss; restart before/after authorization;
safe observation before entry; duplicate follow-up sync; protected mixed residuals;
pure protected opposite/member-only holdings; normal Master dual operation; and
Master changes between claim and final preflight/authorization.

Real PostgreSQL validation runs through the existing PR verification workflow,
which only tests/builds and does not deploy. `npm run test:postgres` requires an
isolated localhost database named `maetajak_qa` and rejects other targets. The six
new tests use 12 independent connections for both UUID orders in both directions,
single authorization, SUBMITTING/filled-unobserved dependencies, and UNKNOWN after
restart. The existing 13 concurrency/lease/ownership/consent/SIGKILL cases remain.
Check the exact candidate's CI log and tree equivalence before accepting these
19 cases as PASS; local PGlite is not a substitute for PostgreSQL concurrency.

## Regression risks and QA handoff

Fail-closed admission can defer entry for another verified cycle, or continue to
block if ownership/observations remain ambiguous. A protected holding is not
expected to reach zero. Master dual operation must not be mistaken for reversal.
The database migration and compatible worker must be coordinated by RELEASE;
mixed versions are not a verified deployment state.

Independent QA must repeat the RED/GREEN harness and close-first matrix, check
ownership preservation, future-only resume and explicit current-seed consent,
and verify actual PostgreSQL results for the new head. BUGFIX test success is
not independent QA_PASS, READY_FOR_RELEASE, a new DRY_RUN, or permission to resume.

Operational gates remain separate: authenticated member ownership/direct exchange
position/fill reconciliation; direct exchange open/pending order verification;
and actual worker deployment SHA/process/schedule/broker-channel uniqueness.
Database heartbeat and test leases do not establish host-level singleton status.
Production HALT/control state must remain unchanged. Next owner: **02_QA**.
