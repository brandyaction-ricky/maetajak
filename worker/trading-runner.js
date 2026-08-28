import { createHash, randomUUID } from 'node:crypto';
import {
  GateApiError, findFuturesOrderByText, getFuturesAccount, getFuturesContracts,
  getFuturesOrder, getFuturesPositions, getOrderTrades, placeFuturesOrder, summarizeGateOrder,
} from './gate.js';
import {
  buildGateOrderText, buildIdempotencyKey, calculateDeltaOrder,
  calculateTargetPosition, deriveCopyState, detectManualOverride,
} from './copy-engine.js';

function safeError(error) { return error instanceof GateApiError ? error.code : 'WORKER_ERROR'; }
function sourceHash(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function positionMap(positions) { return new Map(positions.map((position) => [position.contract, position])); }
function credentials(account) { return { apiKey: account.api_key, secretKey: account.secret_key }; }

export function suppressExecutableIntents(positions, mode) {
  if (mode === 'LIVE') return positions;
  return positions.map(({ intent: _intent, ...observation }) => observation);
}

export function planMemberPositions({ cycleId, system, master, member, contracts, simulateSystemHalt = false }) {
  const masterPositions = positionMap(master.positions);
  const memberPositions = positionMap(member.positions);
  const previousStates = new Map((member.previous_states || []).map((state) => [state.contract, state]));
  const symbols = new Set([...masterPositions.keys(), ...memberPositions.keys(), ...previousStates.keys()]);
  const planned = [];
  for (const contract of symbols) {
    const contractInfo = contracts.get(contract);
    if (!contractInfo || contractInfo.inDelisting) continue;
    const masterPosition = masterPositions.get(contract) || { contract, size: 0, markPrice: memberPositions.get(contract)?.markPrice || 0 };
    const memberPosition = memberPositions.get(contract) || { contract, size: 0, markPrice: masterPosition.markPrice || 0 };
    const markPrice = masterPosition.markPrice || memberPosition.markPrice;
    if (!(markPrice > 0) || !(contractInfo.quantoMultiplier > 0)) continue;
    const target = calculateTargetPosition({
      masterSize: masterPosition.size, masterEquity: master.total, masterMarkPrice: markPrice,
      masterQuantoMultiplier: contractInfo.quantoMultiplier, memberEquity: member.total,
      memberMarkPrice: memberPosition.markPrice || markPrice, memberQuantoMultiplier: contractInfo.quantoMultiplier,
      copyRatio: member.copy_ratio, maxPositionRatio: member.max_position_ratio, sizeStep: contractInfo.sizeStep,
    });
    const previous = previousStates.get(contract);
    if (member.close_positions_requested) {
      target.targetSize = 0;
      target.targetNotional = 0;
    }
    const manual = detectManualOverride({
      previousActualSize: Number(previous?.actual_size || 0), currentActualSize: memberPosition.size,
      knownPlatformFillDelta: Number(previous?.known_fill_delta || 0), sizeStep: contractInfo.sizeStep,
      hasUnresolvedPlatformOrder: Boolean(previous?.has_unresolved_order),
      hasBaseline: Boolean(previous) && !['HALTED', 'PAUSED'].includes(previous.state),
    });
    const leverageExceeded = Number(memberPosition.leverage || 0) > Number(member.max_leverage || 10);
    const reduceOnly = leverageExceeded || Boolean(member.reduce_only) || Boolean(member.close_positions_requested);
    const state = deriveCopyState({
      systemHalted: Boolean(system.emergency_halted) && !simulateSystemHalt, memberHalted: Boolean(member.halted),
      symbolPaused: Boolean(member.copy_paused) && !member.close_positions_requested,
      manualOverride: manual.detected || previous?.state === 'MANUAL_OVERRIDE', reduceOnly,
      targetSize: target.targetSize, actualSize: memberPosition.size, driftToleranceSize: contractInfo.sizeStep,
    });
    const delta = calculateDeltaOrder({ state, targetSize: target.targetSize, actualSize: memberPosition.size, sizeStep: contractInfo.sizeStep });
    const sizeCaps = [contractInfo.orderSizeMax, contractInfo.marketOrderSizeMax].filter((value) => Number(value) > 0);
    const maxOrderSize = sizeCaps.length ? Math.min(...sizeCaps) : 0;
    if (delta.shouldSubmit && maxOrderSize > 0 && Math.abs(delta.deltaSize) > maxOrderSize) {
      delta.deltaSize = Math.sign(delta.deltaSize) * maxOrderSize;
      delta.reason = 'CHUNKED_TO_GATE_ORDER_LIMIT';
    }
    if (Math.abs(delta.deltaSize) < contractInfo.orderSizeMin) {
      delta.shouldSubmit = false;
      delta.deltaSize = 0;
      delta.reason = 'BELOW_MINIMUM_ORDER_SIZE';
    }
    const idempotencyKey = delta.shouldSubmit ? buildIdempotencyKey({ cycleId, userId: member.user_id, contract, targetSize: target.targetSize, actualSize: memberPosition.size }) : null;
    const plannedPosition = {
      contract, size: memberPosition.size, mark_price: memberPosition.markPrice || markPrice,
      entry_price: memberPosition.entryPrice || null, leverage: memberPosition.leverage || null,
      quanto_multiplier: contractInfo.quantoMultiplier, target_size: target.targetSize,
      state, delta_size: delta.deltaSize, previous_actual_size: previous?.actual_size ?? null,
      unexplained_delta: manual.unexplainedDelta,
      pause_reason: manual.detected ? 'MEMBER_POSITION_CHANGED_OUTSIDE_PLATFORM' : member.risk_halt_reason || (leverageExceeded ? 'MAX_LEVERAGE_EXCEEDED' : member.copy_paused ? 'MEMBER_PAUSED' : null),
    };
    if (delta.shouldSubmit) {
      plannedPosition.intent = { delta_size: delta.deltaSize, reduce_only: delta.reduceOnly, idempotency_key: idempotencyKey, gate_order_text: buildGateOrderText(idempotencyKey) };
    }
    planned.push(plannedPosition);
  }
  return planned;
}

export class TradingRunner {
  constructor({ supabase, baseUrl, workerId, workerVersion, publicIp, channelId, mode = 'OBSERVE', fetchImpl = fetch, logger = null }) {
    Object.assign(this, { supabase, baseUrl, workerId, workerVersion, publicIp, channelId, mode, fetchImpl, logger });
    this.contracts = null;
    this.contractsLoadedAt = 0;
    this.lastDryRunPlanHash = null;
  }
  async rpc(name, parameters = {}) {
    const { data, error } = await this.supabase.rpc(name, parameters);
    if (error) throw new Error(`${name}: ${error.message}`);
    return data;
  }
  async heartbeat(testPassed = false) {
    return this.rpc('copy_worker_heartbeat', { p_worker_id: this.workerId, p_worker_version: this.workerVersion, p_gate_base_url: this.baseUrl, p_public_ip: this.publicIp || null, p_broker_channel_id: this.channelId || null, p_mode: this.mode, p_test_passed: testPassed });
  }
  async reportCycle(success, errorCode = null) {
    return this.rpc('report_copy_worker_cycle', { p_success: Boolean(success), p_error_code: errorCode ? String(errorCode).slice(0, 80) : null });
  }
  async loadContracts() {
    if (!this.contracts || Date.now() - this.contractsLoadedAt > 3_600_000) {
      this.contracts = await getFuturesContracts({ baseUrl: this.baseUrl, fetchImpl: this.fetchImpl });
      this.contractsLoadedAt = Date.now();
    }
    return this.contracts;
  }
  async readAccount(account) {
    const auth = credentials(account);
    const [summary, positions] = await Promise.all([
      getFuturesAccount({ ...auth, baseUrl: this.baseUrl, fetchImpl: this.fetchImpl }),
      getFuturesPositions({ ...auth, baseUrl: this.baseUrl, fetchImpl: this.fetchImpl }),
    ]);
    const dayStart = Number(account.day_start_equity || 0);
    const peak = Number(account.peak_equity || 0);
    const dailyLossPct = dayStart > 0 ? Math.max(0, ((dayStart - summary.total) / dayStart) * 100) : 0;
    const drawdownPct = peak > 0 ? Math.max(0, ((peak - summary.total) / peak) * 100) : 0;
    const dailyLimitHit = dailyLossPct >= Number(account.daily_loss_limit_pct || 5);
    const drawdownLimitHit = drawdownPct >= Number(account.max_drawdown_pct || 15);
    const riskHalted = dailyLimitHit || drawdownLimitHit;
    return { ...account, ...summary, positions, halted: Boolean(account.halted) || riskHalted, risk_halt_reason: dailyLimitHit ? 'DAILY_LOSS_LIMIT' : drawdownLimitHit ? 'MAX_DRAWDOWN_LIMIT' : null, daily_loss_pct: dailyLossPct, drawdown_pct: drawdownPct };
  }
  async syncOnce() {
    const context = await this.rpc('get_copy_worker_context');
    if (!context?.master) return { observed: 0, masterObserved: 0, intents: 0 };
    const memberContexts = Array.isArray(context.members) ? context.members : [];
    const contracts = memberContexts.length ? await this.loadContracts() : new Map();
    const cycleId = randomUUID();
    const observedAt = new Date().toISOString();
    const master = await this.readAccount(context.master);
    const members = [];
    let simulatedIntents = 0;
    const dryRunPlans = [];
    for (const memberContext of memberContexts) {
      try {
        const member = await this.readAccount(memberContext);
        const plannedPositions = planMemberPositions({
          cycleId,
          system: context.system,
          master,
          member,
          contracts,
          simulateSystemHalt: this.mode === 'DRY_RUN',
        });
        simulatedIntents += plannedPositions.filter((position) => position.intent).length;
        if (this.mode === 'DRY_RUN') {
          dryRunPlans.push(...plannedPositions.map((position) => ({
            contract: position.contract,
            target_size: position.target_size,
            actual_size: position.size,
            delta_size: position.delta_size,
            state: position.state,
            pause_reason: position.pause_reason,
          })));
        }
        member.planned_positions = suppressExecutableIntents(plannedPositions, this.mode);
        members.push(member);
      } catch (error) {
        members.push({ ...memberContext, error_code: safeError(error), positions: [], planned_positions: [] });
      }
    }
    await this.rpc('record_copy_worker_cycle', { p_payload: { cycle_id: cycleId, source_version: sourceHash({ observedAt, master: master.positions }), observed_at: observedAt, master, members } });
    if (this.mode === 'DRY_RUN' && this.logger && dryRunPlans.length) {
      const planHash = sourceHash(dryRunPlans);
      if (planHash !== this.lastDryRunPlanHash) {
        this.lastDryRunPlanHash = planHash;
        this.logger('dry_run_plan', { positions: dryRunPlans });
      }
    }
    return { observed: members.length, masterObserved: 1, intents: simulatedIntents };
  }
  async submitOrders(limit = 10) {
    const jobs = await this.rpc('claim_copy_order_intents', { p_limit: limit });
    for (const job of jobs || []) {
      try {
        const response = await placeFuturesOrder({ apiKey: job.api_key, secretKey: job.secret_key, channelId: this.channelId, baseUrl: this.baseUrl, fetchImpl: this.fetchImpl, contract: job.contract, size: job.delta_size, reduceOnly: job.reduce_only, text: job.gate_order_text, slippageRatio: job.slippage_ratio });
        const summary = summarizeGateOrder(response.payload);
        await this.rpc('complete_copy_order_attempt', { p_intent_id: job.intent_id, p_result_status: summary.finalStatus, p_gate_order_id: summary.gateOrderId, p_filled_size: summary.filledSize, p_average_fill_price: summary.averageFillPrice, p_http_status: response.status, p_gate_label: summary.finishAs, p_error_code: null, p_safe_response: { finish_as: summary.finishAs, left: summary.left } });
      } catch (error) {
        const unknown = error instanceof GateApiError && error.outcomeUnknown;
        await this.rpc('complete_copy_order_attempt', { p_intent_id: job.intent_id, p_result_status: unknown ? 'UNKNOWN' : 'REJECTED', p_gate_order_id: null, p_filled_size: 0, p_average_fill_price: null, p_http_status: error instanceof GateApiError ? error.status : 0, p_gate_label: null, p_error_code: safeError(error), p_safe_response: {} });
      }
    }
    return jobs?.length || 0;
  }
  async reconcileOrders(limit = 10) {
    const jobs = await this.rpc('claim_copy_reconciliation_jobs', { p_limit: limit });
    for (const job of jobs || []) {
      try {
        const auth = { apiKey: job.api_key, secretKey: job.secret_key, baseUrl: this.baseUrl, fetchImpl: this.fetchImpl };
        const order = job.gate_order_id ? await getFuturesOrder({ ...auth, orderId: job.gate_order_id }) : await findFuturesOrderByText({ ...auth, text: job.gate_order_text, contract: job.contract });
        if (!order) {
          await this.rpc('complete_copy_reconciliation', { p_job_id: job.job_id, p_status: 'UNKNOWN', p_gate_order_id: null, p_filled_size: 0, p_average_fill_price: null, p_safe_response: { found: false } });
          continue;
        }
        const orderId = String(order.id);
        const trades = await getOrderTrades({ ...auth, orderId, contract: job.contract });
        const summary = summarizeGateOrder(order, trades);
        await this.rpc('complete_copy_reconciliation', { p_job_id: job.job_id, p_status: summary.finalStatus, p_gate_order_id: orderId, p_filled_size: summary.filledSize, p_average_fill_price: summary.averageFillPrice, p_safe_response: { finish_as: summary.finishAs, left: summary.left, trade_count: trades.length } });
      } catch (error) {
        await this.rpc('complete_copy_reconciliation', { p_job_id: job.job_id, p_status: 'UNKNOWN', p_gate_order_id: job.gate_order_id, p_filled_size: 0, p_average_fill_price: null, p_safe_response: { error_code: safeError(error) } });
      }
    }
    return jobs?.length || 0;
  }
}
