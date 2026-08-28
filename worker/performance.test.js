import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateMemberPerformance, kstDayRange } from './performance.js';

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
