import { GATE_API_BASE_URL, gateRequest } from './gate.js';

export const BROKER_COMMISSION_HISTORY_PATH = '/api/v4/rebate/broker/commission_history';
export const BROKER_TRANSACTION_HISTORY_PATH = '/api/v4/rebate/broker/transaction_history';

function number(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function utcDateFromSeconds(value) {
  const raw = number(value);
  if (!raw) return null;
  const milliseconds = raw > 10_000_000_000 ? raw : raw * 1_000;
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

async function getBrokerHistory({
  apiKey, secretKey, from, to, path, fetchImpl = fetch, baseUrl = GATE_API_BASE_URL,
}) {
  const records = [];
  const limit = 100;
  for (let offset = 0; ; offset += limit) {
    const { payload } = await gateRequest({
      apiKey, secretKey, path,
      query: { from, to, limit, offset }, fetchImpl, baseUrl,
    });
    const page = Array.isArray(payload) ? payload : (Array.isArray(payload?.list) ? payload.list : []);
    const total = Number(payload?.total);
    records.push(...page);
    if (Number.isFinite(total) && records.length >= total) break;
    if (page.length < limit) break;
  }
  return records;
}

export function getBrokerCommissionHistory(options) {
  return getBrokerHistory({ ...options, path: BROKER_COMMISSION_HISTORY_PATH });
}

export function getBrokerTransactionHistory(options) {
  return getBrokerHistory({ ...options, path: BROKER_TRANSACTION_HISTORY_PATH });
}

export function aggregateGateBrokerMetrics({ transactions, commissions }, { startDate, endDate }) {
  const rows = new Map();
  const cursor = new Date(`${startDate}T00:00:00.000Z`);
  const end = new Date(`${endDate}T00:00:00.000Z`);
  while (cursor <= end) {
    const date = cursor.toISOString().slice(0, 10);
    rows.set(date, { date, trading_volume: 0, commission: 0, user_ids: [], record_count: 0 });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  const usersByDate = new Map([...rows.keys()].map((date) => [date, new Set()]));
  for (const record of transactions || []) {
    const date = utcDateFromSeconds(record?.transaction_time);
    const row = date ? rows.get(date) : null;
    if (!row) continue;
    row.trading_volume += Math.abs(number(record?.amount));
    row.record_count += 1;
    if (record?.user_id != null) usersByDate.get(date).add(String(record.user_id));
  }
  for (const record of commissions || []) {
    const date = utcDateFromSeconds(record?.commission_time);
    const row = date ? rows.get(date) : null;
    if (!row) continue;
    row.commission += number(record?.rebate_fee);
    if (record?.user_id != null) usersByDate.get(date).add(String(record.user_id));
  }
  return [...rows.values()].map((row) => ({
    ...row,
    trading_volume: Number(row.trading_volume.toFixed(12)),
    commission: Number(row.commission.toFixed(12)),
    user_ids: [...usersByDate.get(row.date)],
  }));
}

export async function syncGateBrokerMetrics({
  supabase, apiKey, secretKey, baseUrl = GATE_API_BASE_URL, fetchImpl = fetch,
  now = new Date(), lookbackDays = 30,
}) {
  const endDate = now.toISOString().slice(0, 10);
  const start = new Date(`${endDate}T00:00:00.000Z`);
  start.setUTCDate(start.getUTCDate() - Math.min(29, Math.max(0, lookbackDays - 1)));
  const startDate = start.toISOString().slice(0, 10);
  const from = Math.floor(start.getTime() / 1_000);
  const to = Math.floor(now.getTime() / 1_000);
  const [transactions, commissions] = await Promise.all([
    getBrokerTransactionHistory({ apiKey, secretKey, from, to, fetchImpl, baseUrl }),
    getBrokerCommissionHistory({ apiKey, secretKey, from, to, fetchImpl, baseUrl }),
  ]);
  const rows = aggregateGateBrokerMetrics({ transactions, commissions }, { startDate, endDate });
  const { error } = await supabase.rpc('upsert_gate_broker_metrics', {
    p_rows: rows,
    p_observed_at: now.toISOString(),
  });
  if (error) throw new Error(`upsert_gate_broker_metrics: ${error.message}`);
  return {
    startDate, endDate, transactions: transactions.length, commissions: commissions.length, rows: rows.length,
  };
}
