import { TradingRunner } from '../../worker/trading-runner.js';
import { contracts, ids, observedAccount, position } from './verified-runtime.js';

// Persistent SQL state is shared across fresh runner instances. Only the Gate
// transport and account observations are synthetic; no external writes occur.
export function faultRunner(db, exchange, faults = {}) {
  const calls = []; const alerts = [];
  const rpc = async (name, params = {}) => {
    calls.push(name);
    if (name === 'get_copy_worker_context' && !faults.sqlContext) {
      const states = (await db.query('select * from public.copy_position_states')).rows;
      const profile = (await db.query('select * from public.profiles where id=$1', [ids.user])).rows[0];
      const system = (await db.query('select * from public.copy_system_control')).rows[0];
      return { system, master: { trading_account_id: ids.master }, members: [{ ...profile,
        user_id: ids.user, trading_account_id: ids.member, halted: profile.member_halted,
        previous_states: states, api_key: 'TEST_ONLY', secret_key: 'TEST_ONLY' }] };
    }
    if (faults.beforeRpc === name) throw new Error('SIMULATED_DATABASE_UNAVAILABLE');
    if (!/^[a-z_]+$/.test(name) || Object.keys(params).some((p) => !/^p_[a-z_]+$/.test(p))) throw new Error('Invalid test RPC');
    const args = Object.keys(params).map((p, i) => `${p} => $${i + 1}`).join(',');
    const claim = name.startsWith('claim_');
    const result = await db.query(claim ? `select * from public.${name}(${args})` : `select public.${name}(${args}) value`, Object.values(params));
    if (faults.afterRpc === name) throw new Error('SIMULATED_RPC_RESPONSE_LOST');
    return claim ? result.rows : result.rows[0]?.value;
  };
  const runner = new TradingRunner({ supabase: {}, mode: 'LIVE', channelId: 'maetajak', baseUrl: 'https://api.gateio.ws',
    onSafetyEvent: async (alert) => { alerts.push(alert); return { sent: true }; },
    fetchImpl: async (url, request = {}) => {
      const u = new URL(url);
      if (request.method === 'POST' && u.pathname.includes('leverage')) return new Response('{}');
      if (request.method === 'POST' && u.pathname.endsWith('/orders')) {
        const body = JSON.parse(request.body); exchange.posts++;
        const size = Number(body.size); const fill = exchange.fillFraction == null ? size : size * exchange.fillFraction;
        const order = { id: String(9000 + exchange.posts), contract: body.contract, text: body.text,
          size, left: size - fill, is_reduce_only: body.reduce_only, status: 'finished',
          finish_as: fill === size ? 'filled' : 'ioc', fill_price: '50100' };
        exchange.orders.push(order); exchange.memberSize += fill;
        if (faults.exchange === 'timeout') throw new DOMException('SIMULATED_TIMEOUT', 'TimeoutError');
        if (faults.exchange === 'disconnect') throw new TypeError('SIMULATED_SOCKET_CLOSED');
        if (typeof faults.exchange === 'number') return new Response('{"label":"INTERNAL"}', { status: faults.exchange });
        if (faults.exchange === 'malformed') return new Response('{truncated', { status: 201 });
        return new Response(JSON.stringify(order), { status: 201 });
      }
      if (request.method === 'GET' && /\/orders\//.test(u.pathname)) {
        const key = decodeURIComponent(u.pathname.split('/').at(-1));
        const order = exchange.orders.find((o) => o.id === key || o.text === key);
        return new Response(JSON.stringify(order || { label: 'ORDER_NOT_FOUND' }), { status: order ? 200 : 404 });
      }
      if (request.method === 'GET' && u.pathname.endsWith('/orders')) return new Response('[]');
      if (request.method === 'GET' && u.pathname.endsWith('/my_trades')) return new Response('[]');
      throw new Error(`Unexpected synthetic endpoint ${u.pathname}`);
    } });
  runner.rpc = rpc;
  runner.loadContracts = async () => contracts;
  runner.readAccount = async (account) => observedAccount({ ...account,
    total: account.trading_account_id === ids.master ? exchange.masterEquity ?? 20000 : exchange.memberEquity ?? 5000,
    available: exchange.available ?? 4500,
    positions: (account.trading_account_id === ids.master ? exchange.masterSize : exchange.memberSize)
      ? [position(account.trading_account_id === ids.master ? exchange.masterSize : exchange.memberSize)] : [],
    open_orders: account.trading_account_id === ids.member ? exchange.openOrders || [] : [],
  });
  return { runner, calls, alerts };
}
