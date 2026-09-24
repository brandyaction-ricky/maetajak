import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import { validateGateChannelId, verifyGateAccount } from './gate.js';
import { TradingRunner, safeError } from './trading-runner.js';
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
const telegramConfigured = Boolean(telegramBotToken && telegramChatId);
const alertsConfigured = Boolean(alertWebhookUrl || (telegramBotToken && telegramChatId));
const brokerUid = process.env.GATE_BROKER_UID || '49084031';
const brokerApiKey = process.env.GATE_BROKER_API_KEY || '';
const brokerSecretKey = process.env.GATE_BROKER_SECRET_KEY || '';
const brokerSyncIntervalMs = Math.max(300_000, Number(process.env.BROKER_SYNC_INTERVAL_MS || 3_600_000));
const performanceIntervalMs = Math.max(30_000, Number(process.env.PERFORMANCE_SYNC_INTERVAL_MS || 60_000));
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
if (tradingMode === 'LIVE' && !telegramConfigured) throw new Error('LIVE mode requires Telegram for critical copy safety alerts');

const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
const state = { verification: false, trading: false, broker: false, performance: false, stopping: false, lastDatabaseAlertAt: 0,
  leaseWaitSince: 0, lastLeaseAlertAt: 0, failureStreak: 0, healthyDryRunCycles: 0, lastReadinessAt: 0 };
const LEASE_CONFLICT_ALERT_MS = 90_000;
const READINESS_HEALTHY_CYCLES = 3;
const READINESS_REFRESH_MS = 600_000;

function log(event, details = {}) {
  console.log(JSON.stringify({ at: new Date().toISOString(), worker_id: workerId, event, ...details }));
}

const runner = new TradingRunner({
  supabase, baseUrl, workerId, workerVersion, publicIp: workerPublicIp,
  channelId: gateChannelId, mode: tradingMode, logger: log,
  onSafetyEvent: sendAlert,
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
    try {
      await runner.heartbeat(false);
    } catch (error) {
      // P1-2: a restarted worker gets a new id and must wait up to 30 s for the previous lease. That
      // wait is not a failed cycle; counting it on the shared runtime row froze LIVE after restarts.
      if (!String(error?.message || '').includes('WORKER_LEASE_HELD')) throw error;
      const now = Date.now();
      if (!state.leaseWaitSince) state.leaseWaitSince = now;
      log('worker_lease_waiting', { waited_ms: now - state.leaseWaitSince });
      if (now - state.leaseWaitSince > LEASE_CONFLICT_ALERT_MS && now - state.lastLeaseAlertAt > 600_000) {
        state.lastLeaseAlertAt = now;
        await sendAlert({ event: 'WORKER_LEASE_CONFLICT', severity: 'CRITICAL',
          details: { mode: tradingMode, action: '다른 워커가 실행 중인지 확인' } });
      }
      return;
    }
    state.leaseWaitSince = 0;
    await runner.cancelRequestedOpenOrders();
    const observation = await runner.syncOnce();
    const orderAnomaly = await runner.detectAndHaltOrderAnomaly();
    if (orderAnomaly?.newly_halted) {
      await sendAlert({
        event: 'COPY_DUPLICATE_ORDER_AUTO_HALTED',
        severity: 'CRITICAL',
        details: {
          reason: orderAnomaly.reason,
          contract: orderAnomaly.contract,
          position_side: orderAnomaly.position_side,
          duplicate_count: orderAnomaly.duplicate_count,
          copy_event_id: observation.copyEventId,
        },
      });
    }
    if (orderAnomaly?.anomaly_detected) {
      log('duplicate_order_auto_halted', {
        copy_event_id: observation.copyEventId,
        contract: orderAnomaly.contract,
        position_side: orderAnomaly.position_side,
        duplicate_count: orderAnomaly.duplicate_count,
      });
      return;
    }
    const reconcileStartedAt = Date.now();
    const reconciled = await runner.reconcileOrders();
    const reconcileMs = Date.now() - reconcileStartedAt;
    const submitStartedAt = Date.now();
    const submitted = await runner.submitOrders();
    const submitMs = Date.now() - submitStartedAt;
    // P1-8: resume validation after the order phase, one member per cycle.
    const resumeStartedAt = Date.now();
    const resumes = await runner.processPendingResumes(1);
    const resumeMs = Date.now() - resumeStartedAt;
    const alertsDelivered = await runner.deliverEntryAlerts();
    const report = await runner.reportCycle(true);
    if (state.failureStreak >= 3) {
      const haltKnown = report && Object.prototype.hasOwnProperty.call(report, 'halted');
      const resumed = haltKnown && report.halted === false;
      await sendAlert({ event: 'COPY_WORKER_RECOVERED', severity: resumed ? 'INFO' : 'WARNING',
        details: { failures: state.failureStreak, mode: tradingMode,
          action: resumed ? '주문 처리 자동 재개' : '카피 실행 상태 확인 필요 (중단 시 운영자 재개)' } });
    }
    state.failureStreak = 0;
    if (readinessCheck && tradingMode === 'DRY_RUN') {
      // C6: readiness = a DRY_RUN member-resume validation OR consecutive healthy DRY_RUN cycles that
      // observed the Master and at least one member and committed the verified cycle.
      const healthy = observation.masterObserved === 1 && Number(observation.healthyMembers) > 0;
      state.healthyDryRunCycles = healthy ? state.healthyDryRunCycles + 1 : 0;
      const refreshDue = Date.now() - state.lastReadinessAt > READINESS_REFRESH_MS;
      if (resumes.validated > 0 || (state.healthyDryRunCycles >= READINESS_HEALTHY_CYCLES && refreshDue)) {
        await runner.heartbeat(true);
        state.lastReadinessAt = Date.now();
        log('readiness_recorded', { healthy_cycles: state.healthyDryRunCycles, validated_resumes: resumes.validated });
      }
    }
    // Current State and engine state were committed and compared atomically
    // before any order could be claimed. A fill remains pending observation
    // until two fresh Gate position reads confirm it in later cycles.
    if (observation.masterObserved || observation.observed || reconciled || submitted || alertsDelivered) log('cycle_complete', {
      copy_event_id: observation.copyEventId,
      observed: observation.observed,
      masterObserved: observation.masterObserved,
      intents: observation.intents,
      reconciled,
      submitted,
      resumes_processed: resumes.processed,
      resumes_waiting: resumes.waiting,
      alerts_delivered: alertsDelivered,
      current_state_synced: true,
      timings: {
        ...observation.timings,
        reconcile_ms: reconcileMs,
        submit_ms: submitMs,
        resume_ms: resumeMs,
        current_state_ms: observation.timings.legacy_write_ms,
      },
    });
  } catch (error) {
    const code = error instanceof Error ? error.message : 'unknown';
    try {
      const failure = await runner.reportCycle(false, code);
      const failures = Number(failure?.consecutive_failures);
      state.failureStreak = Number.isFinite(failures) ? failures : state.failureStreak + 1;
      const details = { copy_event_id: runner.currentCopyEventId, failures: failure?.consecutive_failures,
        error_code: failure?.last_error_code || code };
      if (failure && Object.prototype.hasOwnProperty.call(failure, 'newly_halted')) {
        // P1-1: orders stop while failures>0; the database halts only after 5 minutes of failure.
        if (failure.newly_halted) await sendAlert({ event: 'COPY_SYSTEM_AUTO_HALTED', severity: 'CRITICAL', details });
        else if (failures === 1) await sendAlert({ event: 'WORKER_CYCLE_FAILED', severity: 'CRITICAL', details });
        else if (failures === 3 && !failure.halted) await sendAlert({ event: 'COPY_WORKER_DEGRADED', severity: 'CRITICAL', details });
      } else if (shouldSendFailureAlert(failure?.consecutive_failures)) {
        await sendAlert({ event: Number(failure?.consecutive_failures) >= 3 ? 'COPY_SYSTEM_AUTO_HALTED' : 'WORKER_CYCLE_FAILED', severity: 'CRITICAL', details });
      }
    }
    catch (reportError) {
      const reportCode = safeError(reportError, 'FAILURE_REPORT');
      state.failureStreak += 1;
      log('worker_failure_report_error', { code: reportCode });
      // Telegram must remain usable when the database itself is unreachable.
      if (Date.now() - state.lastDatabaseAlertAt > 300_000) {
        const alert = await sendAlert({ event: 'WORKER_DATABASE_UNREACHABLE', severity: 'CRITICAL',
          details: { copy_event_id: runner.currentCopyEventId, error_code: reportCode, mode: tradingMode, action: '현재 주문 처리 회차 중단' } });
        if (alert?.sent) state.lastDatabaseAlertAt = Date.now();
      }
    }
    state.healthyDryRunCycles = 0;
    log('trading_cycle_error', { copy_event_id: runner.currentCopyEventId, code });
  } finally { state.trading = false; }
}

// A11: accounting sync and stale-fill checks run outside the latency-sensitive order loop.
export async function runPerformanceSync() {
  if (state.performance || state.stopping || tradingMode !== 'LIVE') return;
  state.performance = true;
  try {
    await runner.alertStaleFillObservations(300);
    for (const member of runner.latestPerformanceMembers || []) {
      if (state.stopping) break;
      try { await runner.syncMemberPerformance(member, runner.contracts, new Date().toISOString()); }
      catch (error) { log('member_performance_sync_failed', { user_id: member.user_id, error_code: safeError(error, 'PERFORMANCE') }); }
    }
  } finally { state.performance = false; }
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
setInterval(runPerformanceSync, performanceIntervalMs);
setInterval(runBrokerMetricsSync, brokerSyncIntervalMs);
