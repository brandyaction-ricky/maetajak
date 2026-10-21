import { createHash } from 'node:crypto';

const number = (value) => Number(value || 0);
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function kstDayRange(now = new Date()) {
  const shifted = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const tradingDate = shifted.toISOString().slice(0, 10);
  const from = Math.floor(Date.parse(`${tradingDate}T00:00:00+09:00`) / 1000);
  return { tradingDate, from, to: Math.floor(now.getTime() / 1000) };
}

// The whole KST day before `now`: from its 00:00 KST to the current day's 00:00 KST (Gate's `to` bound).
export function previousKstDayRange(now = new Date()) {
  const today = kstDayRange(now);
  const from = today.from - 86_400;
  const tradingDate = new Date((from + 9 * 60 * 60) * 1000).toISOString().slice(0, 10);
  return { tradingDate, from, to: today.from };
}

function typeOf(entry) { return String(entry.type || '').trim().toLowerCase(); }

const finite = (value) => value != null && value !== '' && Number.isFinite(Number(value));

// Raw Gate equity at the start of the KST day. The risk day-start (get_copy_worker_context day_start_equity)
// is transfer-adjusted: total - net transfers recorded since tracking began. Adding back the transfers that
// happened before today gives the raw opening. net after this sync's transfer recording includes today's
// transfers; the cycle's net (fund_flow_net) only reliably does when there were none today. Otherwise the
// opening is rebuilt from the ledger (null here).
export function openingEquityFor(member, netFlowToday) {
  if (finite(member?.opening_equity)) return Number(member.opening_equity);
  const dayStart = number(member?.day_start_equity);
  if (!(dayStart > 0)) return null;
  if (finite(member?.fund_flow_net_after_sync)) return dayStart + Number(member.fund_flow_net_after_sync) - netFlowToday;
  if (netFlowToday === 0) return dayStart + number(member?.fund_flow_net);
  return null;
}

export function aggregateMemberPerformance({ member, ledger = [], trades = [], contracts = new Map(), observedAt }) {
  const bySymbol = new Map();
  const symbol = (contract) => {
    const key = String(contract || 'UNSPECIFIED').toUpperCase();
    if (!bySymbol.has(key)) bySymbol.set(key, { contract: key, realisedPnl: 0, fees: 0, fundingPnl: 0, tradeCount: 0, wins: 0, losses: 0 });
    return bySymbol.get(key);
  };
  let realisedPnl = 0; let fees = 0; let fundingPnl = 0; let deposits = 0; let withdrawals = 0;
  for (const entry of ledger) {
    const type = typeOf(entry); const change = number(entry.change); const row = symbol(entry.contract);
    if (type === 'pnl') { realisedPnl += change; row.realisedPnl += change; if (change > 0) row.wins += 1; if (change < 0) row.losses += 1; }
    else if (type === 'fee' || type === 'refr') { const cost = Math.max(0, -change); fees += cost; row.fees += cost; }
    else if (type === 'fund') { fundingPnl += change; row.fundingPnl += change; }
    else if (type === 'dnw') { if (change >= 0) deposits += change; else withdrawals += Math.abs(change); }
  }
  let tradingVolume = 0;
  for (const trade of trades) {
    const contract = String(trade.contract || '').toUpperCase();
    const multiplier = number(contracts.get(contract)?.quantoMultiplier);
    tradingVolume += Math.abs(number(trade.size) * number(trade.price) * multiplier);
    symbol(contract).tradeCount += 1;
  }
  const wins = [...bySymbol.values()].reduce((sum, row) => sum + row.wins, 0);
  const losses = [...bySymbol.values()].reduce((sum, row) => sum + row.losses, 0);
  const netFlow = deposits - withdrawals;
  const closingEquity = Math.max(0, number(member.total));
  const openingEquity = Math.max(0, openingEquityFor(member, netFlow)
    ?? number(member.total) - realisedPnl + fees - fundingPnl - netFlow);
  // Opening and closing are both raw Gate equity, so today's deposits/withdrawals are taken out of the change
  // (2026-10-21 QA D11). Money deposited today is capital at risk today, so it joins the base. The table
  // requires daily_return_pct >= -100.
  const returnBase = openingEquity + deposits;
  const dailyReturnPct = returnBase > 0 ? Math.max(-100, ((closingEquity - openingEquity - netFlow) / returnBase) * 100) : null;
  const daily = {
    openingEquity, closingEquity, deposits, withdrawals,
    realisedPnl, unrealisedPnl: number(member.unrealisedPnl), fees, fundingPnl, tradingVolume,
    tradeCount: trades.length, wins, losses, dailyReturnPct, observedAt,
  };
  return { daily: { ...daily, sourceHash: hash(daily) }, symbols: [...bySymbol.values()].filter((row) => row.contract !== 'UNSPECIFIED').map((row) => ({ ...row, observedAt, sourceHash: hash(row) })) };
}
