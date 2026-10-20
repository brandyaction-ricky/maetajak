import { safeError } from './trading-runner.js';

// Process-level helpers for worker/index.js (kept here so they can be tested without starting the worker).

// One normalisation for the worker and scripts/worker-preflight.js: ' live ' must not pass preflight as LIVE
// while the worker runs it as an unknown mode (or the reverse).
export function normalizeTradingMode(value) {
  return String(value ?? '').trim().toUpperCase() || 'OBSERVE';
}

// A non-numeric or empty interval used to become Math.max(2000, NaN) = NaN, which setInterval runs every 1 ms.
export function readIntervalMs(value, fallbackMs, minimumMs) {
  const raw = String(value ?? '').trim();
  const parsed = raw === '' ? NaN : Number(raw);
  return Math.max(minimumMs, Number.isFinite(parsed) ? parsed : fallbackMs);
}

// The code stored by report_copy_worker_cycle (p_error_code). GateApiError and TradingRunner.rpc errors carry a
// machine code; a message can be a Korean sentence, so it is never used as the code.
export function cycleFailureCode(error) {
  const code = error?.code;
  return code != null && String(code).trim() ? String(code).trim().slice(0, 80) : safeError(error);
}

// Client-side timeouts for Supabase requests. Without one, undici waits up to 300 s for a stuck PostgREST call:
// the cycle (and its heartbeat) froze and WORKER_DATABASE_UNREACHABLE arrived ~10 min late.
//
// A timeout only stops the worker waiting. PostgREST does not roll back on a client disconnect, so the server may
// still commit afterwards: every timeout must be as safe as a lost response. RPCs the worker calls:
// - Reads (no state change; abort is harmless): get_copy_worker_context, get_copy_order_observation_guards,
//   get_copy_resume_context, get_copy_target_anchors, get_copy_fund_flow_totals, get_copy_reversal_entry_context,
//   get_member_copy_resume_ownership, get_copy_stale_fill_observations.
// - Idempotent writes / reports (a commit after the abort is repeated or superseded next cycle): copy_worker_heartbeat,
//   report_copy_worker_cycle, record_verified_copy_worker_cycle (also refused by the DB once its observation is
//   >15 s old), upsert_copy_current_state, confirm_copy_order_observation, advance_member_copy_resume_baseline_legs,
//   record_copy_fund_flows (once per Gate row), upsert_member_daily_performance, upsert_member_symbol_daily_performance,
//   prune_member_symbol_daily_performance, report_member_copy_resume_blocker, prepare_member_copy_resume,
//   activate_member_copy_resume (a lost activation is seen as ACTIVE next cycle), detect_and_halt_copy_order_anomaly
//   (halting is the safe direction; only its alert can be missed), complete_open_order_cancel_job, complete_gate_api_verification,
//   complete_copy_entry_alert, report_gate_broker_sync_status, upsert_gate_broker_metrics.
// - Claims (a committed claim whose response is lost is never acted on; it expires): claim_gate_api_verification_jobs,
//   claim_open_order_cancel_jobs, claim_copy_entry_alerts, claim_copy_reconciliation_jobs, and claim_copy_order_intents
//   (an unauthorised SUBMITTING intent is settled by the DB as UNSENT_CLAIM_EXPIRED; nothing was sent to Gate).
// - authorize_copy_order_submission runs BEFORE the order POST: a timeout throws inside submitOrders' try with
//   orderSent=false, so the intent is completed as REJECTED and never POSTed. If the server committed the
//   authorisation anyway, the REJECTED completion (same advisory lock) settles it; if that completion fails, the
//   intent stays SUBMITTING without a Gate order and reconciliation cancels it after expiry. Never a re-submit.
// - Completions AFTER a Gate write (complete_copy_order_attempt, complete_copy_reconciliation) record an exchange
//   outcome that already exists. A lost response is already handled (the batch aborts; SUBMITTING/UNKNOWN intents
//   are reconciled by order text, never re-sent), but aborting a slow commit only adds UNKNOWN churn, so they get
//   a longer timeout instead of the default.
export const SUPABASE_DEFAULT_TIMEOUT_MS = 15_000;
export const SUPABASE_RPC_TIMEOUTS_MS = Object.freeze({
  complete_copy_order_attempt: 30_000,
  complete_copy_reconciliation: 30_000,
});

export function supabaseRequestTimeoutMs(url) {
  const match = /\/rest\/v1\/rpc\/([A-Za-z0-9_]+)/.exec(String(url ?? ''));
  return (match && SUPABASE_RPC_TIMEOUTS_MS[match[1]]) || SUPABASE_DEFAULT_TIMEOUT_MS;
}

export function createSupabaseFetch({ fetchImpl = fetch, timeoutFor = supabaseRequestTimeoutMs } = {}) {
  return (input, init = {}) => {
    const url = typeof input === 'string' ? input : input?.url ?? String(input);
    const timeout = AbortSignal.timeout(timeoutFor(url));
    const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    return fetchImpl(input, { ...init, signal });
  };
}

// SIGTERM/SIGINT: stop scheduling new work, then let an in-flight trading step finish (a Gate order and its
// completion RPC must not be cut in half) for up to `waitMs` before exiting. `docker stop` waits 10 s.
export function createShutdown({ state, log = () => {}, exit = (code) => process.exit(code), waitMs = 8_000, pollMs = 100,
  now = () => Date.now() }) {
  let started = null;
  return function stop(signal) {
    if (started) return started;
    state.stopping = true;
    const startedAt = now();
    log('worker_stopping', { signal, trading_in_flight: Boolean(state.trading) });
    started = new Promise((resolve) => {
      const check = () => {
        const waited = now() - startedAt;
        if (!state.trading || waited >= waitMs) {
          log('worker_stopped', { signal, waited_ms: waited, trading_in_flight: Boolean(state.trading) });
          resolve(exit(0));
          return;
        }
        setTimeout(check, pollMs);
      };
      check();
    });
    return started;
  };
}
