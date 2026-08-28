import { createHash, randomUUID } from 'node:crypto';
import {
  GateApiError, findFuturesOrderByText, getFuturesAccount, getFuturesAccountBook, getFuturesContracts,
  getMyFuturesTradesInRange,
  getFuturesOrder, getFuturesPositions, getOrderTrades, placeFuturesOrder, summarizeGateOrder,
} from './gate.js';
import {
  buildGateOrderText, buildIdempotencyKey, calculateDeltaOrder,
  calculateCopyableMasterSize, calculateTargetPosition, deriveCopyState, detectManualOverride,
} from './copy-engine.js';
import { aggregateMemberPerformance, kstDayRange } from './performance.js';

export function safeError(error, stage = 'WORKER') {
  const safeStage = String(stage).toUpperCase().replace(/[^A-Z0-9_]/g, '_').slice(0, 40) || 'WORKER';
  const detail = error instanceof GateApiError
    ? error.code
    : error instanceof TypeError
      ? 'TYPE_ERROR'
      : 'FAILED';
  const safeDetail = String(detail || 'FAILED').toUpperCase().replace(/[^A-Z0-9_]/g, '_').slice(0, 35);
  return `${safeStage}_${safeDetail}`.slice(0, 80);
}
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
  const masterBaselines = new Map((member.master_baselines || []).map((position) => [position.contract, Number(position.size || 0)]));
  const symbols = new Set([...masterPositions.keys(), ...memberPositions.keys(), ...previousStates.keys(), ...masterBaselines.keys()]);
  const planned = [];
  for (const contract of symbols) {
    const contractInfo = contracts.get(contract);
    if (!contractInfo || contractInfo.inDelisting) continue;
    const observedMasterPosition = masterPositions.get(contract) || { contract, size: 0, markPrice: memberPositions.get(contract)?.markPrice || 0 };
    const baseline = calculateCopyableMasterSize({ masterSize: observedMasterPosition.size, baselineSize: masterBaselines.get(contract) || 0 });
    const masterPosition = { ...observedMasterPosition, size: baseline.copyableSize };
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
      master_baseline_size: masterBaselines.get(contract) || 0,
      baseline_clear_requested: baseline.clearBaseline,
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
    this.lastDryRunMasterHash = null;
    this.performanceSyncedAt = new Map();
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
  async syncMemberPerformance(member, contracts, observedAt) {
    const last = this.performanceSyncedAt.get(member.user_id) || 0;
    if (Date.now() - last < 300_000) return;
    const range = kstDayRange(new Date(observedAt));
    const auth = { ...credentials(member), baseUrl: this.baseUrl, fetchImpl: this.fetchImpl };
    const [ledger, trades] = await Promise.all([
      getFuturesAccountBook({ ...auth, from: range.from, to: range.to }),
      getMyFuturesTradesInRange({ ...auth, from: range.from, to: range.to }),
    ]);
    const performance = aggregateMemberPerformance({ member, ledger, trades, contracts, observedAt });
    await this.rpc('upsert_member_daily_performance', {
      p_user_id: member.user_id, p_trading_date: range.tradingDate,
      p_opening_equity: performance.daily.openingEquity, p_closing_equity: performance.daily.closingEquity,
      p_deposits: performance.daily.deposits, p_withdrawals: performance.daily.withdrawals,
      p_realised_pnl: performance.daily.realisedPnl, p_unrealised_pnl: performance.daily.unrealisedPnl,
      p_fees: performance.daily.fees, p_funding_pnl: performance.daily.fundingPnl,
      p_trading_volume: performance.daily.tradingVolume, p_trade_count: performance.daily.tradeCount,
      p_winning_trade_count: performance.daily.wins, p_losing_trade_count: performance.daily.losses,
      p_daily_return_pct: performance.daily.dailyReturnPct, p_source_snapshot_at: observedAt,
      p_source_hash: performance.daily.sourceHash,
    });
    for (const row of performance.symbols) {
      await this.rpc('upsert_member_symbol_daily_performance', {
        p_user_id: member.user_id, p_trading_date: range.tradingDate, p_contract: row.contract,
        p_realised_pnl: row.realisedPnl, p_fees: row.fees, p_funding_pnl: row.fundingPnl,
        p_trade_count: row.tradeCount, p_winning_trade_count: row.wins, p_losing_trade_count: row.losses,
        p_source_snapshot_at: observedAt, p_source_hash: row.sourceHash,
      });
    }
    this.performanceSyncedAt.set(member.user_id, Date.now());
  }
  async syncOnce() {
    const context = await this.rpc('get_copy_worker_context');
    if (!context?.master) return { observed: 0, masterObserved: 0, intents: 0 };
    const memberContexts = Array.isArray(context.members) ? context.members : [];
    let contracts = memberContexts.length ? await this.loadContracts() : new Map();
    const cycleId = randomUUID();
    const observedAt = new Date().toISOString();
    const master = await this.readAccount(context.master);
    // A newly listed or newly traded contract may appear after the hourly
    // contract metadata cache was built. Refresh immediately instead of
    // silently dropping that Master position from every member plan.
    if (memberContexts.length && master.positions.some((position) => !contracts.has(position.contract))) {
      this.contracts = null;
      contracts = await this.loadContracts();
    }
    if (this.mode === 'DRY_RUN' && this.logger) {
      const masterSnapshot = {
        total_equity: master.total,
        available_equity: master.available,
        positions: master.positions.map((position) => ({
          contract: position.contract,
          size: position.size,
          mark_price: position.markPrice,
          leverage: position.leverage || null,
        })),
      };
      const masterHash = sourceHash(masterSnapshot);
      if (masterHash !== this.lastDryRunMasterHash) {
        this.lastDryRunMasterHash = masterHash;
        this.logger('dry_run_master_snapshot', masterSnapshot);
      }
    }
    const members = [];
    let simulatedIntents = 0;
    const dryRunPlans = [];
    for (const memberContext of memberContexts) {
      let memberStage = 'BASELINE_INIT';
      try {
        const baseline = await this.rpc('get_or_initialize_member_copy_baseline', {
          p_trading_account_id: memberContext.trading_account_id,
          p_master_positions: master.positions.map((position) => ({ contract: position.contract, size: position.size })),
        });
        const observedMasterPositions = positionMap(master.positions);
        const baselinePositions = baseline?.positions || [];
        const contractsToClear = baselinePositions.filter((position) => {
          const currentSize = Number(observedMasterPositions.get(position.contract)?.size || 0);
          const baselineSize = Number(position.size || 0);
          return currentSize === 0 || (baselineSize !== 0 && Math.sign(currentSize) !== Math.sign(baselineSize));
        }).map((position) => position.contract);
        if (contractsToClear.length) {
          memberStage = 'BASELINE_CLEAR';
          await this.rpc('clear_member_copy_baselines', {
            p_trading_account_id: memberContext.trading_account_id,
            p_contracts: contractsToClear,
          });
        }
        const activeBaselines = baselinePositions.filter((position) => !contractsToClear.includes(position.contract));
        memberStage = 'MEMBER_ACCOUNT_READ';
        const member = await this.readAccount({ ...memberContext, master_baselines: activeBaselines });
        memberStage = 'MEMBER_PLAN';
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
        if (this.mode === 'LIVE') {
          try {
            await this.syncMemberPerformance(member, contracts, observedAt);
          } catch (performanceError) {
            if (this.logger) this.logger('member_performance_sync_failed', { user_id: member.user_id, error_code: safeError(performanceError, 'PERFORMANCE') });
          }
        }
      } catch (error) {
        const errorCode = safeError(error, memberStage);
        if (this.logger) this.logger('member_sync_failed', { user_id: memberContext.user_id, trading_account_id: memberContext.trading_account_id, error_code: errorCode });
        members.push({ ...memberContext, error_code: errorCode, positions: [], planned_positions: [] });
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
