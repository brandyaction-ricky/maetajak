import { createHash } from 'node:crypto';

const number = (value) => Number(value || 0);
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function kstDayRange(now = new Date()) {
  const shifted = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const tradingDate = shifted.toISOString().slice(0, 10);
  const from = Math.floor(Date.parse(`${tradingDate}T00:00:00+09:00`) / 1000);
  return { tradingDate, from, to: Math.floor(now.getTime() / 1000) };
}

function typeOf(entry) { return String(entry.type || '').trim().toLowerCase(); }

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
  const openingEquity = Math.max(0, number(member.day_start_equity) || number(member.total) - realisedPnl + fees - fundingPnl - deposits + withdrawals);
  const dailyReturnPct = openingEquity > 0 ? ((realisedPnl - fees + fundingPnl) / openingEquity) * 100 : null;
  const daily = {
    openingEquity, closingEquity: Math.max(0, number(member.total)), deposits, withdrawals,
    realisedPnl, unrealisedPnl: number(member.unrealisedPnl), fees, fundingPnl, tradingVolume,
    tradeCount: trades.length, wins, losses, dailyReturnPct, observedAt,
  };
  return { daily: { ...daily, sourceHash: hash(daily) }, symbols: [...bySymbol.values()].filter((row) => row.contract !== 'UNSPECIFIED').map((row) => ({ ...row, observedAt, sourceHash: hash(row) })) };
}
