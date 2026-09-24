import test from 'node:test';
import assert from 'node:assert/strict';
import { TradingRunner, planMemberPositions, sizingEquity, partialAnchorMasterSize } from './trading-runner.js';

// Regression tests for the 2026-09-24 QA findings P0-1 / P0-2 / P1 (worker half).
const contracts = new Map([['BTC_USDT', { quantoMultiplier: 0.001, sizeStep: 1, orderSizeMin: 1, orderSizeMax: 0,
  marketOrderSizeMax: 0, inDelisting: false, takerFeeRate: 0.0005 }]]);
const pos = (size, markPrice = 50_000) => ({ contract: 'BTC_USDT', size, markPrice, leverage: 10, posMarginMode: 'cross',
  positionSide: size < 0 ? 'SHORT' : 'LONG' });
const anchorAt = (master, target) => [{ contract: 'BTC_USDT', position_side: 'LONG', resume_version: 'r1',
  master_copyable_size: master, target_size: target }];
function plan({ masterSize, masterTotal = 10_000, masterFlag, memberTotal = 5_000, memberUpnl = 0, memberFlag,
  actual, anchors = [], price = 50_000, maxRatio = 100, extra = {} }) {
  return planMemberPositions({
    cycleId: 'c-1', system: { emergency_halted: false }, contracts,
    master: { total: masterTotal, ...(masterFlag == null ? {} : { equityIncludesUnrealised: masterFlag }),
      positions: masterSize ? [pos(masterSize, price)] : [] },
    member: { user_id: 'u', total: memberTotal, available: memberTotal, unrealisedPnl: memberUpnl,
      ...(memberFlag == null ? {} : { equityIncludesUnrealised: memberFlag }),
      copy_ratio: 100, max_position_ratio: maxRatio, resume_version: 'r1',
      positions: actual ? [pos(actual, price)] : [],
      previous_states: [{ contract: 'BTC_USDT', position_side: 'LONG', actual_size: actual || 0, state: 'SYNCED' }],
      target_anchors: anchors, ...extra },
  })[0];
}

test('P0-1 (QA s1b): Master adds to a winner while its unified equity includes the gain -> member never sells', () => {
  // Entry at 50k: Master 100 / member 50. Price +20%: Master unified equity 11k, member classic wallet 5k
  // with +1k unrealised (not in `total`). Master adds 1 contract. Before the fix: target 45, SELL 5.
  const p = plan({ masterSize: 101, masterTotal: 11_000, masterFlag: true, memberTotal: 5_000, memberUpnl: 1_000,
    memberFlag: false, actual: 50, anchors: anchorAt(100, 50), price: 60_000 });
  assert.ok(p.target_size >= 50, `target ${p.target_size} must not fall below the carried 50`);
  assert.equal(p.intent, undefined);
  assert.equal(p.target_lock_reason, 'MASTER_INCREASE_BELOW_MEMBER_LOT');
  assert.equal(p.anchor_master_copyable_size, 100, 'a sub-lot increase keeps the anchor Master size so it accumulates');
});

test('P0-1 (QA s1a): member equity fell 10% since the anchor -> a Master BUY is never a member SELL', () => {
  const p = plan({ masterSize: 101, memberTotal: 4_500, actual: 50, anchors: anchorAt(100, 50) });
  assert.ok(p.target_size >= 50);
  assert.ok(!p.intent || (p.intent.delta_size > 0 && p.intent.reduce_only === false));
});

test('P0-1: every anchored leg follows only the Master change, at the current ratio', () => {
  // Carried copy 30 (decided earlier); Master +20 at ratio 0.5 -> +10, not a re-size of the whole leg to 60.
  const p = plan({ masterSize: 120, actual: 30, anchors: anchorAt(100, 30) });
  assert.equal(p.target_size, 40);
  assert.equal(p.intent.delta_size, 10);
  assert.equal(p.target_lock_reason, 'MASTER_QUANTITY_INCREASED');
});

test('P0-1: Master pyramiding in sub-lot steps accumulates instead of rounding each step to zero', () => {
  // Ratio 0.5. +1 is half a lot: hold, anchor unchanged.
  let p = plan({ masterSize: 101, actual: 50, anchors: anchorAt(100, 50) });
  assert.equal(p.target_size, 50); assert.equal(p.anchor_master_copyable_size, 100);
  // +3 since the unchanged anchor = 1.5 lots -> buy 1; the anchor consumes only 2 Master contracts.
  p = plan({ masterSize: 103, actual: 50, anchors: anchorAt(100, 50) });
  assert.equal(p.target_size, 51); assert.equal(p.intent.delta_size, 1);
  assert.equal(p.anchor_master_copyable_size, 102);
  assert.equal(p.master_copyable_size, 103, 'plan evidence keeps the observed Master quantity');
  // Next cycle from anchor (102, 51): the remaining half lot waits; +1 more completes it.
  p = plan({ masterSize: 103, actual: 51, anchors: anchorAt(102, 51) });
  assert.equal(p.target_size, 51); assert.equal(p.intent, undefined); assert.equal(p.anchor_master_copyable_size, 102);
  p = plan({ masterSize: 104, actual: 51, anchors: anchorAt(102, 51) });
  assert.equal(p.target_size, 52); assert.equal(p.intent.delta_size, 1);
  assert.equal('anchor_master_copyable_size' in p, false, 'an exact lot consumes the whole increase');
});

test('P0-1: a sub-lot Master increase behaves exactly like an unchanged Master (shortfall still completes)', () => {
  // A partial fill left the member at 45 of the decided 50; the Master then adds half a member lot.
  const p = plan({ masterSize: 101, actual: 45, anchors: anchorAt(100, 50) });
  const unchanged = plan({ masterSize: 100, actual: 45, anchors: anchorAt(100, 50) });
  assert.equal(p.target_size, unchanged.target_size);
  assert.equal(p.target_size, 50);
  assert.equal(p.intent.delta_size, 5);
  assert.equal(p.anchor_master_copyable_size, 100);
});

test('P0-1 (review): a Master increase of one lot or more keeps an unfilled part of the previous decision', () => {
  // The member's earlier buy filled only 20 of the decided 50. Master +2 (one member lot): 50 + 1, not 20 + 1.
  const p = plan({ masterSize: 102, actual: 20, anchors: anchorAt(100, 50) });
  assert.equal(p.target_size, 51);
  assert.equal(p.intent.delta_size, 31);
  assert.equal(p.intent.reduce_only, false);
});

test('P0-1 (review): a risk-cap reduction during a Master increase is labelled as a cap reduction', () => {
  // Cap 30% of 4,000 = 24 contracts at 50k. Anchor 30 (decided when equity was higher), Master +2.
  const p = plan({ masterSize: 102, memberTotal: 4_000, actual: 30, anchors: anchorAt(100, 30), maxRatio: 30 });
  assert.equal(p.target_size, 24);
  assert.equal(p.target_lock_reason, 'CURRENT_RISK_CAP_REDUCTION');
  assert.equal(p.intent.reduce_only, true);
});

test('P0-2 (review): legs on a Master contract Gate could not confirm are paused and keep their anchor', () => {
  const p = planMemberPositions({ cycleId: 'c-1', system: { emergency_halted: false }, contracts,
    master: { total: 10_000, positions: [], unconfirmed_contracts: ['BTC_USDT'] },
    member: { user_id: 'u', total: 5_000, available: 5_000, copy_ratio: 100, max_position_ratio: 100, resume_version: 'r1',
      positions: [pos(50)], previous_states: [{ contract: 'BTC_USDT', position_side: 'LONG', actual_size: 50, state: 'SYNCED' }],
      target_anchors: anchorAt(100, 50) } })[0];
  assert.equal(p.state, 'PAUSED');
  assert.equal(p.intent, undefined);
  assert.equal(p.anchor_update_allowed, false);
  assert.equal(p.pause_reason, 'MASTER_POSITION_UNCONFIRMED');
});

test('P0-1: a pending decision below the actual size still reduces (anchor leads execution)', () => {
  // Master cut 100 -> 50 (anchor 25) before the member's reduction executed, then added back to 60.
  const p = plan({ masterSize: 60, actual: 50, anchors: anchorAt(50, 25) });
  assert.equal(p.target_size, 30);
  assert.equal(p.intent.delta_size, -20);
  assert.equal(p.intent.reduce_only, true);
});

test('P0-1: reductions are unchanged (proportional to the carried copy)', () => {
  const p = plan({ masterSize: 80, actual: 50, anchors: anchorAt(100, 50) });
  assert.equal(p.target_size, 40); assert.equal(p.intent.delta_size, -10); assert.equal(p.intent.reduce_only, true);
});

test('P0-1: a capped increase consumes the whole Master change (no buy-back later)', () => {
  // Member cap 30% of 5k = 1,500 USDT = 30 contracts at 50k.
  const p = plan({ masterSize: 140, actual: 30, anchors: anchorAt(100, 30), maxRatio: 30 });
  assert.equal(p.target_size, 30);
  assert.equal(p.intent, undefined);
  assert.equal(p.anchor_update_allowed, true);
  assert.equal('anchor_master_copyable_size' in p, false);
});

test('P0-1: proportional sizing compares both accounts including unrealised PnL', () => {
  assert.equal(sizingEquity({ total: 5_000, unrealisedPnl: 500, equityIncludesUnrealised: false }), 5_500);
  assert.equal(sizingEquity({ total: 11_000, unrealisedPnl: 1_000, equityIncludesUnrealised: true }), 11_000);
  assert.equal(sizingEquity({ total: 5_000, unrealisedPnl: 500 }), 5_000, 'accounts without the flag keep their total');
  // New leg: Master unified 11k, member classic 5k + 500 uPnL -> 100 * 5,500 / 11,000 = 50 (old basis: 45).
  const p = plan({ masterSize: 100, masterTotal: 11_000, masterFlag: true, memberTotal: 5_000, memberUpnl: 500,
    memberFlag: false });
  assert.equal(p.target_size, 50);
  assert.equal(p.target_lock_reason, 'TARGET_ANCHOR_INITIALIZED');
});

test('P0-1: a partial anchor never passes the observed Master quantity', () => {
  assert.equal(partialAnchorMasterSize({ anchorMaster: 100, masterSize: 103, lots: 1, rawLots: 1.5 }), 102);
  assert.equal(partialAnchorMasterSize({ anchorMaster: 100, masterSize: 104, lots: 2, rawLots: 2 }), null);
  assert.equal(partialAnchorMasterSize({ anchorMaster: -100, masterSize: -103, lots: -1, rawLots: 1.5 }), -102);
  const tiny = partialAnchorMasterSize({ anchorMaster: 0.1, masterSize: 0.3, lots: 0.9999999999999, rawLots: 1 });
  assert.ok(tiny === null || Math.abs(tiny) < 0.3);
});

test('P1-4: CLOSE closes a leg that was changed outside the platform (manual override does not block exit)', () => {
  const p = plan({ masterSize: 100, actual: 55, anchors: anchorAt(100, 50),
    extra: { close_positions_requested: true, reduce_only: true, copy_paused: true,
      previous_states: [{ contract: 'BTC_USDT', position_side: 'LONG', actual_size: 50, state: 'MANUAL_OVERRIDE' }] } });
  assert.equal(p.target_size, 0);
  assert.equal(p.state, 'REDUCE_ONLY');
  assert.equal(p.intent.delta_size, -55);
  assert.equal(p.intent.reduce_only, true);
});

function fakeRunner({ masterReads, baseline = [{ contract: 'BTC_USDT', position_side: 'LONG', size: 100 }], anchors = [] }) {
  const calls = { advance: [], masterExpected: [], recorded: [] };
  let baselinePositions = baseline;
  const runner = new TradingRunner({ supabase: {}, baseUrl: 'https://api.gateio.ws', workerId: 'w', workerVersion: '0.5.0',
    publicIp: '192.0.2.1', channelId: 'maetajak', mode: 'LIVE' });
  runner.rpc = async (name, params = {}) => {
    switch (name) {
      case 'get_copy_worker_context': return { system: { emergency_halted: false, execution_enabled: true },
        master: { trading_account_id: 'master' },
        members: [{ trading_account_id: 'acct', user_id: 'u', copy_ratio: 100, max_position_ratio: 50, previous_states: [] }] };
      case 'get_copy_order_observation_guards': return [];
      case 'get_copy_resume_context': return [{ trading_account_id: 'acct', state: 'ACTIVE', version: 'v1', baseline_version: 'v1',
        positions: baselinePositions, member_positions: [], copy_positions: [], ownership_status: 'CONFIRMED',
        resume_authorized: true, unresolved_orders: 0 }];
      case 'get_copy_target_anchors': return anchors;
      case 'confirm_copy_order_observation': return 0;
      case 'advance_member_copy_resume_baseline_legs':
        calls.advance.push(params.p_positions);
        baselinePositions = baselinePositions.map((b) => {
          const c = params.p_positions.find((x) => x.contract === b.contract && x.position_side === b.position_side);
          if (!c) return b;
          return Math.sign(c.size) !== Math.sign(b.size) ? { ...b, size: 0 }
            : { ...b, size: Math.sign(b.size) * Math.min(Math.abs(b.size), Math.abs(c.size)) };
        }).filter((b) => b.size !== 0);
        return null;
      case 'record_verified_copy_worker_cycle': calls.recorded.push(params.p_payload); return params.p_payload.cycle_id;
      default: throw new Error(`unexpected rpc ${name}`);
    }
  };
  runner.loadContracts = async () => contracts;
  let read = 0;
  runner.readAccount = async (account) => {
    const now = new Date().toISOString();
    const base = { ...account, open_orders: [], observed_started_at: now, observed_at: now, unrealisedPnl: 0, positionMode: 'single' };
    if (account.trading_account_id === 'master') {
      calls.masterExpected.push(account.expected_contracts || []);
      const positions = masterReads[Math.min(read, masterReads.length - 1)];
      read++;
      return { ...base, total: 10_000, available: 9_000, positions };
    }
    return { ...base, total: 5_000, available: 5_000, positions: [], reduce_only: false, halted: false };
  };
  return { runner, calls, baseline: () => baselinePositions };
}

test('P0-2 (QA s3): one empty Master read cannot erase a FUTURE_ONLY baseline', async () => {
  const full = [pos(100)];
  const { runner, calls, baseline } = fakeRunner({ masterReads: [full, [], full] });
  for (let i = 0; i < 3; i++) await runner.syncOnce();
  assert.deepEqual(calls.advance, [], 'no baseline change from a single glitch');
  assert.deepEqual(baseline(), [{ contract: 'BTC_USDT', position_side: 'LONG', size: 100 }]);
  const lastPlan = calls.recorded.at(-1).members[0].planned_positions[0];
  assert.equal(lastPlan.target_size, 0, 'the Master pre-resume holding is still not copied');
  assert.equal(lastPlan.intent, undefined);
  assert.ok(calls.masterExpected.every((expected) => expected.includes('BTC_USDT')),
    'the Master read always asks for baseline contracts explicitly');
});

test('P0-2: a real Master reduction advances the baseline after two consistent reads (smaller shrink kept)', async () => {
  const { runner, calls, baseline } = fakeRunner({ masterReads: [[pos(100)], [pos(60)], [pos(70)]] });
  await runner.syncOnce(); await runner.syncOnce();
  assert.deepEqual(calls.advance, []);
  await runner.syncOnce();
  assert.equal(calls.advance.length, 1);
  assert.equal(calls.advance[0][0].size, 70);
  assert.deepEqual(baseline(), [{ contract: 'BTC_USDT', position_side: 'LONG', size: 70 }]);
});

test('P0-2 (review): an unconfirmed Master contract pauses its legs and never shrinks the baseline', async () => {
  const { runner, calls, baseline } = fakeRunner({ masterReads: [[pos(100)], [], []] });
  const read = runner.readAccount;
  let cycle = 0;
  runner.readAccount = async (account) => {
    const value = await read(account);
    if (account.trading_account_id === 'master') {
      assert.equal(account.tolerate_unconfirmed_positions, true);
      assert.ok(account.expected_legs.includes('BTC_USDT:LONG'));
      cycle++;
      if (cycle > 1) value.unconfirmed_contracts = ['BTC_USDT'];
    }
    return value;
  };
  for (let i = 0; i < 3; i++) await runner.syncOnce();
  assert.deepEqual(calls.advance, []);
  assert.deepEqual(baseline(), [{ contract: 'BTC_USDT', position_side: 'LONG', size: 100 }]);
  const last = calls.recorded.at(-1).members[0].planned_positions[0];
  assert.equal(last.pause_reason, 'MASTER_POSITION_UNCONFIRMED');
  assert.equal(last.anchor_update_allowed, false);
});

test('P1-8 (review): one member\'s resume failure does not fail the cycle', async () => {
  const runner = new TradingRunner({ supabase: {}, mode: 'LIVE' });
  runner.processMemberResume = async ({ memberContext }) => {
    if (memberContext.trading_account_id === 'a') throw new Error('report_member_copy_resume_blocker: statement timeout');
    return { validated: true };
  };
  runner.pendingResumes = [{ memberContext: { trading_account_id: 'a' } }];
  assert.deepEqual(await runner.processPendingResumes(1), { processed: 1, validated: 0, activated: 0, waiting: 0 });
});

test('P1-8: resume validation runs after the cycle, one member per call, least recently attempted first', async () => {
  const runner = new TradingRunner({ supabase: {}, mode: 'LIVE' });
  const seen = [];
  runner.processMemberResume = async ({ memberContext }) => { seen.push(memberContext.trading_account_id); return { validated: true }; };
  const item = (id) => ({ session: { state: 'REQUESTED' }, memberContext: { trading_account_id: id } });
  runner.pendingResumes = [item('a'), item('b')];
  assert.deepEqual(await runner.processPendingResumes(1), { processed: 1, validated: 1, activated: 0, waiting: 1 });
  runner.pendingResumes = [item('a'), item('b')];
  await runner.processPendingResumes(1);
  assert.deepEqual(seen, ['a', 'b']);
});

test('K3: resume snapshot blocks on member open orders only', async () => {
  const runner = new TradingRunner({ supabase: {}, mode: 'LIVE' });
  runner.readAccount = async (account) => ({ ...account, positions: [],
    open_orders: account.role === 'MASTER' ? [{ id: 'm1', contract: 'BTC_USDT' }] : [] });
  let snapshot = await runner.readResumeSnapshot({ role: 'MASTER' }, { role: 'MEMBER' });
  assert.deepEqual(snapshot.openOrders, []);
  runner.readAccount = async (account) => ({ ...account, positions: [],
    open_orders: account.role === 'MEMBER' ? [{ id: 'u1', contract: 'ETH_USDT' }] : [] });
  snapshot = await runner.readResumeSnapshot({ role: 'MASTER' }, { role: 'MEMBER' });
  assert.equal(snapshot.openOrders.length, 1);
});

test('alerts: a plan superseded before any Gate request is not reported as an order failure', async () => {
  const sent = []; const completed = [];
  const runner = new TradingRunner({ supabase: {}, mode: 'LIVE', onSafetyEvent: async (a) => { sent.push(a); return { sent: true }; } });
  runner.rpc = async (name, params) => {
    if (name === 'claim_copy_entry_alerts') return [
      { alert_id: 1, event_type: 'COPY_ORDER_FAILED', gate_order_id: null, result_status: 'CANCELLED', filled_size: 0,
        error_code: 'SUPERSEDED_BY_FRESH_PLAN', details: {} },
      { alert_id: 2, event_type: 'COPY_ORDER_FAILED', gate_order_id: null, result_status: 'REJECTED', filled_size: 0,
        error_code: 'WORKER_MASTER_POSITION_CHANGED_BEFORE_SUBM', details: {} },
    ];
    completed.push(params); return null;
  };
  assert.equal(await runner.deliverEntryAlerts(), 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].details.error_code, 'WORKER_MASTER_POSITION_CHANGED_BEFORE_SUBM');
  assert.deepEqual(completed.map((c) => [c.p_alert_id, c.p_sent]), [[1, true], [2, true]]);
});
