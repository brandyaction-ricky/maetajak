-- Repo sync (2026-09-24): production definitions changed OUTSIDE tracked migrations.
-- Purpose: repo == prod so tests verify the code that actually runs. Idempotent; applying this to
-- production is a no-op (every body below is md5-identical to production pg_proc.prosrc, verified
-- 2026-09-24 KST).
--  1) Seven worker/performance RPCs: the legacy `request.jwt.claim.role` check was removed in production
--     (newer PostgREST only sets request.jwt.claims). Access stays service_role-only via GRANTs.
--  2) public.clear_member_copy_baseline_legs existed only in production.
--  3) Retention support indexes + pg_cron job (applied 2026-09-24, see retention_prune_copy_history_function).

create or replace function public.report_copy_worker_cycle(p_success boolean, p_error_code text default null)
returns jsonb language plpgsql security definer set search_path=public,pg_temp
as $$
declare runtime private.copy_worker_runtime;
begin
  
  update private.copy_worker_runtime set
    consecutive_failures=case when p_success then 0 else consecutive_failures+1 end,
    last_success_at=case when p_success then now() else last_success_at end,
    last_error_code=case when p_success then null else left(coalesce(p_error_code,'WORKER_CYCLE_ERROR'),80) end,
    updated_at=now()
  where singleton returning * into runtime;
  if not p_success and runtime.mode='LIVE' and runtime.consecutive_failures>=3 then
    update public.copy_system_control set execution_enabled=false,emergency_halted=true,
      halt_reason='WORKER_REPEATED_FAILURE',updated_at=now() where singleton;
    if not exists(select 1 from public.copy_events where event_type='SYSTEM_HALTED' and safe_payload->>'reason'='WORKER_REPEATED_FAILURE' and occurred_at>now()-interval '5 minutes') then
      insert into public.copy_events(event_type,severity,safe_payload)
      values('SYSTEM_HALTED','CRITICAL',jsonb_build_object('reason','WORKER_REPEATED_FAILURE','error_code',runtime.last_error_code,'failures',runtime.consecutive_failures));
    end if;
  end if;
  return jsonb_build_object('consecutive_failures',runtime.consecutive_failures,'last_success_at',runtime.last_success_at,'last_error_code',runtime.last_error_code);
end;
$$;

revoke all on function public.report_copy_worker_cycle(boolean,text) from public, anon, authenticated;
grant execute on function public.report_copy_worker_cycle(boolean,text) to service_role;

create or replace function public.set_copy_live_activation(p_enable boolean,p_confirmation text,p_reason text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp
as $$
declare result public.copy_system_control;
begin
  
  if p_enable then
    if p_confirmation<>'ENABLE_LIVE_COPY_TRADING' then raise exception 'LIVE_CONFIRMATION_REQUIRED'; end if;
    if not exists(select 1 from private.copy_worker_runtime r cross join public.copy_system_control c where r.singleton and c.singleton and r.mode='LIVE' and r.gate_base_url='https://api.gateio.ws' and r.public_ip is not null and r.broker_channel_id=c.broker_channel_id and r.heartbeat_at>now()-interval '30 seconds' and r.last_test_passed_at>now()-interval '7 days') then raise exception 'WORKER_READINESS_REQUIRED'; end if;
    if not exists(select 1 from private.trading_accounts a join private.gate_api_credentials g on g.user_id=a.credential_user_id cross join private.copy_worker_runtime r where r.singleton and a.account_role='MASTER' and a.status='ACTIVE' and g.status='VERIFIED' and g.verification_version>=2 and g.verified_worker_ip=r.public_ip) then raise exception 'VERIFIED_MASTER_REQUIRED'; end if;
    if not exists(select 1 from private.trading_accounts a join private.gate_api_credentials g on g.user_id=a.credential_user_id cross join private.copy_worker_runtime r where r.singleton and a.account_role='MEMBER' and a.status='ACTIVE' and g.status='VERIFIED' and g.verification_version>=2 and g.verified_worker_ip=r.public_ip) then raise exception 'VERIFIED_MEMBER_REQUIRED'; end if;
  end if;
  update public.copy_system_control set execution_enabled=p_enable,emergency_halted=not p_enable,
    halt_reason=case when p_enable then 'LIVE_EXECUTION_ENABLED' else left(coalesce(nullif(trim(p_reason),''),'DEPLOYMENT_HALT'),160) end,updated_at=now()
  where singleton returning * into result;
  if p_enable then
    update private.copy_order_intents set status='CANCELLED',last_error_code='PRE_LIVE_INTENT_DISCARDED',resolved_at=now(),updated_at=now()
    where status in ('PLANNED','QUEUED') and created_at<result.updated_at;
  end if;
  insert into public.admin_audit_logs(action,next_value) values(case when p_enable then 'LIVE_COPY_ENABLED' else 'LIVE_COPY_HALTED' end,jsonb_build_object('reason',p_reason,'execution_enabled',p_enable,'broker_channel_id',result.broker_channel_id));
  return to_jsonb(result);
end;
$$;

revoke all on function public.set_copy_live_activation(boolean,text,text) from public, anon, authenticated;
grant execute on function public.set_copy_live_activation(boolean,text,text) to service_role;

create or replace function public.set_member_copy_started_at(p_user_id uuid, p_started_at timestamptz)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  
  update public.profiles set copy_started_at = coalesce(copy_started_at, p_started_at)
  where id = p_user_id and role = 'MEMBER' and approval_status = 'APPROVED';
end;
$$;

revoke all on function public.set_member_copy_started_at(uuid,timestamptz) from public, anon, authenticated;
grant execute on function public.set_member_copy_started_at(uuid,timestamptz) to service_role;

create or replace function public.upsert_member_daily_performance(
  p_user_id uuid,
  p_trading_date date,
  p_opening_equity numeric,
  p_closing_equity numeric,
  p_deposits numeric,
  p_withdrawals numeric,
  p_realised_pnl numeric,
  p_unrealised_pnl numeric,
  p_fees numeric,
  p_funding_pnl numeric,
  p_trading_volume numeric,
  p_trade_count integer,
  p_winning_trade_count integer,
  p_losing_trade_count integer,
  p_daily_return_pct numeric,
  p_source_snapshot_at timestamptz,
  p_source_hash text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  
  if not exists (
    select 1 from public.profiles
    where id = p_user_id and role = 'MEMBER' and approval_status = 'APPROVED'
  ) then raise exception 'APPROVED_MEMBER_REQUIRED'; end if;

  insert into public.member_daily_performance (
    user_id, trading_date, opening_equity, closing_equity, deposits, withdrawals,
    realised_pnl, unrealised_pnl, fees, funding_pnl, trading_volume,
    trade_count, winning_trade_count, losing_trade_count, daily_return_pct,
    source_snapshot_at, source_hash, updated_at
  ) values (
    p_user_id, p_trading_date, p_opening_equity, p_closing_equity,
    greatest(coalesce(p_deposits, 0), 0), greatest(coalesce(p_withdrawals, 0), 0),
    coalesce(p_realised_pnl, 0), coalesce(p_unrealised_pnl, 0),
    greatest(coalesce(p_fees, 0), 0), coalesce(p_funding_pnl, 0),
    greatest(coalesce(p_trading_volume, 0), 0), greatest(coalesce(p_trade_count, 0), 0),
    greatest(coalesce(p_winning_trade_count, 0), 0), greatest(coalesce(p_losing_trade_count, 0), 0),
    p_daily_return_pct, p_source_snapshot_at, left(p_source_hash, 128), now()
  )
  on conflict (user_id, trading_date) do update set
    opening_equity = excluded.opening_equity,
    closing_equity = excluded.closing_equity,
    deposits = excluded.deposits,
    withdrawals = excluded.withdrawals,
    realised_pnl = excluded.realised_pnl,
    unrealised_pnl = excluded.unrealised_pnl,
    fees = excluded.fees,
    funding_pnl = excluded.funding_pnl,
    trading_volume = excluded.trading_volume,
    trade_count = excluded.trade_count,
    winning_trade_count = excluded.winning_trade_count,
    losing_trade_count = excluded.losing_trade_count,
    daily_return_pct = excluded.daily_return_pct,
    source_snapshot_at = excluded.source_snapshot_at,
    source_hash = excluded.source_hash,
    updated_at = now()
  where public.member_daily_performance.source_snapshot_at <= excluded.source_snapshot_at;
end;
$$;

revoke all on function public.upsert_member_daily_performance(uuid,date,numeric,numeric,numeric,numeric,numeric,numeric,numeric,numeric,numeric,integer,integer,integer,numeric,timestamptz,text) from public, anon, authenticated;
grant execute on function public.upsert_member_daily_performance(uuid,date,numeric,numeric,numeric,numeric,numeric,numeric,numeric,numeric,numeric,integer,integer,integer,numeric,timestamptz,text) to service_role;

create or replace function public.upsert_member_symbol_daily_performance(
  p_user_id uuid, p_trading_date date, p_contract text, p_realised_pnl numeric,
  p_fees numeric, p_funding_pnl numeric, p_trade_count integer,
  p_winning_trade_count integer, p_losing_trade_count integer,
  p_source_snapshot_at timestamptz, p_source_hash text
)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  
  insert into public.member_symbol_daily_performance (
    user_id, trading_date, contract, realised_pnl, fees, funding_pnl, trade_count,
    winning_trade_count, losing_trade_count, source_snapshot_at, source_hash, updated_at
  ) values (
    p_user_id, p_trading_date, upper(trim(p_contract)), coalesce(p_realised_pnl, 0),
    greatest(coalesce(p_fees, 0), 0), coalesce(p_funding_pnl, 0), greatest(coalesce(p_trade_count, 0), 0),
    greatest(coalesce(p_winning_trade_count, 0), 0), greatest(coalesce(p_losing_trade_count, 0), 0),
    p_source_snapshot_at, left(p_source_hash, 128), now()
  ) on conflict (user_id, trading_date, contract) do update set
    realised_pnl = excluded.realised_pnl, fees = excluded.fees, funding_pnl = excluded.funding_pnl,
    trade_count = excluded.trade_count, winning_trade_count = excluded.winning_trade_count,
    losing_trade_count = excluded.losing_trade_count, source_snapshot_at = excluded.source_snapshot_at,
    source_hash = excluded.source_hash, updated_at = now()
  where public.member_symbol_daily_performance.source_snapshot_at <= excluded.source_snapshot_at;
end;
$$;

revoke all on function public.upsert_member_symbol_daily_performance(uuid,date,text,numeric,numeric,numeric,integer,integer,integer,timestamptz,text) from public, anon, authenticated;
grant execute on function public.upsert_member_symbol_daily_performance(uuid,date,text,numeric,numeric,numeric,integer,integer,integer,timestamptz,text) to service_role;

CREATE OR REPLACE FUNCTION public.clear_member_copy_baselines(p_trading_account_id uuid, p_contracts text[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare result jsonb;
begin
  update private.member_copy_onboarding_baselines baseline set positions=coalesce((select jsonb_agg(item order by item->>'contract') from jsonb_array_elements(baseline.positions) item where not(item->>'contract'=any(coalesce(p_contracts,array[]::text[])))),'[]'::jsonb),updated_at=now() where baseline.trading_account_id=p_trading_account_id returning positions into result;
  return coalesce(result,'[]'::jsonb);
end; $function$;

revoke all on function public.clear_member_copy_baselines(uuid,text[]) from public, anon, authenticated;
grant execute on function public.clear_member_copy_baselines(uuid,text[]) to service_role;

CREATE OR REPLACE FUNCTION public.get_or_initialize_member_copy_baseline(p_trading_account_id uuid, p_master_positions jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare result jsonb;
begin
  if not exists(select 1 from private.trading_accounts where id=p_trading_account_id and account_role='MEMBER' and status='ACTIVE') then
    raise exception 'ACTIVE_MEMBER_ACCOUNT_REQUIRED';
  end if;
  insert into private.member_copy_onboarding_baselines(trading_account_id,positions)
  values(p_trading_account_id,coalesce((
    select jsonb_agg(jsonb_build_object(
      'contract',item->>'contract',
      'position_side',coalesce(nullif(item->>'position_side',''),case when (item->>'size')::numeric<0 then 'SHORT' else 'LONG' end),
      'size',(item->>'size')::numeric
    ) order by item->>'contract',coalesce(item->>'position_side',''))
    from jsonb_array_elements(coalesce(p_master_positions,'[]'::jsonb)) item
    where nullif(item->>'contract','') is not null and coalesce((item->>'size')::numeric,0)<>0
  ),'[]'::jsonb))
  on conflict(trading_account_id) do nothing;
  select jsonb_build_object('initialized_at',initialized_at,'positions',positions) into result
  from private.member_copy_onboarding_baselines where trading_account_id=p_trading_account_id;
  return result;
end;
$function$;

revoke all on function public.get_or_initialize_member_copy_baseline(uuid,jsonb) from public, anon, authenticated;
grant execute on function public.get_or_initialize_member_copy_baseline(uuid,jsonb) to service_role;

CREATE OR REPLACE FUNCTION public.clear_member_copy_baseline_legs(p_trading_account_id uuid, p_positions jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare result jsonb;
begin
  update private.member_copy_onboarding_baselines baseline
  set positions=coalesce((
    select jsonb_agg(item order by item->>'contract',item->>'position_side')
    from jsonb_array_elements(baseline.positions) item
    where not exists(
      select 1 from jsonb_array_elements(coalesce(p_positions,'[]'::jsonb)) cleared
      where cleared->>'contract'=item->>'contract'
        and coalesce(cleared->>'position_side',case when (cleared->>'size')::numeric<0 then 'SHORT' else 'LONG' end)
          =coalesce(item->>'position_side',case when (item->>'size')::numeric<0 then 'SHORT' else 'LONG' end)
    )
  ),'[]'::jsonb),updated_at=now()
  where baseline.trading_account_id=p_trading_account_id
  returning positions into result;
  return coalesce(result,'[]'::jsonb);
end;
$function$;

revoke all on function public.clear_member_copy_baseline_legs(uuid,jsonb) from public, anon, authenticated;
grant execute on function public.clear_member_copy_baseline_legs(uuid,jsonb) to service_role;

-- Retention support (built in production by a one-off pg_cron job on 2026-09-24).
create index if not exists copy_events_cycle_id_idx on public.copy_events (cycle_id) where cycle_id is not null;
create index if not exists copy_cycles_master_snapshot_id_idx on private.copy_cycles (master_snapshot_id) where master_snapshot_id is not null;
create index if not exists copy_cycles_created_at_idx on private.copy_cycles (created_at);
-- Recurring TTL job (production jobid 2). Only where pg_cron is installed; keeps 3 days, 1000 rows/batch.
do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('maetajak-prune-copy-history', '*/10 * * * *',
      $job$set statement_timeout = '8min'; select private.prune_copy_history(interval '3 days', 1000, false)$job$);
  end if;
end $$;
