# CT-QA-RESUME-OWNERSHIP-001 — confirmed COPY continuity

P1 follow-up to P0 UNAUTHORIZED_REBALANCE. Previous candidate:
`4740bb2aca43206f02bc99e25398064621e1ea02` (PR #51). This file contains only
technical details and synthetic fixtures, not production account evidence.

## Root cause and red test

The original P0 consent fix made ordinary resume protect **all** existing member
legs. A real worker/SQL lifecycle against a fake exchange proved that FILLED,
observation-confirmed COPY 10 was reclassified as protected on HOLD/RESUME.
Master 40 → 0 then left member 10 with target 10 / delta 0. The new regression
failed on the previous candidate (`10 !== 0`) before product changes.

## Ownership and execution policy

- Start a private ownership checkpoint only from a verified pre-fill baseline.
  Never backfill ownership from historical net fill totals. Each terminal fill
  must be observation-confirmed, match the checkpoint's generation and starting
  actual quantity, and be consumed once by its unique intent ID.
- Keep COPY and protected pre-existing quantities separate for each account,
  contract and LONG/SHORT leg. Compare their sum to actual observations. An
  unexplained mismatch latches UNKNOWN; restoring the same total later is not
  proof of ownership. UNKNOWN blocks new candidates/claim/authorization/resume.
- First enrollment with no platform fill history may protect existing holdings
  by policy; that is not a claim that their trade origin is known. Legacy fills
  without a checkpoint require explicit evidence review outside this patch.
- Ordinary resume keeps confirmed COPY and protected quantities unchanged at
  activation. Anchor carried COPY to the Master quantity observed at resume.
  Subsequent reductions scale only actual COPY; a close leaves protected stock.
  Subsequent increases add only the new Master delta at current allocation.
  HOLD-period changes, old unfilled targets and equity drift are not replayed.
- If carried COPY has no matching Master leg at resume, block with
  `RESUME_COPY_SOURCE_MISSING`; do not auto-close or relabel it. If proof or
  observation is ambiguous, block with `RESUME_COPY_OWNERSHIP_UNKNOWN` or
  `RESUME_UNRESOLVED_OWNERSHIP`. Unconfirmed historical fills cannot become
  eligible merely because the global control timestamp changed.
- Policy v2 binds raw observations, journal revision, split, settings and anchors
  across prepare/activation. Recheck in SQL; reject changed or overwritten
  anchors. Old protect-all v1 workers cannot adopt confirmed COPY. Explicit
  current-Master NEW_OPERATION remains separately receipted and flat-only.
- Serialize worker lease check/acquisition with a transaction advisory lock,
  including absent rows and expired leases. Read the wall clock after locking.
  This proves one database lease, not the number of host processes or channels.

## Change surface / regression risk

Additive migration `20260914163259_preserve_confirmed_copy_ownership_on_resume.sql`:
private checkpoint/fill journal, verification trigger, guarded ownership RPC,
v2 prepare/activation wrappers, context, authorization predicate, worker lease.
No data backfill or execution/member flag mutation runs during migration.

Worker: continuation calculations and ownership-backed resume preview. Removed
the unused historical-fill subtraction helper and its superseded policy tests;
these are replaced by end-to-end ownership lifecycle tests, not weaker asserts.

Risks: new journal writes under the existing execution lock; conservative legacy
account blocking; worker/SQL coordinated compatibility; closed/partial-fill
rounding; gross exposure across hedge legs; old worker overwriting an anchor;
multi-step validation races. Checkpoint queries use account indexes and the
fill journal has a unique intent ID. All new private objects have RLS and no
client grants; implementation wrappers are not alternate public RPCs.

The journal is an observation-based proof, not a substitute for complete Gate
trade history. An unobserved personal round trip with the same net quantity
cannot be distinguished from aggregate snapshots. Operational ownership
certification still requires exchange evidence and explicit resolution of gaps.

## Self-checks and QA handoff

Run `node --test tests/resume-ownership.test.js`, `npm test`, `npm run check`,
`npm run build`, and the existing CI's `npm run test:postgres` (isolated local
Postgres 17 database `maetajak_qa`; never Production).

Coverage includes confirmed LONG/SHORT entry → resume → partial/full close;
same-symbol protected holdings, opposite hedge and member-only legs; terminal
partial fill; repeated resume and observations; paused Master changes; manual
increase/decrease; sticky UNKNOWN; legacy attribution gaps; stale revisions,
forged splits, changed Master and overwritten anchors; v1 bypass; risk caps;
timeout accepted at exchange → order-query reconciliation → observation → resume.
Existing suites retain oversize, wrong-direction, pending/UNKNOWN, stale intent,
retry, restart and crash recovery tests. Postgres adds 12-connection absent/stale
lease acquisition and concurrent unique fill consumption to existing claim,
authorization, repeated-resume and four process-crash tests.

Independent QA must rerun its original failing harness on the new commit and
review these broader lifecycle tests. Self-tests and CI success are NOT QA PASS.
No merge, deployment, production migration or LIVE action belongs to this work.
RELEASE/CONTROL must keep the halt latched and obtain deployed host SHA,
process/scheduler/channel singleton evidence, direct exchange Open/Pending/Fill
evidence and member-level ownership mapping. No automated production backfill
or cleanup is authorized. A fresh independent QA and fresh DRY_RUN are required;
only 05_LIVE with user approval may make a later operational decision.
