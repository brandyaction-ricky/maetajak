-- Tighten Gate verification and recover uncertain submissions before live activation.
alter table private.gate_api_credentials
  add column if not exists verification_version integer not null default 1,
  add column if not exists verified_worker_ip inet;

create or replace function private.reset_gate_verification_marker()
returns trigger language plpgsql set search_path = public, pg_temp
as $$
begin
  if new.status = 'PENDING_VERIFICATION' then
    new.verification_version := 1;
    new.verified_worker_ip := null;
  end if;
  return new;
end;
$$;
drop trigger if exists reset_gate_verification_marker on private.gate_api_credentials;
create trigger reset_gate_verification_marker
before insert or update of status on private.gate_api_credentials
for each row execute function private.reset_gate_verification_marker();

-- Any account approved by the earlier read-only check must pass the strict permission/IP check again.
with reset_accounts as (
  update private.gate_api_credentials
  set status = 'PENDING_VERIFICATION', futures_read = false, futures_trade = false,
      ip_whitelisted = false, withdrawal_disabled = false, verification_version = 1,
      verified_worker_ip = null, verified_at = null, updated_at = now()
  where status = 'VERIFIED' and verification_version < 2
  returning user_id
)
insert into private.gate_api_verification_jobs(user_id, attempts, run_after, claimed_at, updated_at)
select user_id, 0, now(), null, now() from reset_accounts
on conflict(user_id) do update set attempts=0,run_after=now(),claimed_at=null,updated_at=now();

drop function if exists public.complete_gate_api_verification(bigint, boolean, text, text, text);
create function public.complete_gate_api_verification(
  p_job_id bigint, p_success boolean, p_gate_user_id text default null,
  p_error_code text default null, p_error_message text default null,
  p_worker_public_ip text default null
)
returns void language plpgsql security definer set search_path = public, pg_temp
as $$
declare target_user_id uuid;
declare target_connection_role text;
begin
  if coalesce(current_setting('request.jwt.claim.role', true), '') <> 'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  if p_success and nullif(trim(p_worker_public_ip), '') is null then raise exception 'WORKER_IP_REQUIRED'; end if;
  select job.user_id, credentials.connection_role into target_user_id, target_connection_role
  from private.gate_api_verification_jobs job
  join private.gate_api_credentials credentials on credentials.user_id=job.user_id
  where job.id=p_job_id for update of job;
  if target_user_id is null then raise exception 'JOB_NOT_FOUND'; end if;

  update private.gate_api_credentials set
    status=case when p_success then 'VERIFIED' else 'ERROR' end,
    futures_read=p_success, futures_trade=p_success, ip_whitelisted=p_success,
    withdrawal_disabled=p_success, permissions_confirmed=p_success,
    gate_user_id=nullif(trim(p_gate_user_id),''),
    verification_version=case when p_success then 2 else 1 end,
    verified_worker_ip=case when p_success then trim(p_worker_public_ip)::inet else null end,
    last_error_code=case when p_success then null else left(coalesce(p_error_code,'VERIFICATION_FAILED'),80) end,
    last_error=case when p_success then null else left(coalesce(p_error_message,'Gate.io verification failed'),300) end,
    last_checked_at=now(),verified_at=case when p_success then now() else null end,updated_at=now()
  where user_id=target_user_id;

  if p_success then
    insert into private.trading_accounts(user_id,credential_user_id,account_role,settle,status,is_primary,updated_at)
    values(target_user_id,target_user_id,target_connection_role,'usdt','ACTIVE',true,now())
    on conflict(credential_user_id,account_role,settle) do update set status='ACTIVE',updated_at=now();
  else
    update private.trading_accounts set status='ERROR',updated_at=now()
    where credential_user_id=target_user_id and account_role=target_connection_role;
  end if;
  delete from private.gate_api_verification_jobs where id=p_job_id;
  insert into public.admin_audit_logs(action,target_user_id,next_value)
  values(case when p_success then 'GATE_API_VERIFIED' else 'GATE_API_VERIFICATION_FAILED' end,target_user_id,
    jsonb_build_object('success',p_success,'connection_role',target_connection_role,'verification_version',case when p_success then 2 else 1 end,'error_code',p_error_code));
end;
$$;
revoke all on function public.complete_gate_api_verification(bigint,boolean,text,text,text,text) from public;
grant execute on function public.complete_gate_api_verification(bigint,boolean,text,text,text,text) to service_role;

create or replace function public.copy_worker_heartbeat(
  p_worker_id text,p_worker_version text,p_gate_base_url text,p_public_ip text default null,
  p_mode text default 'OBSERVE',p_test_passed boolean default false
)
returns jsonb language plpgsql security definer set search_path=public,pg_temp
as $$
declare runtime private.copy_worker_runtime;
begin
  if coalesce(current_setting('request.jwt.claim.role',true),'')<>'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  if p_mode not in ('OBSERVE','DRY_RUN','LIVE') then raise exception 'INVALID_WORKER_MODE'; end if;
  if p_test_passed and p_mode<>'DRY_RUN' then raise exception 'DRY_RUN_REQUIRED_FOR_READINESS'; end if;
  if p_mode='LIVE' and (nullif(trim(p_public_ip),'') is null or p_gate_base_url<>'https://api.gateio.ws') then raise exception 'LIVE_WORKER_CONFIGURATION_REQUIRED'; end if;
  if exists(select 1 from private.copy_worker_runtime r where r.singleton and r.worker_id is distinct from p_worker_id and r.heartbeat_at>now()-interval '30 seconds') then raise exception 'WORKER_LEASE_HELD'; end if;
  insert into private.copy_worker_runtime(singleton,worker_id,worker_version,gate_base_url,public_ip,mode,heartbeat_at,last_test_passed_at,started_at,updated_at)
  values(true,left(p_worker_id,120),left(p_worker_version,80),left(p_gate_base_url,200),nullif(trim(p_public_ip),'')::inet,p_mode,now(),case when p_test_passed then now() end,now(),now())
  on conflict(singleton) do update set worker_id=excluded.worker_id,worker_version=excluded.worker_version,
    gate_base_url=excluded.gate_base_url,public_ip=excluded.public_ip,mode=excluded.mode,heartbeat_at=now(),
    last_test_passed_at=case when p_test_passed then now() else private.copy_worker_runtime.last_test_passed_at end,
    started_at=coalesce(private.copy_worker_runtime.started_at,now()),updated_at=now()
  returning * into runtime;
  return jsonb_build_object('mode',runtime.mode,'heartbeat_at',runtime.heartbeat_at,'test_passed_at',runtime.last_test_passed_at);
end;
$$;
revoke all on function public.copy_worker_heartbeat(text,text,text,text,text,boolean) from public;
grant execute on function public.copy_worker_heartbeat(text,text,text,text,text,boolean) to service_role;

create or replace function public.claim_copy_order_intents(p_limit integer default 10)
returns table(intent_id uuid,user_id uuid,contract text,delta_size numeric,reduce_only boolean,
  gate_order_text text,idempotency_key text,api_key text,secret_key text,slippage_ratio numeric)
language plpgsql security definer set search_path=public,pg_temp
as $$
declare encryption_key text;
begin
  if coalesce(current_setting('request.jwt.claim.role',true),'')<>'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  if exists(select 1 from public.copy_system_control c where c.singleton and c.execution_enabled and not c.emergency_halted)
    and not exists(select 1 from private.copy_worker_runtime r where r.singleton and r.mode='LIVE' and r.gate_base_url='https://api.gateio.ws' and r.public_ip is not null and r.heartbeat_at>now()-interval '30 seconds') then
    update public.copy_system_control set emergency_halted=true,execution_enabled=false,halt_reason='STALE_OR_INVALID_WORKER',updated_at=now() where singleton;
  end if;
  if not exists(select 1 from public.copy_system_control c where c.singleton and c.execution_enabled and not c.emergency_halted) then return; end if;
  select decrypted_secret into encryption_key from vault.decrypted_secrets where name='gate_api_credentials_key';
  return query with claimable as (
    select i.id from private.copy_order_intents i
    join public.copy_position_states s on s.trading_account_id=i.trading_account_id and s.contract=i.contract
    where i.status in('PLANNED','QUEUED') and i.next_attempt_at<=now() and s.state in('DRIFT','REDUCE_ONLY')
    order by i.created_at for update of i skip locked limit greatest(1,least(coalesce(p_limit,10),50))
  ),claimed as (
    update private.copy_order_intents i set status='SUBMITTING',submit_attempts=i.submit_attempts+1,updated_at=now()
    from claimable where i.id=claimable.id returning i.*
  ) select c.id,c.user_id,c.contract,c.delta_size,c.reduce_only,c.gate_order_text,c.idempotency_key,
    pgp_sym_decrypt(g.api_key_ciphertext,encryption_key),pgp_sym_decrypt(g.secret_key_ciphertext,encryption_key),control.max_order_slippage_ratio
  from claimed c join private.trading_accounts a on a.id=c.trading_account_id
    join private.gate_api_credentials g on g.user_id=a.credential_user_id
    cross join public.copy_system_control control cross join private.copy_worker_runtime runtime
  where a.status='ACTIVE' and g.status='VERIFIED' and g.verification_version>=2 and g.futures_trade
    and g.verified_worker_ip=runtime.public_ip and runtime.singleton and control.singleton;
end;
$$;
revoke all on function public.claim_copy_order_intents(integer) from public;
grant execute on function public.claim_copy_order_intents(integer) to service_role;

create or replace function public.claim_copy_reconciliation_jobs(p_limit integer default 10)
returns table(job_id bigint,intent_id uuid,contract text,gate_order_id text,gate_order_text text,api_key text,secret_key text)
language plpgsql security definer set search_path=public,pg_temp
as $$
declare encryption_key text;
begin
  if coalesce(current_setting('request.jwt.claim.role',true),'')<>'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  insert into private.copy_reconciliation_jobs(intent_id,run_after,claimed_at,updated_at)
  select i.id,now(),null,now() from private.copy_order_intents i
  where i.status='SUBMITTING' and i.updated_at<now()-interval '30 seconds'
  on conflict(intent_id) do nothing;
  select decrypted_secret into encryption_key from vault.decrypted_secrets where name='gate_api_credentials_key';
  return query with claimed as (
    select j.id from private.copy_reconciliation_jobs j where j.run_after<=now() and (j.claimed_at is null or j.claimed_at<now()-interval '1 minute')
    order by j.run_after for update skip locked limit greatest(1,least(coalesce(p_limit,10),50))
  ),updated as (
    update private.copy_reconciliation_jobs j set claimed_at=now(),attempts=j.attempts+1,updated_at=now() from claimed where j.id=claimed.id returning j.*
  ) select u.id,i.id,i.contract,i.gate_order_id,i.gate_order_text,pgp_sym_decrypt(g.api_key_ciphertext,encryption_key),pgp_sym_decrypt(g.secret_key_ciphertext,encryption_key)
  from updated u join private.copy_order_intents i on i.id=u.intent_id
    join private.trading_accounts a on a.id=i.trading_account_id
    join private.gate_api_credentials g on g.user_id=a.credential_user_id;
end;
$$;
revoke all on function public.claim_copy_reconciliation_jobs(integer) from public;
grant execute on function public.claim_copy_reconciliation_jobs(integer) to service_role;

create or replace function public.set_copy_live_activation(p_enable boolean,p_confirmation text,p_reason text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp
as $$
declare result public.copy_system_control;
begin
  if coalesce(current_setting('request.jwt.claim.role',true),'')<>'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  if p_enable then
    if p_confirmation<>'ENABLE_LIVE_COPY_TRADING' then raise exception 'LIVE_CONFIRMATION_REQUIRED'; end if;
    if not exists(select 1 from private.copy_worker_runtime r where r.singleton and r.mode='LIVE' and r.gate_base_url='https://api.gateio.ws' and r.public_ip is not null and r.heartbeat_at>now()-interval '30 seconds' and r.last_test_passed_at>now()-interval '7 days') then raise exception 'WORKER_READINESS_REQUIRED'; end if;
    if not exists(select 1 from private.trading_accounts a join private.gate_api_credentials g on g.user_id=a.credential_user_id cross join private.copy_worker_runtime r where r.singleton and a.account_role='MASTER' and a.status='ACTIVE' and g.status='VERIFIED' and g.verification_version>=2 and g.verified_worker_ip=r.public_ip) then raise exception 'VERIFIED_MASTER_REQUIRED'; end if;
    if not exists(select 1 from private.trading_accounts a join private.gate_api_credentials g on g.user_id=a.credential_user_id cross join private.copy_worker_runtime r where r.singleton and a.account_role='MEMBER' and a.status='ACTIVE' and g.status='VERIFIED' and g.verification_version>=2 and g.verified_worker_ip=r.public_ip) then raise exception 'VERIFIED_MEMBER_REQUIRED'; end if;
  end if;
  update public.copy_system_control set execution_enabled=p_enable,emergency_halted=not p_enable,
    halt_reason=case when p_enable then 'LIVE_EXECUTION_ENABLED' else left(coalesce(nullif(trim(p_reason),''),'DEPLOYMENT_HALT'),160) end,updated_at=now()
  where singleton returning * into result;
  insert into public.admin_audit_logs(action,next_value) values(case when p_enable then 'LIVE_COPY_ENABLED' else 'LIVE_COPY_HALTED' end,jsonb_build_object('reason',p_reason,'execution_enabled',p_enable));
  return to_jsonb(result);
end;
$$;
revoke all on function public.set_copy_live_activation(boolean,text,text) from public;
grant execute on function public.set_copy_live_activation(boolean,text,text) to service_role;
