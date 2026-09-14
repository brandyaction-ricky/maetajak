# UNAUTHORIZED_REBALANCE: resume consent boundary

Base: `15dd0b29bea07e2db69ccfa54895ece0bac50216`.
Scope: code/test changes only. This document contains no production account evidence.

## Root cause

`20260912100000_resume_copy_attribution.sql` made every new ordinary
RESUME generation set `sync_current_master=true`. This replaced the previous
operation-history/risk linkage used to identify an explicitly approved new
operation. The worker then stored an empty Master baseline and used historical
net platform fills to subtract supposedly copied exposure from protected member
holdings. Its active planning path also discarded the saved Master baseline
whenever the flag was true. Therefore ordinary resume could turn existing Master
positions into immediately executable full-portfolio deltas. A member-only-symbol
guard did not address this authorization error for symbols shared with Master.

## Fix

- Ordinary RESUME creates a future-only generation. Preserve both the complete
  observed Master baseline and every existing member hedge leg. Historical fill
  totals remain diagnostic data, not ownership authorization.
- Only an existing explicit NEW_OPERATION receipt bound to the same account,
  requester and resume generation, and referenced by current operation risk,
  authorizes current-Master planning. This preserves the separate admin feature;
  it does not add an operation or start one.
- Recheck the new-operation flat-account requirement against fresh observations.
  Never subtract net historical fills to make a non-flat account appear flat.
- Carry raw signed observations, policy version and operation identity through
  both validation calls. SQL checks future-only baseline equality and the
  current-Master approval/flatness boundary before preparing or activating.
- Persist explicit operation mode during preparation so loss of its receipt
  fails closed afterward. Reject unreceipted legacy sync sessions in worker
  planning, SQL intent creation, claim and final submission authorization.
- Active planning consumes the stored baseline rather than replacing it from a
  boolean. Existing freshness, idempotency, pause, risk and verified-cycle gates
  remain in place.

## Reproduction / own verification

The three `incident regression:` tests in `tests/resume-consent.test.js` failed
on the base code: ordinary resume returned true, unapproved sync reached
prepare/activate, and an old unapproved session claimed an order. They pass with
this patch. All exchange interfaces used by tests are synthetic; no production
credentials, accounts or endpoints are used for execution.

Commands:

```sh
npm ci --ignore-scripts
npm test
npm run check
npm run build
npm run test:postgres
```

The last command requires the existing CI's isolated localhost `maetajak_qa`
PostgreSQL 17 service. Its fixture truncates test schemas and MUST NOT be pointed
at production. The fixture refuses remote hosts and other database names.

Regression coverage includes personal same-side holdings, member-only symbols,
both hedge legs, manual decreases, Master close/re-entry, stale generations,
invalid consent/payloads, normal entries and reductions, oversize/direction
checks, timeout after acceptance, UNKNOWN quarantine, terminal partial fills,
post-fill observations and restart recovery. PostgreSQL tests use 12 independent
connections, serialized one-time claims/authorizations, invalidated approval,
concurrent future-only resume and four SIGKILL checkpoints with a fake exchange.

## QA / release cautions

- These are BUGFIX self-checks, not final QA PASS or permission to resume LIVE.
- Existing copy holdings are conservatively protected on ordinary resume along
  with personal holdings. This deliberately does not continue managing old
  ownership based on a historical fill sum. Ownership review and any separate
  operational decision belong to the authorized LIVE process.
- Ambiguous hedges/member-only exposure must stay untouched. Do not net hedge
  legs, liquidate them, relabel them as copy exposure, or repair DB history here.
- Historical `sync_current_master=true` sessions without valid receipts stay
  blocked. No migration backfill clears their flag or rewrites their baselines.
  If operationally approved later, normal expiry/pause and a fresh ordinary
  resume generation must use the new protocol; do not silently upgrade them.
- A new worker against the old DB blocks legacy current-seed sessions. The new
  DB rejects old-worker validation payloads lacking policy evidence. Deploy the
  SQL and worker as a coordinated RELEASE while STOP remains in effect.
- Applying this additive migration changes function definitions/privileges only,
  not current production data. Do not run a blanket historical migration replay:
  compare production migration identities and function bodies first because
  deployed historical timestamps can differ from repository filenames.
- Before LIVE consideration, independently verify frontend AND Lightsail worker
  commit, host process/schedule inventory, broker channel configuration, actual
  exchange order/position state and ownership. A singleton DB heartbeat is not
  proof that only one OS process exists. The historical heartbeat implementation
  checks its lease before an upsert without serializing the check; simultaneous
  expired-lease takeover remains a separate concurrency risk, not an established
  cause of this incident. Submission serialization tests do not certify host
  singleton execution.
- Obtain independent `02_QA` results, then `04_RELEASE` review and a new DRY_RUN.
  The pre-incident DRY_RUN is not valid evidence for this patch. Only `05_LIVE`
  with user approval may decide operational changes. No merge/deploy/LIVE action
  is performed by this PR.

## QA handoff

BUG: UNAUTHORIZED_REBALANCE (2026-09-12), P0.
Expected: ordinary resume creates zero catch-up orders, protects all prior
holdings, and only subsequent Master changes affect newly attributable copy
exposure. Explicit new operations require the existing separate consent path
and an independently re-observed flat account.

Pay particular attention to coordinated worker/SQL compatibility, invalid legacy
flags, expiry/repeated clicks, wrong-account/wrong-generation operation receipts,
SQL permission boundaries, stale or mutated validation payloads, remaining old
copy holdings, dual/single position modes, pending/UNKNOWN orders and restarts.
Operational evidence and affected-account quantities are supplied privately in
the incident report, not in this public repository.
