import { pathToFileURL } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { TradingRunner, safeError } from '../worker/trading-runner.js';
import { positionSide, assertFreshAccount } from '../worker/execution-safety.js';

export function compareAccountPositions(record, snapshot) {
  assertFreshAccount(snapshot);
  const expected = new Map((record.positions || []).map((p) => [`${p.contract}:${p.position_side}`,p]));
  const actual = new Map(snapshot.positions.map((p) => [`${p.contract}:${positionSide(p)}`,p]));
  const mismatches = [];
  for (const key of new Set([...expected.keys(),...actual.keys()])) {
    const d = expected.get(key); const a = actual.get(key);
    const gateSize = Number(a?.size || 0); const currentSize = Number(d?.size || 0);
    const engineSize = record.role === 'MASTER' ? currentSize : Number(d?.engine_size || 0);
    if (Math.abs(gateSize-currentSize)>1e-9 || Math.abs(engineSize-currentSize)>1e-9) {
      mismatches.push({ contract: a?.contract || d.contract, position_side: a ? positionSide(a) : d.position_side,
        gate_size: gateSize, current_size: currentSize, engine_size: engineSize });
    }
  }
  return mismatches;
}

export async function auditCopyState(runner) {
  const audit = await runner.rpc('get_copy_state_reconciliation');
  const context = await runner.rpc('get_copy_worker_context');
  const contexts = [context.master,...(context.members || [])].filter(Boolean);
  const accounts = [];
  for (const record of audit.accounts || []) {
    const account = contexts.find((a) => a.trading_account_id === record.trading_account_id);
    try {
      if (!account) throw new Error('ACCOUNT_CONTEXT_UNAVAILABLE');
      const snapshot = await runner.readAccount({ ...account, expected_contracts: (record.positions || []).map((p)=>p.contract) });
      const mismatches = compareAccountPositions(record,snapshot);
      const fresh = Date.now()-Date.parse(record.observed_at)<=15000;
      accounts.push({ trading_account_id: record.trading_account_id, role:record.role,
        status: !fresh ? 'STALE' : record.status!=='VERIFIED' ? record.status : mismatches.length ? 'MISMATCH' : 'VERIFIED',
        db_observed_at: record.observed_at, gate_observed_at:snapshot.observed_at,
        open_orders:snapshot.open_orders.length, mismatches });
    } catch (error) {
      accounts.push({ trading_account_id:record.trading_account_id,role:record.role,status:'ERROR',error_code:safeError(error,'AUDIT') });
    }
  }
  const ok = audit.schema_version===3 && accounts.length>0 && accounts.every((a)=>a.status==='VERIFIED' && a.open_orders===0)
    && Number(audit.unresolved_orders)===0 && Number(audit.pending_fill_observations)===0;
  return { checked_at:new Date().toISOString(),ok,schema_version:audit.schema_version,system:audit.system,worker:audit.worker,
    unresolved_orders:audit.unresolved_orders,pending_fill_observations:audit.pending_fill_observations,
    pending_alerts:audit.pending_alerts,accounts };
}

if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes('--help')) {
    console.log('Read-only Gate / engine / Current State audit. Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY. Never submits orders or sends alerts.');
  } else {
    try {
      const { SUPABASE_URL:url,SUPABASE_SERVICE_ROLE_KEY:key } = process.env;
      if (!url || !key) throw new Error('Audit connection is not configured');
      const runner = new TradingRunner({ supabase:createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}}),
        baseUrl:'https://api.gateio.ws',mode:'OBSERVE' });
      const report = await auditCopyState(runner);
      console.log(JSON.stringify(report,null,2)); process.exitCode=report.ok?0:1;
    } catch (error) {
      console.error(JSON.stringify({ok:false,error_code:safeError(error,'AUDIT')})); process.exitCode=1;
    }
  }
}
