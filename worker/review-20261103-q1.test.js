// Independent review 2026-11-03 of Q1 (resume Master snapshot confirmation). R1/R3 now assert the fixes (F1, F3);
// R2 documents the intended strictness (an empty-list resume read is refused even when the fallback found every leg).
import test from 'node:test';
import assert from 'node:assert/strict';
import { TradingRunner, RESUME_MASTER_SNAPSHOT_UNCONFIRMED, PERSISTED_MASTER_ALERT_AFTER_MS } from './trading-runner.js';

const runnerWith = (rpcImpl) => {
  const runner = new TradingRunner({ supabase: { rpc: async () => ({ data: null, error: null }) }, mode: 'LIVE' });
  runner.rpc = rpcImpl;
  return runner;
};
const ETH = { contract: 'ETH_USDT', position_side: 'LONG', size: 1_000 };

test('review R1 fixed (F1): a failed first read of the DB Master legs fails the cycle before it records anything', async () => {
  let dbLegs = [ETH];
  let fail = true;
  const calls = [];
  const now = () => new Date().toISOString();
  const runner = runnerWith(async (name) => {
    calls.push(name);
    if (name === 'get_copy_last_master_legs') {
      if (fail) throw new Error('timeout');
      return { observed_at: now(), legs: dbLegs };
    }
    if (name === 'get_copy_worker_context') return { system: { execution_enabled: true }, master: { trading_account_id: 'm' }, members: [] };
    if (name === 'get_copy_resume_context' || name === 'get_copy_target_anchors' || name === 'get_copy_order_observation_guards') return [];
    if (name === 'record_verified_copy_worker_cycle') { dbLegs = []; return 'c'; } // a glitched (empty) Master record
    return null;
  });
  runner.loadContracts = async () => new Map();
  runner.readAccount = async (account) => ({ ...account, total: 1, available: 1, positions: [], open_orders: [], list_empty: true,
    unconfirmed_contracts: [], list_empty_fallback_contracts: [], observed_started_at: now(), observed_at: now() });
  await assert.rejects(runner.syncOnce(), (error) => error.code === 'PERSISTED_MASTER_LEGS_UNAVAILABLE');
  assert.equal(calls.includes('record_verified_copy_worker_cycle'), false, 'nothing overwrote the DB legs');
  assert.equal(runner.masterObservedAt, 0);
  assert.equal(runner.resumeMasterStateBlocker(), RESUME_MASTER_SNAPSHOT_UNCONFIRMED, 'resume stays fail-closed');
  // Next cycle: the read succeeds (DB still holds ETH) -> the leg is pending although the list is empty.
  fail = false;
  await runner.syncOnce();
  assert.equal(calls.filter((n) => n === 'record_verified_copy_worker_cycle').length, 1);
  assert.deepEqual([...runner.unresolvedMasterLegs.keys()], ['ETH_USDT:LONG']);
  assert.equal(runner.resumeMasterStateBlocker(), RESUME_MASTER_SNAPSHOT_UNCONFIRMED);
  assert.equal(runner.resumeMasterSnapshotBlocker({ list_empty: true, positions: [], unconfirmed_contracts: [] }),
    RESUME_MASTER_SNAPSHOT_UNCONFIRMED);
});

test('review R2: a persistent list-empty Master read blocks every resume while the Master holds any leg (even fully confirmed)', () => {
  const runner = runnerWith(async () => null);
  runner.persistedMasterLoaded = true;
  const legs = [{ contract: 'ETH_USDT', size: 1_000, positionSide: 'LONG' }];
  for (let seq = 1; seq <= 50; seq++) {
    runner.cycleSeq = seq;
    const current = new Map([['ETH_USDT:LONG', 1_000]]);
    runner.trackMasterLegConfirmation({ list_empty: true, positions: legs }, runner.lastMasterSizes, current, new Set());
    runner.lastMasterSizes = current;
  }
  assert.equal(runner.resumeMasterStateBlocker(), null, 'no pending leg: the single-contract read confirmed it each cycle');
  // ...but the resume read itself is refused whenever the list is empty, although the fallback found every leg.
  assert.equal(runner.resumeMasterSnapshotBlocker({ list_empty: true, positions: legs, unconfirmed_contracts: [] }),
    RESUME_MASTER_SNAPSHOT_UNCONFIRMED);
});

test('review R3 fixed (F3): a persistently failing read keeps resume blocked and alerts CRITICAL after 5 min, then every 30 min', async () => {
  const events = [];
  const logs = [];
  const runner = runnerWith(async (name) => { if (name === 'get_copy_last_master_legs') throw new Error('permission denied'); return null; });
  runner.onSafetyEvent = async (event) => { events.push(event); return { sent: true }; };
  runner.logger = (name) => logs.push(name);
  for (let seq = 1; seq <= 100; seq++) {
    runner.cycleSeq = seq;
    await runner.loadPersistedMasterLegs();
  }
  assert.equal(runner.resumeMasterStateBlocker(), RESUME_MASTER_SNAPSHOT_UNCONFIRMED);
  assert.equal(events.length, 0, 'not yet 5 minutes');
  assert.equal(logs.filter((n) => n === 'persisted_master_positions_failed').length, 100, 'one log line per attempt');
  runner.persistedMasterFailingSince = Date.now() - PERSISTED_MASTER_ALERT_AFTER_MS - 1_000;
  await runner.loadPersistedMasterLegs();
  await runner.loadPersistedMasterLegs();
  assert.equal(events.length, 1);
  assert.deepEqual([events[0].event, events[0].severity], ['MASTER_LAST_LEGS_UNAVAILABLE', 'CRITICAL']);
  assert.ok(events[0].details.failing_minutes >= 5);
  runner.persistedMasterAlertAt = Date.now() - 1_800_001;
  await runner.loadPersistedMasterLegs();
  assert.equal(events.length, 2, 'repeated after 30 minutes');
  // Recovery clears the failure clock.
  runner.rpc = async () => ({ observed_at: new Date().toISOString(), legs: [] });
  await runner.loadPersistedMasterLegs();
  assert.equal(runner.persistedMasterLoaded, true);
  assert.equal(runner.persistedMasterFailingSince, 0);
});

test('review F2: list_empty is logged (with counters) only while the Master is known to hold legs', () => {
  const logs = [];
  const runner = runnerWith(async () => null);
  runner.logger = (name, details) => logs.push([name, details]);
  runner.trackMasterListEmpty({ list_empty: true, positions: [] }, []); // flat Master: normal, not logged
  runner.trackMasterListEmpty({ list_empty: true, positions: [], list_empty_fallback_contracts: ['ETH_USDT'] }, ['ETH_USDT:LONG']);
  runner.trackMasterListEmpty({ list_empty: true, positions: [{ contract: 'ETH_USDT' }], list_empty_fallback_contracts: ['ETH_USDT'] }, []);
  runner.trackMasterListEmpty({ list_empty: false, positions: [{}] }, ['ETH_USDT:LONG']);
  runner.trackMasterListEmpty({ list_empty: true, positions: [] }, ['ETH_USDT:LONG']);
  assert.deepEqual(logs.map(([name, d]) => [name, d.held_total, d.empty_total, d.consecutive]), [
    ['master_positions_list_empty', 1, 2, 1], ['master_positions_list_empty', 2, 3, 2], ['master_positions_list_empty', 3, 4, 1]]);
  assert.deepEqual(Object.keys(logs[0][1]).sort(), ['consecutive', 'cycle_seq', 'empty_total', 'expected_legs', 'fallback_contracts',
    'fallback_positions', 'held_total', 'unconfirmed_contracts']);
});

test('review OK: genuinely flat Master after restart (DB had legs) resolves in two consecutive empty-list cycles', async () => {
  const runner = runnerWith(async (name) => (name === 'get_copy_last_master_legs'
    ? { observed_at: new Date().toISOString(), legs: [ETH, { contract: 'BTC_USDT', position_side: 'SHORT', size: -3 }] } : null));
  runner.cycleSeq = 1;
  await runner.loadPersistedMasterLegs();
  assert.deepEqual(runner.masterExpectations().legs, ['BTC_USDT:SHORT', 'ETH_USDT:LONG']);
  runner.trackMasterLegConfirmation({ list_empty: true, positions: [] }, new Map(), new Map(), new Set());
  assert.equal(runner.resumeMasterStateBlocker(), RESUME_MASTER_SNAPSHOT_UNCONFIRMED);
  runner.cycleSeq = 2;
  runner.trackMasterLegConfirmation({ list_empty: true, positions: [] }, new Map(), new Map(), new Set());
  assert.equal(runner.resumeMasterStateBlocker(), null);
  assert.deepEqual(runner.masterExpectations(), { contracts: [], legs: [] }, 'no extra Gate reads once resolved');
  assert.equal(runner.resumeMasterSnapshotBlocker({ list_empty: true, positions: [], unconfirmed_contracts: [] }), null);
});

test('review OK: trackMasterLegConfirmation never changes the sizes the cycle plans with', () => {
  const runner = runnerWith(async () => null);
  runner.cycleSeq = 5;
  const previous = new Map([['ETH_USDT:LONG', 1_000]]);
  const current = new Map();
  runner.trackMasterLegConfirmation({ list_empty: true, positions: [] }, previous, current, new Set());
  assert.deepEqual([...current], []);
  assert.deepEqual([...previous], [['ETH_USDT:LONG', 1_000]]);
});
