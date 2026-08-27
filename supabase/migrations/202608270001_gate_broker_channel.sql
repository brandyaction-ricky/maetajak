-- Gate API Broker attribution must be present before DRY_RUN can be marked ready or LIVE can start.
alter table public.copy_system_control
  add column if not exists broker_channel_id text not null default 'maetajak';

alter table public.copy_system_control drop constraint if exists copy_system_control_broker_channel_id_check;
alter table public.copy_system_control add constraint copy_system_control_broker_channel_id_check
  check (broker_channel_id ~ '^[a-z0-9]{1,19}$');

alter table private.copy_worker_runtime
  add column if not exists broker_channel_id text;

alter table private.copy_worker_runtime drop constraint if exists copy_worker_runtime_broker_channel_id_check;
alter table private.copy_worker_runtime add constraint copy_worker_runtime_broker_channel_id_check
  check (broker_channel_id is null or broker_channel_id ~ '^[a-z0-9]{1,19}$');

drop function if exists public.copy_worker_heartbeat(text,text,text,text,text,boolean);
create function public.copy_worker_heartbeat(
  p_worker_id text,
  p_worker_version text,
  p_gate_base_url text,
  p_public_ip text default null,
  p_broker_channel_id text default null,
  p_mode text default 'OBSERVE',
  p_test_passed boolean default false
)
returns jsonb language plpgsql security definer set search_path=public,pg_temp
as $$
declare runtime private.copy_worker_runtime;
declare expected_channel_id text;
declare supplied_channel_id text := nullif(trim(p_broker_channel_id),'');
begin
  if coalesce(current_setting('request.jwt.claim.role',true),'')<>'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  if p_mode not in ('OBSERVE','DRY_RUN','LIVE') then raise exception 'INVALID_WORKER_MODE'; end if;
  if p_test_passed and p_mode<>'DRY_RUN' then raise exception 'DRY_RUN_REQUIRED_FOR_READINESS'; end if;
  select broker_channel_id into expected_channel_id from public.copy_system_control where singleton;
  if supplied_channel_id is not null and supplied_channel_id !~ '^[a-z0-9]{1,19}$' then raise exception 'INVALID_BROKER_CHANNEL_ID'; end if;
  if supplied_channel_id is not null and supplied_channel_id is distinct from expected_channel_id then raise exception 'BROKER_CHANNEL_ID_MISMATCH'; end if;
  if p_mode in ('DRY_RUN','LIVE') and supplied_channel_id is null then raise exception 'BROKER_CHANNEL_ID_REQUIRED'; end if;
  if p_mode='LIVE' and (nullif(trim(p_public_ip),'') is null or p_gate_base_url<>'https://api.gateio.ws') then raise exception 'LIVE_WORKER_CONFIGURATION_REQUIRED'; end if;
  if exists(select 1 from private.copy_worker_runtime r where r.singleton and r.worker_id is distinct from p_worker_id and r.heartbeat_at>now()-interval '30 seconds') then raise exception 'WORKER_LEASE_HELD'; end if;
  insert into private.copy_worker_runtime(singleton,worker_id,worker_version,gate_base_url,public_ip,broker_channel_id,mode,heartbeat_at,last_test_passed_at,started_at,updated_at)
  values(true,left(p_worker_id,120),left(p_worker_version,80),left(p_gate_base_url,200),nullif(trim(p_public_ip),'')::inet,supplied_channel_id,p_mode,now(),case when p_test_passed then now() end,now(),now())
  on conflict(singleton) do update set worker_id=excluded.worker_id,worker_version=excluded.worker_version,
    gate_base_url=excluded.gate_base_url,public_ip=excluded.public_ip,broker_channel_id=excluded.broker_channel_id,mode=excluded.mode,heartbeat_at=now(),
    last_test_passed_at=case when p_test_passed then now() else private.copy_worker_runtime.last_test_passed_at end,
    started_at=coalesce(private.copy_worker_runtime.started_at,now()),updated_at=now()
  returning * into runtime;
  return jsonb_build_object('mode',runtime.mode,'broker_channel_id',runtime.broker_channel_id,'heartbeat_at',runtime.heartbeat_at,'test_passed_at',runtime.last_test_passed_at);
end;
$$;
revoke all on function public.copy_worker_heartbeat(text,text,text,text,text,text,boolean) from public;
grant execute on function public.copy_worker_heartbeat(text,text,text,text,text,text,boolean) to service_role;

-- Never release OBSERVE/DRY_RUN or pre-activation intents after LIVE is enabled.
create or replace function public.claim_copy_order_intents(p_limit integer default 10)
returns table(intent_id uuid,user_id uuid,contract text,delta_size numeric,reduce_only boolean,
  gate_order_text text,idempotency_key text,api_key text,secret_key text,slippage_ratio numeric)
language plpgsql security definer set search_path=public,pg_temp
as $$
declare encryption_key text;
begin
  if coalesce(current_setting('request.jwt.claim.role',true),'')<>'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  if exists(select 1 from public.copy_system_control c where c.singleton and c.execution_enabled and not c.emergency_halted)
    and not exists(select 1 from private.copy_worker_runtime r cross join public.copy_system_control c where r.singleton and c.singleton and r.mode='LIVE' and r.gate_base_url='https://api.gateio.ws' and r.public_ip is not null and r.broker_channel_id=c.broker_channel_id and r.heartbeat_at>now()-interval '30 seconds') then
    update public.copy_system_control set emergency_halted=true,execution_enabled=false,halt_reason='STALE_OR_INVALID_WORKER',updated_at=now() where singleton;
  end if;
  if not exists(select 1 from public.copy_system_control c where c.singleton and c.execution_enabled and not c.emergency_halted) then return; end if;
  select decrypted_secret into encryption_key from vault.decrypted_secrets where name='gate_api_credentials_key';
  return query with claimable as (
    select i.id from private.copy_order_intents i
    join public.copy_position_states s on s.trading_account_id=i.trading_account_id and s.contract=i.contract
    cross join public.copy_system_control control
    cross join private.copy_worker_runtime runtime
    where control.singleton and runtime.singleton and control.execution_enabled and not control.emergency_halted
      and runtime.mode='LIVE' and runtime.broker_channel_id=control.broker_channel_id
      and i.created_at>=control.updated_at
      and i.status in('PLANNED','QUEUED') and i.next_attempt_at<=now() and s.state in('DRIFT','REDUCE_ONLY')
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
    and g.verified_worker_ip=runtime.public_ip and runtime.singleton and runtime.broker_channel_id=control.broker_channel_id and control.singleton;
end;
$$;
revoke all on function public.claim_copy_order_intents(integer) from public;
grant execute on function public.claim_copy_order_intents(integer) to service_role;

create or replace function public.set_copy_live_activation(p_enable boolean,p_confirmation text,p_reason text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp
as $$
declare result public.copy_system_control;
begin
  if coalesce(current_setting('request.jwt.claim.role',true),'')<>'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
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
revoke all on function public.set_copy_live_activation(boolean,text,text) from public;
grant execute on function public.set_copy_live_activation(boolean,text,text) to service_role;

create or replace function public.get_copy_system_status()
returns jsonb language plpgsql stable security definer set search_path=public,pg_temp
as $$
declare result jsonb;
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED'; end if;
  select jsonb_build_object('execution_enabled',c.execution_enabled,'emergency_halted',c.emergency_halted,'halt_reason',c.halt_reason,'updated_at',c.updated_at,
    'broker_channel_id',case when public.is_approved_admin() then c.broker_channel_id end,
    'worker',jsonb_build_object('mode',r.mode,'worker_version',r.worker_version,'public_ip',case when public.is_approved_admin() then host(r.public_ip) end,
      'broker_channel_id',case when public.is_approved_admin() then r.broker_channel_id end,
      'heartbeat_at',r.heartbeat_at,'test_passed_at',r.last_test_passed_at,'healthy',coalesce(r.heartbeat_at>now()-interval '30 seconds',false),
      'consecutive_failures',r.consecutive_failures,'last_success_at',r.last_success_at,'last_error_code',r.last_error_code))
  into result from public.copy_system_control c left join private.copy_worker_runtime r on r.singleton where c.singleton;
  return result;
end;
$$;
revoke all on function public.get_copy_system_status() from public;
grant execute on function public.get_copy_system_status() to authenticated;
