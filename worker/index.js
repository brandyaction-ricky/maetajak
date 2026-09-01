import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import { validateGateChannelId, verifyGateAccount } from './gate.js';
import { TradingRunner } from './trading-runner.js';
import { sendWorkerAlert, shouldSendFailureAlert } from './alerts.js';
import { syncGateBrokerMetrics } from './broker-metrics.js';

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
const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN || '';
const telegramChatId = process.env.TELEGRAM_CHAT_ID || '';
const alertsConfigured = Boolean(alertWebhookUrl || (telegramBotToken && telegramChatId));
const brokerUid = process.env.GATE_BROKER_UID || '49084031';
const brokerApiKey = process.env.GATE_BROKER_API_KEY || '';
const brokerSecretKey = process.env.GATE_BROKER_SECRET_KEY || '';
const brokerSyncIntervalMs = Math.max(300_000, Number(process.env.BROKER_SYNC_INTERVAL_MS || 3_600_000));
if (!supabaseUrl || !serviceRoleKey) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
if (gateChannelId) validateGateChannelId(gateChannelId);
if (gateChannelId && gateChannelId !== 'maetajak') throw new Error('GATE_CHANNEL_ID must equal the approved Channel ID maetajak');
if (['DRY_RUN', 'LIVE'].includes(tradingMode) && !gateChannelId) {
  throw new Error('DRY_RUN and LIVE modes require GATE_CHANNEL_ID');
}
if (tradingMode === 'LIVE' && (!workerPublicIp || baseUrl !== 'https://api.gateio.ws')) {
  throw new Error('LIVE mode requires WORKER_PUBLIC_IP and the production Gate API base URL');
}
if (tradingMode === 'LIVE' && !alertsConfigured) throw new Error('LIVE mode requires a Telegram or webhook alert destination');

const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
const state = { verification: false, trading: false, broker: false, stopping: false };

function log(event, details = {}) {
  console.log(JSON.stringify({ at: new Date().toISOString(), worker_id: workerId, event, ...details }));
}

const runner = new TradingRunner({
  supabase, baseUrl, workerId, workerVersion, publicIp: workerPublicIp,
  channelId: gateChannelId, mode: tradingMode, logger: log,
});

function sendAlert(options) {
  return sendWorkerAlert({
    webhookUrl: alertWebhookUrl,
    bearerToken: alertWebhookBearer,
    telegramBotToken,
    telegramChatId,
    ...options,
  });
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
      log('verification_result', {
        gate_uid: job.gate_uid,
        success: result.success,
        error_code: result.errorCode || null,
        error_path: result.diagnostic?.path || null,
        error_status: result.diagnostic?.status || null,
        upstream_label: result.diagnostic?.label || null,
      });
      const { error: completionError } = await supabase.rpc('complete_gate_api_verification', {
        p_job_id: job.job_id, p_success: result.success, p_gate_user_id: result.gateUserId || null,
        p_error_code: result.errorCode || null, p_error_message: result.errorMessage || null,
        p_worker_public_ip: workerPublicIp || null,
      });
      if (completionError) throw completionError;
      if (!result.success) await sendAlert({ event: 'GATE_API_VERIFICATION_FAILED', details: { gate_uid: job.gate_uid, error_code: result.errorCode || 'UNKNOWN' } });
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
    if (observation.masterObserved || observation.observed || reconciled || submitted) log('cycle_complete', { ...observation, reconciled, submitted });
  } catch (error) {
    const code = error instanceof Error ? error.message : 'unknown';
    try {
      const failure = await runner.reportCycle(false, code);
      if (shouldSendFailureAlert(failure?.consecutive_failures)) {
        await sendAlert({ event: Number(failure?.consecutive_failures) >= 3 ? 'COPY_SYSTEM_AUTO_HALTED' : 'WORKER_CYCLE_FAILED', severity: 'CRITICAL', details: { failures: failure?.consecutive_failures, error_code: failure?.last_error_code || code } });
      }
    }
    catch (reportError) { log('worker_failure_report_error', { code: reportError instanceof Error ? reportError.message : 'unknown' }); }
    log('trading_cycle_error', { code });
  } finally { state.trading = false; }
}

export async function runBrokerMetricsSync() {
  if (state.broker || state.stopping) return;
  state.broker = true;
  try {
    let apiKey = brokerApiKey;
    let secretKey = brokerSecretKey;
    if (!apiKey || !secretKey) {
      const { data: context, error } = await supabase.rpc('get_copy_worker_context');
      if (error) throw new Error(`get_copy_worker_context: ${error.message}`);
      if (String(context?.master?.gate_uid || '') === String(brokerUid)) {
        apiKey = context.master.api_key;
        secretKey = context.master.secret_key;
      }
    }
    if (!apiKey || !secretKey) {
      await supabase.rpc('report_gate_broker_sync_status', {
        p_status: 'NOT_CONFIGURED', p_error_code: 'BROKER_API_KEY_REQUIRED', p_observed_at: new Date().toISOString(),
      });
      return;
    }
    const result = await syncGateBrokerMetrics({ supabase, apiKey, secretKey, baseUrl });
    log('gate_broker_metrics_synced', result);
  } catch (error) {
    const code = error?.code || (error instanceof Error ? error.message.split(':', 1)[0] : 'BROKER_SYNC_FAILED');
    await supabase.rpc('report_gate_broker_sync_status', {
      p_status: 'ERROR', p_error_code: String(code).slice(0, 80), p_observed_at: new Date().toISOString(),
    });
    log('gate_broker_metrics_error', { code: String(code).slice(0, 80) });
  } finally { state.broker = false; }
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
await runBrokerMetricsSync();
setInterval(runVerificationBatch, pollIntervalMs);
setInterval(runTradingCycle, syncIntervalMs);
setInterval(runBrokerMetricsSync, brokerSyncIntervalMs);
