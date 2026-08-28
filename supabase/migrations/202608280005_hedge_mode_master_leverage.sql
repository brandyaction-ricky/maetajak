-- Copy each hedge-mode leg independently and inherit the Master's leverage.

alter table private.copy_position_snapshots add column if not exists position_side text;
update private.copy_position_snapshots
set position_side = case when size < 0 then 'SHORT' else 'LONG' end
where position_side is null;
alter table private.copy_position_snapshots alter column position_side set not null;
alter table private.copy_position_snapshots alter column position_side set default 'LONG';
alter table private.copy_position_snapshots drop constraint if exists copy_position_snapshots_account_snapshot_id_contract_key;
alter table private.copy_position_snapshots drop constraint if exists copy_position_snapshots_account_snapshot_id_contract_position_side_key;
alter table private.copy_position_snapshots drop constraint if exists copy_position_snapshots_account_contract_side_key;
alter table private.copy_position_snapshots add constraint copy_position_snapshots_account_contract_side_key
  unique(account_snapshot_id, contract, position_side);
create index if not exists copy_position_snapshots_leg_latest_idx
  on private.copy_position_snapshots(trading_account_id, contract, position_side, observed_at desc);

alter table public.copy_position_states add column if not exists position_side text;
alter table public.copy_position_states add column if not exists target_leverage numeric;
alter table public.copy_position_states add column if not exists margin_mode text;
alter table public.copy_position_states add column if not exists position_mode text;
update public.copy_position_states
set position_side = case when coalesce(actual_size, target_size, 0) < 0 then 'SHORT' else 'LONG' end
where position_side is null;
update public.copy_position_states
set state='SYNCED',manual_override_confirmed_at=null,pause_reason=null,updated_at=now()
where state='MANUAL_OVERRIDE' and actual_size=0 and target_size=0;
alter table public.copy_position_states alter column position_side set not null;
alter table public.copy_position_states alter column position_side set default 'LONG';
alter table public.copy_position_states drop constraint if exists copy_position_states_trading_account_id_contract_key;
alter table public.copy_position_states drop constraint if exists copy_position_states_trading_account_id_contract_position_side_key;
alter table public.copy_position_states drop constraint if exists copy_position_states_account_contract_side_key;
alter table public.copy_position_states add constraint copy_position_states_account_contract_side_key
  unique(trading_account_id, contract, position_side);
alter table public.copy_position_states drop constraint if exists copy_position_states_position_side_check;
alter table public.copy_position_states add constraint copy_position_states_position_side_check
  check(position_side in ('LONG','SHORT'));

alter table public.copy_events add column if not exists position_side text;
alter table public.copy_events drop constraint if exists copy_events_position_side_check;
alter table public.copy_events add constraint copy_events_position_side_check
  check(position_side is null or position_side in ('LONG','SHORT'));

alter table private.copy_order_intents add column if not exists position_side text;
alter table private.copy_order_intents add column if not exists target_leverage numeric;
alter table private.copy_order_intents add column if not exists margin_mode text;
alter table private.copy_order_intents add column if not exists position_mode text;
alter table private.copy_order_intents add column if not exists pid text;
update private.copy_order_intents
set position_side = case when coalesce(target_size, delta_size, 0) < 0 then 'SHORT' else 'LONG' end
where position_side is null;
alter table private.copy_order_intents alter column position_side set not null;
alter table private.copy_order_intents alter column position_side set default 'LONG';
alter table private.copy_order_intents drop constraint if exists copy_order_intents_cycle_id_trading_account_id_contract_key;
alter table private.copy_order_intents drop constraint if exists copy_order_intents_cycle_id_trading_account_id_contract_position_side_key;
alter table private.copy_order_intents drop constraint if exists copy_order_intents_cycle_account_contract_side_key;
alter table private.copy_order_intents add constraint copy_order_intents_cycle_account_contract_side_key
  unique(cycle_id, trading_account_id, contract, position_side);
alter table private.copy_order_intents drop constraint if exists copy_order_intents_position_side_check;
alter table private.copy_order_intents add constraint copy_order_intents_position_side_check
  check(position_side in ('LONG','SHORT'));

create or replace function public.get_or_initialize_member_copy_baseline(
  p_trading_account_id uuid,
  p_master_positions jsonb
)
returns jsonb language plpgsql security definer set search_path=public,extensions,pg_temp
as $$
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
$$;
revoke all on function public.get_or_initialize_member_copy_baseline(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.get_or_initialize_member_copy_baseline(uuid,jsonb) to service_role;

create or replace function public.clear_member_copy_baseline_legs(
  p_trading_account_id uuid,
  p_positions jsonb
)
returns jsonb language plpgsql security definer set search_path=public,pg_temp
as $$
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
$$;
revoke all on function public.clear_member_copy_baseline_legs(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.clear_member_copy_baseline_legs(uuid,jsonb) to service_role;

create or replace function public.get_copy_worker_context()
returns jsonb language plpgsql security definer set search_path=public,extensions,pg_temp
as $$
declare encryption_key text;
declare result jsonb;
begin
  select decrypted_secret into encryption_key from vault.decrypted_secrets where name='gate_api_credentials_key';
  if encryption_key is null then raise exception 'ENCRYPTION_KEY_NOT_CONFIGURED'; end if;
  select jsonb_build_object(
    'system',(select jsonb_build_object('execution_enabled',c.execution_enabled,'emergency_halted',c.emergency_halted,'halt_reason',c.halt_reason,'slippage_ratio',c.max_order_slippage_ratio) from public.copy_system_control c where c.singleton),
    'master',(select jsonb_build_object('trading_account_id',a.id,'user_id',a.user_id,'gate_uid',g.gate_uid,
      'api_key',pgp_sym_decrypt(g.api_key_ciphertext,encryption_key),'secret_key',pgp_sym_decrypt(g.secret_key_ciphertext,encryption_key))
      from private.trading_accounts a join private.gate_api_credentials g on g.user_id=a.credential_user_id
      where a.account_role='MASTER' and a.status='ACTIVE' and g.status='VERIFIED' and g.futures_read and not g.futures_trade
      order by a.updated_at desc limit 1),
    'members',coalesce((select jsonb_agg(jsonb_build_object(
      'trading_account_id',a.id,'user_id',a.user_id,'gate_uid',g.gate_uid,
      'api_key',pgp_sym_decrypt(g.api_key_ciphertext,encryption_key),'secret_key',pgp_sym_decrypt(g.secret_key_ciphertext,encryption_key),
      'copy_ratio',p.copy_ratio,'max_position_ratio',p.max_position_ratio,'copy_paused',p.copy_paused,
      'halted',p.member_halted,'reduce_only',p.reduce_only,'close_positions_requested',p.close_positions_requested,
      'daily_loss_limit_pct',p.daily_loss_limit_pct,'max_drawdown_pct',p.max_drawdown_pct,
      'day_start_equity',(select s.total_equity from private.copy_account_snapshots s where s.trading_account_id=a.id and s.observed_at>=date_trunc('day',now()) order by s.observed_at limit 1),
      'peak_equity',(select max(s.total_equity) from private.copy_account_snapshots s where s.trading_account_id=a.id),
      'previous_states',coalesce((select jsonb_agg(jsonb_build_object(
        'contract',s.contract,'position_side',s.position_side,'state',s.state,'actual_size',s.actual_size,
        'target_leverage',s.target_leverage,'margin_mode',s.margin_mode,'position_mode',s.position_mode,
        'last_observed_at',s.last_observed_at,
        'known_fill_delta',coalesce((select sum(i.filled_size) from private.copy_order_intents i
          where i.trading_account_id=a.id and i.contract=s.contract and i.position_side=s.position_side
            and i.updated_at>coalesce(s.last_observed_at,'-infinity'::timestamptz) and i.filled_size<>0),0),
        'has_unresolved_order',exists(select 1 from private.copy_order_intents i
          where i.trading_account_id=a.id and i.contract=s.contract and i.position_side=s.position_side
            and i.status in('SUBMITTING','ACKNOWLEDGED','PARTIALLY_FILLED','UNKNOWN'))
      ) order by s.contract,s.position_side) from public.copy_position_states s where s.trading_account_id=a.id),'[]'::jsonb)
    ) order by p.created_at) from private.trading_accounts a
      join private.gate_api_credentials g on g.user_id=a.credential_user_id join public.profiles p on p.id=a.user_id
      where a.account_role='MEMBER' and a.status='ACTIVE' and g.status='VERIFIED' and g.futures_read and g.futures_trade
        and p.role='MEMBER' and p.approval_status='APPROVED'),'[]'::jsonb)
  ) into result;
  return result;
end;
$$;
revoke all on function public.get_copy_worker_context() from public,anon,authenticated;
grant execute on function public.get_copy_worker_context() to service_role;

create or replace function public.record_copy_worker_cycle(p_payload jsonb)
returns uuid language plpgsql security definer set search_path=public,extensions,pg_temp
as $$
declare cycle_id uuid:=(p_payload->>'cycle_id')::uuid;
declare observed_at timestamptz:=coalesce((p_payload->>'observed_at')::timestamptz,now());
declare master jsonb:=p_payload->'master';
declare member jsonb;
declare position jsonb;
declare v_master_snapshot_id bigint;
declare member_snapshot_id bigint;
declare previous_state text;
declare intent_count integer:=0;
declare source_hash text:=encode(digest(p_payload::text,'sha256'),'hex');
declare side text;
begin
  if master is null or master->>'trading_account_id' is null then raise exception 'MASTER_REQUIRED'; end if;
  insert into private.copy_cycles(id,master_account_id,status,source_version,started_at)
  values(cycle_id,(master->>'trading_account_id')::uuid,'RECONCILING',left(p_payload->>'source_version',160),observed_at)
  on conflict(id) do nothing;
  insert into private.copy_account_snapshots(trading_account_id,total_equity,available_equity,unrealised_pnl,observed_at,source_hash)
  values((master->>'trading_account_id')::uuid,greatest(0,(master->>'total')::numeric),greatest(0,(master->>'available')::numeric),(master->>'unrealisedPnl')::numeric,observed_at,source_hash)
  returning id into v_master_snapshot_id;
  for position in select value from jsonb_array_elements(coalesce(master->'positions','[]'::jsonb)) loop
    if coalesce((position->>'markPrice')::numeric,0)>0 then
      side:=coalesce(nullif(position->>'positionSide',''),case when (position->>'size')::numeric<0 then 'SHORT' else 'LONG' end);
      insert into private.copy_position_snapshots(account_snapshot_id,trading_account_id,contract,position_side,size,mark_price,entry_price,leverage,quanto_multiplier,observed_at)
      values(v_master_snapshot_id,(master->>'trading_account_id')::uuid,position->>'contract',side,(position->>'size')::numeric,
        (position->>'markPrice')::numeric,nullif(position->>'entryPrice','')::numeric,nullif(position->>'leverage','')::numeric,
        coalesce(nullif(position->>'quanto_multiplier','')::numeric,1),observed_at);
    end if;
  end loop;
  update private.copy_cycles set master_snapshot_id=v_master_snapshot_id where id=cycle_id;

  for member in select value from jsonb_array_elements(coalesce(p_payload->'members','[]'::jsonb)) loop
    if member->>'error_code' is not null then
      insert into public.copy_events(user_id,event_type,severity,cycle_id,safe_payload)
      values((member->>'user_id')::uuid,'ERROR','CRITICAL',cycle_id,jsonb_build_object('code',left(member->>'error_code',80)));
      continue;
    end if;
    if member->>'risk_halt_reason' in('DAILY_LOSS_LIMIT','MAX_DRAWDOWN_LIMIT') then
      update public.profiles set member_halted=true,updated_at=now() where id=(member->>'user_id')::uuid;
    end if;
    insert into private.copy_account_snapshots(trading_account_id,total_equity,available_equity,unrealised_pnl,observed_at,source_hash)
    values((member->>'trading_account_id')::uuid,greatest(0,(member->>'total')::numeric),greatest(0,(member->>'available')::numeric),(member->>'unrealisedPnl')::numeric,observed_at,source_hash)
    returning id into member_snapshot_id;
    for position in select value from jsonb_array_elements(coalesce(member->'planned_positions','[]'::jsonb)) loop
      side:=coalesce(nullif(position->>'position_side',''),case when (position->>'size')::numeric<0 then 'SHORT' else 'LONG' end);
      select state into previous_state from public.copy_position_states
      where trading_account_id=(member->>'trading_account_id')::uuid and contract=position->>'contract' and position_side=side;
      insert into private.copy_position_snapshots(account_snapshot_id,trading_account_id,contract,position_side,size,mark_price,entry_price,leverage,quanto_multiplier,observed_at)
      values(member_snapshot_id,(member->>'trading_account_id')::uuid,position->>'contract',side,(position->>'size')::numeric,
        (position->>'mark_price')::numeric,nullif(position->>'entry_price','')::numeric,nullif(position->>'leverage','')::numeric,
        (position->>'quanto_multiplier')::numeric,observed_at);
      insert into public.copy_position_states(user_id,trading_account_id,contract,position_side,state,target_size,actual_size,delta_size,
        previous_actual_size,unexplained_delta,copy_ratio,max_position_ratio,drift_tolerance_size,pause_reason,
        manual_override_confirmed_at,last_cycle_id,last_observed_at,target_leverage,margin_mode,position_mode,updated_at)
      values((member->>'user_id')::uuid,(member->>'trading_account_id')::uuid,position->>'contract',side,position->>'state',
        (position->>'target_size')::numeric,(position->>'size')::numeric,(position->>'delta_size')::numeric,
        nullif(position->>'previous_actual_size','')::numeric,coalesce((position->>'unexplained_delta')::numeric,0),
        (member->>'copy_ratio')::numeric,(member->>'max_position_ratio')::numeric,1,nullif(position->>'pause_reason',''),
        case when position->>'state'='MANUAL_OVERRIDE' then now() end,cycle_id,observed_at,
        nullif(position->>'target_leverage','')::numeric,nullif(position->>'margin_mode',''),nullif(position->>'position_mode',''),now())
      on conflict(trading_account_id,contract,position_side) do update set
        state=excluded.state,target_size=excluded.target_size,actual_size=excluded.actual_size,delta_size=excluded.delta_size,
        previous_actual_size=excluded.previous_actual_size,unexplained_delta=excluded.unexplained_delta,copy_ratio=excluded.copy_ratio,
        max_position_ratio=excluded.max_position_ratio,pause_reason=excluded.pause_reason,
        manual_override_confirmed_at=coalesce(public.copy_position_states.manual_override_confirmed_at,excluded.manual_override_confirmed_at),
        last_cycle_id=excluded.last_cycle_id,last_observed_at=excluded.last_observed_at,target_leverage=excluded.target_leverage,
        margin_mode=excluded.margin_mode,position_mode=excluded.position_mode,updated_at=now();
      if previous_state is distinct from position->>'state' then
        insert into public.copy_events(user_id,contract,position_side,event_type,severity,cycle_id,safe_payload)
        values((member->>'user_id')::uuid,position->>'contract',side,
          case position->>'state' when 'MANUAL_OVERRIDE' then 'MANUAL_OVERRIDE_DETECTED' when 'SYNCED' then 'POSITION_SYNCED'
            when 'PAUSED' then 'SYMBOL_PAUSED' when 'REDUCE_ONLY' then 'RISK_REDUCE_ONLY' when 'HALTED' then 'MEMBER_HALTED'
            else 'TARGET_POSITION_CALCULATED' end,
          case when position->>'state' in('MANUAL_OVERRIDE','ERROR','HALTED') then 'CRITICAL'
            when position->>'state' in('DRIFT','PAUSED','REDUCE_ONLY') then 'WARNING' else 'INFO' end,
          cycle_id,jsonb_build_object('previous_state',previous_state,'state',position->>'state','position_side',side,
            'target_size',position->>'target_size','actual_size',position->>'size','target_leverage',position->>'target_leverage'));
      end if;
      if position->'intent' is not null then
        insert into private.copy_order_intents(cycle_id,user_id,trading_account_id,contract,position_side,target_size,actual_size_at_plan,
          delta_size,reduce_only,target_leverage,margin_mode,position_mode,pid,idempotency_key,gate_order_text,status)
        values(cycle_id,(member->>'user_id')::uuid,(member->>'trading_account_id')::uuid,position->>'contract',side,
          (position->>'target_size')::numeric,(position->>'size')::numeric,(position->'intent'->>'delta_size')::numeric,
          (position->'intent'->>'reduce_only')::boolean,nullif(position->'intent'->>'target_leverage','')::numeric,
          nullif(position->'intent'->>'margin_mode',''),nullif(position->'intent'->>'position_mode',''),nullif(position->'intent'->>'pid',''),
          position->'intent'->>'idempotency_key',position->'intent'->>'gate_order_text','PLANNED')
        on conflict(idempotency_key) do nothing;
        intent_count:=intent_count+1;
      end if;
    end loop;
  end loop;
  update private.copy_cycles set status=case when intent_count>0 then 'PLANNED' else 'COMPLETED' end,
    completed_at=case when intent_count=0 then now() end where id=cycle_id;
  return cycle_id;
end;
$$;
revoke all on function public.record_copy_worker_cycle(jsonb) from public,anon,authenticated;
grant execute on function public.record_copy_worker_cycle(jsonb) to service_role;

drop function if exists public.claim_copy_order_intents(integer);
create function public.claim_copy_order_intents(p_limit integer default 10)
returns table(intent_id uuid,user_id uuid,contract text,position_side text,delta_size numeric,reduce_only boolean,
  target_leverage numeric,margin_mode text,position_mode text,pid text,gate_order_text text,idempotency_key text,
  api_key text,secret_key text,slippage_ratio numeric)
language plpgsql security definer set search_path=public,extensions,pg_temp
as $$
declare encryption_key text;
begin
  if exists(select 1 from public.copy_system_control c where c.singleton and c.execution_enabled and not c.emergency_halted)
    and not exists(select 1 from private.copy_worker_runtime r cross join public.copy_system_control c
      where r.singleton and c.singleton and r.mode='LIVE' and r.gate_base_url='https://api.gateio.ws' and r.public_ip is not null
        and r.broker_channel_id=c.broker_channel_id and r.heartbeat_at>now()-interval '30 seconds') then
    update public.copy_system_control set emergency_halted=true,execution_enabled=false,halt_reason='STALE_OR_INVALID_WORKER',updated_at=now() where singleton;
  end if;
  if not exists(select 1 from public.copy_system_control where singleton and execution_enabled and not emergency_halted) then return; end if;
  select decrypted_secret into encryption_key from vault.decrypted_secrets where name='gate_api_credentials_key';
  return query with claimable as(
    select i.id from private.copy_order_intents i
    join public.copy_position_states s on s.trading_account_id=i.trading_account_id and s.contract=i.contract and s.position_side=i.position_side
    cross join public.copy_system_control control cross join private.copy_worker_runtime runtime
    where control.singleton and runtime.singleton and control.execution_enabled and not control.emergency_halted
      and runtime.mode='LIVE' and runtime.broker_channel_id=control.broker_channel_id and i.created_at>=control.updated_at
      and i.status in('PLANNED','QUEUED') and i.next_attempt_at<=now() and s.state in('DRIFT','REDUCE_ONLY')
    order by i.created_at for update of i skip locked limit greatest(1,least(coalesce(p_limit,10),50))
  ),claimed as(
    update private.copy_order_intents i set status='SUBMITTING',submit_attempts=i.submit_attempts+1,updated_at=now()
    from claimable where i.id=claimable.id returning i.*
  ) select c.id,c.user_id,c.contract,c.position_side,c.delta_size,c.reduce_only,c.target_leverage,c.margin_mode,c.position_mode,c.pid,
    c.gate_order_text,c.idempotency_key,pgp_sym_decrypt(g.api_key_ciphertext,encryption_key),pgp_sym_decrypt(g.secret_key_ciphertext,encryption_key),
    control.max_order_slippage_ratio
  from claimed c join private.trading_accounts a on a.id=c.trading_account_id
    join private.gate_api_credentials g on g.user_id=a.credential_user_id
    cross join public.copy_system_control control cross join private.copy_worker_runtime runtime
  where a.status='ACTIVE' and g.status='VERIFIED' and g.verification_version>=2 and g.futures_trade
    and g.verified_worker_ip=runtime.public_ip and runtime.singleton and runtime.broker_channel_id=control.broker_channel_id and control.singleton;
end;
$$;
revoke all on function public.claim_copy_order_intents(integer) from public,anon,authenticated;
grant execute on function public.claim_copy_order_intents(integer) to service_role;

create or replace function public.get_my_live_trading_data()
returns jsonb language plpgsql stable security definer set search_path=public,pg_temp
as $$
declare account_id uuid;
declare latest_snapshot_id bigint;
declare result jsonb;
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED'; end if;
  select id into account_id from private.trading_accounts where user_id=auth.uid() and account_role='MEMBER' order by updated_at desc limit 1;
  select id into latest_snapshot_id from private.copy_account_snapshots where trading_account_id=account_id order by observed_at desc limit 1;
  select jsonb_build_object(
    'account',(select jsonb_build_object('total_equity',s.total_equity,'available_equity',s.available_equity,
      'used_margin',greatest(0,s.total_equity-s.available_equity),'margin_usage_pct',case when s.total_equity>0 then greatest(0,s.total_equity-s.available_equity)*100/s.total_equity else 0 end,
      'unrealised_pnl',s.unrealised_pnl,'observed_at',s.observed_at) from private.copy_account_snapshots s where s.id=latest_snapshot_id),
    'open_positions',coalesce((select jsonb_agg(jsonb_build_object('contract',p.contract,'position_side',p.position_side,'size',p.size,
      'side',p.position_side,'entry_price',p.entry_price,'mark_price',p.mark_price,'leverage',p.leverage,
      'notional',abs(p.size*p.mark_price*p.quanto_multiplier),'margin',case when coalesce(p.leverage,0)>0 then abs(p.size*p.mark_price*p.quanto_multiplier)/p.leverage end,
      'unrealised_pnl',case when p.entry_price>0 then (p.mark_price-p.entry_price)*p.size*p.quanto_multiplier else 0 end,
      'roe',case when p.entry_price>0 and coalesce(p.leverage,0)>0 then (p.mark_price-p.entry_price)*sign(p.size)*p.leverage*100/p.entry_price end,
      'observed_at',p.observed_at) order by abs(p.size*p.mark_price*p.quanto_multiplier) desc)
      from private.copy_position_snapshots p where p.account_snapshot_id=latest_snapshot_id and p.size<>0),'[]'::jsonb),
    'positions',coalesce((select jsonb_agg(jsonb_build_object('contract',s.contract,'position_side',s.position_side,'state',s.state,
      'target_size',s.target_size,'actual_size',s.actual_size,'delta_size',s.delta_size,'target_leverage',s.target_leverage,
      'pause_reason',s.pause_reason,'observed_at',s.last_observed_at) order by s.contract,s.position_side)
      from public.copy_position_states s where s.user_id=auth.uid()),'[]'::jsonb),
    'events',coalesce((select jsonb_agg(jsonb_build_object('contract',e.contract,'position_side',e.position_side,'type',e.event_type,
      'severity',e.severity,'payload',e.safe_payload,'occurred_at',e.occurred_at) order by e.occurred_at desc)
      from (select * from public.copy_events where user_id=auth.uid() order by occurred_at desc limit 50)e),'[]'::jsonb)
  ) into result;
  return result;
end;
$$;
revoke all on function public.get_my_live_trading_data() from public;
grant execute on function public.get_my_live_trading_data() to authenticated;

create or replace function public.get_admin_live_trading_data()
returns jsonb language plpgsql stable security definer set search_path=public,pg_temp
as $$
declare result jsonb;
begin
  if not public.is_approved_admin() then raise exception 'ADMIN_REQUIRED'; end if;
  select jsonb_build_object(
    'master_positions',coalesce((select jsonb_agg(jsonb_build_object('contract',p.contract,'position_side',p.position_side,'size',p.size,
      'mark_price',p.mark_price,'entry_price',p.entry_price,'leverage',p.leverage,'observed_at',p.observed_at) order by p.contract,p.position_side)
      from private.copy_position_snapshots p join private.trading_accounts a on a.id=p.trading_account_id
      where a.account_role='MASTER' and p.account_snapshot_id=(select s.id from private.copy_account_snapshots s where s.trading_account_id=a.id order by s.observed_at desc limit 1)),'[]'::jsonb),
    'member_states',coalesce((select jsonb_agg(jsonb_build_object('name',p.full_name,'email',p.email,'contract',s.contract,
      'position_side',s.position_side,'state',s.state,'target_size',s.target_size,'actual_size',s.actual_size,'delta_size',s.delta_size,
      'target_leverage',s.target_leverage,'pause_reason',s.pause_reason,'observed_at',s.last_observed_at) order by s.updated_at desc)
      from public.copy_position_states s join public.profiles p on p.id=s.user_id),'[]'::jsonb),
    'orders',coalesce((select jsonb_agg(jsonb_build_object('name',p.full_name,'email',p.email,'contract',i.contract,
      'position_side',i.position_side,'delta_size',i.delta_size,'target_leverage',i.target_leverage,'filled_size',i.filled_size,
      'status',i.status,'gate_order_id',i.gate_order_id,'error_code',i.last_error_code,'created_at',i.created_at,'updated_at',i.updated_at)
      order by i.created_at desc) from (select * from private.copy_order_intents order by created_at desc limit 100)i
      join public.profiles p on p.id=i.user_id),'[]'::jsonb)
  ) into result;
  return result;
end;
$$;
revoke all on function public.get_admin_live_trading_data() from public;
grant execute on function public.get_admin_live_trading_data() to authenticated;

comment on column public.copy_position_states.position_side is 'Independent LONG or SHORT leg in Gate hedge mode.';
comment on column private.copy_order_intents.target_leverage is 'Master leverage applied before increasing this member position leg.';
