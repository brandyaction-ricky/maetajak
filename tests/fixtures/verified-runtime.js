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
  '20260910095235_confirmed_order_observation_context.sql',
  '20260911062432_admin_new_operation.sql',
  '20260911065800_new_operation_confirmation_window.sql',
  '20260911100000_new_operation_current_master_copy.sql',
  '20260912100000_resume_copy_attribution.sql',
  '20260914154037_resume_requires_explicit_rebalance_consent.sql',
  '20260914163259_preserve_confirmed_copy_ownership_on_resume.sql',
  '20260914172954_require_observed_copy_close_before_reversal.sql',
  // Production fixes applied 2026-09-21/22 (exact production migration text).
  '20260921125321_fix_resume_ownership_legacy_fill_qualifier.sql',
  '20260922131020_fix_reversal_guard_legacy_fill_qualifier.sql',
  '20260924162948_copy_reliability_p0_p1.sql',
  '20260925002511_member_own_position_absorption.sql',
  '20260926075458_copy_history_footprint.sql',
  // 2026-10-19 reliability fixes.
  '20261019060000_copy_event_noise_retention.sql',
  '20261019060100_risk_equity_net_of_transfers.sql',
  '20261019060200_target_anchor_desired_size.sql',
  '20261019060300_gate_account_change_rebind.sql',
  // 2026-10-20 admin weights; a member's own trading no longer locks a leg.
  '20261020010000_admin_member_weights_no_member_trade_lock.sql',
  // 2026-10-20 DB QA fixes (KST dates, admin member disconnect, least privilege, alert retry cap).
  '20261020020000_qa_fixes.sql',
  // 2026-10-21 administrator member withdrawal / restore.
  '20261021010000_admin_member_withdrawal.sql',
  // 2026-10-21 Gate UID accounts (needs the production stand-ins below).
  '20261021020000_uid_accounts.sql',
  // 2026-10-21 QA sizing: FUTURE_ONLY anchors (consumed increases, reference/observed Master, held ratio).
  '20261021030000_qa_sizing_anchor.sql',
  // 2026-10-21 QA A/D: Master key rotation, admin status, UID release, restore reset, admin restrictions.
  '20261021032000_qa_admin_lifecycle.sql',
  // 2026-10-21 QA D: risk on the sizing equity basis, unified-member policy.
  '20261021033000_qa_risk_basis.sql',
  // 2026-10-21 review fixes: account policy (unified member) visible to the administrator.
  '20261021034000_qa_review_fixes.sql',
];
// Production objects the structural fixture lacks (test-only stand-ins, no data). Every statement is
// "if not exists"/"or replace", so a test may still create its own (narrower) stand-in first.
export const productionStandIns = `
  create table if not exists private.gate_api_verification_jobs (
    id bigint generated always as identity primary key, user_id uuid not null unique,
    attempts integer not null default 0, run_after timestamptz not null default now(), claimed_at timestamptz,
    created_at timestamptz not null default now(), updated_at timestamptz not null default now());
  create table if not exists private.open_order_cancel_jobs (
    id bigint generated always as identity primary key, trading_account_id uuid not null unique,
    state text not null default 'PENDING', requested_by uuid, reason text, attempts integer not null default 0,
    run_after timestamptz not null default now(), claimed_at timestamptz, cancelled_count integer,
    remaining_count integer, last_error_code text, completed_at timestamptz,
    created_at timestamptz not null default now(), updated_at timestamptz not null default now());
  create table if not exists auth.users (id uuid primary key, email text, raw_user_meta_data jsonb,
    email_confirmed_at timestamptz, banned_until timestamptz, updated_at timestamptz);
  create table if not exists public.legal_acceptances (user_id uuid not null, document_type text not null,
    document_version text not null, accepted_at timestamptz not null, unique (user_id, document_type, document_version));
  create or replace function extensions.pgp_sym_encrypt(text,text,text) returns bytea language sql as $$ select convert_to('TEST_ONLY','UTF8') $$;
  create or replace function extensions.gen_random_bytes(integer) returns bytea language sql as $$ select decode(repeat('00',$1),'hex') $$;
  CREATE OR REPLACE FUNCTION public.auto_approve_confirmed_user()
   RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
  AS $function$
begin
  if new.email_confirmed_at is null then
    return new;
  end if;
  return new;
end;
$function$;`;
export async function createVerifiedDatabase() {
  const db = new PGlite();
  await db.exec(readFileSync('tests/fixtures/copy-runtime-schema.sql', 'utf8'));
  await db.exec('insert into public.copy_system_control default values');
  await db.exec(productionStandIns);
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
