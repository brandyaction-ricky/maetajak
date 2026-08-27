import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import { validateGateChannelId, verifyGateAccount } from './gate.js';
import { TradingRunner } from './trading-runner.js';
import { sendWorkerAlert } from './alerts.js';

const supabaseUrl = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const pollIntervalMs = Math.max(2_000, Number(process.env.POLL_INTERVAL_MS || 5_000));
const syncIntervalMs = Math.max(2_000, Number(process.env.SYNC_INTERVAL_MS || 5_000));
const baseUrl = process.env.GATE_API_BASE_URL || 'https://api.gateio.ws';
const workerId = `${process.env.WORKER_ID || 'maetajak-worker'}:${randomUUID()}`;
const workerVersion = process.env.WORKER_VERSION || process.env.npm_package_version || 'dev';
const workerPublicIp = process.env.WORKER_PUBLIC_IP || '';
const gateChannelId = process.env.GATE_CHANNEL_ID || '';
const tradingMode = process.env.TRADING_MODE || 'OBSERVE';
const readinessCheck = process.env.RUN_READINESS_CHECK === 'true';
const alertWebhookUrl = process.env.ALERT_WEBHOOK_URL || '';
const alertWebhookBearer = process.env.ALERT_WEBHOOK_BEARER || '';
if (!supabaseUrl || !serviceRoleKey) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
if (gateChannelId) validateGateChannelId(gateChannelId);
if (gateChannelId && gateChannelId !== 'maetajak') throw new Error('GATE_CHANNEL_ID must equal the approved Channel ID maetajak');
if (['DRY_RUN', 'LIVE'].includes(tradingMode) && !gateChannelId) {
  throw new Error('DRY_RUN and LIVE modes require GATE_CHANNEL_ID');
}
if (tradingMode === 'LIVE' && (!workerPublicIp || baseUrl !== 'https://api.gateio.ws')) {
  throw new Error('LIVE mode requires WORKER_PUBLIC_IP and the production Gate API base URL');
}
if (tradingMode === 'LIVE' && !alertWebhookUrl) throw new Error('LIVE mode requires ALERT_WEBHOOK_URL');

const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
const runner = new TradingRunner({ supabase, baseUrl, workerId, workerVersion, publicIp: workerPublicIp, channelId: gateChannelId, mode: tradingMode });
const state = { verification: false, trading: false, stopping: false };

function log(event, details = {}) {
  console.log(JSON.stringify({ at: new Date().toISOString(), worker_id: workerId, event, ...details }));
}

export async function runVerificationBatch() {
  if (state.verification || state.stopping) return;
  state.verification = true;
  try {
    const { data: jobs, error } = await supabase.rpc('claim_gate_api_verification_jobs', { p_limit: 5 });
    if (error) throw error;
    for (const job of jobs || []) {
      const result = await verifyGateAccount({
        gateUid: job.gate_uid, apiKey: job.api_key, secretKey: job.secret_key,
        expectedPublicIp: workerPublicIp, requiresTradingPermission: job.connection_role !== 'MASTER', baseUrl,
      });
      const { error: completionError } = await supabase.rpc('complete_gate_api_verification', {
        p_job_id: job.job_id, p_success: result.success, p_gate_user_id: result.gateUserId || null,
        p_error_code: result.errorCode || null, p_error_message: result.errorMessage || null,
        p_worker_public_ip: workerPublicIp || null,
      });
      if (completionError) throw completionError;
      if (!result.success) await sendWorkerAlert({ webhookUrl: alertWebhookUrl, bearerToken: alertWebhookBearer, event: 'GATE_API_VERIFICATION_FAILED', details: { gate_uid: job.gate_uid, error_code: result.errorCode || 'UNKNOWN' } });
    }
  } catch (error) {
    log('verification_error', { code: error instanceof Error ? error.message : 'unknown' });
  } finally { state.verification = false; }
}

export async function runTradingCycle() {
  if (state.trading || state.stopping) return;
  state.trading = true;
  try {
    await runner.heartbeat(false);
    const observation = await runner.syncOnce();
    if (readinessCheck && tradingMode === 'DRY_RUN' && observation.observed > 0 && observation.intents > 0) await runner.heartbeat(true);
    const reconciled = await runner.reconcileOrders();
    const submitted = await runner.submitOrders();
    await runner.reportCycle(true);
    if (observation.observed || reconciled || submitted) log('cycle_complete', { ...observation, reconciled, submitted });
  } catch (error) {
    const code = error instanceof Error ? error.message : 'unknown';
    try {
      const failure = await runner.reportCycle(false, code);
      if ([1, 3].includes(Number(failure?.consecutive_failures)) || Number(failure?.consecutive_failures) % 10 === 0) {
        await sendWorkerAlert({ webhookUrl: alertWebhookUrl, bearerToken: alertWebhookBearer, event: Number(failure?.consecutive_failures) >= 3 ? 'COPY_SYSTEM_AUTO_HALTED' : 'WORKER_CYCLE_FAILED', severity: 'CRITICAL', details: { failures: failure?.consecutive_failures, error_code: failure?.last_error_code || code } });
      }
    }
    catch (reportError) { log('worker_failure_report_error', { code: reportError instanceof Error ? reportError.message : 'unknown' }); }
    log('trading_cycle_error', { code });
  } finally { state.trading = false; }
}

function stop(signal) {
  state.stopping = true;
  log('worker_stopping', { signal });
  setTimeout(() => process.exit(0), 1_000).unref();
}
process.on('SIGTERM', () => stop('SIGTERM'));
process.on('SIGINT', () => stop('SIGINT'));

log('worker_started', { mode: tradingMode, gate_base_url: baseUrl, broker_channel_id: gateChannelId || null, fixed_ip_configured: Boolean(workerPublicIp) });
await runVerificationBatch();
await runTradingCycle();
setInterval(runVerificationBatch, pollIntervalMs);
setInterval(runTradingCycle, syncIntervalMs);
