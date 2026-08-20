-- Operational controls required before live copy trading.

alter table private.copy_worker_runtime
  add column if not exists consecutive_failures integer not null default 0,
  add column if not exists last_success_at timestamptz,
  add column if not exists last_error_code text;

create or replace function public.report_copy_worker_cycle(p_success boolean, p_error_code text default null)
returns jsonb language plpgsql security definer set search_path=public,pg_temp
as $$
declare runtime private.copy_worker_runtime;
begin
  if coalesce(current_setting('request.jwt.claim.role',true),'')<>'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
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
revoke all on function public.report_copy_worker_cycle(boolean,text) from public;
grant execute on function public.report_copy_worker_cycle(boolean,text) to service_role;

create or replace function public.set_member_copy_control(p_user_id uuid,p_mode text,p_reason text default null)
returns jsonb language plpgsql security definer set search_path=public,pg_temp
as $$
declare target public.profiles;
begin
  if not public.is_approved_admin() then raise exception 'ADMIN_REQUIRED'; end if;
  if p_mode not in ('PAUSE','REDUCE_ONLY','HALT','RESUME') then raise exception 'INVALID_CONTROL_MODE'; end if;
  update public.profiles set
    copy_paused=p_mode in ('PAUSE','HALT'),
    member_halted=p_mode='HALT',
    reduce_only=p_mode='REDUCE_ONLY',
    close_positions_requested=false,
    updated_at=now()
  where id=p_user_id and role='MEMBER' returning * into target;
  if target.id is null then raise exception 'MEMBER_NOT_FOUND'; end if;
  update public.copy_position_states set
    state=case when p_mode='HALT' then 'HALTED' when p_mode='PAUSE' then 'PAUSED' when p_mode='REDUCE_ONLY' then 'REDUCE_ONLY' else 'DRIFT' end,
    pause_reason=case when p_mode='RESUME' then null else left(coalesce(nullif(trim(p_reason),''),'ADMIN_'||p_mode),160) end,
    manual_override_confirmed_at=case when p_mode='RESUME' then null else manual_override_confirmed_at end,
    updated_at=now()
  where user_id=p_user_id;
  insert into public.copy_events(user_id,event_type,severity,safe_payload)
  values(p_user_id,case when p_mode='HALT' then 'MEMBER_HALTED' when p_mode='REDUCE_ONLY' then 'RISK_REDUCE_ONLY' when p_mode='RESUME' then 'TARGET_POSITION_CALCULATED' else 'SYMBOL_PAUSED' end,
    case when p_mode in('HALT','REDUCE_ONLY') then 'WARNING' else 'INFO' end,jsonb_build_object('mode',p_mode,'reason',p_reason,'actor_id',auth.uid()));
  insert into public.admin_audit_logs(actor_id,action,target_user_id,next_value)
  values(auth.uid(),'MEMBER_COPY_CONTROL_UPDATED',p_user_id,jsonb_build_object('mode',p_mode,'reason',p_reason));
  return jsonb_build_object('user_id',p_user_id,'mode',p_mode);
end;
$$;
revoke all on function public.set_member_copy_control(uuid,text,text) from public;
grant execute on function public.set_member_copy_control(uuid,text,text) to authenticated;

create or replace function public.disable_my_gate_api_connection(p_confirmation text)
returns void language plpgsql security definer set search_path=public,pg_temp
as $$
declare encryption_key text;
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED'; end if;
  if p_confirmation<>'DISCONNECT_GATE_API' then raise exception 'CONFIRMATION_REQUIRED'; end if;
  select decrypted_secret into encryption_key from vault.decrypted_secrets where name='gate_api_credentials_key';
  update public.profiles set copy_paused=true,member_halted=true,updated_at=now() where id=auth.uid() and role='MEMBER';
  update private.trading_accounts set status='DISABLED',updated_at=now() where credential_user_id=auth.uid();
  delete from private.gate_api_verification_jobs where user_id=auth.uid();
  update private.gate_api_credentials set gate_uid='DISABLED',api_key_ciphertext=pgp_sym_encrypt(encode(gen_random_bytes(32),'hex'),encryption_key,'cipher-algo=aes256'),
    secret_key_ciphertext=pgp_sym_encrypt(encode(gen_random_bytes(32),'hex'),encryption_key,'cipher-algo=aes256'),api_key_last4='NONE',status='DISABLED',
    futures_read=false,futures_trade=false,ip_whitelisted=false,withdrawal_disabled=true,verified_at=null,updated_at=now() where user_id=auth.uid() and connection_role='MEMBER';
  insert into public.copy_events(user_id,event_type,severity,safe_payload) values(auth.uid(),'MEMBER_HALTED','WARNING',jsonb_build_object('reason','API_DISCONNECTED'));
end;
$$;
revoke all on function public.disable_my_gate_api_connection(text) from public;
grant execute on function public.disable_my_gate_api_connection(text) to authenticated;

create or replace function public.disable_admin_master_gate_api_connection(p_confirmation text)
returns void language plpgsql security definer set search_path=public,pg_temp
as $$
declare encryption_key text;
begin
  if not public.is_approved_admin() then raise exception 'ADMIN_REQUIRED'; end if;
  if p_confirmation<>'DISCONNECT_MASTER_GATE_API' then raise exception 'CONFIRMATION_REQUIRED'; end if;
  select decrypted_secret into encryption_key from vault.decrypted_secrets where name='gate_api_credentials_key';
  update public.copy_system_control set execution_enabled=false,emergency_halted=true,halt_reason='MASTER_API_DISCONNECTED',updated_by=auth.uid(),updated_at=now() where singleton;
  update private.trading_accounts set status='DISABLED',updated_at=now() where credential_user_id=auth.uid() and account_role='MASTER';
  delete from private.gate_api_verification_jobs where user_id=auth.uid();
  update private.gate_api_credentials set gate_uid='DISABLED',api_key_ciphertext=pgp_sym_encrypt(encode(gen_random_bytes(32),'hex'),encryption_key,'cipher-algo=aes256'),
    secret_key_ciphertext=pgp_sym_encrypt(encode(gen_random_bytes(32),'hex'),encryption_key,'cipher-algo=aes256'),api_key_last4='NONE',status='DISABLED',
    futures_read=false,futures_trade=false,ip_whitelisted=false,withdrawal_disabled=true,verified_at=null,updated_at=now() where user_id=auth.uid() and connection_role='MASTER';
  insert into public.admin_audit_logs(actor_id,action,target_user_id,next_value)
  values(auth.uid(),'MASTER_GATE_API_DISCONNECTED',auth.uid(),jsonb_build_object('execution_enabled',false,'reason','MASTER_API_DISCONNECTED'));
end;
$$;
revoke all on function public.disable_admin_master_gate_api_connection(text) from public;
grant execute on function public.disable_admin_master_gate_api_connection(text) to authenticated;

create or replace function public.get_admin_operational_events(p_limit integer default 100)
returns jsonb language sql stable security definer set search_path=public,pg_temp
as $$
  select case when public.is_approved_admin() then coalesce(jsonb_agg(jsonb_build_object(
    'id',e.id,'name',p.full_name,'email',p.email,'contract',e.contract,'type',e.event_type,
    'severity',e.severity,'payload',e.safe_payload,'occurred_at',e.occurred_at) order by e.occurred_at desc),'[]'::jsonb) else '[]'::jsonb end
  from (select * from public.copy_events order by occurred_at desc limit greatest(1,least(coalesce(p_limit,100),500))) e
  left join public.profiles p on p.id=e.user_id;
$$;
revoke all on function public.get_admin_operational_events(integer) from public;
grant execute on function public.get_admin_operational_events(integer) to authenticated;

create or replace function public.get_admin_audit_log(p_limit integer default 100)
returns jsonb language sql stable security definer set search_path=public,pg_temp
as $$
  select case when public.is_approved_admin() then coalesce(jsonb_agg(jsonb_build_object(
    'id',l.id,'actor_name',a.full_name,'actor_email',a.email,'action',l.action,'target_name',t.full_name,'target_email',t.email,
    'previous_value',l.previous_value,'next_value',l.next_value,'created_at',l.created_at) order by l.created_at desc),'[]'::jsonb) else '[]'::jsonb end
  from (select * from public.admin_audit_logs order by created_at desc limit greatest(1,least(coalesce(p_limit,100),500))) l
  left join public.profiles a on a.id=l.actor_id left join public.profiles t on t.id=l.target_user_id;
$$;
revoke all on function public.get_admin_audit_log(integer) from public;
grant execute on function public.get_admin_audit_log(integer) to authenticated;

create or replace function public.get_copy_system_status()
returns jsonb language plpgsql stable security definer set search_path=public,pg_temp
as $$
declare result jsonb;
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED'; end if;
  select jsonb_build_object('execution_enabled',c.execution_enabled,'emergency_halted',c.emergency_halted,'halt_reason',c.halt_reason,'updated_at',c.updated_at,
    'worker',jsonb_build_object('mode',r.mode,'worker_version',r.worker_version,'public_ip',case when public.is_approved_admin() then host(r.public_ip) end,
      'heartbeat_at',r.heartbeat_at,'test_passed_at',r.last_test_passed_at,'healthy',coalesce(r.heartbeat_at>now()-interval '30 seconds',false),
      'consecutive_failures',r.consecutive_failures,'last_success_at',r.last_success_at,'last_error_code',r.last_error_code))
  into result from public.copy_system_control c left join private.copy_worker_runtime r on r.singleton where c.singleton;
  return result;
end;
$$;
revoke all on function public.get_copy_system_status() from public;
grant execute on function public.get_copy_system_status() to authenticated;
