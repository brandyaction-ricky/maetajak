import { ids, position } from './verified-runtime.js';
import { faultRunner } from './fault-runner.js';
import { buildGateOrderText, buildIdempotencyKey } from '../../worker/copy-engine.js';

// Independent dual-leg exchange ledger, shared across runner restarts. A POST
// may fill even when its response throws; exposure is updated in finally.
export function reversalRuntime(db, sign = 1, protectedSize = 0) {
  const oldSide = sign > 0 ? 'LONG' : 'SHORT';
  const newSide = sign > 0 ? 'SHORT' : 'LONG';
  const legs = { LONG: 0, SHORT: 0 }; legs[oldSide] = protectedSize;
  const exchange = { masterSize: sign * 40, memberSize: protectedSize, posts: 0, orders: [] };
  const submissions = [];
  const makeRunner = (faults = {}, legacyCandidates = false) => {
    const { runner } = faultRunner(db, exchange, faults);
    const read = runner.readAccount.bind(runner);
    runner.readAccount = async (account) => {
      const value = await read(account);
      value.positions = account.trading_account_id === ids.member
        ? Object.values(legs).filter(Boolean).map(n => position(n))
        : exchange.masterPositions || (exchange.masterSize ? [position(exchange.masterSize)] : []);
      return value;
    };
    const transport = runner.fetchImpl;
    runner.fetchImpl = async (url, request = {}) => {
      if (request.method !== 'POST' || !new URL(url).pathname.endsWith('/orders')) return transport(url, request);
      const body = JSON.parse(request.body); const size = Number(body.size);
      const side = body.reduce_only ? (size < 0 ? 'LONG' : 'SHORT') : (size > 0 ? 'LONG' : 'SHORT');
      submissions.push({ size, reduce_only: body.reduce_only, side, before: { ...legs } });
      const before = exchange.orders.length;
      try { return await transport(url, request); }
      finally {
        for (const order of exchange.orders.slice(before)) {
          legs[side] += Number(order.size) - Number(order.left);
          if (exchange.nonterminal) { order.status = 'open'; order.finish_as = ''; }
        }
      }
    };
    if (legacyCandidates) {
      const rpc = runner.rpc;
      runner.rpc = async (name, params) => {
        // Test the server boundary with a valid old-style simultaneous plan.
        // No function, trigger, evidence, account read or quantity is bypassed.
        if (name === 'record_verified_copy_worker_cycle') {
          for (const member of params.p_payload.members) for (const p of member.planned_positions || []) {
            if (p.pause_reason !== 'COPY_REVERSAL_CLOSE_REQUIRED') continue;
            const key = buildIdempotencyKey({ cycleId: params.p_payload.cycle_id, userId: member.user_id,
              contract: p.contract, positionSide: p.position_side, targetSize: p.target_size, actualSize: p.size });
            p.state = 'DRIFT'; p.delta_size = p.target_size - p.size; p.pause_reason = null;
            p.intent = { delta_size: p.delta_size, reduce_only: false, position_side: p.position_side,
              position_mode: 'dual', target_leverage: p.target_leverage, margin_mode: p.margin_mode,
              pid: null, idempotency_key: key, gate_order_text: buildGateOrderText(key) };
          }
        }
        return rpc(name, params);
      };
    }
    return runner;
  };
  const confirm = async (runner) => {
    await runner.syncOnce();
    await db.exec("update private.copy_order_intents set position_match_at=clock_timestamp()-interval '3 seconds' where observation_confirmed_at is null");
    await runner.syncOnce();
  };
  const initialize = async () => {
    if (protectedSize) await db.query('update private.member_copy_onboarding_baselines set member_positions=$1',
      [[{ contract: 'BTC_USDT', position_side: oldSide, size: protectedSize }]]);
    const runner = makeRunner(); await runner.syncOnce(); await runner.submitOrders(); await confirm(runner);
    return runner;
  };
  const orderCandidates = async (entryFirst) => {
    await db.query(`update private.copy_order_intents set created_at=clock_timestamp(), id=case when reduce_only=$1
      then 'ffffffff-ffff-4fff-8fff-ffffffffffff'::uuid else '00000000-0000-4000-8000-000000000001'::uuid end
      where status='PLANNED' and submit_attempts=0`, [entryFirst]);
    // All rows must tie regardless of clock precision or PostgreSQL executor.
    await db.exec("update private.copy_order_intents set created_at=(select min(created_at) from private.copy_order_intents where status='PLANNED') where status='PLANNED'");
  };
  const expire = () => db.exec("update private.copy_order_intents set submitted_at=clock_timestamp()-interval '1 minute',updated_at=clock_timestamp()-interval '1 minute' where status='SUBMITTING'; update private.copy_reconciliation_jobs set run_after=clock_timestamp()-interval '1 second',claimed_at=null");
  return { exchange, legs, submissions, oldSide, newSide, makeRunner, confirm, initialize, orderCandidates, expire };
}
