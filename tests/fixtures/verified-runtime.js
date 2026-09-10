import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { buildCurrentStatePayload, planMemberPositions } from '../../worker/trading-runner.js';

export const ids = { user: '20000000-0000-4000-8000-000000000001',
  member: '20000000-0000-4000-8000-000000000002', master: '20000000-0000-4000-8000-000000000003',
  version: '20000000-0000-4000-8000-000000000004' };
export const migrationFiles = [
  '202609030001_current_state_shadow.sql', '202609030002_fix_current_state_service_role.sql',
  '20260909011308_safe_member_resume.sql', '20260909011702_fix_resume_reconciliation_alias.sql',
  '20260909014924_copy_entry_alert_outbox.sql', '20260909034000_entry_alert_usdt_notional.sql',
  '20260909065335_lock_targets_to_master_size_changes.sql',
  '20260910002837_verified_copy_cycles_and_trade_alerts.sql',
  '20260910052000_supersede_stale_planned_intents.sql',
];
export async function createVerifiedDatabase() {
  const db = new PGlite();
  await db.exec(readFileSync('tests/fixtures/copy-runtime-schema.sql', 'utf8'));
  await db.exec('insert into public.copy_system_control default values');
  for (const file of migrationFiles) {
    try { await db.exec(readFileSync(`supabase/migrations/${file}`, 'utf8')); }
    catch (error) { await db.close(); throw new Error(`${file}: ${error.message}`, { cause: error }); }
  }
  return db;
}
export async function seedVerifiedAccount(db) {
  await db.query("insert into public.profiles(id,email,approval_status,copy_paused) values($1,'qa@example.invalid','APPROVED',false)", [ids.user]);
  await db.query("insert into private.trading_accounts(id,user_id,credential_user_id,account_role,status) values($1,$2,$2,'MEMBER','ACTIVE'),($3,null,null,'MASTER','ACTIVE')", [ids.member, ids.user, ids.master]);
  await db.query("insert into private.copy_resume_sessions(trading_account_id,version,state) values($1,$2,'ACTIVE')", [ids.member, ids.version]);
  await db.query("insert into private.member_copy_onboarding_baselines(trading_account_id,positions,member_positions,resume_version) values($1,'[]','[]',$2)", [ids.member, ids.version]);
  await db.query("insert into private.gate_api_credentials(user_id,gate_uid,api_key_ciphertext,secret_key_ciphertext,api_key_last4,status,futures_read,futures_trade,verification_version,verified_worker_ip) values($1,'TEST_ONLY','x','y','TEST','VERIFIED',true,true,2,'192.0.2.1')", [ids.user]);
  await db.exec("insert into private.copy_worker_runtime(worker_version,mode,gate_base_url,public_ip,broker_channel_id,heartbeat_at) values('0.5.0','LIVE','https://api.gateio.ws','192.0.2.1','maetajak',clock_timestamp()); update public.copy_system_control set execution_enabled=true,emergency_halted=false; select set_config('request.jwt.claim.role','service_role',false)");
}
export const contractInfo = { quantoMultiplier: 0.001, sizeStep: 1, orderSizeMin: 1, takerFeeRate: 0.001 };
export const contracts = new Map([['BTC_USDT', contractInfo], ['SOXL_USDT', { ...contractInfo, quantoMultiplier: 1 }]]);
export function observedAccount(fields = {}) {
  const now = new Date().toISOString();
  return { total: 5000, available: 4500, unrealisedPnl: 0, positions: [], open_orders: [],
    positionMode: 'dual', observed_at: now, observed_started_at: now, ...fields };
}
export const position = (size, contract = 'BTC_USDT') => ({ contract, positionSide: size < 0 ? 'SHORT' : 'LONG',
  size, markPrice: 50000, entryPrice: 49900, leverage: 10, mode: size < 0 ? 'dual_short' : 'dual_long', posMarginMode: 'cross' });
export function cyclePayload({ masterSize = 40, actualSize = 0, member = {}, master = {}, system = {}, mode = 'LIVE' } = {}) {
  const cycleId = randomUUID(); const observedAt = new Date().toISOString();
  const m = observedAccount({ trading_account_id: ids.master, total: 20000, available: 18000,
    positions: masterSize ? [position(masterSize)] : [], ...master });
  const a = observedAccount({ trading_account_id: ids.member, user_id: ids.user, resume_version: ids.version,
    copy_ratio: 100, max_position_ratio: 30, positions: actualSize ? [position(actualSize)] : [], ...member });
  a.planned_positions = planMemberPositions({ cycleId, system: { emergency_halted: false, ...system }, master: m, member: a, contracts });
  if (mode !== 'LIVE') a.planned_positions = a.planned_positions.map(({ intent, ...p }) => p);
  return { cycle_id: cycleId, source_version: cycleId, observed_at: observedAt, master: m, members: [a],
    current_state: buildCurrentStatePayload({ cycleId, observedAt, master: m, members: [a] }) };
}
export const record = (db, payload) => db.query('select public.record_verified_copy_worker_cycle($1)', [payload]);
