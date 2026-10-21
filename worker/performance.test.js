import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateMemberPerformance, kstDayRange, openingEquityFor } from './performance.js';
import { TradingRunner } from './trading-runner.js';

test('KST day range starts at Korean midnight', () => {
  assert.deepEqual(kstDayRange(new Date('2026-08-28T08:00:00Z')), { tradingDate: '2026-08-28', from: 1787842800, to: 1787904000 });
});

test('Gate futures ledger and fills aggregate into actual daily performance', () => {
  const result = aggregateMemberPerformance({
    member: { total: 1010, day_start_equity: 1000, unrealisedPnl: 3 }, observedAt: '2026-08-28T08:00:00Z',
    ledger: [
      { type: 'pnl', change: '12', contract: 'BTC_USDT' },
      { type: 'fee', change: '-2', contract: 'BTC_USDT' },
      { type: 'fund', change: '-1', contract: 'BTC_USDT' },
      { type: 'pnl', change: '-4', contract: 'ETH_USDT' },
    ],
    trades: [{ contract: 'BTC_USDT', size: '2', price: '50000' }],
    contracts: new Map([['BTC_USDT', { quantoMultiplier: 0.0001 }]]),
  });
  assert.equal(result.daily.realisedPnl, 8);
  assert.equal(result.daily.fees, 2);
  assert.equal(result.daily.fundingPnl, -1);
  assert.equal(result.daily.tradingVolume, 10);
  assert.equal(result.daily.tradeCount, 1);
  assert.equal(result.daily.wins, 1);
  assert.equal(result.daily.losses, 1);
  assert.equal(result.symbols.length, 2);
});

// 2026-10-21 QA D11: deposits/withdrawals are neither profit nor loss.
test('daily return excludes today\'s deposits and withdrawals: (closing - opening - net transfers) / base', () => {
  const at = '2026-10-21T08:00:00Z';
  // Withdrawal of 400 today, +50 trading result: 1000 -> 650.
  let { daily } = aggregateMemberPerformance({ observedAt: at,
    member: { total: 650, day_start_equity: 1000, fund_flow_net_after_sync: -400 },
    ledger: [{ type: 'dnw', change: '-400' }, { type: 'pnl', change: '50', contract: 'BTC_USDT' }] });
  assert.equal(daily.openingEquity, 1000);
  assert.equal(daily.withdrawals, 400);
  assert.equal(daily.dailyReturnPct, 5, '+50 on 1000, not -35%');
  // Deposit of 1000 today, -100 trading result: 1000 -> 1900; the deposit is capital at risk today.
  ({ daily } = aggregateMemberPerformance({ observedAt: at,
    member: { total: 1900, day_start_equity: 1000, fund_flow_net_after_sync: 1000 },
    ledger: [{ type: 'dnw', change: '1000' }, { type: 'pnl', change: '-100', contract: 'BTC_USDT' }] }));
  assert.equal(daily.openingEquity, 1000);
  assert.equal(daily.dailyReturnPct, -5, '-100 on 2000, not +90%');
  // Losing everything right after a deposit stays within the table's -100% floor.
  ({ daily } = aggregateMemberPerformance({ observedAt: at,
    member: { total: 0, day_start_equity: 100, fund_flow_net_after_sync: 1000 }, ledger: [{ type: 'dnw', change: '1000' }] }));
  assert.equal(daily.dailyReturnPct, -100);
});

test('opening equity: risk day-start + transfers recorded before today; ledger fallback; explicit resync value', () => {
  // A transfer recorded before today (net 500, nothing today): day-start 1000 adjusted -> 1500 raw.
  assert.equal(openingEquityFor({ day_start_equity: 1000, fund_flow_net: 500 }, 0), 1500);
  // Fresh net after this sync includes today's -200: before today it was 300.
  assert.equal(openingEquityFor({ day_start_equity: 1000, fund_flow_net: 0, fund_flow_net_after_sync: 100 }, -200), 1300);
  // A transfer today without a fresh total: unknown split -> rebuilt from the ledger.
  assert.equal(openingEquityFor({ day_start_equity: 1000, fund_flow_net: 0 }, 300), null);
  const { daily } = aggregateMemberPerformance({ observedAt: '2026-10-21T08:00:00Z',
    member: { total: 1310, day_start_equity: 1000, fund_flow_net: 0 },
    ledger: [{ type: 'dnw', change: '300' }, { type: 'pnl', change: '12' }, { type: 'fee', change: '-2' }] });
  assert.equal(daily.openingEquity, 1000, '1310 - 12 + 2 - 300');
  assert.equal(daily.dailyReturnPct, 10 / 13);
  // Previous-day resync passes the opening it recorded (raw) and it is used as is.
  assert.equal(openingEquityFor({ opening_equity: 777, day_start_equity: 1, fund_flow_net: 99 }, 50), 777);
  assert.equal(openingEquityFor({ total: 5 }, 0), null);
});

test('worker sync: a withdrawal recorded in this sync is neither a loss nor double-counted in the opening', async () => {
  const at = new Date('2026-10-21T03:00:00.000Z');
  const time = Math.floor(at.getTime() / 1000) - 60;
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    const body = parsed.pathname.endsWith('/account_book') ? [{ id: 'w1', type: 'dnw', change: '-300', time }] : [];
    return new Response(JSON.stringify(body), { status: 200 });
  };
  const upserts = [];
  const runner = new TradingRunner({ supabase: {}, baseUrl: 'https://api.gateio.ws', mode: 'LIVE', fetchImpl });
  runner.rpc = async (name, parameters) => {
    if (name === 'upsert_member_daily_performance') upserts.push(parameters);
    return name === 'record_copy_fund_flows' ? -300 : 0; // net transfers after recording this one
  };
  // The cycle context was read before the withdrawal was recorded (fund_flow_net 0); day-start 1000.
  await runner.syncMemberPerformance({ user_id: 'u1', trading_account_id: 'a1', api_key: 'k', secret_key: 's',
    total: 700, day_start_equity: 1000, fund_flow_net: 0, unrealisedPnl: 0 }, new Map(), at.toISOString());
  assert.equal(upserts.length, 1);
  assert.equal(upserts[0].p_opening_equity, 1000);
  assert.equal(upserts[0].p_closing_equity, 700);
  assert.equal(upserts[0].p_withdrawals, 300);
  assert.equal(upserts[0].p_daily_return_pct, 0);
});

test('empty Gate ledger contracts never create a ranking row', () => {
  const result = aggregateMemberPerformance({
    member: { total: 1000 }, observedAt: '2026-08-28T08:00:00Z',
    ledger: [{ type: 'fee', change: '-1', contract: '' }],
    trades: [], contracts: new Map(),
  });
  assert.deepEqual(result.symbols, []);
});
