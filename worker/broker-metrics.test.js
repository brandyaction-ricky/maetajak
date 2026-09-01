import test from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregateGateBrokerMetrics, getBrokerCommissionHistory, getBrokerTransactionHistory,
} from './broker-metrics.js';

test('broker metrics aggregate transaction volume and commission income separately by UTC day', () => {
  const rows = aggregateGateBrokerMetrics({
    transactions: [
      { transaction_time: 1788220800, user_id: '1', amount: '100.25' },
      { transaction_time: 1788224400, user_id: '1', amount: '-20' },
      { transaction_time: 1788307200, user_id: '2', amount: '50' },
    ],
    commissions: [
      { commission_time: 1788220800, user_id: '1', amount: '999', rebate_fee: '0.10' },
      { commission_time: 1788224400, user_id: '1', amount: '999', rebate_fee: '0.02' },
      { commission_time: 1788307200, user_id: '2', amount: '999', rebate_fee: '0.05' },
    ],
  }, { startDate: '2026-09-01', endDate: '2026-09-02' });
  assert.deepEqual(rows, [
    { date: '2026-09-01', trading_volume: 120.25, commission: 0.12, user_ids: ['1'], record_count: 2 },
    { date: '2026-09-02', trading_volume: 50, commission: 0.05, user_ids: ['2'], record_count: 1 },
  ]);
});

test('broker commission history follows Gate pagination', async () => {
  const pages = [
    { total: 101, list: Array.from({ length: 100 }, (_, index) => ({ user_id: String(index) })) },
    { total: 101, list: [{ user_id: 'last' }] },
  ];
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return { ok: true, status: 200, text: async () => JSON.stringify(pages.shift()) };
  };
  const records = await getBrokerCommissionHistory({ apiKey: 'key', secretKey: 'secret', from: 1, to: 2, fetchImpl });
  assert.equal(records.length, 101);
  assert.match(calls[0], /limit=100&offset=0/);
  assert.match(calls[1], /limit=100&offset=100/);
});

test('broker transaction history uses Gate transaction endpoint', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return { ok: true, status: 200, text: async () => JSON.stringify({ total: 1, list: [{ amount: '10' }] }) };
  };
  const records = await getBrokerTransactionHistory({ apiKey: 'key', secretKey: 'secret', from: 1, to: 2, fetchImpl });
  assert.equal(records.length, 1);
  assert.match(calls[0], /\/rebate\/broker\/transaction_history/);
});
