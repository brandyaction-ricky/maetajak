import { createHash, randomUUID } from 'node:crypto';
import {
  GateApiError, cancelAllOpenFuturesOrders, findFuturesOrderByText, getFuturesAccount, getFuturesAccountBook, getFuturesContracts, listFuturesOrders,
  getMyFuturesTradesInRange,
  getFuturesOrder, getFuturesPositions, getOrderTrades, placeFuturesOrder, setFuturesLeverage,
  safeGateErrorLabel, setFuturesPositionMode, summarizeGateOrder,
} from './gate.js';
import {
  buildGateOrderText, buildIdempotencyKey, calculateDeltaOrder,
  calculateCopyableMasterSize, calculateTargetPosition, capLockedTargetToCurrentRisk, calculateReducedCopyTarget,
  deriveCopyState, detectManualOverride, roundTowardZeroToStep,
} from './copy-engine.js';
import { aggregateMemberPerformance, kstDayRange } from './performance.js';
import {
  resumePositions, sameResumePositions, validateResumeSnapshot, validateResumePreview,
  validateCurrentMasterSyncPreview, RESUME_MAX_AGE_MS,
} from './member-resume.js';
import { assertFreshAccount, assertOrderIdentity, assertSubmissionSnapshot, exchangeTradeAlert } from './execution-safety.js';

// Engine plans cancelled before any Gate request; they are not order failures.
const NEVER_SENT_CANCELLATIONS = new Set(['SUPERSEDED_BY_FRESH_PLAN', 'SUPERSEDED_BY_RESUME', 'PRE_LIVE_INTENT_DISCARDED']);

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
function normalizePositionSide(position) {
  if (position?.positionSide === 'LONG' || position?.position_side === 'LONG') return 'LONG';
  if (position?.positionSide === 'SHORT' || position?.position_side === 'SHORT') return 'SHORT';
  return Number(position?.size ?? position?.actual_size ?? 0) < 0 ? 'SHORT' : 'LONG';
}
function positionKey(position) { return `${position.contract}:${normalizePositionSide(position)}`; }
function positionMap(positions) { return new Map(positions.map((position) => [positionKey(position), position])); }
function parsePositionKey(key) {
  const separator = key.lastIndexOf(':');
  return { contract: key.slice(0, separator), positionSide: key.slice(separator + 1) };
}
function accountSupportsDual(account) {
  return String(account?.positionMode || '').startsWith('dual')
    || (account?.positions || []).some((position) => String(position.mode || '').startsWith('dual_'));
}
function credentials(account) { return { apiKey: account.api_key, secretKey: account.secret_key }; }
function elapsedMs(startedAt) { return Math.max(0, Date.now() - startedAt); }

// Proportional sizing compares account values on one basis. Gate unified equity already includes
// unrealised PnL while the classic futures `total` is the wallet balance without it, so a classic
// account adds its unrealised PnL. Accounts without the flag keep their reported total.
export function sizingEquity(account) {
  const total = Number(account?.total);
  if (account?.equityIncludesUnrealised !== false || !Number.isFinite(total)) return total;
  const unrealised = Number(account?.unrealisedPnl ?? 0);
  return Number.isFinite(unrealised) ? total + unrealised : total;
}

// Master quantity consumed by `lots` member contracts out of `rawLots` (unrounded) for an increase of
// `increment`. Returns null when the whole increase was consumed, so the anchor takes the observed
// Master size exactly. A partial consumption is rounded toward the previous anchor so an anchor can
// never pass the observed Master quantity (which would read as a Master reduction).
export function partialAnchorMasterSize({ anchorMaster, masterSize, lots, rawLots }) {
  const increment = masterSize - anchorMaster;
  if (!(rawLots > 0) || !(Math.abs(lots) > 0) || Math.abs(lots) >= rawLots * (1 - 1e-12)) return null;
  const consumed = Math.floor(Math.abs(increment) * (Math.abs(lots) / rawLots) * 1e8) / 1e8;
  const anchored = Number((anchorMaster + Math.sign(increment) * consumed).toPrecision(15));
  if (!(Math.abs(anchored) < Math.abs(masterSize)) || Math.abs(masterSize) - Math.abs(anchored) < 1e-9) return null;
  return anchored;
}

export function buildCurrentStatePayload({ cycleId, observedAt, master, members }) {
  const accountPayload = (account, accountRole, positions) => ({
    trading_account_id: account.trading_account_id,
    user_id: account.user_id || null,
    account_role: accountRole,
    total_equity: account.total,
    available_equity: account.available,
    unrealised_pnl: account.unrealisedPnl ?? null,
    error_code: account.error_code || null,
    positions: (positions || []).map((position) => ({
      contract: position.contract,
      position_side: normalizePositionSide(position),
      size: Number(position.size || 0),
      mark_price: position.mark_price ?? position.markPrice ?? null,
      entry_price: position.entry_price ?? position.entryPrice ?? null,
      leverage: position.leverage ?? null,
      quanto_multiplier: position.quanto_multiplier ?? null,
      state: position.state ?? null,
      target_size: position.target_size ?? null,
      delta_size: position.delta_size ?? null,
    })),
  });
  return {
    copy_event_id: cycleId,
    observed_at: observedAt,
    master: accountPayload(master, 'MASTER', master.positions),
    members: members.map((member) => {
      const positions = positionMap(member.positions || []);
      const merged = (member.planned_positions || []).map((plan) => ({
        ...plan, ...(positions.get(positionKey(plan)) || { size: 0 }),
      }));
      const plannedKeys = new Set(merged.map(positionKey));
      merged.push(...(member.positions || []).filter((position) => !plannedKeys.has(positionKey(position))));
      return accountPayload(member, 'MEMBER', merged);
    }),
  };
}

export function suppressExecutableIntents(positions, mode) {
  if (mode === 'LIVE') return positions;
  return positions.map(({ intent: _intent, ...observation }) => observation);
}

export function applyOrderObservationGuards(context, guards = []) {
  const guardKeys = new Set((guards || []).map((guard) =>
    `${guard.trading_account_id}:${guard.contract}:${guard.position_side}`));
  return {
    ...context,
    members: (context?.members || []).map((member) => {
      const states = [...(member.previous_states || [])];
      const stateKeys = new Set(states.map((state) => `${state.contract}:${state.position_side}`));
      for (const guard of guards || []) {
        if (guard.trading_account_id !== member.trading_account_id) continue;
        const stateKey = `${guard.contract}:${guard.position_side}`;
        if (!stateKeys.has(stateKey)) {
          states.push({
            contract: guard.contract,
            position_side: guard.position_side,
            state: 'PAUSED',
            has_unresolved_order: true,
          });
          stateKeys.add(stateKey);
        }
      }
      return {
        ...member,
        previous_states: states.map((state) => ({
          ...state,
          has_unresolved_order: Boolean(state.has_unresolved_order)
            || guardKeys.has(`${member.trading_account_id}:${state.contract}:${state.position_side}`),
        })),
      };
    }),
  };
}

export function planMemberPositions({ cycleId, system, master, member, contracts, simulateSystemHalt = false }) {
  const masterPositions = positionMap(master.positions);
  const memberPositions = positionMap(member.positions);
  const previousStates = new Map((member.previous_states || []).map((state) => [positionKey(state), state]));
  const masterBaselines = new Map((member.master_baselines || []).map((position) => [positionKey(position), Number(position.size || 0)]));
  const memberPositionBaselines = new Map((member.member_position_baselines || []).map((position) => [positionKey(position), Number(position.size || 0)]));
  const targetAnchors = new Map((member.target_anchors || []).map((anchor) => [positionKey(anchor), anchor]));
  const continuedCopyLegs = new Set((member.continued_copy_positions || []).map(positionKey));
  // Contracts whose Master legs Gate could not confirm this cycle: no order, no anchor move.
  const unconfirmedMasterContracts = new Set(master.unconfirmed_contracts || []);
  const symbols = new Set([...masterPositions.keys(), ...memberPositions.keys(), ...previousStates.keys(), ...masterBaselines.keys(), ...memberPositionBaselines.keys(), ...targetAnchors.keys()]);
  const planned = [];
  const reservedNotional = new Map();
  let remainingMargin = Math.max(0, Number(member.available ?? member.total));
  for (const symbol of symbols) {
    const { contract, positionSide } = parsePositionKey(symbol);
    const contractInfo = contracts.get(contract);
    const masterUnconfirmed = unconfirmedMasterContracts.has(contract) && !member.close_positions_requested;
    if (!contractInfo) {
      const observedMaster = masterPositions.get(symbol);
      const observedMember = memberPositions.get(symbol);
      if (Number(observedMaster?.size || 0) === 0 && Number(observedMember?.size || 0) === 0) {
        const previous = previousStates.get(symbol);
        const previousActualSize = Number(previous?.actual_size || 0);
        const masterBaselineSize = masterBaselines.get(symbol) || 0;
        const memberBaselineSize = memberPositionBaselines.get(symbol) || 0;
        planned.push({
          contract, position_side: positionSide, position_mode: member.positionMode || 'single',
          size: 0, mark_price: null, entry_price: null, leverage: null,
          target_leverage: null, margin_mode: String(previous?.margin_mode || 'cross'),
          quanto_multiplier: null, target_size: 0,
          state: previousActualSize !== 0 ? 'MANUAL_OVERRIDE' : 'SYNCED',
          delta_size: 0, previous_actual_size: previous?.actual_size ?? null,
          unexplained_delta: -previousActualSize,
          master_baseline_size: masterBaselineSize,
          master_copyable_size: 0,
          member_baseline_size: memberBaselineSize,
          target_resume_version: member.resume_version || null,
          target_lock_reason: 'FLAT_CONTRACT_METADATA_UNAVAILABLE',
          anchor_update_allowed: false,
          sizing_reason: null,
          execution_reason: 'NO_EXECUTABLE_POSITION',
          master_actual_size: 0,
          risk_leverage: null,
          taker_fee_rate: null,
          baseline_clear_requested: masterBaselineSize !== 0,
          pause_reason: 'FLAT_CONTRACT_METADATA_UNAVAILABLE',
        });
        continue;
      }
      throw new GateApiError('계약 정보를 안전하게 확인할 수 없습니다.', { code: 'CONTRACT_METADATA_UNAVAILABLE' });
    }
    const observedMasterPosition = masterPositions.get(symbol) || {
      contract, positionSide, size: 0, markPrice: memberPositions.get(symbol)?.markPrice || contractInfo.markPrice || 0,
    };
    const baseline = calculateCopyableMasterSize({ masterSize: observedMasterPosition.size, baselineSize: masterBaselines.get(symbol) || 0 });
    const masterPosition = { ...observedMasterPosition, size: baseline.copyableSize };
    const memberPosition = memberPositions.get(symbol) || { contract, positionSide, size: 0, markPrice: masterPosition.markPrice || 0 };
    // Flat legs still need a zero observation to clear old engine/DB state.
    // A neutral arithmetic reference is used only when both actual sizes are
    // zero; it is never reported as an exchange quote or used for an entry.
    const reportedMarkPrice = masterPosition.markPrice || memberPosition.markPrice || 0;
    const markPrice = reportedMarkPrice || (!observedMasterPosition.size && !memberPosition.size ? 1 : 0);
    if (!(markPrice > 0) || !Number.isFinite(markPrice) || !(contractInfo.quantoMultiplier > 0)
      || !Number.isFinite(contractInfo.quantoMultiplier)) {
      throw new GateApiError('계약 가격 또는 단위를 확인할 수 없습니다.', { code: 'ORDER_RISK_METADATA_INVALID' });
    }
    const protectedMemberSize = memberPositionBaselines.get(symbol) || 0;
    const protectedRatio = member.total > 0
      ? Math.abs(protectedMemberSize) * (memberPosition.markPrice || markPrice) * contractInfo.quantoMultiplier / member.total * 100 : 0;
    // Proportional sizing only; the member risk caps below keep using `member.total`.
    const masterEquity = sizingEquity(master);
    const memberEquity = sizingEquity(member);
    const target = calculateTargetPosition({
      masterSize: masterPosition.size, masterEquity, masterMarkPrice: markPrice,
      masterQuantoMultiplier: contractInfo.quantoMultiplier, memberEquity,
      // Both legs trade the same Gate contract. Use one reference price so a
      // read/entry-price difference cannot manufacture additional contracts.
      memberMarkPrice: markPrice, memberQuantoMultiplier: contractInfo.quantoMultiplier,
      copyRatio: member.copy_ratio, maxPositionRatio: Math.max(0, member.max_position_ratio - protectedRatio), sizeStep: contractInfo.sizeStep,
    });
    target.targetSize += protectedMemberSize;
    const anchor = targetAnchors.get(symbol);
    const anchorMatchesResume = Boolean(anchor?.resume_version && member.resume_version
      && anchor.resume_version === member.resume_version);
    const masterQuantityUnchanged = anchorMatchesResume
      && Number(anchor.master_copyable_size) === Number(masterPosition.size);
    const masterQuantityReduced = anchorMatchesResume
      && Math.abs(Number(masterPosition.size)) < Math.abs(Number(anchor.master_copyable_size))
      && (Number(masterPosition.size) === 0
        || Math.sign(Number(masterPosition.size)) === Math.sign(Number(anchor.master_copyable_size)));
    const masterQuantityIncreased = anchorMatchesResume
      && Math.abs(masterPosition.size) > Math.abs(Number(anchor.master_copyable_size))
      && (!Number(anchor.master_copyable_size) || Math.sign(masterPosition.size) === Math.sign(Number(anchor.master_copyable_size)));
    // null: the anchor takes the observed Master copyable size (DB default).
    let anchorMasterCopyableSize = null;
    if (masterQuantityIncreased) {
      // Every anchored leg follows only the Master's CHANGE since its anchor. Re-sizing the whole leg
      // at the current equity ratio could make a member SELL while the Master BUYS (P0-1). The anchored
      // COPY decision is kept as decided (a shortfall still completes, as with an unchanged Master) and
      // only the increment is sized at the current ratio. Reductions keep min(anchor, actual) so a
      // Master reduction never becomes a member increase.
      const anchorMaster = Number(anchor.master_copyable_size);
      const increment = masterPosition.size - anchorMaster;
      const incremental = calculateTargetPosition({
        masterSize: increment, masterEquity,
        masterMarkPrice: markPrice, masterQuantoMultiplier: contractInfo.quantoMultiplier,
        memberEquity, memberMarkPrice: markPrice, memberQuantoMultiplier: contractInfo.quantoMultiplier,
        copyRatio: member.copy_ratio, maxPositionRatio: Math.max(0, member.max_position_ratio - protectedRatio), sizeStep: contractInfo.sizeStep,
      });
      const lockedTargetSize = Number(anchor.target_size) + incremental.targetSize;
      target.targetSize = capLockedTargetToCurrentRisk({
        lockedTargetSize, protectedSize: protectedMemberSize,
        memberEquity: member.total, memberMarkPrice: memberPosition.markPrice || markPrice,
        memberQuantoMultiplier: contractInfo.quantoMultiplier,
        maxPositionRatio: member.max_position_ratio, sizeStep: contractInfo.sizeStep,
      });
      const rawLots = Math.abs(incremental.uncappedTargetNotional) / (markPrice * contractInfo.quantoMultiplier);
      if (target.targetSize !== lockedTargetSize) {
        // The current risk cap binds: the whole Master increase is consumed (no later buy-back).
        target.targetLockReason = 'CURRENT_RISK_CAP_REDUCTION';
      } else if (incremental.targetSize === 0 && !incremental.capped) {
        // Smaller than one member lot at the current ratio: same target as an unchanged Master, and
        // the anchor keeps its Master quantity so later increases accumulate instead of each rounding
        // to zero (the stored target still records any cut applied below).
        target.targetLockReason = 'MASTER_INCREASE_BELOW_MEMBER_LOT';
        anchorMasterCopyableSize = anchorMaster;
      } else {
        target.targetLockReason = continuedCopyLegs.has(symbol) ? 'CONFIRMED_COPY_FUTURE_INCREASE' : 'MASTER_QUANTITY_INCREASED';
        // Consume only the Master quantity the member lots represent; the remainder carries over.
        if (!incremental.capped) {
          anchorMasterCopyableSize = partialAnchorMasterSize({
            anchorMaster, masterSize: masterPosition.size, lots: incremental.targetSize, rawLots,
          });
        }
      }
    } else if (masterQuantityUnchanged || masterQuantityReduced) {
      const lockedTargetSize = masterQuantityReduced
        ? calculateReducedCopyTarget({
          previousMasterSize: anchor.master_copyable_size,
          masterSize: masterPosition.size,
          lockedTargetSize: protectedMemberSize + Math.sign(Number(anchor.target_size) - protectedMemberSize)
            * Math.min(Math.abs(Number(anchor.target_size) - protectedMemberSize),
              Math.max(0, Math.abs(memberPosition.size) - Math.abs(protectedMemberSize))),
          protectedSize: protectedMemberSize,
          sizeStep: contractInfo.sizeStep,
        })
        : Number(anchor.target_size);
      target.targetSize = capLockedTargetToCurrentRisk({
        lockedTargetSize,
        protectedSize: protectedMemberSize,
        memberEquity: member.total,
        memberMarkPrice: memberPosition.markPrice || markPrice,
        memberQuantoMultiplier: contractInfo.quantoMultiplier,
        maxPositionRatio: member.max_position_ratio,
        sizeStep: contractInfo.sizeStep,
      });
      target.targetLockReason = target.targetSize === lockedTargetSize
        ? (masterQuantityReduced ? 'MASTER_QUANTITY_REDUCED_PROPORTIONALLY' : 'MASTER_QUANTITY_UNCHANGED')
        : 'CURRENT_RISK_CAP_REDUCTION';
    } else {
      target.targetLockReason = anchorMatchesResume ? 'MASTER_QUANTITY_CHANGED' : 'TARGET_ANCHOR_INITIALIZED';
    }
    target.targetNotional = Math.abs(target.targetSize) * (memberPosition.markPrice || markPrice) * contractInfo.quantoMultiplier;
    const previous = previousStates.get(symbol);
    const targetLeverage = Number(observedMasterPosition.leverage || previous?.target_leverage || memberPosition.leverage || 0);
    const riskLeverage = protectedMemberSize ? Number(memberPosition.leverage || 0) : targetLeverage;
    const marginMode = String(observedMasterPosition.posMarginMode || previous?.margin_mode || memberPosition.posMarginMode || 'cross');
    // An outstanding order may already have filled at Gate even when the
    // account read has not caught up. Do not create a fresh cycle/order key
    // until reconciliation resolves it and a later observation replans.
    const hasUnresolvedOrder = Boolean(previous?.has_unresolved_order);
    const hasOpenExchangeOrder = (member.open_orders || []).some((order) => order.contract === contract);
    const oppositeKey = `${contract}:${positionSide === 'LONG' ? 'SHORT' : 'LONG'}`;
    // A dual-mode reversal is two executions with a fill/observation dependency.
    // Never reserve an entry while the retiring COPY leg is still present or
    // unresolved. Protected holdings and a Master that keeps both legs are
    // separate cases; neither is permission to liquidate the member's hedge.
    const reversalCloseRequired = !member.close_positions_requested
      && Math.abs(target.targetSize) > Math.abs(memberPosition.size)
      && Number(masterPositions.get(oppositeKey)?.size || 0) === 0
      && (Number(memberPositions.get(oppositeKey)?.size || 0) !== (memberPositionBaselines.get(oppositeKey) || 0)
        || Boolean(previousStates.get(oppositeKey)?.has_unresolved_order));
    const protectedOppositePosition = !String(member.positionMode || 'single').startsWith('dual')
      && [...memberPositionBaselines.entries()].some(([baselineKey, size]) => {
        const baselineLeg = parsePositionKey(baselineKey);
        return baselineLeg.contract === contract && baselineLeg.positionSide !== positionSide && size !== 0;
      })
      && target.targetSize !== 0;
    if (member.close_positions_requested) {
      target.targetSize = 0;
      target.targetNotional = 0;
    }
    const manual = detectManualOverride({
      previousActualSize: Number(previous?.actual_size || 0), currentActualSize: memberPosition.size,
      knownPlatformFillDelta: Number(previous?.known_fill_delta || 0), sizeStep: contractInfo.sizeStep,
      hasUnresolvedPlatformOrder: hasUnresolvedOrder,
      hasBaseline: Boolean(previous) && !['HALTED', 'PAUSED'].includes(previous.state),
    });
    // Never buy back a protected holding the member has reduced manually.
    if (protectedMemberSize && !member.close_positions_requested
      && (Math.sign(memberPosition.size) !== Math.sign(protectedMemberSize)
        || Math.abs(memberPosition.size) < Math.abs(protectedMemberSize))) {
      manual.detected = true;
      manual.unexplainedDelta = memberPosition.size - protectedMemberSize;
    }
    if (member.resume_version && !previous && !anchor && memberPosition.size !== protectedMemberSize
      && !hasUnresolvedOrder && !member.close_positions_requested) {
      manual.detected = true;
      manual.unexplainedDelta = memberPosition.size - protectedMemberSize;
    }
    let budgetReason = null;
    if (!member.close_positions_requested && !hasUnresolvedOrder && !hasOpenExchangeOrder
      && !member.resume_required && !manual.detected && !reversalCloseRequired && !masterUnconfirmed) {
      const price = memberPosition.markPrice || markPrice;
      const unitNotional = price * contractInfo.quantoMultiplier;
      const otherLegNotional = member.positions.filter((position) => position.contract === contract
        && positionKey(position) !== symbol).reduce((sum, position) =>
        sum + Math.abs(position.size) * (position.markPrice || price) * contractInfo.quantoMultiplier, 0);
      const availableSymbolNotional = Math.max(0, member.total * member.max_position_ratio / 100
        - otherLegNotional - (reservedNotional.get(contract) || 0));
      const grossCapped = Math.sign(target.targetSize) * Math.max(Math.abs(protectedMemberSize),
        Math.min(Math.abs(target.targetSize), Math.abs(roundTowardZeroToStep(availableSymbolNotional / unitNotional, contractInfo.sizeStep))));
      if (Math.abs(grossCapped) < Math.abs(target.targetSize)) {
        target.targetSize = grossCapped;
        budgetReason = 'SYMBOL_GROSS_EXPOSURE_LIMIT';
      }
      const increase = Math.max(0, Math.abs(target.targetSize) - Math.abs(memberPosition.size));
      // Reserve the worst allowed entry price, margin and a conservative fee.
      // Never spend expected proceeds from a reduction that has not filled.
      const feeRate = Math.max(0, Number(contractInfo.takerFeeRate ?? 0.001));
      const marginPerUnit = unitNotional * (1 + Number(system.max_order_slippage_ratio ?? 0.005))
        * (1 / Math.max(1, riskLeverage) + feeRate);
      if (increase > 0) {
        const affordable = Math.max(0, roundTowardZeroToStep(remainingMargin / marginPerUnit, contractInfo.sizeStep));
        if (affordable < increase) {
          target.targetSize = Math.sign(target.targetSize) * (Math.abs(memberPosition.size) + affordable);
          budgetReason = 'INSUFFICIENT_AVAILABLE_MARGIN';
        }
      }
      if (!manual.detected && !hasUnresolvedOrder && !hasOpenExchangeOrder && !member.resume_required) {
        const reservedSize = Math.max(0, Math.abs(target.targetSize) - Math.abs(memberPosition.size));
        remainingMargin = Math.max(0, remainingMargin - reservedSize * marginPerUnit);
        reservedNotional.set(contract, (reservedNotional.get(contract) || 0) + reservedSize * unitNotional);
      }
      if (budgetReason) target.targetLockReason = budgetReason;
      target.targetNotional = Math.abs(target.targetSize) * unitNotional;
    }
    const reduceOnly = Boolean(member.reduce_only) || Boolean(member.close_positions_requested) || contractInfo.inDelisting === true;
    const state = deriveCopyState({
      systemHalted: Boolean(system.emergency_halted) && !simulateSystemHalt, memberHalted: Boolean(member.halted),
      symbolPaused: Boolean(member.resume_required) || hasUnresolvedOrder || hasOpenExchangeOrder || reversalCloseRequired
        || masterUnconfirmed
        || ((Boolean(member.copy_paused) || protectedOppositePosition) && !member.close_positions_requested),
      // A member who asked to stop and close wants every leg closed, including one changed outside
      // the platform. Close orders are reduce-only to zero and re-read before submission.
      manualOverride: !member.close_positions_requested && (manual.detected || previous?.state === 'MANUAL_OVERRIDE'), reduceOnly,
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
    const idempotencyKey = delta.shouldSubmit ? buildIdempotencyKey({ cycleId, userId: member.user_id, contract, positionSide, targetSize: target.targetSize, actualSize: memberPosition.size }) : null;
    const plannedPosition = {
      contract, position_side: positionSide, position_mode: member.positionMode || 'single',
      size: memberPosition.size, mark_price: memberPosition.markPrice || reportedMarkPrice || null,
      entry_price: memberPosition.entryPrice || null, leverage: memberPosition.leverage || null,
      target_leverage: targetLeverage || null, margin_mode: marginMode,
      quanto_multiplier: contractInfo.quantoMultiplier, target_size: target.targetSize,
      state, delta_size: delta.deltaSize, previous_actual_size: previous?.actual_size ?? null,
      unexplained_delta: manual.unexplainedDelta,
      master_baseline_size: masterBaselines.get(symbol) || 0,
      master_copyable_size: masterPosition.size,
      member_baseline_size: protectedMemberSize,
      target_resume_version: member.resume_version || null,
      target_lock_reason: target.targetLockReason,
      anchor_update_allowed: !hasUnresolvedOrder && !hasOpenExchangeOrder && !member.resume_required
        && !manual.detected && !reversalCloseRequired && previous?.state !== 'MANUAL_OVERRIDE' && !masterUnconfirmed,
      ...(anchorMasterCopyableSize == null ? {} : { anchor_master_copyable_size: anchorMasterCopyableSize }),
      sizing_reason: budgetReason,
      execution_reason: delta.reason,
      master_actual_size: Number(observedMasterPosition.size),
      risk_leverage: riskLeverage, taker_fee_rate: Number(contractInfo.takerFeeRate ?? 0.001),
      baseline_clear_requested: baseline.clearBaseline,
      pause_reason: member.resume_required ? 'MEMBER_RESUME_VALIDATION_REQUIRED'
        : masterUnconfirmed ? 'MASTER_POSITION_UNCONFIRMED'
        : manual.detected ? 'MEMBER_POSITION_CHANGED_OUTSIDE_PLATFORM'
        : reversalCloseRequired ? 'COPY_REVERSAL_CLOSE_REQUIRED'
        : hasUnresolvedOrder ? 'UNRESOLVED_PLATFORM_ORDER'
          : hasOpenExchangeOrder ? 'OPEN_EXCHANGE_ORDER'
          : protectedOppositePosition ? 'PROTECTED_EXISTING_POSITION_OPPOSITE_SIDE'
            : member.risk_halt_reason || (member.copy_paused ? 'MEMBER_PAUSED' : null) || budgetReason,
    };
    if (delta.shouldSubmit) {
      plannedPosition.intent = {
        delta_size: delta.deltaSize, reduce_only: delta.reduceOnly,
        position_side: positionSide, position_mode: member.positionMode || 'single',
        target_leverage: protectedMemberSize ? null : targetLeverage || null, margin_mode: marginMode,
        pid: memberPosition.pid || null,
        idempotency_key: idempotencyKey, gate_order_text: buildGateOrderText(idempotencyKey),
      };
    }
    planned.push(plannedPosition);
  }
  return planned;
}

export class TradingRunner {
  constructor({ supabase, baseUrl, workerId, workerVersion, publicIp, channelId, mode = 'OBSERVE', fetchImpl = fetch, logger = null, onSafetyEvent = null }) {
    Object.assign(this, { supabase, baseUrl, workerId, workerVersion, publicIp, channelId, mode, fetchImpl, logger, onSafetyEvent });
    this.contracts = null;
    this.contractsLoadedAt = 0;
    this.lastDryRunPlanHash = null;
    this.lastDryRunMasterHash = null;
    this.performanceSyncedAt = new Map();
    this.currentCopyEventId = null;
    this.resumeAlerts = new Map();
    // P0-2: Master legs seen in the previous cycle, and baseline reductions awaiting a second read.
    this.cycleSeq = 0;
    this.lastMasterSizes = new Map();
    this.recentMasterContracts = new Map();
    this.pendingBaselineClears = new Map();
    // P1-8: resume validation runs after the order phase, one member per cycle.
    this.pendingResumes = [];
    this.resumeAttemptAt = new Map();
    this.staleFillAlerts = new Map();
    this.notFoundAfterExpiry = new Map();
    this.unconfirmedSince = new Map();
    this.lastUnconfirmedKey = '';
    this.lastUnconfirmedAlertAt = 0;
    this.latestPerformanceMembers = [];
  }
  // A FUTURE_ONLY baseline only shrinks, permanently. One empty or partial Master read must not
  // shrink it (the member would then copy the Master's pre-resume holdings): require the same
  // reduction in two consecutive cycles and keep the smaller shrink of the two.
  confirmBaselineClear(accountId, version, leg) {
    const key = `${accountId}:${version}:${leg.contract}:${leg.position_side}`;
    const previous = this.pendingBaselineClears.get(key);
    this.pendingBaselineClears.set(key, { size: Number(leg.size), seq: this.cycleSeq });
    if (!previous || previous.seq !== this.cycleSeq - 1) return null;
    this.pendingBaselineClears.delete(key);
    return { ...leg, size: Math.abs(previous.size) >= Math.abs(Number(leg.size)) ? previous.size : Number(leg.size) };
  }
  // Member legs on an unconfirmed Master contract are paused, so a contract that stays unconfirmed
  // must reach a person: log on change, alert once it lasts about a minute (then every 30 minutes).
  trackUnconfirmedMasterContracts(current) {
    const key = [...current].sort().join(',');
    if (key !== this.lastUnconfirmedKey && this.logger) this.logger('master_positions_unconfirmed', { contracts: [...current].sort() });
    this.lastUnconfirmedKey = key;
    for (const contract of current) if (!this.unconfirmedSince.has(contract)) this.unconfirmedSince.set(contract, this.cycleSeq);
    for (const contract of [...this.unconfirmedSince.keys()]) if (!current.has(contract)) this.unconfirmedSince.delete(contract);
    const lasting = [...this.unconfirmedSince].filter(([, seq]) => this.cycleSeq - seq >= 12).map(([contract]) => contract).sort();
    if (!lasting.length || !this.onSafetyEvent || Date.now() - this.lastUnconfirmedAlertAt < 1_800_000) return;
    this.lastUnconfirmedAlertAt = Date.now();
    Promise.resolve(this.onSafetyEvent({ event: 'MASTER_POSITION_UNCONFIRMED', severity: 'CRITICAL',
      details: { contract: lasting.join(', '), action: '해당 종목 회원 주문 보류' } })).catch(() => {});
  }
  // Contracts and legs the Master read must confirm individually when Gate's list omits them: legs
  // seen in the previous read, contracts seen in roughly the last minute, and every leg that ACTIVE
  // copy state depends on (FUTURE_ONLY baselines, target anchors).
  masterExpectations(resumeContext = [], targetAnchors = []) {
    const contracts = new Set(this.recentMasterContracts.keys());
    const legs = new Set([...this.lastMasterSizes].filter(([, size]) => size !== 0).map(([key]) => key));
    const activeAccounts = new Set();
    for (const session of resumeContext || []) {
      if (session?.state !== 'ACTIVE') continue;
      activeAccounts.add(session.trading_account_id);
      for (const position of session?.positions || []) {
        if (!Number(position?.size) || !position.contract) continue;
        contracts.add(position.contract);
        legs.add(positionKey(position));
      }
    }
    for (const anchor of targetAnchors || []) {
      if (!activeAccounts.has(anchor?.trading_account_id) || !Number(anchor?.master_copyable_size) || !anchor.contract) continue;
      contracts.add(anchor.contract);
      legs.add(positionKey({ ...anchor, size: anchor.master_copyable_size }));
    }
    return { contracts: [...contracts].sort(), legs: [...legs].sort() };
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
  async detectAndHaltOrderAnomaly() {
    return this.rpc('detect_and_halt_copy_order_anomaly');
  }
  async syncCurrentState(payload) {
    if (!payload) return { synced: false, duration_ms: 0 };
    const startedAt = Date.now();
    try {
      await this.rpc('upsert_copy_current_state', { p_payload: payload });
      return { synced: true, duration_ms: elapsedMs(startedAt) };
    } catch (error) {
      const errorCode = safeError(error, 'CURRENT_STATE_SHADOW_WRITE');
      if (this.logger) this.logger('current_state_shadow_write_failed', {
        copy_event_id: payload.copy_event_id,
        error_code: errorCode,
        duration_ms: elapsedMs(startedAt),
      });
      return { synced: false, error_code: errorCode, duration_ms: elapsedMs(startedAt) };
    }
  }
  async loadContracts() {
    if (!this.contracts || Date.now() - this.contractsLoadedAt > 3_600_000) {
      this.contracts = await getFuturesContracts({ baseUrl: this.baseUrl, fetchImpl: this.fetchImpl });
      this.contractsLoadedAt = Date.now();
    }
    return this.contracts;
  }
  async readAccount(account) {
    const startedAt = new Date().toISOString();
    const auth = credentials(account);
    const [summary, positions, openOrders] = await Promise.all([
      getFuturesAccount({ ...auth, baseUrl: this.baseUrl, fetchImpl: this.fetchImpl }),
      getFuturesPositions({ ...auth, baseUrl: this.baseUrl, fetchImpl: this.fetchImpl,
        expectedContracts: account.expected_contracts || (account.previous_states || []).map((p) => p.contract),
        expectedLegs: account.expected_legs || [], tolerateUnconfirmed: account.tolerate_unconfirmed_positions === true }),
      listFuturesOrders({ ...auth, baseUrl: this.baseUrl, fetchImpl: this.fetchImpl, status: 'open', limit: 100 }),
    ]);
    const dayStart = Number(account.day_start_equity || 0);
    const peak = Number(account.peak_equity || 0);
    const dailyLossPct = dayStart > 0 ? Math.max(0, ((dayStart - summary.total) / dayStart) * 100) : 0;
    const drawdownPct = peak > 0 ? Math.max(0, ((peak - summary.total) / peak) * 100) : 0;
    const dailyLimitHit = dailyLossPct >= Number(account.daily_loss_limit_pct || 5);
    const drawdownLimitHit = drawdownPct >= Number(account.max_drawdown_pct || 15);
    const riskHalted = dailyLimitHit || drawdownLimitHit;
    if (openOrders.length >= 100) throw new GateApiError('미체결 주문을 모두 확인해야 합니다.', { code: 'OPEN_ORDERS_LIMIT_REACHED' });
    return { ...account, ...summary, positions, open_orders: openOrders,
      unconfirmed_contracts: positions.unconfirmedContracts || [],
      observed_started_at: startedAt, observed_at: new Date().toISOString(),
      halted: Boolean(account.halted), reduce_only: Boolean(account.reduce_only) || riskHalted,
      risk_halt_reason: dailyLimitHit ? 'DAILY_LOSS_LIMIT' : drawdownLimitHit ? 'MAX_DRAWDOWN_LIMIT' : null,
      daily_loss_pct: dailyLossPct, drawdown_pct: drawdownPct };
  }
  async readResumeSnapshot(masterContext, memberContext) {
    const startedAt = Date.now();
    const [master, member] = await Promise.all([
      this.readAccount((({ contracts, legs }) => ({ ...masterContext, expected_contracts: contracts, expected_legs: legs }))(this.masterExpectations())),
      this.readAccount(memberContext),
    ]);
    // Only the member's resting orders can change what the member holds while resume is validated.
    // A Master order that fills in between changes the Master snapshot, which the second read rejects.
    return { master, member, startedAt, openOrders: member.open_orders || [] };
  }
  async processMemberResume({ session, masterContext, memberContext, contracts, system }) {
    if (!['REQUESTED', 'VALIDATED'].includes(session?.state)) return;
    const syncCurrentMaster = session.sync_current_master === true;
    let reason;
    try {
      if (session.ownership_status === 'UNKNOWN') throw new Error('RESUME_COPY_OWNERSHIP_UNKNOWN');
      // A resume flag is not consent to rebalance. The DB supplies a receipt
      // bound to this account and resume generation only for NEW_OPERATION.
      if (session.resume_authorized === false || (syncCurrentMaster
        && !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(session.current_master_operation_id || ''))) {
        throw new Error('RESUME_CURRENT_MASTER_AUTHORIZATION_REQUIRED');
      }
      if (Date.parse(session.expires_at) <= Date.now()) throw new Error('RESUME_REQUEST_EXPIRED');
      if (Number(session.unresolved_orders) !== 0) throw new Error('RESUME_UNRESOLVED_ORDERS');
      if (session.state === 'VALIDATED' && (this.mode !== 'LIVE' || system?.emergency_halted || !system?.execution_enabled)) return { validated: true };
      const first = await this.readResumeSnapshot(masterContext, memberContext);
      reason = validateResumeSnapshot({ ...first, contracts });
      if (reason) throw new Error(reason);
      const observedMemberPositions = resumePositions(first.member.positions);
      if (syncCurrentMaster && observedMemberPositions.length) throw new Error('RESUME_NEW_OPERATION_NOT_FLAT');
      // Only the database's generation-linked observation journal may carry
      // COPY across resume. Historical fill sums are never subtracted here.
      const ownership = syncCurrentMaster ? null : await this.rpc('get_member_copy_resume_ownership', {
        p_trading_account_id: memberContext.trading_account_id, p_version: session.version,
        p_master_positions: resumePositions(first.master.positions), p_member_positions: observedMemberPositions,
      });
      if (!syncCurrentMaster && (!ownership || !Array.isArray(ownership.copy_positions)
        || !Array.isArray(ownership.target_anchors))) throw new Error('RESUME_COPY_OWNERSHIP_UNKNOWN');
      const protectedMemberPositions = syncCurrentMaster ? [] : ownership.member_positions;
      const preview = planMemberPositions({
        cycleId: randomUUID(), system: { emergency_halted: false }, contracts, master: first.master,
        member: { ...first.member, copy_paused: false, resume_required: false, previous_states: [],
          resume_version: session.version, target_anchors: ownership?.target_anchors || [],
          continued_copy_positions: ownership?.copy_positions || [],
          master_baselines: syncCurrentMaster ? [] : ownership.master_positions,
          member_position_baselines: protectedMemberPositions },
      });
      const previewValid = syncCurrentMaster
        ? validateCurrentMasterSyncPreview(preview, first.member.positions, protectedMemberPositions)
        : validateResumePreview(preview, first.member.positions);
      if (!previewValid) throw new Error(syncCurrentMaster
        ? 'RESUME_CURRENT_MASTER_PREVIEW_INVALID' : 'RESUME_PREVIEW_NOT_ZERO');
      const payload = (snapshot) => ({
        resume_policy_version: syncCurrentMaster ? 1 : 2,
        ...(ownership ? { ownership } : {}),
        resume_mode: syncCurrentMaster ? 'CURRENT_MASTER' : 'FUTURE_ONLY',
        current_master_operation_id: syncCurrentMaster ? session.current_master_operation_id : null,
        observed_master_positions: resumePositions(snapshot.master.positions),
        observed_member_positions: resumePositions(snapshot.member.positions),
        started_at: new Date(snapshot.startedAt).toISOString(),
        observed_at: new Date().toISOString(),
        // New-operation sessions intentionally use an empty Master baseline:
        // the first active cycle copies the full current portfolio at the
        // current Master/member equity ratio. Raw Master quantities are still
        // compared twice above before activation.
        master_positions: syncCurrentMaster ? [] : ownership.master_positions,
        member_positions: protectedMemberPositions,
        settings: { copy_ratio: Number(snapshot.member.copy_ratio ?? 100), max_position_ratio: Number(snapshot.member.max_position_ratio ?? 30),
          daily_loss_limit_pct: Number(snapshot.member.daily_loss_limit_pct ?? 5), max_drawdown_pct: Number(snapshot.member.max_drawdown_pct ?? 15),
          max_leverage: Number(snapshot.member.max_leverage ?? 10) },
        open_order_count: snapshot.openOrders.length, preview_passed: true,
      });
      await this.rpc('prepare_member_copy_resume', { p_trading_account_id: memberContext.trading_account_id,
        p_version: session.version, p_snapshot: payload(first) });
      // DRY_RUN validates and stores the protected quantities; it never enables a member.
      if (this.mode !== 'LIVE' || system?.emergency_halted || !system?.execution_enabled) return { validated: true };
      const second = await this.readResumeSnapshot(masterContext, memberContext);
      reason = validateResumeSnapshot({ ...second, contracts });
      if (reason || Date.now() - first.startedAt > RESUME_MAX_AGE_MS
        || !sameResumePositions(first.master.positions, second.master.positions)
        || !sameResumePositions(first.member.positions, second.member.positions)
        || first.master.positionMode !== second.master.positionMode
        || first.member.positionMode !== second.member.positionMode) throw new Error(reason || 'RESUME_SNAPSHOT_CHANGED');
      const activation = await this.rpc('activate_member_copy_resume', { p_trading_account_id: memberContext.trading_account_id,
        p_version: session.version, p_snapshot: payload(second) });
      this.resumeAlerts.delete(memberContext.trading_account_id);
      return { validated: true, activated: activation?.state === 'ACTIVE' };
    } catch (error) {
      const code = error.message?.match(/\bRESUME_[A-Z_]+\b/)?.[0] || safeError(error, 'RESUME');
      await this.rpc('report_member_copy_resume_blocker', {
        p_trading_account_id: memberContext.trading_account_id, p_version: session.version, p_reason: code,
      });
      const lastAlert = this.resumeAlerts.get(memberContext.trading_account_id);
      if ((!lastAlert || lastAlert.version !== session.version || Date.now() - lastAlert.at > 300_000) && this.onSafetyEvent) {
        const sent = await this.onSafetyEvent({ event: 'MEMBER_COPY_RESUME_WAITING', severity: 'WARNING',
          details: { reason: code, user_id: memberContext.user_id, trading_account_id: memberContext.trading_account_id } });
        if (sent?.sent) this.resumeAlerts.set(memberContext.trading_account_id, { version: session.version, at: Date.now() });
      }
      if (this.logger) this.logger('member_resume_waiting', { trading_account_id: memberContext.trading_account_id, error_code: code });
    }
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
    await this.rpc('prune_member_symbol_daily_performance', {
      p_user_id: member.user_id,
      p_trading_date: range.tradingDate,
      p_active_contracts: performance.symbols.map((row) => row.contract),
      p_source_snapshot_at: observedAt,
    });
    this.performanceSyncedAt.set(member.user_id, Date.now());
  }
  async syncOnce() {
    const cycleStartedAt = Date.now();
    const cycleId = randomUUID();
    this.currentCopyEventId = cycleId;
    this.cycleSeq += 1;
    for (const [key, pending] of this.pendingBaselineClears) {
      if (pending.seq < this.cycleSeq - 1) this.pendingBaselineClears.delete(key);
    }
    this.pendingResumes = [];
    const contextStartedAt = Date.now();
    const [rawContext, observationGuards, resumeContext, targetAnchors] = await Promise.all([
      this.rpc('get_copy_worker_context'),
      this.rpc('get_copy_order_observation_guards'),
      this.rpc('get_copy_resume_context'),
      this.rpc('get_copy_target_anchors'),
    ]);
    const context = applyOrderObservationGuards(rawContext, observationGuards);
    const timings = { context_ms: elapsedMs(contextStartedAt) };
    if (!context?.master) return {
      observed: 0, masterObserved: 0, intents: 0, copyEventId: cycleId,
      currentStatePayload: null, timings: { ...timings, total_ms: elapsedMs(cycleStartedAt) },
    };
    const memberContexts = Array.isArray(context.members) ? context.members : [];
    const sessions = new Map((resumeContext || []).map((s) => [s.trading_account_id, s]));
    const anchorsByAccount = new Map();
    for (const anchor of targetAnchors || []) {
      const anchors = anchorsByAccount.get(anchor.trading_account_id) || [];
      anchors.push(anchor);
      anchorsByAccount.set(anchor.trading_account_id, anchors);
    }
    const contractsStartedAt = Date.now();
    let contracts = memberContexts.length ? await this.loadContracts() : new Map();
    timings.contracts_ms = elapsedMs(contractsStartedAt);
    const observedAt = new Date().toISOString();
    const masterReadStartedAt = Date.now();
    // P0-2: an empty or partial position list must not look like a Master close. Every contract the
    // copy state depends on (last seen legs, FUTURE_ONLY baselines, anchors) is confirmed by Gate's
    // single-contract endpoint when the list omits it.
    const masterExpected = this.masterExpectations(resumeContext, targetAnchors);
    const [master, memberReads] = await Promise.all([
      this.readAccount({ ...context.master, expected_contracts: masterExpected.contracts, expected_legs: masterExpected.legs,
        tolerate_unconfirmed_positions: true }),
      Promise.allSettled(memberContexts.map((account) => this.readAccount({
        ...account, expected_contracts: sessions.get(account.trading_account_id)?.expected_contracts || [],
      }))),
    ]);
    timings.master_exchange_ms = elapsedMs(masterReadStartedAt);
    assertFreshAccount(master);
    // A contract Gate could not confirm this cycle (its single-contract read failed) has unknown Master
    // legs: member legs on it are paused and no anchor or baseline moves (planMemberPositions), instead
    // of one flaky contract failing every member's cycle.
    const unconfirmedMasterContracts = new Set(master.unconfirmed_contracts || []);
    const currentMasterSizes = new Map(master.positions
      .filter((position) => !unconfirmedMasterContracts.has(position.contract))
      .map((position) => [positionKey(position), Number(position.size)]));
    for (const [key, size] of this.lastMasterSizes) {
      if (unconfirmedMasterContracts.has(parsePositionKey(key).contract)) currentMasterSizes.set(key, size);
    }
    this.lastMasterSizes = currentMasterSizes;
    for (const position of master.positions) this.recentMasterContracts.set(position.contract, this.cycleSeq);
    for (const contract of unconfirmedMasterContracts) this.recentMasterContracts.set(contract, this.cycleSeq);
    for (const [contract, seq] of this.recentMasterContracts) {
      if (seq < this.cycleSeq - 12) this.recentMasterContracts.delete(contract);
    }
    this.trackUnconfirmedMasterContracts(unconfirmedMasterContracts);
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
          position_side: normalizePositionSide(position),
          size: position.size,
          mark_price: position.markPrice,
          leverage: position.leverage || null,
          margin_mode: position.posMarginMode || null,
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
    const membersStartedAt = Date.now();
    for (const [memberIndex, memberContext] of memberContexts.entries()) {
      let memberStage = 'MEMBER_ACCOUNT_READ';
      try {
        const session = sessions.get(memberContext.trading_account_id);
        const closing = session?.state === 'CLOSING';
        memberContext.expected_contracts = session?.expected_contracts || [];
        memberContext.resume_required = closing ? !memberContext.close_positions_requested
          : session?.state !== 'ACTIVE' || session?.baseline_version !== session?.version;
        // CLOSE is an exit: unknown COPY ownership must not stop close-only orders (P1-4). The DB still
        // limits a close-requested member to reduce-only orders that target zero.
        if (!closing && (session?.ownership_status === 'UNKNOWN' || session?.resume_authorized === false
          || (session?.sync_current_master === true && !session?.current_master_operation_id))) memberContext.resume_required = true;
        memberContext.resume_version = session?.version || null;
        memberContext.target_anchors = anchorsByAccount.get(memberContext.trading_account_id) || [];
        if (['REQUESTED', 'VALIDATED'].includes(session?.state)) {
          // P1-8: validation does its own fresh reads; running it here spent this cycle's 15 s
          // snapshot budget for every member. It runs after the order phase instead.
          this.pendingResumes.push({ session, masterContext: context.master, memberContext, contracts, system: context.system });
          continue;
        }
        const memberRead = memberReads[memberIndex];
        if (memberRead.status === 'rejected') throw memberRead.reason;
        let member = { ...memberRead.value, resume_required: memberContext.resume_required, resume_version: memberContext.resume_version,
          target_anchors: memberContext.target_anchors, continued_copy_positions: session?.copy_positions || [] };
        assertFreshAccount(member);
        // Concurrent account reads reduce skew; any remaining slow snapshot is
        // observed without producing an executable plan.
        const snapshotTimes = [master.observed_at, member.observed_at].map(Date.parse);
        if (snapshotTimes.every(Number.isFinite) && (Math.abs(snapshotTimes[0] - snapshotTimes[1]) > 3_000
          || Date.now() - Math.min(...snapshotTimes) > RESUME_MAX_AGE_MS)) member.resume_required = true;
        memberStage = 'BASELINE_INIT';
        const baseline = session?.state === 'CLOSING' ? { positions: [], member_positions: [] }
          : {
            // Use the validated, persisted baseline, never override it from a flag.
            positions: session?.positions || [],
            member_positions: session?.member_positions || [],
          };
        if (!member.resume_required) await this.rpc('confirm_copy_order_observation', {
          p_trading_account_id: member.trading_account_id, p_version: session.version,
          p_positions: resumePositions(member.positions), p_started_at: member.observed_started_at, p_observed_at: member.observed_at,
        });
        const observedMasterPositions = positionMap(master.positions);
        const baselinePositions = baseline?.positions || [];
        const contractsToClear = baselinePositions.filter((position) => {
          const currentSize = Number(observedMasterPositions.get(positionKey(position))?.size || 0);
          const baselineSize = Number(position.size || 0);
          return Math.abs(currentSize) < Math.abs(baselineSize) || (baselineSize !== 0 && Math.sign(currentSize) !== Math.sign(baselineSize));
        }).map((position) => {
          const currentSize = Number(observedMasterPositions.get(positionKey(position))?.size || 0);
          return { contract: position.contract, position_side: normalizePositionSide(position),
            size: Math.sign(currentSize) === Math.sign(Number(position.size)) ? currentSize : 0 };
        });
        const confirmedClears = member.resume_required ? [] : contractsToClear
          .filter((position) => !unconfirmedMasterContracts.has(position.contract))
          .map((position) => this.confirmBaselineClear(memberContext.trading_account_id, session?.version, position))
          .filter(Boolean);
        if (confirmedClears.length) {
          memberStage = 'BASELINE_CLEAR';
          await this.rpc('advance_member_copy_resume_baseline_legs', {
            p_trading_account_id: memberContext.trading_account_id,
            p_version: session.version,
            p_positions: confirmedClears,
          });
        }
        // Until a reduction is confirmed the stored baseline stays in effect; a smaller Master leg
        // yields no copyable quantity under either baseline, so nothing is copied early.
        const updatedBaselines = new Map(confirmedClears.map((p) => [positionKey(p), p]));
        const activeBaselines = baselinePositions.map((p) => updatedBaselines.get(positionKey(p)) || p).filter((p) => Number(p.size) !== 0);
        member.master_baselines = activeBaselines;
        member.member_position_baselines = baseline?.member_positions || [];
        const masterUsesDualMode = master.positions.some((position) => String(position.mode || '').startsWith('dual_'));
        if (accountSupportsDual(member)) member.positionMode = 'dual';
        if (masterUsesDualMode && !accountSupportsDual(member) && !member.resume_required) {
          if (this.mode !== 'LIVE' || member.positions.length || member.copy_paused || member.halted || context.system.emergency_halted || !context.system.execution_enabled) {
            throw new GateApiError('íì ê³ì ì ìë°©í¥ ëª¨ëë¡ ì íí´ì¼ í©ëë¤.', { code: 'DUAL_MODE_REQUIRED' });
          }
          memberStage = 'MEMBER_POSITION_MODE';
          await setFuturesPositionMode({
            ...credentials(memberContext), channelId: this.channelId, baseUrl: this.baseUrl,
            fetchImpl: this.fetchImpl, positionMode: 'dual',
          });
          member = await this.readAccount({
            ...memberContext,
            master_baselines: activeBaselines,
            member_position_baselines: baseline?.member_positions || [],
          });
          if (!accountSupportsDual(member)) {
            throw new GateApiError('íì ê³ì  ìë°©í¥ ëª¨ë ì íì íì¸íì§ ëª»íìµëë¤.', { code: 'DUAL_MODE_REQUIRED' });
          }
        }
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
            position_side: position.position_side,
            target_size: position.target_size,
            actual_size: position.size,
            delta_size: position.delta_size,
            target_leverage: position.target_leverage,
            state: position.state,
            pause_reason: position.pause_reason,
          })));
        }
        member.planned_positions = suppressExecutableIntents(plannedPositions, this.mode);
        members.push(member);
        // Accounting is sampled after the latency-sensitive order cycle.
      } catch (error) {
        const errorCode = safeError(error, memberStage);
        if (this.logger) this.logger('member_sync_failed', { user_id: memberContext.user_id, trading_account_id: memberContext.trading_account_id, error_code: errorCode });
        members.push({ ...memberContext, error_code: errorCode, positions: [], planned_positions: [] });
      }
    }
    timings.members_ms = elapsedMs(membersStartedAt);
    const recordedMaster = {
      ...master,
      positions: master.positions.map((position) => ({
        ...position,
        quanto_multiplier: contracts.get(position.contract)?.quantoMultiplier || null,
      })),
    };
    const currentStatePayload = buildCurrentStatePayload({ cycleId, observedAt, master: recordedMaster, members });
    const legacyPayload = { cycle_id: cycleId, source_version: sourceHash({ observedAt, master: master.positions }),
      observed_at: observedAt, master: recordedMaster, members, current_state: currentStatePayload };
    const legacyWriteStartedAt = Date.now();
    await this.rpc('record_verified_copy_worker_cycle', { p_payload: legacyPayload });
    timings.legacy_write_ms = elapsedMs(legacyWriteStartedAt);
    if (this.mode === 'DRY_RUN' && this.logger && dryRunPlans.length) {
      const planHash = sourceHash(dryRunPlans);
      if (planHash !== this.lastDryRunPlanHash) {
        this.lastDryRunPlanHash = planHash;
        this.logger('dry_run_plan', { positions: dryRunPlans });
      }
    }
    timings.total_ms = elapsedMs(cycleStartedAt);
    const healthyMembers = members.filter((member) => !member.error_code);
    this.latestPerformanceMembers = healthyMembers;
    return {
      observed: members.length,
      masterObserved: 1,
      healthyMembers: healthyMembers.length,
      intents: simulatedIntents,
      validatedResumes: 0,
      pendingResumes: this.pendingResumes.length,
      copyEventId: cycleId,
      currentStatePayload, membersForPerformance: healthyMembers,
      timings,
    };
  }
  // P1-8: at most `limit` resume validations per cycle, least recently attempted first, after the
  // order phase so a slow validation cannot expire this cycle's plans or snapshot budget.
  async processPendingResumes(limit = 1) {
    const pending = [...this.pendingResumes];
    this.pendingResumes = [];
    pending.sort((a, b) => (this.resumeAttemptAt.get(a.memberContext.trading_account_id) || 0)
      - (this.resumeAttemptAt.get(b.memberContext.trading_account_id) || 0));
    let validated = 0;
    let activated = 0;
    const selected = pending.slice(0, Math.max(0, limit));
    for (const item of selected) {
      this.resumeAttemptAt.set(item.memberContext.trading_account_id, Date.now());
      try {
        const result = await this.processMemberResume(item);
        if (result?.validated) validated++;
        if (result?.activated) activated++;
      } catch (error) {
        // One member's resume (e.g. a blocker report hitting a DB timeout) must not fail the cycle.
        if (this.logger) this.logger('member_resume_failed', { trading_account_id: item.memberContext.trading_account_id,
          user_id: item.memberContext.user_id || null, error_code: safeError(error, 'RESUME') });
      }
    }
    return { processed: selected.length, validated, activated, waiting: pending.length - selected.length };
  }
  async submitOrders(limit = 10) {
    if (this.mode !== 'LIVE') return 0;
    const jobs = await this.rpc('claim_copy_order_intents', { p_limit: limit });
    let attempts = 0;
    for (const job of jobs || []) {
      if (!job.resume_version) throw new Error('ORDER_RESUME_VERSION_REQUIRED');
      let response;
      let summary;
      let memberLabel = job.user_id || '회원 계정';
      // Everything before the order POST (reads, leverage POST, authorization) cannot have created an
      // order: a failure there is a definite non-submission, never UNKNOWN (P1-5).
      let orderSent = false;
      try {
        const auth = { apiKey: job.api_key, secretKey: job.secret_key, channelId: this.channelId, baseUrl: this.baseUrl, fetchImpl: this.fetchImpl };
        const context = await this.rpc('get_copy_worker_context');
        if (!context?.master) throw new GateApiError('마스터 조회가 필요합니다.', { code: 'MASTER_POSITION_NOT_FOUND' });
        const memberContext = context.members?.find((member) => member.trading_account_id === job.trading_account_id);
        if (!memberContext) throw new GateApiError('활성 회원 설정을 확인할 수 없습니다.', { code: 'MEMBER_CONTEXT_MISSING' });
        memberLabel = memberContext.nickname || memberContext.full_name || memberLabel;
        // The order's own leg is confirmed individually when the list omits it.
        const jobLeg = [`${job.contract}:${job.position_side}`];
        const [memberSnapshot, masterSnapshot] = await Promise.all([
          this.readAccount({ ...memberContext, ...job, expected_contracts: [job.contract], expected_legs: jobLeg }),
          this.readAccount({ ...context.master, expected_contracts: [job.contract], expected_legs: jobLeg }),
        ]);
        const opposite = (p) => p.contract === job.contract
          && (p.positionSide || p.position_side || (Number(p.size) < 0 ? 'SHORT' : 'LONG')) !== job.position_side
          && Number(p.size) !== 0;
        const reversalContext = !job.reduce_only && memberSnapshot.positions.some(opposite)
          && !masterSnapshot.positions.some(opposite)
          ? await this.rpc('get_copy_reversal_entry_context', { p_intent_id: job.intent_id, p_version: job.resume_version }) : null;
        assertSubmissionSnapshot(job, memberSnapshot, masterSnapshot, reversalContext);
        if (!job.reduce_only && Number(job.target_leverage) > 0) {
          await setFuturesLeverage({
            ...auth, contract: job.contract, leverage: job.target_leverage,
            marginMode: job.margin_mode || 'cross',
            positionSide: String(job.position_mode || '').startsWith('dual') ? job.position_side : undefined,
          });
        }
        const permitted = await this.rpc('authorize_copy_order_submission', {
          p_intent_id: job.intent_id, p_version: job.resume_version,
        });
        if (permitted !== true) continue;
        attempts++;
        orderSent = true;
        response = await placeFuturesOrder({ ...auth, contract: job.contract, size: job.delta_size, reduceOnly: job.reduce_only, pid: job.pid, text: job.gate_order_text, slippageRatio: job.slippage_ratio,
          expiresAtMs: Date.parse(job.source_observed_at) + RESUME_MAX_AGE_MS });
        // A successful HTTP status without usable order data is not proof of
        // either rejection or a fill. Reconcile it by the original order text.
        if (response.payload?.id == null
          || !['size', 'left'].every((key) => response.payload[key] != null
            && Number.isFinite(Number(response.payload[key])))) {
          throw new GateApiError('Gate order response could not be verified.', {
            code: 'INVALID_ORDER_RESPONSE', status: response.status, outcomeUnknown: true,
          });
        }
        summary = assertOrderIdentity(job, response.payload);
        if (Number(response.payload.size) !== Number(job.delta_size) || Math.abs(summary.filledSize) > Math.abs(Number(job.delta_size))
          || (summary.filledSize && Math.sign(summary.filledSize) !== Math.sign(Number(job.delta_size)))) {
          throw new GateApiError('Order quantity differs from the submitted intent.', { code: 'ORDER_QUANTITY_MISMATCH', outcomeUnknown: true });
        }
      } catch (error) {
        const unknown = orderSent && error instanceof GateApiError && error.outcomeUnknown;
        const errorCode = safeError(error);
        await this.rpc('complete_copy_order_attempt', { p_intent_id: job.intent_id, p_result_status: unknown ? 'UNKNOWN' : 'REJECTED', p_gate_order_id: null, p_filled_size: 0, p_average_fill_price: null, p_http_status: error instanceof GateApiError ? error.status : 0, p_gate_label: safeGateErrorLabel(error), p_error_code: errorCode, p_safe_response: {} });
        if (this.logger) this.logger('order_attempt_failed', {
          intent_id: job.intent_id,
          user_id: job.user_id || null,
          contract: job.contract,
          position_side: job.position_side || null,
          result_status: unknown ? 'UNKNOWN' : 'REJECTED',
          error_code: errorCode,
        });
        if (unknown && this.onSafetyEvent) await this.onSafetyEvent({ event: 'COPY_ORDER_UNCONFIRMED', severity: 'CRITICAL',
          details: { member: memberLabel, contract: job.contract, position_side: job.position_side,
            side: Number(job.delta_size) > 0 ? 'BUY' : 'SELL', result_status: 'UNKNOWN',
            error_code: errorCode, evidence: 'NO_CONFIRMED_EXCHANGE_FILL', intent_id: job.intent_id } });
        if (error instanceof GateApiError && ['ORDER_QUANTITY_MISMATCH', 'ORDER_IDENTITY_MISMATCH'].includes(error.code)) {
          if (this.onSafetyEvent) await this.onSafetyEvent({ event: 'COPY_ORDER_QUANTITY_AUTO_HALTED', severity: 'CRITICAL',
            details: { intent_id: job.intent_id, contract: job.contract, reason: error.code } });
          break;
        }
        continue;
      }
      // Keep persistence failures outside the Gate rejection handler. A lost
      // RPC response may mean FILLED was already committed; overwriting that
      // with REJECTED would erase the fill. Abort this batch and let the
      // existing SUBMITTING/reconciliation recovery resolve unrecorded orders.
      await this.rpc('complete_copy_order_attempt', { p_intent_id: job.intent_id, p_result_status: summary.finalStatus, p_gate_order_id: summary.gateOrderId, p_filled_size: summary.filledSize, p_average_fill_price: summary.averageFillPrice, p_http_status: response.status, p_gate_label: summary.finishAs, p_error_code: null, p_safe_response: { finish_as: summary.finishAs, left: summary.left, terminal: summary.terminal } });
      if (this.logger) this.logger('order_attempt_completed', {
        intent_id: job.intent_id,
        user_id: job.user_id || null,
        contract: job.contract,
        position_side: job.position_side || null,
        result_status: summary.finalStatus,
        gate_order_id: summary.gateOrderId,
        filled_size: summary.filledSize,
      });
    }
    return attempts;
  }
  async reconcileOrders(limit = 10) {
    const jobs = await this.rpc('claim_copy_reconciliation_jobs', { p_limit: limit });
    for (const job of jobs || []) {
      let completion;
      let summary;
      try {
        const auth = { apiKey: job.api_key, secretKey: job.secret_key, baseUrl: this.baseUrl, fetchImpl: this.fetchImpl };
        const order = job.gate_order_id ? await getFuturesOrder({ ...auth, orderId: job.gate_order_id }) : await findFuturesOrderByText({ ...auth, text: job.gate_order_text, contract: job.contract });
        if (!order) {
          completion = await this.resolveMissingOrder(job, auth);
        } else {
          assertOrderIdentity(job, order);
          const orderId = String(order.id);
          const trades = await getOrderTrades({ ...auth, orderId, contract: job.contract });
          summary = summarizeGateOrder(order, trades);
          completion = { p_job_id: job.job_id, p_status: summary.finalStatus, p_gate_order_id: orderId,
            p_filled_size: summary.filledSize, p_average_fill_price: summary.averageFillPrice,
            p_safe_response: { finish_as: summary.finishAs, left: summary.left, trade_count: trades.length, terminal: summary.terminal } };
        }
      } catch (error) {
        const errorCode = safeError(error, 'RECONCILIATION');
        completion = { p_job_id: job.job_id, p_status: 'UNKNOWN', p_gate_order_id: job.gate_order_id,
          p_filled_size: 0, p_average_fill_price: null, p_safe_response: { error_code: errorCode } };
        if (this.logger) this.logger('order_reconciliation_failed', {
          intent_id: job.intent_id,
          job_id: job.job_id,
          contract: job.contract,
          result_status: 'UNKNOWN',
          error_code: errorCode,
        });
      }
      // A lost database acknowledgement must never rewrite a committed fill.
      await this.rpc('complete_copy_reconciliation', completion);
      if (completion.p_safe_response?.resolution && this.logger) this.logger('order_reconciliation_resolved', {
        intent_id: job.intent_id, job_id: job.job_id, contract: job.contract,
        result_status: completion.p_status, resolution: completion.p_safe_response.resolution,
      });
      if (summary && this.logger) this.logger('order_reconciliation_completed', {
        intent_id: job.intent_id, job_id: job.job_id, contract: job.contract,
        result_status: summary.finalStatus, gate_order_id: summary.gateOrderId, filled_size: summary.filledSize,
      });
    }
    return jobs?.length || 0;
  }
  // P1-5: an order that Gate cannot find by its unique text is proof of non-placement only after its
  // X-Gate-Exptime has passed (Gate rejects later arrivals), a previous lookup also missed it, and the
  // member's leg still equals the size the order was planned from (no unexplained fill). Otherwise it
  // stays UNKNOWN and the member stays blocked.
  async resolveMissingOrder(job, auth) {
    const unknown = (details = {}) => ({ p_job_id: job.job_id, p_status: 'UNKNOWN', p_gate_order_id: null,
      p_filled_size: 0, p_average_fill_price: null, p_safe_response: { found: false, ...details } });
    const expiresAt = Date.parse(job.source_observed_at) + RESUME_MAX_AGE_MS;
    if (job.gate_order_id || !Number.isFinite(expiresAt) || Date.now() < expiresAt + 60_000
      || !(Number(job.job_attempts) >= 2) || !Number.isFinite(Number(job.actual_size_at_plan))) return unknown();
    for (const [intentId, at] of this.notFoundAfterExpiry) if (Date.now() - at > 86_400_000) this.notFoundAfterExpiry.delete(intentId);
    const positions = await getFuturesPositions({ ...auth, expectedContracts: [job.contract],
      expectedLegs: [`${job.contract}:${job.position_side}`] });
    const leg = positions.find((position) => position.contract === job.contract
      && normalizePositionSide(position) === job.position_side);
    const observedSize = Number(leg?.size || 0);
    if (observedSize !== Number(job.actual_size_at_plan)) {
      this.notFoundAfterExpiry.delete(job.intent_id);
      if (this.onSafetyEvent && this.shouldAlertStuckOrder(job.intent_id)) {
        await this.onSafetyEvent({ event: 'COPY_ORDER_UNRESOLVED', severity: 'CRITICAL', details: {
          intent_id: job.intent_id, contract: job.contract, position_side: job.position_side,
          reason: 'ORDER_NOT_FOUND_POSITION_CHANGED', user_id: job.user_id || null } });
      }
      return unknown({ position_changed: true });
    }
    // Two separate lookups after the expiry must both miss it (the first one is only recorded).
    if (!this.notFoundAfterExpiry.has(job.intent_id)) {
      this.notFoundAfterExpiry.set(job.intent_id, Date.now());
      return unknown({ not_found_after_expiry: 1 });
    }
    this.notFoundAfterExpiry.delete(job.intent_id);
    return { p_job_id: job.job_id, p_status: 'CANCELLED', p_gate_order_id: null, p_filled_size: 0,
      p_average_fill_price: null, p_safe_response: { found: false, resolution: 'NOT_FOUND_AFTER_EXPIRY',
        terminal: true, observed_size: observedSize } };
  }
  shouldAlertStuckOrder(intentId) {
    const last = this.staleFillAlerts.get(`order:${intentId}`) || 0;
    if (Date.now() - last < 1_800_000) return false;
    this.staleFillAlerts.set(`order:${intentId}`, Date.now());
    return true;
  }
  // P1-6: a fill that never matched a later observation blocks every order of that account and, before
  // this alert, did so silently. Alert once per intent every 30 minutes.
  async alertStaleFillObservations(olderThanSeconds = 300) {
    let stale;
    try { stale = await this.rpc('get_copy_stale_fill_observations', { p_older_than_seconds: olderThanSeconds }); }
    catch (error) {
      if (this.logger) this.logger('stale_fill_check_failed', { error_code: safeError(error, 'STALE_FILL_CHECK') });
      return 0;
    }
    let alerted = 0;
    for (const [key, at] of this.staleFillAlerts) if (Date.now() - at > 7_200_000) this.staleFillAlerts.delete(key);
    for (const item of Array.isArray(stale) ? stale : []) {
      const key = `fill:${item.intent_id}`;
      if (Date.now() - (this.staleFillAlerts.get(key) || 0) < 1_800_000) continue;
      this.staleFillAlerts.set(key, Date.now());
      alerted++;
      if (this.onSafetyEvent) await this.onSafetyEvent({ event: 'COPY_FILL_OBSERVATION_STALE', severity: 'CRITICAL', details: {
        intent_id: item.intent_id, contract: item.contract, position_side: item.position_side,
        filled_size: item.filled_size, user_id: item.user_id } });
      if (this.logger) this.logger('copy_fill_observation_stale', { intent_id: item.intent_id, contract: item.contract });
    }
    return alerted;
  }
  async cancelRequestedOpenOrders(limit = 5) {
    const jobs = await this.rpc('claim_open_order_cancel_jobs', { p_limit: limit });
    for (const job of jobs || []) {
      let result;
      let errorCode = null;
      try {
        result = await cancelAllOpenFuturesOrders({
          apiKey: job.api_key,
          secretKey: job.secret_key,
          baseUrl: this.baseUrl,
          fetchImpl: this.fetchImpl,
          channelId: this.channelId,
        });
      } catch (error) {
        errorCode = safeError(error, 'OPEN_ORDER_CANCEL');
        result = { cancelledCount: 0, remainingCount: -1 };
      }
      await this.rpc('complete_open_order_cancel_job', {
        p_job_id: job.job_id,
        p_success: errorCode == null,
        p_cancelled_count: result.cancelledCount,
        p_remaining_count: result.remainingCount,
        p_error_code: errorCode,
      });
      if (this.onSafetyEvent) {
        await this.onSafetyEvent({
          event: errorCode ? 'OPEN_ORDER_CANCEL_FAILED' : 'OPEN_ORDERS_CANCELLED',
          severity: errorCode ? 'CRITICAL' : 'WARNING',
          details: {
            cancelled_count: result.cancelledCount,
            remaining_count: result.remainingCount,
            error_code: errorCode,
          },
        });
      }
      if (this.logger) this.logger(errorCode ? 'open_order_cancel_failed' : 'open_orders_cancelled', {
        job_id: job.job_id,
        cancelled_count: result.cancelledCount,
        remaining_count: result.remainingCount,
        error_code: errorCode,
      });
    }
    return jobs?.length || 0;
  }
  async deliverEntryAlerts(limit = 10) {
    const jobs = await this.rpc('claim_copy_entry_alerts', { p_limit: limit });
    let delivered = 0;
    for (const job of jobs || []) {
      let sent = false;
      let errorCode = null;
      try {
        let details;
        if (job.gate_order_id == null && job.result_status === 'CANCELLED' && Number(job.filled_size) === 0
          && (job.error_code == null || NEVER_SENT_CANCELLATIONS.has(job.error_code))) {
          // A plan replaced by a fresher plan (or discarded on pause/resume/LIVE start) never reached
          // Gate. Reporting it as "주문 미체결" was 63% of all alerts in 9/21-9/24 and hid real ones.
          await this.rpc('complete_copy_entry_alert', { p_alert_id: job.alert_id, p_sent: true, p_error_code: null });
          if (this.logger) this.logger('entry_alert_suppressed', { alert_id: job.alert_id, error_code: job.error_code || null });
          continue;
        }
        if (job.gate_order_id != null) {
          const auth = { apiKey: job.api_key, secretKey: job.secret_key, baseUrl: this.baseUrl, fetchImpl: this.fetchImpl };
          const order = await getFuturesOrder({ ...auth, orderId: job.gate_order_id });
          const trades = await getOrderTrades({ ...auth, orderId: job.gate_order_id, contract: job.contract });
          details = exchangeTradeAlert(job, order, trades);
        } else if (['REJECTED', 'CANCELLED'].includes(job.result_status) && Number(job.filled_size) === 0 && job.error_code) {
          details = { ...job.details, error_code: job.error_code, result_status: job.result_status,
            fill_notional_usdt: 0, evidence: 'NO_CONFIRMED_EXCHANGE_FILL' };
        } else throw new GateApiError('거래소 결과를 확인하지 못했습니다.', { code: 'ALERT_EXCHANGE_RESULT_UNVERIFIED' });
        const result = this.onSafetyEvent
          ? await this.onSafetyEvent({ event: job.event_type, severity: Number(job.filled_size) ? 'INFO' : 'WARNING', details })
          : { sent: false, reason: 'ALERT_DESTINATION_NOT_CONFIGURED' };
        sent = result?.sent === true;
        errorCode = sent ? null : safeError(new Error(result?.reason || 'ALERT_DELIVERY_FAILED'), 'ENTRY_ALERT');
      } catch (error) {
        errorCode = safeError(error, 'ENTRY_ALERT');
      }
      try {
        await this.rpc('complete_copy_entry_alert', {
          p_alert_id: job.alert_id, p_sent: sent, p_error_code: errorCode,
        });
      } catch (error) {
        if (this.logger) this.logger('entry_alert_completion_failed', {
          alert_id: job.alert_id, error_code: safeError(error, 'ENTRY_ALERT_COMPLETION'),
        });
        continue;
      }
      if (sent) delivered++;
      if (this.logger) this.logger(sent ? 'entry_alert_delivered' : 'entry_alert_delivery_deferred', {
        alert_id: job.alert_id, error_code: errorCode,
      });
    }
    return delivered;
  }
}
