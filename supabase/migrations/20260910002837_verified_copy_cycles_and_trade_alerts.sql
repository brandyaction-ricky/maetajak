-- Apply only while halted. No operation in this migration enables copying.
do $$ begin
  if not exists(select 1 from public.copy_system_control where singleton and not execution_enabled and emergency_halted) then
    raise exception 'HALTED_DEPLOYMENT_REQUIRED';
  end if;
end $$;

alter table private.copy_order_intents add column plan_evidence jsonb not null default '{}'
  check (jsonb_typeof(plan_evidence)='object');

create table private.copy_current_verifications (
  trading_account_id uuid primary key references private.trading_accounts(id) on delete cascade,
  cycle_id uuid not null,
  observed_at timestamptz not null,
  verified_at timestamptz not null default clock_timestamp(),
  status text not null check(status in ('VERIFIED','ERROR')),
  error_code text,
  position_count integer not null default 0
);
alter table private.copy_current_verifications enable row level security;
revoke all on private.copy_current_verifications from public,anon,authenticated;
create index copy_account_inflight_guard_idx on private.copy_order_intents(trading_account_id,id)
  where status in ('SUBMITTING','ACKNOWLEDGED','UNKNOWN','PARTIALLY_FILLED')
    or (filled_size<>0 and observation_confirmed_at is null);

create function public.record_verified_copy_worker_cycle(p_payload jsonb)
returns uuid language plpgsql security definer set search_path=pg_catalog
as $$
#variable_conflict use_variable
declare
  cycle_id uuid := (p_payload->>'cycle_id')::uuid;
  observed_at timestamptz := (p_payload->>'observed_at')::timestamptz;
  current_state jsonb := p_payload->'current_state';
  account jsonb; member jsonb; source_account jsonb; position jsonb; account_id uuid; engine_size numeric;
begin
  perform private.require_copy_worker_role();
  perform pg_advisory_xact_lock(hashtextextended('maetajak:copy-execution',0));
  if cycle_id is null or observed_at is null or observed_at<clock_timestamp()-interval '15 seconds'
    or observed_at>clock_timestamp()+interval '1 second'
    or current_state is null or jsonb_typeof(current_state)<>'object'
    or (current_state->>'copy_event_id')::uuid is distinct from cycle_id
    or (current_state->>'observed_at')::timestamptz is distinct from observed_at
    or current_state->'master'->>'trading_account_id' is distinct from p_payload->'master'->>'trading_account_id'
    or jsonb_array_length(current_state->'members') is distinct from jsonb_array_length(p_payload->'members') then
    raise exception 'CURRENT_STATE_SNAPSHOT_INVALID';
  end if;
  for account in select value from jsonb_array_elements(
    jsonb_build_array(current_state->'master')||coalesce(current_state->'members','[]'))
  loop
    if account->>'error_code' is not null then continue; end if;
    if account->>'account_role'='MASTER' then source_account := p_payload->'master';
    else select value into source_account from jsonb_array_elements(p_payload->'members')
      where value->>'trading_account_id'=account->>'trading_account_id'; end if;
    if source_account is null or (source_account->>'total')::numeric is distinct from (account->>'total_equity')::numeric
      or (source_account->>'available')::numeric is distinct from (account->>'available_equity')::numeric then
      raise exception 'ENGINE_ACCOUNT_RECONCILIATION_MISMATCH'; end if;
    if exists(select 1 from jsonb_array_elements(account->'positions') p
      group by p->>'contract',p->>'position_side' having count(*)>1) then
      raise exception 'DUPLICATE_POSITION_OBSERVATION'; end if;
    if exists(
      with engine as (select p->>'contract' contract,
        coalesce(p->>'positionSide',p->>'position_side',case when (p->>'size')::numeric<0 then 'SHORT' else 'LONG' end) side,
        (p->>'size')::numeric size from jsonb_array_elements(source_account->'positions') p),
      expected as (select p->>'contract' contract,p->>'position_side' side,(p->>'size')::numeric size
        from jsonb_array_elements(account->'positions') p)
      select 1 from engine e full join expected c using(contract,side)
        where coalesce(e.size,0) is distinct from coalesce(c.size,0)
    ) then raise exception 'ENGINE_EXCHANGE_RECONCILIATION_MISMATCH'; end if;
    if exists(select 1 from private.copy_current_accounts c
      where c.trading_account_id=(account->>'trading_account_id')::uuid and c.observed_at>observed_at) then
      raise exception 'CURRENT_STATE_NEWER_OBSERVATION_EXISTS';
    end if;
  end loop;

  perform public.record_copy_worker_cycle_with_target_anchors(p_payload);
  perform public.upsert_copy_current_state(current_state);

  for account in select value from jsonb_array_elements(
    jsonb_build_array(current_state->'master')||coalesce(current_state->'members','[]'))
  loop
    account_id := (account->>'trading_account_id')::uuid;
    if account->>'error_code' is not null then
      insert into private.copy_current_verifications(trading_account_id,cycle_id,observed_at,status,error_code)
        values(account_id,cycle_id,observed_at,'ERROR',left(account->>'error_code',80))
        on conflict(trading_account_id) do update set cycle_id=excluded.cycle_id,observed_at=excluded.observed_at,
          status='ERROR',error_code=excluded.error_code,verified_at=clock_timestamp();
      continue;
    end if;
    if not exists(select 1 from private.copy_current_accounts c where c.trading_account_id=account_id
      and c.copy_cycle_id=cycle_id and c.observed_at=observed_at
      and c.total_equity=(account->>'total_equity')::numeric
      and c.available_equity=(account->>'available_equity')::numeric) then
      raise exception 'CURRENT_ACCOUNT_RECONCILIATION_MISMATCH';
    end if;
    if exists(
      with expected as (
        select p->>'contract' contract,p->>'position_side' side,(p->>'size')::numeric size
        from jsonb_array_elements(account->'positions') p
      ), actual as (
        select c.contract,c.position_side side,c.size from private.copy_current_positions c
        where c.trading_account_id=account_id
      )
      select 1 from expected e full join actual a using(contract,side)
      where coalesce(e.size,0) is distinct from coalesce(a.size,0)
    ) then raise exception 'CURRENT_POSITION_RECONCILIATION_MISMATCH'; end if;
    if account->>'account_role'='MEMBER' then
      select value into member from jsonb_array_elements(p_payload->'members')
        where (value->>'trading_account_id')::uuid=account_id;
      if member is null then raise exception 'MEMBER_OBSERVATION_MISSING'; end if;
      for position in select value from jsonb_array_elements(member->'planned_positions') loop
        select (p->>'size')::numeric into engine_size from jsonb_array_elements(account->'positions') p
          where p->>'contract'=position->>'contract' and p->>'position_side'=position->>'position_side';
        if coalesce(engine_size,0) is distinct from (position->>'size')::numeric
          or not exists(select 1 from public.copy_position_states s where s.trading_account_id=account_id
            and s.contract=position->>'contract' and s.position_side=position->>'position_side'
            and s.last_cycle_id=cycle_id and s.actual_size=(position->>'size')::numeric
            and s.target_size=(position->>'target_size')::numeric) then
          raise exception 'ENGINE_EXCHANGE_RECONCILIATION_MISMATCH';
        end if;
        update private.copy_order_intents i set plan_evidence=jsonb_build_object(
          'quanto_multiplier',(position->>'quanto_multiplier')::numeric,
          'master_size_at_plan',(position->>'master_actual_size')::numeric,
          'master_copyable_size',(position->>'master_copyable_size')::numeric,
          'reference_mark_price',(position->>'mark_price')::numeric,
          'sizing_reason',position->>'sizing_reason',
          'risk_leverage',(position->>'risk_leverage')::numeric,
          'taker_fee_rate',(position->>'taker_fee_rate')::numeric)
          where i.cycle_id=cycle_id and i.trading_account_id=account_id
            and i.contract=position->>'contract' and i.position_side=position->>'position_side';
      end loop;
    end if;
    insert into private.copy_current_verifications(trading_account_id,cycle_id,observed_at,status,position_count)
      values(account_id,cycle_id,observed_at,'VERIFIED',jsonb_array_length(account->'positions'))
      on conflict(trading_account_id) do update set cycle_id=excluded.cycle_id,observed_at=excluded.observed_at,
        status='VERIFIED',error_code=null,position_count=excluded.position_count,verified_at=clock_timestamp();
  end loop;
  return cycle_id;
end;
$$;
revoke all on function public.record_verified_copy_worker_cycle(jsonb) from public,anon,authenticated;
grant execute on function public.record_verified_copy_worker_cycle(jsonb) to service_role;

create function private.guard_verified_copy_submission()
returns trigger language plpgsql security definer set search_path=pg_catalog
as $$
begin
  if new.status<>'SUBMITTING' then return new; end if;
  perform pg_advisory_xact_lock(hashtextextended('maetajak:copy-execution',0));
  -- One account cannot spend the same available margin through concurrent
  -- workers or different symbols while a prior exchange outcome is unsettled.
  if exists(select 1 from private.copy_order_intents i where i.trading_account_id=new.trading_account_id and i.id<>new.id
    and (i.status in ('SUBMITTING','ACKNOWLEDGED','UNKNOWN')
      or (i.status='PARTIALLY_FILLED' and not i.exchange_terminal)
      or (i.resume_version=new.resume_version and i.filled_size<>0 and i.observation_confirmed_at is null))) then return null; end if;
  if not exists(select 1 from private.copy_current_verifications v
    join private.copy_current_accounts c on c.trading_account_id=v.trading_account_id
    where v.trading_account_id=new.trading_account_id and v.cycle_id=new.cycle_id and v.status='VERIFIED'
      and c.copy_cycle_id=v.cycle_id and c.observed_at=v.observed_at
      and v.observed_at>=clock_timestamp()-interval '15 seconds') then return null; end if;
  if not new.reduce_only and (coalesce((new.plan_evidence->>'master_copyable_size')::numeric,0)=0
    or sign(new.delta_size)<>sign((new.plan_evidence->>'master_copyable_size')::numeric)) then return null; end if;
  return new;
end;
$$;
revoke all on function private.guard_verified_copy_submission() from public,anon,authenticated;
create trigger guard_verified_copy_submission before insert or update of status on private.copy_order_intents
  for each row execute function private.guard_verified_copy_submission();

create function public.get_copy_state_reconciliation()
returns jsonb language plpgsql security definer set search_path=pg_catalog
as $$
begin
  perform private.require_copy_worker_role();
  return jsonb_build_object('checked_at',clock_timestamp(),'schema_version',3,
    'system',(select jsonb_build_object('execution_enabled',execution_enabled,'emergency_halted',emergency_halted,
      'halt_reason',halt_reason) from public.copy_system_control where singleton),
    'worker',(select jsonb_build_object('mode',mode,'worker_version',worker_version,'heartbeat_at',heartbeat_at,
      'last_success_at',last_success_at,'consecutive_failures',consecutive_failures) from private.copy_worker_runtime where singleton),
    'accounts',(select coalesce(jsonb_agg(jsonb_build_object('trading_account_id',a.id,'role',a.account_role,
      'status',case when v.trading_account_id is null then 'UNVERIFIED'
        when v.status='ERROR' then 'ERROR' when v.observed_at<clock_timestamp()-interval '15 seconds' then 'STALE'
        when c.copy_cycle_id is distinct from v.cycle_id or c.observed_at is distinct from v.observed_at then 'MISMATCH'
        when a.account_role='MEMBER' and exists(
          select 1 from public.copy_position_states s full join private.copy_current_positions cp
            on s.trading_account_id=cp.trading_account_id and s.contract=cp.contract and s.position_side=cp.position_side
          where coalesce(s.trading_account_id,cp.trading_account_id)=a.id
            and coalesce(s.actual_size,0) is distinct from coalesce(cp.size,0)) then 'MISMATCH'
        else 'VERIFIED' end,'cycle_id',v.cycle_id,'observed_at',v.observed_at,'error_code',v.error_code,
      'positions',(select coalesce(jsonb_agg(jsonb_build_object('contract',cp.contract,'position_side',cp.position_side,
        'size',cp.size,'target_size',cp.target_size,'engine_size',s.actual_size,'state',s.state)),'[]')
        from private.copy_current_positions cp left join public.copy_position_states s
          on s.trading_account_id=cp.trading_account_id and s.contract=cp.contract and s.position_side=cp.position_side
        where cp.trading_account_id=a.id))), '[]')
      from private.trading_accounts a left join private.copy_current_verifications v on v.trading_account_id=a.id
      left join private.copy_current_accounts c on c.trading_account_id=a.id where a.status='ACTIVE'),
    'unresolved_orders',(select count(*) from private.copy_order_intents where status in ('SUBMITTING','ACKNOWLEDGED','UNKNOWN')
      or (status='PARTIALLY_FILLED' and not exchange_terminal)),
    'pending_fill_observations',(select count(*) from private.copy_order_intents where filled_size<>0 and observation_confirmed_at is null),
    'pending_alerts',(select count(*) from private.copy_entry_alert_outbox where delivered_at is null));
end;
$$;
revoke all on function public.get_copy_state_reconciliation() from public,anon,authenticated;
grant execute on function public.get_copy_state_reconciliation() to service_role;

-- Matching worker generation; enriched server-only execution claims.
drop function public.claim_copy_order_intents(integer);
create or replace function public.claim_copy_order_intents(p_limit integer default 10)
returns table(intent_id uuid,user_id uuid,contract text,position_side text,delta_size numeric,
  reduce_only boolean,target_leverage numeric,margin_mode text,position_mode text,pid text,
  gate_order_text text,idempotency_key text,api_key text,secret_key text,slippage_ratio numeric,
  trading_account_id uuid,resume_version uuid,source_observed_at timestamptz,actual_size_at_plan numeric,target_size numeric,master_size_at_plan numeric,quanto_multiplier numeric,taker_fee_rate numeric,risk_leverage numeric)
language plpgsql security definer set search_path=pg_catalog,extensions
as $$
declare item private.copy_order_intents; claimed private.copy_order_intents; encryption_key text;
begin
  perform private.require_copy_worker_role();
  perform pg_advisory_xact_lock(hashtextextended('maetajak:copy-execution',0));
  if not exists(select 1 from public.copy_system_control c cross join private.copy_worker_runtime r
    where c.singleton and r.singleton and c.execution_enabled and not c.emergency_halted
      and r.mode='LIVE' and r.worker_version='0.5.0' and r.gate_base_url='https://api.gateio.ws'
      and r.public_ip is not null and r.broker_channel_id=c.broker_channel_id
      and r.heartbeat_at>now()-interval '30 seconds' and r.consecutive_failures=0) then return; end if;
  select decrypted_secret into encryption_key from vault.decrypted_secrets where name='gate_api_credentials_key';
  if encryption_key is null then raise exception 'ENCRYPTION_KEY_NOT_CONFIGURED'; end if;
  for item in select i.* from private.copy_order_intents i
    join private.copy_resume_sessions session on session.trading_account_id=i.trading_account_id and session.version=i.resume_version
    join public.copy_position_states s on s.trading_account_id=i.trading_account_id and s.contract=i.contract and s.position_side=i.position_side
    join private.trading_accounts a on a.id=i.trading_account_id
    join private.gate_api_credentials g on g.user_id=a.credential_user_id
    join public.profiles p on p.id=i.user_id
    cross join private.copy_worker_runtime r
    where r.singleton and session.state in ('ACTIVE','CLOSING') and a.status='ACTIVE' and g.status='VERIFIED'
      and g.verification_version>=2 and g.futures_read and g.futures_trade and g.verified_worker_ip=r.public_ip
      and p.approval_status='APPROVED' and (not p.copy_paused or (p.close_positions_requested and i.reduce_only and i.target_size=0)) and not p.member_halted
      and (not p.reduce_only or i.reduce_only)
      and i.status in ('PLANNED','QUEUED') and i.submit_attempts=0 and i.next_attempt_at<=now()
      and s.state in ('DRIFT','REDUCE_ONLY') and s.last_cycle_id=i.cycle_id
      and s.actual_size=i.actual_size_at_plan and s.target_size=i.target_size
      and i.source_observed_at>=clock_timestamp()-interval '15 seconds'
    order by i.created_at,i.id for update of i skip locked limit greatest(1,least(coalesce(p_limit,10),50))
  loop
    update private.copy_order_intents set status='SUBMITTING',submit_attempts=submit_attempts+1,submitted_at=now(),updated_at=now()
      where id=item.id returning * into claimed;
    if found then
      return query select claimed.id,claimed.user_id,claimed.contract,claimed.position_side,claimed.delta_size,
        claimed.reduce_only,claimed.target_leverage,claimed.margin_mode,claimed.position_mode,claimed.pid,
        claimed.gate_order_text,claimed.idempotency_key,
        extensions.pgp_sym_decrypt(g.api_key_ciphertext,encryption_key),
        extensions.pgp_sym_decrypt(g.secret_key_ciphertext,encryption_key),c.max_order_slippage_ratio,
        claimed.trading_account_id,claimed.resume_version,claimed.source_observed_at,claimed.actual_size_at_plan,claimed.target_size,
        (claimed.plan_evidence->>'master_size_at_plan')::numeric,(claimed.plan_evidence->>'quanto_multiplier')::numeric,
        (claimed.plan_evidence->>'taker_fee_rate')::numeric,(claimed.plan_evidence->>'risk_leverage')::numeric
      from private.trading_accounts a join private.gate_api_credentials g on g.user_id=a.credential_user_id
        cross join public.copy_system_control c where a.id=claimed.trading_account_id and c.singleton;
    end if;
  end loop;
end;
$$;
revoke all on function public.claim_copy_order_intents(integer) from public,anon,authenticated;
grant execute on function public.claim_copy_order_intents(integer) to service_role;

create or replace function public.authorize_copy_order_submission(p_intent_id uuid,p_version uuid)
returns boolean language plpgsql security definer set search_path=pg_catalog
as $$
declare permitted boolean;
begin
  perform private.require_copy_worker_role();
  perform pg_advisory_xact_lock(hashtextextended('maetajak:copy-execution',0));
  select exists(select 1 from private.copy_order_intents i
    join private.copy_resume_sessions s on s.trading_account_id=i.trading_account_id and s.version=i.resume_version
    join public.profiles p on p.id=i.user_id
    join private.trading_accounts a on a.id=i.trading_account_id
    join private.gate_api_credentials g on g.user_id=a.credential_user_id
    cross join public.copy_system_control c cross join private.copy_worker_runtime r
    where i.id=p_intent_id and i.resume_version=p_version and i.status='SUBMITTING' and i.submission_authorized_at is null and s.state in ('ACTIVE','CLOSING')
      and i.source_observed_at>=clock_timestamp()-interval '15 seconds'
      and p.approval_status='APPROVED' and (not p.copy_paused or (p.close_positions_requested and i.reduce_only and i.target_size=0)) and not p.member_halted
      and (not p.reduce_only or i.reduce_only) and a.status='ACTIVE' and g.status='VERIFIED' and g.futures_trade
      and g.verification_version>=2 and g.verified_worker_ip=r.public_ip
      and c.singleton and c.execution_enabled and not c.emergency_halted
      and r.singleton and r.mode='LIVE' and r.worker_version='0.5.0'
      and r.heartbeat_at>now()-interval '30 seconds' and r.consecutive_failures=0
      and exists(select 1 from private.copy_current_verifications v
        join private.copy_current_accounts ca on ca.trading_account_id=v.trading_account_id
        where v.trading_account_id=i.trading_account_id and v.cycle_id=i.cycle_id
          and v.status='VERIFIED' and ca.copy_cycle_id=v.cycle_id and ca.observed_at=v.observed_at)
      and exists(select 1 from public.copy_position_states ps where ps.trading_account_id=i.trading_account_id
        and ps.contract=i.contract and ps.position_side=i.position_side and ps.last_cycle_id=i.cycle_id
        and ps.actual_size=i.actual_size_at_plan and ps.target_size=i.target_size)
      and exists(select 1 from private.copy_current_positions cp where cp.trading_account_id=i.trading_account_id
        and cp.contract=i.contract and cp.position_side=i.position_side and cp.copy_cycle_id=i.cycle_id
        and cp.size=i.actual_size_at_plan and cp.target_size=i.target_size)) into permitted;
  if permitted then
    update private.copy_order_intents set submission_authorized_at=clock_timestamp() where id=p_intent_id;
  else
    update private.copy_order_intents set status='CANCELLED',exchange_terminal=true,resolved_at=now(),
      last_error_code='SUBMISSION_AUTHORIZATION_REVOKED',updated_at=now()
      where id=p_intent_id and status='SUBMITTING' and gate_order_id is null and submission_authorized_at is null;
  end if;
  return permitted;
end;
$$;
revoke all on function public.authorize_copy_order_submission(uuid,uuid) from public,anon,authenticated;
grant execute on function public.authorize_copy_order_submission(uuid,uuid) to service_role;

create or replace function public.activate_member_copy_resume(p_trading_account_id uuid,p_version uuid,p_snapshot jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog
as $$
declare s private.copy_resume_sessions; uid uuid; observed timestamptz;
begin
  perform private.require_copy_worker_role();
  perform pg_advisory_xact_lock(hashtextextended('maetajak:copy-execution',0));
  select * into s from private.copy_resume_sessions where trading_account_id=p_trading_account_id for update;
  if not found or s.version is distinct from p_version or s.state<>'VALIDATED' or s.expires_at<=clock_timestamp()
    then raise exception 'RESUME_VERSION_OR_STATE_CHANGED'; end if;
  if not exists(select 1 from public.copy_system_control c cross join private.copy_worker_runtime r
    where c.singleton and r.singleton and c.execution_enabled and not c.emergency_halted and r.mode='LIVE'
    and r.heartbeat_at>now()-interval '30 seconds' and r.consecutive_failures=0)
    then return jsonb_build_object('state','VALIDATED','reason','SYSTEM_NOT_LIVE'); end if;
  observed:=(p_snapshot->>'observed_at')::timestamptz;
  if observed is null or observed<s.snapshot_observed_at or observed>clock_timestamp()+interval '1 second'
    or s.snapshot_started_at<clock_timestamp()-interval '15 seconds'
    or (p_snapshot->'master_positions') is distinct from s.master_positions
    or (p_snapshot->'member_positions') is distinct from s.member_positions
    or coalesce((p_snapshot->>'open_order_count')::integer,-1)<>0
    or coalesce((p_snapshot->>'preview_passed')::boolean,false) is not true
    then raise exception 'RESUME_SNAPSHOT_CHANGED'; end if;
  select a.user_id into uid from private.trading_accounts a join private.gate_api_credentials g on g.user_id=a.credential_user_id
    cross join private.copy_worker_runtime r
    where a.id=p_trading_account_id and a.status='ACTIVE' and g.status='VERIFIED' and g.futures_read and g.futures_trade
      and g.verification_version>=2 and g.verified_worker_ip=r.public_ip and r.singleton;
  if uid is null or not exists(select 1 from public.profiles where id=uid and role='MEMBER'
    and approval_status='APPROVED' and copy_paused and not member_halted and not close_positions_requested)
    or private.copy_resume_settings(uid) is distinct from s.settings then raise exception 'RESUME_MEMBER_NOT_ELIGIBLE'; end if;
  if exists(select 1 from private.copy_order_intents where trading_account_id=p_trading_account_id
    and status in ('SUBMITTING','ACKNOWLEDGED','PARTIALLY_FILLED','UNKNOWN') and not exchange_terminal)
    then raise exception 'RESUME_UNRESOLVED_ORDERS'; end if;
  update private.copy_resume_sessions set state='ACTIVE',activated_at=clock_timestamp(),blocker_reason=null,updated_at=now()
    where trading_account_id=p_trading_account_id;
  update public.profiles set copy_paused=false,reduce_only=false,updated_at=now() where id=uid;
  update public.copy_position_states set state='PAUSED',pause_reason='RESUME_BASELINE_REPLACED',
    manual_override_confirmed_at=null,last_observed_at=null,updated_at=now() where trading_account_id=p_trading_account_id;
  insert into public.copy_events(user_id,event_type,severity,safe_payload)
    values(uid,'TARGET_POSITION_CALCULATED','INFO',jsonb_build_object('reason','RESUME_VALIDATED','version',p_version));
  return jsonb_build_object('state','ACTIVE','version',p_version);
end;
$$;
revoke all on function public.activate_member_copy_resume(uuid,uuid,jsonb) from public, anon, authenticated;
grant execute on function public.activate_member_copy_resume(uuid,uuid,jsonb) to service_role;

create or replace function public.complete_copy_order_attempt(p_intent_id uuid,p_result_status text,
  p_gate_order_id text default null,p_filled_size numeric default 0,p_average_fill_price numeric default null,
  p_http_status integer default null,p_gate_label text default null,p_error_code text default null,p_safe_response jsonb default '{}')
returns void language plpgsql security definer set search_path=pg_catalog
as $$
declare target private.copy_order_intents; terminal boolean;
begin
  perform private.require_copy_worker_role();
  perform pg_advisory_xact_lock(hashtextextended('maetajak:copy-execution',0));
  select * into target from private.copy_order_intents where id=p_intent_id for update;
  if not found then raise exception 'INTENT_NOT_FOUND'; end if;
  if p_result_status is null or p_result_status not in ('ACKNOWLEDGED','PARTIALLY_FILLED','FILLED','CANCELLED','REJECTED','UNKNOWN')
    then raise exception 'INVALID_ORDER_RESULT'; end if;
  if p_filled_size is null or abs(p_filled_size)>abs(target.delta_size)
    or (p_filled_size<>0 and sign(p_filled_size)<>sign(target.delta_size))
    or coalesce(p_error_code,'') like '%ORDER_QUANTITY_MISMATCH%'
    or coalesce(p_error_code,'') like '%ORDER_IDENTITY_MISMATCH%' then
    update public.copy_system_control set execution_enabled=false,emergency_halted=true,
      halt_reason='ORDER_QUANTITY_MISMATCH',updated_at=now() where singleton;
    insert into public.copy_events(user_id,contract,event_type,severity,cycle_id,safe_payload)
      values(target.user_id,target.contract,'SYSTEM_HALTED','CRITICAL',target.cycle_id,
        jsonb_build_object('reason','ORDER_QUANTITY_MISMATCH','intent_id',target.id));
    return;
  end if;
  -- A delayed failure report cannot erase a confirmed terminal order/fill.
  if target.exchange_terminal or target.status in ('FILLED','CANCELLED','REJECTED') then return; end if;
  if abs(p_filled_size)<abs(target.filled_size) then return; end if;
  terminal:=p_result_status in ('FILLED','CANCELLED','REJECTED')
    or coalesce((p_safe_response->>'terminal')::boolean,false);
  insert into private.copy_order_attempts(intent_id,attempt_number,request_fingerprint,http_status,gate_label,result_status,safe_response)
    values(target.id,target.submit_attempts,target.idempotency_key,nullif(p_http_status,0),left(p_gate_label,100),
      case when p_result_status='UNKNOWN' then 'UNKNOWN' when p_result_status='REJECTED' then 'REJECTED' else 'ACKNOWLEDGED' end,
      coalesce(p_safe_response,'{}'::jsonb))
    on conflict(intent_id,attempt_number) do update set result_status=excluded.result_status,
      safe_response=excluded.safe_response,http_status=excluded.http_status,gate_label=excluded.gate_label;
  update private.copy_order_intents set status=p_result_status,gate_order_id=coalesce(nullif(p_gate_order_id,''),gate_order_id),
    filled_size=p_filled_size,average_fill_price=coalesce(p_average_fill_price,average_fill_price),
    exchange_terminal=terminal,last_error_code=left(p_error_code,80),submitted_at=coalesce(submitted_at,now()),
    resolved_at=case when terminal then now() else resolved_at end,updated_at=now() where id=target.id;
  if not terminal then
    insert into private.copy_reconciliation_jobs(intent_id,run_after,claimed_at,updated_at)
      values(target.id,now()+interval '2 seconds',null,now())
      on conflict(intent_id) do update set run_after=excluded.run_after,claimed_at=null,updated_at=now();
  else
    delete from private.copy_reconciliation_jobs where intent_id=target.id;
  end if;
  insert into public.copy_events(user_id,contract,event_type,severity,cycle_id,safe_payload)
    values(target.user_id,target.contract,
      case when p_filled_size<>0 then 'ORDER_FILLED' when p_result_status='UNKNOWN' then 'ORDER_UNKNOWN' else 'ORDER_SUBMITTED' end,
      case when p_result_status='UNKNOWN' then 'CRITICAL' when p_result_status='REJECTED' then 'WARNING' else 'INFO' end,
      target.cycle_id,jsonb_build_object('status',p_result_status,'terminal',terminal,'filled_size',p_filled_size));
end;
$$;
revoke all on function public.complete_copy_order_attempt(uuid,text,text,numeric,numeric,integer,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.complete_copy_order_attempt(uuid,text,text,numeric,numeric,integer,text,text,jsonb) to service_role;

create or replace function public.complete_copy_reconciliation(p_job_id bigint,p_status text,p_gate_order_id text default null,
  p_filled_size numeric default 0,p_average_fill_price numeric default null,p_safe_response jsonb default '{}')
returns void language plpgsql security definer set search_path=pg_catalog
as $$
declare job private.copy_reconciliation_jobs; target private.copy_order_intents; terminal boolean;
begin
  perform private.require_copy_worker_role();
  perform pg_advisory_xact_lock(hashtextextended('maetajak:copy-execution',0));
  select * into job from private.copy_reconciliation_jobs where id=p_job_id for update;
  if not found then return; end if;
  select * into target from private.copy_order_intents where id=job.intent_id for update;
  if p_status is null or p_status not in ('ACKNOWLEDGED','PARTIALLY_FILLED','FILLED','CANCELLED','REJECTED','UNKNOWN')
    then raise exception 'INVALID_RECONCILIATION_RESULT'; end if;
  if target.exchange_terminal or target.status in ('FILLED','CANCELLED','REJECTED') then
    delete from private.copy_reconciliation_jobs where id=job.id; return;
  end if;
  if coalesce(p_safe_response->>'error_code','') ~ 'ORDER_(QUANTITY|IDENTITY)_MISMATCH'
    or p_filled_size is null or abs(p_filled_size)>abs(target.delta_size)
    or (p_filled_size<>0 and sign(p_filled_size)<>sign(target.delta_size)) then
    update public.copy_system_control set execution_enabled=false,emergency_halted=true,
      halt_reason='RECONCILIATION_QUANTITY_MISMATCH',updated_at=now() where singleton;
    raise warning 'RECONCILIATION_QUANTITY_MISMATCH';
    return;
  end if;
  terminal:=p_status in ('FILLED','CANCELLED','REJECTED')
    or coalesce((p_safe_response->>'terminal')::boolean,false);
  if abs(p_filled_size)>=abs(target.filled_size) then
    update private.copy_order_intents set status=p_status,gate_order_id=coalesce(nullif(p_gate_order_id,''),gate_order_id),
      filled_size=p_filled_size,average_fill_price=coalesce(p_average_fill_price,average_fill_price),
      exchange_terminal=terminal,resolved_at=case when terminal then now() else resolved_at end,updated_at=now()
      where id=target.id;
  else terminal:=false;
  end if;
  if terminal then delete from private.copy_reconciliation_jobs where id=job.id;
  else update private.copy_reconciliation_jobs set claimed_at=null,
    run_after=now()+greatest(10,least(attempts,30))*interval '10 seconds',updated_at=now() where id=job.id; end if;
end;
$$;
revoke all on function public.complete_copy_reconciliation(bigint,text,text,numeric,numeric,jsonb) from public,anon,authenticated;
grant execute on function public.complete_copy_reconciliation(bigint,text,text,numeric,numeric,jsonb) to service_role;

create or replace function public.get_copy_safety_version()
returns jsonb language plpgsql security definer set search_path=pg_catalog
as $$
begin
  perform private.require_copy_worker_role();
  return jsonb_build_object('schema_version',3,'worker_version','0.5.0','resume_requires_validation',true,'current_state_atomic',true,'trade_alert_exchange_verification',true);
end;
$$;
revoke all on function public.get_copy_safety_version() from public,anon,authenticated;
grant execute on function public.get_copy_safety_version() to service_role;

drop function public.claim_copy_reconciliation_jobs(integer);
-- Qualify columns that share names with RETURNS TABLE output parameters.
CREATE OR REPLACE FUNCTION public.claim_copy_reconciliation_jobs(p_limit integer DEFAULT 10)
 RETURNS TABLE(job_id bigint, intent_id uuid, contract text, gate_order_id text, gate_order_text text, api_key text, secret_key text, delta_size numeric, position_side text, reduce_only boolean, target_size numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
declare encryption_key text;
begin
  perform private.require_copy_worker_role();
  perform pg_advisory_xact_lock(hashtextextended('maetajak:copy-execution',0));
  -- A new-generation claim that was never authorized cannot have reached Gate.
  update private.copy_order_intents i set status='CANCELLED',exchange_terminal=true,resolved_at=now(),
    last_error_code='UNSENT_CLAIM_EXPIRED',updated_at=now()
    where i.resume_version is not null and i.status='SUBMITTING' and i.submission_authorized_at is null
      and i.gate_order_id is null and i.submitted_at<now()-interval '30 seconds';
  insert into private.copy_reconciliation_jobs(intent_id,run_after,claimed_at,updated_at)
  select i.id,now(),null,now() from private.copy_order_intents i
  where i.status='SUBMITTING' and i.updated_at<now()-interval '30 seconds'
  on conflict on constraint copy_reconciliation_jobs_intent_id_key do nothing;
  select decrypted_secret into encryption_key from vault.decrypted_secrets where name='gate_api_credentials_key';
  return query with claimed as (
    select j.id from private.copy_reconciliation_jobs j
    where j.run_after<=now() and (j.claimed_at is null or j.claimed_at<now()-interval '1 minute')
    order by j.run_after for update skip locked
    limit greatest(1,least(coalesce(p_limit,10),50))
  ),updated as (
    update private.copy_reconciliation_jobs j
    set claimed_at=now(),attempts=j.attempts+1,updated_at=now()
    from claimed where j.id=claimed.id returning j.*
  )
  select u.id,i.id,i.contract,i.gate_order_id,i.gate_order_text,
    pgp_sym_decrypt(g.api_key_ciphertext,encryption_key),
    pgp_sym_decrypt(g.secret_key_ciphertext,encryption_key),i.delta_size,i.position_side,i.reduce_only,i.target_size
  from updated u
  join private.copy_order_intents i on i.id=u.intent_id
  join private.trading_accounts a on a.id=i.trading_account_id
  join private.gate_api_credentials g on g.user_id=a.credential_user_id;
end;
$function$;
notify pgrst, 'reload schema';

revoke all on function public.claim_copy_reconciliation_jobs(integer) from public,anon,authenticated;
grant execute on function public.claim_copy_reconciliation_jobs(integer) to service_role;

-- Do not consume a Master change while exchange evidence is unresolved.
create or replace function public.record_copy_worker_cycle_with_target_anchors(p_payload jsonb)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  cycle_id uuid;
  member jsonb;
  position jsonb;
  account_id uuid;
  observed_at timestamptz := coalesce((p_payload->>'observed_at')::timestamptz, clock_timestamp());
begin
  perform private.require_copy_worker_role();
  cycle_id := public.record_copy_worker_cycle(p_payload);

  for member in
    select value from jsonb_array_elements(coalesce(p_payload->'members', '[]'::jsonb))
  loop
    if member->>'error_code' is not null or member->>'resume_version' is null then
      continue;
    end if;
    account_id := (member->>'trading_account_id')::uuid;
    for position in
      select value from jsonb_array_elements(coalesce(member->'planned_positions', '[]'::jsonb))
    loop
      if position->>'anchor_update_allowed'='false'
        or position->>'target_resume_version' is null
        or position->>'master_copyable_size' is null
        or (position->>'target_resume_version')::uuid is distinct from (member->>'resume_version')::uuid then
        continue;
      end if;
      insert into private.copy_target_anchors(
        trading_account_id, contract, position_side, resume_version,
        master_copyable_size, target_size, protected_member_size,
        lock_reason, observed_at, updated_at
      ) values (
        account_id,
        position->>'contract',
        coalesce(nullif(position->>'position_side',''),
          case when (position->>'master_copyable_size')::numeric < 0 then 'SHORT' else 'LONG' end),
        (position->>'target_resume_version')::uuid,
        (position->>'master_copyable_size')::numeric,
        (position->>'target_size')::numeric,
        coalesce((position->>'member_baseline_size')::numeric, 0),
        left(coalesce(nullif(position->>'target_lock_reason',''), 'TARGET_ANCHOR_INITIALIZED'), 80),
        observed_at,
        now()
      )
      on conflict (trading_account_id, contract, position_side) do update set
        resume_version = excluded.resume_version,
        master_copyable_size = excluded.master_copyable_size,
        target_size = excluded.target_size,
        protected_member_size = excluded.protected_member_size,
        lock_reason = excluded.lock_reason,
        observed_at = excluded.observed_at,
        updated_at = now()
      where excluded.observed_at > private.copy_target_anchors.observed_at;
    end loop;
  end loop;
  return cycle_id;
end;
$$;

revoke all on function public.record_copy_worker_cycle_with_target_anchors(jsonb)
  from public, anon, authenticated;
grant execute on function public.record_copy_worker_cycle_with_target_anchors(jsonb)
  to service_role;

-- Keep the existing durable outbox and unique intent key; cover all terminal
-- trade outcomes. The worker must independently re-read Gate before delivery.
create or replace function private.queue_copy_entry_alert()
returns trigger language plpgsql security definer set search_path=pg_catalog
as $$
declare member_label text; event text; multiplier numeric;
begin
  if new.status not in ('FILLED','REJECTED','CANCELLED') and not new.exchange_terminal then return new; end if;
  select coalesce(nullif(p.nickname,''),nullif(p.full_name,''),'회원 계정') into member_label
    from public.profiles p where p.id=new.user_id;
  event := case when new.filled_size=0 then 'COPY_ORDER_FAILED'
    when new.reduce_only then 'COPY_POSITION_REDUCTION_FILLED' else 'COPY_POSITION_ENTRY_FILLED' end;
  multiplier := (new.plan_evidence->>'quanto_multiplier')::numeric;
  insert into private.copy_entry_alert_outbox(intent_id,event_type,safe_payload)
  values(new.id,event,jsonb_build_object('member',coalesce(member_label,'회원 계정'),
    'contract',new.contract,'position_side',new.position_side,'side',case when new.delta_size>0 then 'BUY' else 'SELL' end,
    'filled_size',abs(new.filled_size),'fill_notional_usdt',case when new.filled_size=0 then 0
      when multiplier>0 and new.average_fill_price>0 then abs(new.filled_size)*multiplier*new.average_fill_price else null end,
    'average_fill_price',new.average_fill_price,'target_leverage',coalesce(new.target_leverage,(new.plan_evidence->>'risk_leverage')::numeric),
    'margin_mode',new.margin_mode,'result_status',new.status,'error_code',new.last_error_code,
    'gate_order_id',new.gate_order_id))
    on conflict(intent_id) do nothing;
  return new;
end;
$$;
revoke all on function private.queue_copy_entry_alert() from public,anon,authenticated;

drop function public.claim_copy_entry_alerts(integer);
create function public.claim_copy_entry_alerts(p_limit integer default 10)
returns table(alert_id bigint,event_type text,details jsonb,gate_order_id text,gate_order_text text,
  contract text,position_side text,delta_size numeric,reduce_only boolean,target_size numeric,
  filled_size numeric,result_status text,quanto_multiplier numeric,error_code text,api_key text,secret_key text)
language plpgsql security definer set search_path=pg_catalog,extensions
as $$
declare encryption_key text;
begin
  perform private.require_copy_worker_role();
  select decrypted_secret into encryption_key from vault.decrypted_secrets where name='gate_api_credentials_key';
  return query with candidates as (
    select o.id from private.copy_entry_alert_outbox o
    where o.delivered_at is null and o.next_attempt_at<=clock_timestamp()
      and (o.claimed_at is null or o.claimed_at<clock_timestamp()-interval '2 minutes')
    order by o.next_attempt_at,o.id for update skip locked
    limit greatest(1,least(coalesce(p_limit,10),50))
  ), claimed as (
    update private.copy_entry_alert_outbox o set claimed_at=clock_timestamp(),attempts=o.attempts+1,updated_at=now()
    from candidates c where o.id=c.id returning o.*
  ) select c.id,c.event_type,c.safe_payload,i.gate_order_id,i.gate_order_text,i.contract,i.position_side,
      i.delta_size,i.reduce_only,i.target_size,i.filled_size,i.status,(i.plan_evidence->>'quanto_multiplier')::numeric,i.last_error_code,
      extensions.pgp_sym_decrypt(g.api_key_ciphertext,encryption_key),extensions.pgp_sym_decrypt(g.secret_key_ciphertext,encryption_key)
    from claimed c join private.copy_order_intents i on i.id=c.intent_id
    join private.trading_accounts a on a.id=i.trading_account_id
    left join private.gate_api_credentials g on g.user_id=a.credential_user_id;
end;
$$;
revoke all on function public.claim_copy_entry_alerts(integer) from public,anon,authenticated;
grant execute on function public.claim_copy_entry_alerts(integer) to service_role;

notify pgrst,'reload schema';

-- Automated loss limits block additions while allowing Master reductions.
CREATE OR REPLACE FUNCTION public.record_copy_worker_cycle(p_payload jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
declare
  cycle_id uuid := (p_payload->>'cycle_id')::uuid;
  observed_at timestamptz := coalesce((p_payload->>'observed_at')::timestamptz, now());
  master jsonb := p_payload->'master';
  member jsonb;
  position jsonb;
  account_positions jsonb;
  account_id uuid;
  account_snapshot_id bigint;
  latest_account_snapshot_id bigint;
  previous_state text;
  v_position_side text;
  intent_count integer := 0;
  source_hash text := encode(digest(p_payload::text, 'sha256'), 'hex');
  position_structure_hash text;
  previous_position_structure_hash text;
  previous_account_snapshot_at timestamptz;
  position_changed boolean;
  account_sample_due boolean;
begin
  perform private.require_copy_worker_role();
  perform pg_advisory_xact_lock(hashtextextended('maetajak:copy-execution',0));
  if master is null or master->>'trading_account_id' is null then raise exception 'MASTER_REQUIRED'; end if;

  insert into private.copy_cycles(id, master_account_id, status, source_version, started_at)
  values (
    cycle_id,
    (master->>'trading_account_id')::uuid,
    'RECONCILING',
    left(p_payload->>'source_version', 160),
    observed_at
  )
  on conflict (id) do nothing;

  account_id := (master->>'trading_account_id')::uuid;
  account_positions := coalesce(master->'positions', '[]'::jsonb);
  select md5(coalesce(string_agg(concat_ws('|',
    item->>'contract',
    coalesce(nullif(item->>'positionSide', ''), case when coalesce((item->>'size')::numeric, 0) < 0 then 'SHORT' else 'LONG' end),
    coalesce((item->>'size')::numeric, 0)::text,
    coalesce(nullif(item->>'entryPrice', '')::numeric, 0)::text,
    coalesce(nullif(item->>'leverage', '')::numeric, 0)::text,
    coalesce(nullif(item->>'quanto_multiplier', '')::numeric, 1)::text
  ), '||' order by item->>'contract', coalesce(nullif(item->>'positionSide', ''), '')), 'EMPTY'))
  into position_structure_hash
  from jsonb_array_elements(account_positions) item
  where coalesce((item->>'size')::numeric, 0) <> 0;

  select checkpoint.position_structure_hash, checkpoint.account_snapshot_at
  into previous_position_structure_hash, previous_account_snapshot_at
  from private.copy_snapshot_checkpoints checkpoint
  where checkpoint.trading_account_id = account_id;

  position_changed := previous_position_structure_hash is distinct from position_structure_hash;
  account_sample_due := previous_account_snapshot_at is null
    or previous_account_snapshot_at <= observed_at - interval '1 minute';
  account_snapshot_id := null;

  if account_sample_due or position_changed then
    insert into private.copy_account_snapshots(
      trading_account_id, total_equity, available_equity, unrealised_pnl, observed_at, source_hash
    ) values (
      account_id,
      greatest(0, (master->>'total')::numeric),
      greatest(0, (master->>'available')::numeric),
      (master->>'unrealisedPnl')::numeric,
      observed_at,
      source_hash
    ) returning id into account_snapshot_id;
  end if;

  if position_changed then
    for position in select value from jsonb_array_elements(account_positions) loop
      if coalesce((position->>'size')::numeric, 0) <> 0
        and coalesce((position->>'markPrice')::numeric, 0) > 0 then
        insert into private.copy_position_snapshots(
          account_snapshot_id, trading_account_id, contract, size, mark_price,
          entry_price, leverage, quanto_multiplier, observed_at, position_side
        ) values (
          account_snapshot_id,
          account_id,
          position->>'contract',
          (position->>'size')::numeric,
          (position->>'markPrice')::numeric,
          nullif(position->>'entryPrice', '')::numeric,
          nullif(position->>'leverage', '')::numeric,
          coalesce(nullif(position->>'quanto_multiplier', '')::numeric, 1),
          observed_at,
          coalesce(nullif(position->>'positionSide', ''),
            case when (position->>'size')::numeric < 0 then 'SHORT' else 'LONG' end)
        );
      end if;
    end loop;
  end if;

  insert into private.copy_snapshot_checkpoints(
    trading_account_id, account_snapshot_at, position_snapshot_at,
    position_structure_hash, updated_at
  ) values (
    account_id,
    case when account_snapshot_id is not null then observed_at end,
    case when position_changed then observed_at end,
    position_structure_hash,
    now()
  ) on conflict (trading_account_id) do update set
    account_snapshot_at = case when account_snapshot_id is not null
      then excluded.account_snapshot_at
      else private.copy_snapshot_checkpoints.account_snapshot_at end,
    position_snapshot_at = case when position_changed
      then excluded.position_snapshot_at
      else private.copy_snapshot_checkpoints.position_snapshot_at end,
    position_structure_hash = excluded.position_structure_hash,
    updated_at = now();

  if account_snapshot_id is null then
    select snapshot.id
    into latest_account_snapshot_id
    from private.copy_account_snapshots snapshot
    where snapshot.trading_account_id = account_id
    order by snapshot.observed_at desc
    limit 1;
  else
    latest_account_snapshot_id := account_snapshot_id;
  end if;

  update private.copy_cycles
  set master_snapshot_id = latest_account_snapshot_id
  where id = cycle_id;

  for member in
    select value from jsonb_array_elements(coalesce(p_payload->'members', '[]'::jsonb))
  loop
    if member->>'error_code' is not null then
      insert into public.copy_events(user_id, event_type, severity, cycle_id, safe_payload)
      values (
        (member->>'user_id')::uuid,
        'ERROR',
        'CRITICAL',
        cycle_id,
        jsonb_build_object('code', left(member->>'error_code', 80))
      );
      continue;
    end if;

    if member->>'risk_halt_reason' in ('DAILY_LOSS_LIMIT', 'MAX_DRAWDOWN_LIMIT') then
      update public.profiles
      set reduce_only = true, updated_at = now()
      where id = (member->>'user_id')::uuid;
    end if;

    account_id := (member->>'trading_account_id')::uuid;
    -- A late response from an earlier generation cannot overwrite new states.
    if member->>'resume_version' is not null and not exists(
      select 1 from private.copy_resume_sessions s where s.trading_account_id=account_id
        and s.version=(member->>'resume_version')::uuid
    ) then continue; end if;
    account_positions := coalesce(member->'planned_positions', '[]'::jsonb);
    select md5(coalesce(string_agg(concat_ws('|',
      item->>'contract',
      coalesce(nullif(item->>'position_side', ''), case when coalesce((item->>'size')::numeric, 0) < 0 then 'SHORT' else 'LONG' end),
      coalesce((item->>'size')::numeric, 0)::text,
      coalesce(nullif(item->>'entry_price', '')::numeric, 0)::text,
      coalesce(nullif(item->>'leverage', '')::numeric, 0)::text,
      coalesce(nullif(item->>'quanto_multiplier', '')::numeric, 1)::text
    ), '||' order by item->>'contract', coalesce(nullif(item->>'position_side', ''), '')), 'EMPTY'))
    into position_structure_hash
    from jsonb_array_elements(account_positions) item
    where coalesce((item->>'size')::numeric, 0) <> 0;

    previous_position_structure_hash := null;
    previous_account_snapshot_at := null;
    select checkpoint.position_structure_hash, checkpoint.account_snapshot_at
    into previous_position_structure_hash, previous_account_snapshot_at
    from private.copy_snapshot_checkpoints checkpoint
    where checkpoint.trading_account_id = account_id;

    position_changed := previous_position_structure_hash is distinct from position_structure_hash;
    account_sample_due := previous_account_snapshot_at is null
      or previous_account_snapshot_at <= observed_at - interval '1 minute';
    account_snapshot_id := null;

    if account_sample_due or position_changed then
      insert into private.copy_account_snapshots(
        trading_account_id, total_equity, available_equity, unrealised_pnl, observed_at, source_hash
      ) values (
        account_id,
        greatest(0, (member->>'total')::numeric),
        greatest(0, (member->>'available')::numeric),
        (member->>'unrealisedPnl')::numeric,
        observed_at,
        source_hash
      ) returning id into account_snapshot_id;
    end if;

    for position in select value from jsonb_array_elements(account_positions) loop
      v_position_side := coalesce(nullif(position->>'position_side', ''),
        case when coalesce((position->>'size')::numeric, 0) < 0 then 'SHORT' else 'LONG' end);
      select state.state
      into previous_state
      from public.copy_position_states state
      where state.trading_account_id = account_id
        and state.contract = position->>'contract'
        and state.position_side = v_position_side;

      if position_changed
        and coalesce((position->>'size')::numeric, 0) <> 0
        and coalesce((position->>'mark_price')::numeric, 0) > 0 then
        insert into private.copy_position_snapshots(
          account_snapshot_id, trading_account_id, contract, size, mark_price,
          entry_price, leverage, quanto_multiplier, observed_at, position_side
        ) values (
          account_snapshot_id,
          account_id,
          position->>'contract',
          (position->>'size')::numeric,
          (position->>'mark_price')::numeric,
          nullif(position->>'entry_price', '')::numeric,
          nullif(position->>'leverage', '')::numeric,
          (position->>'quanto_multiplier')::numeric,
          observed_at,
          v_position_side
        );
      end if;

      insert into public.copy_position_states(
        user_id, trading_account_id, contract, state, target_size, actual_size, delta_size,
        previous_actual_size, unexplained_delta, copy_ratio, max_position_ratio,
        drift_tolerance_size, pause_reason, manual_override_confirmed_at,
        last_cycle_id, last_observed_at, updated_at, position_side,
        target_leverage, margin_mode, position_mode
      ) values (
        (member->>'user_id')::uuid,
        account_id,
        position->>'contract',
        position->>'state',
        (position->>'target_size')::numeric,
        (position->>'size')::numeric,
        (position->>'delta_size')::numeric,
        nullif(position->>'previous_actual_size', '')::numeric,
        coalesce((position->>'unexplained_delta')::numeric, 0),
        (member->>'copy_ratio')::numeric,
        (member->>'max_position_ratio')::numeric,
        1,
        nullif(position->>'pause_reason', ''),
        case when position->>'state' = 'MANUAL_OVERRIDE' then now() end,
        cycle_id,
        observed_at,
        now(),
        v_position_side,
        nullif(position->>'target_leverage', '')::numeric,
        nullif(position->>'margin_mode', ''),
        nullif(position->>'position_mode', '')
      ) on conflict (trading_account_id, contract, position_side) do update set
        state = excluded.state,
        target_size = excluded.target_size,
        actual_size = excluded.actual_size,
        delta_size = excluded.delta_size,
        previous_actual_size = excluded.previous_actual_size,
        unexplained_delta = excluded.unexplained_delta,
        copy_ratio = excluded.copy_ratio,
        max_position_ratio = excluded.max_position_ratio,
        pause_reason = excluded.pause_reason,
        target_leverage = excluded.target_leverage,
        margin_mode = excluded.margin_mode,
        position_mode = excluded.position_mode,
        manual_override_confirmed_at = coalesce(
          public.copy_position_states.manual_override_confirmed_at,
          excluded.manual_override_confirmed_at
        ),
        last_cycle_id = excluded.last_cycle_id,
        last_observed_at = excluded.last_observed_at,
        updated_at = now()
        where public.copy_position_states.last_observed_at is null
          or excluded.last_observed_at > public.copy_position_states.last_observed_at;

      if previous_state is distinct from position->>'state' then
        insert into public.copy_events(user_id, contract, event_type, severity, cycle_id, safe_payload)
        values (
          (member->>'user_id')::uuid,
          position->>'contract',
          case position->>'state'
            when 'MANUAL_OVERRIDE' then 'MANUAL_OVERRIDE_DETECTED'
            when 'SYNCED' then 'POSITION_SYNCED'
            when 'PAUSED' then 'SYMBOL_PAUSED'
            when 'REDUCE_ONLY' then 'RISK_REDUCE_ONLY'
            when 'HALTED' then 'MEMBER_HALTED'
            else 'TARGET_POSITION_CALCULATED'
          end,
          case
            when position->>'state' in ('MANUAL_OVERRIDE', 'ERROR', 'HALTED') then 'CRITICAL'
            when position->>'state' in ('DRIFT', 'PAUSED', 'REDUCE_ONLY') then 'WARNING'
            else 'INFO'
          end,
          cycle_id,
          jsonb_build_object(
            'previous_state', previous_state,
            'state', position->>'state',
            'target_size', position->>'target_size',
            'actual_size', position->>'size'
          )
        );
      end if;

      if position->'intent' is not null then
        insert into private.copy_order_intents(
          cycle_id, user_id, trading_account_id, contract, target_size,
          actual_size_at_plan, delta_size, reduce_only, idempotency_key,
          gate_order_text, status, position_side, target_leverage,
          margin_mode, position_mode, pid, resume_version, source_observed_at
        ) values (
          cycle_id,
          (member->>'user_id')::uuid,
          account_id,
          position->>'contract',
          (position->>'target_size')::numeric,
          (position->>'size')::numeric,
          (position->'intent'->>'delta_size')::numeric,
          (position->'intent'->>'reduce_only')::boolean,
          position->'intent'->>'idempotency_key',
          position->'intent'->>'gate_order_text',
          'PLANNED',
          v_position_side,
          nullif(position->'intent'->>'target_leverage', '')::numeric,
          nullif(position->'intent'->>'margin_mode', ''),
          nullif(position->'intent'->>'position_mode', ''),
          nullif(position->'intent'->>'pid', ''),
          (member->>'resume_version')::uuid,
          (member->>'observed_at')::timestamptz
        ) on conflict (idempotency_key) do nothing;
        intent_count := intent_count + 1;
      end if;
    end loop;

    insert into private.copy_snapshot_checkpoints(
      trading_account_id, account_snapshot_at, position_snapshot_at,
      position_structure_hash, updated_at
    ) values (
      account_id,
      case when account_snapshot_id is not null then observed_at end,
      case when position_changed then observed_at end,
      position_structure_hash,
      now()
    ) on conflict (trading_account_id) do update set
      account_snapshot_at = case when account_snapshot_id is not null
        then excluded.account_snapshot_at
        else private.copy_snapshot_checkpoints.account_snapshot_at end,
      position_snapshot_at = case when position_changed
        then excluded.position_snapshot_at
        else private.copy_snapshot_checkpoints.position_snapshot_at end,
      position_structure_hash = excluded.position_structure_hash,
      updated_at = now();
  end loop;

  update private.copy_cycles
  set status = case when intent_count > 0 then 'PLANNED' else 'COMPLETED' end,
      completed_at = case when intent_count = 0 then now() end
  where id = cycle_id;

  return cycle_id;
end;
$function$;
revoke all on function public.record_copy_worker_cycle(jsonb) from public,anon,authenticated;
grant execute on function public.record_copy_worker_cycle(jsonb) to service_role;
notify pgrst, 'reload schema';
