-- UNAUTHORIZED_REBALANCE: ordinary RESUME must be future-only.
-- Definitions only: no LIVE flag, member, order, position or baseline data is
-- changed by applying this migration. Existing unreceipted sync sessions fail
-- closed; RELEASE must keep STOP until QA and a fresh DRY_RUN are complete.
create function private.copy_resume_operation_id(p_account uuid,p_version uuid)
returns uuid language sql stable set search_path=pg_catalog
as $$
  select h.id from private.copy_operation_history h
  join private.copy_operation_risk r on r.operation_id=h.id and r.trading_account_id=h.trading_account_id
  join private.copy_resume_sessions s on s.trading_account_id=h.trading_account_id and s.version=h.resume_version
  where h.trading_account_id=p_account and h.resume_version=p_version
    and h.requested_by=s.requested_by
    and h.receipt->>'mode'='NEW_OPERATION'
    and h.receipt->>'operation_id'=h.id::text
    and h.receipt->>'resume_version'=s.version::text
    and h.receipt->>'user_id'=h.user_id::text
$$;
revoke all on function private.copy_resume_operation_id(uuid,uuid) from public,anon,authenticated;

create function private.copy_resume_policy_authorized(p_account uuid,p_version uuid)
returns boolean language sql stable set search_path=pg_catalog
as $$
  select exists(select 1 from private.copy_resume_sessions s
    where s.trading_account_id=p_account and s.version=p_version
      and (not s.sync_current_master or private.copy_resume_operation_id(p_account,p_version) is not null))
$$;
revoke all on function private.copy_resume_policy_authorized(uuid,uuid) from public,anon,authenticated;

create function private.assert_copy_resume_policy(p_account uuid,p_version uuid,p_snapshot jsonb)
returns void language plpgsql set search_path=pg_catalog
as $$
declare operation uuid := private.copy_resume_operation_id(p_account,p_version);
begin
  if not private.copy_resume_policy_authorized(p_account,p_version) then
    raise exception 'RESUME_CURRENT_MASTER_AUTHORIZATION_REQUIRED';
  end if;
  if p_snapshot->>'resume_policy_version' is distinct from '1'
    or not private.copy_resume_positions_valid(p_snapshot->'observed_master_positions')
    or not private.copy_resume_positions_valid(p_snapshot->'observed_member_positions') then
    raise exception 'RESUME_POLICY_EVIDENCE_REQUIRED';
  end if;
  if operation is null then
    if p_snapshot->>'resume_mode' is distinct from 'FUTURE_ONLY'
      or p_snapshot->>'current_master_operation_id' is not null
      or p_snapshot->'master_positions' is distinct from p_snapshot->'observed_master_positions'
      or p_snapshot->'member_positions' is distinct from p_snapshot->'observed_member_positions' then
      raise exception 'RESUME_FUTURE_ONLY_BASELINE_REQUIRED';
    end if;
  else
    if p_snapshot->>'resume_mode' is distinct from 'CURRENT_MASTER'
      or p_snapshot->>'current_master_operation_id' is distinct from operation::text
      or p_snapshot->'master_positions' is distinct from '[]'::jsonb then
      raise exception 'RESUME_CURRENT_MASTER_AUTHORIZATION_REQUIRED';
    end if;
    if p_snapshot->'member_positions' is distinct from '[]'::jsonb
      or p_snapshot->'observed_member_positions' is distinct from '[]'::jsonb then
      raise exception 'RESUME_NEW_OPERATION_NOT_FLAT';
    end if;
  end if;
end;
$$;
revoke all on function private.assert_copy_resume_policy(uuid,uuid,jsonb) from public,anon,authenticated;

create or replace function private.request_member_copy_resume(p_user_id uuid)
returns jsonb language plpgsql set search_path=pg_catalog
as $$
declare a record; result jsonb := '[]'; s private.copy_resume_sessions;
begin
  perform pg_advisory_xact_lock(hashtextextended('maetajak:copy-execution',0));
  if not exists(select 1 from public.profiles where id=p_user_id and role='MEMBER'
      and approval_status='APPROVED' and not member_halted) then
    raise exception 'MEMBER_HALTED_OR_NOT_APPROVED';
  end if;
  for a in select id from private.trading_accounts
    where user_id=p_user_id and account_role='MEMBER' and status='ACTIVE' order by id
  loop
    insert into private.copy_resume_sessions(trading_account_id) values(a.id) on conflict do nothing;
    select * into s from private.copy_resume_sessions where trading_account_id=a.id for update;
    if s.state='ACTIVE' and exists(select 1 from public.profiles where id=p_user_id and not copy_paused) then
      result:=result||jsonb_build_array(jsonb_build_object('version',s.version,'state',s.state)); continue;
    end if;
    -- Repeated clicks preserve both the in-progress version and its sync mode.
    if s.state not in ('REQUESTED','VALIDATED') or s.expires_at<=clock_timestamp() then
      update private.copy_resume_sessions set version=gen_random_uuid(),state='REQUESTED',
        requested_at=clock_timestamp(),requested_by=auth.uid(),
        expires_at=clock_timestamp()+interval '5 minutes',
        snapshot_started_at=null,snapshot_observed_at=null,validated_at=null,activated_at=null,
        master_positions=null,member_positions=null,settings=null,blocker_reason=null,
        sync_current_master=false,updated_at=now()
      where trading_account_id=a.id returning * into s;
    end if;
    update public.profiles set copy_paused=true,close_positions_requested=false,reduce_only=false,updated_at=now()
      where id=p_user_id;
    update private.copy_order_intents set status='CANCELLED',resolved_at=now(),
      last_error_code='SUPERSEDED_BY_RESUME',updated_at=now()
      where trading_account_id=a.id and status in ('PLANNED','QUEUED') and submit_attempts=0;
    insert into private.copy_reconciliation_jobs(intent_id)
      select id from private.copy_order_intents where trading_account_id=a.id
        and status in ('SUBMITTING','ACKNOWLEDGED','PARTIALLY_FILLED','UNKNOWN')
        and not exchange_terminal
      on conflict(intent_id) do update set run_after=now();
    result:=result||jsonb_build_array(jsonb_build_object('version',s.version,'state',s.state));
  end loop;
  if result='[]'::jsonb then raise exception 'ACTIVE_MEMBER_ACCOUNT_REQUIRED'; end if;
  return jsonb_build_object('mode','RESUME','copy_paused',true,'sessions',result);
end;
$$;
revoke all on function private.request_member_copy_resume(uuid) from public,anon,authenticated;

create or replace function public.get_copy_resume_context()
returns jsonb language plpgsql security definer set search_path=pg_catalog
as $$
begin
  perform private.require_copy_worker_role();
  return (select coalesce(jsonb_agg(jsonb_build_object(
    'trading_account_id',a.id,'version',s.version,'state',coalesce(s.state,'REQUIRED'),
    'requested_at',s.requested_at,'expires_at',s.expires_at,'blocker_reason',s.blocker_reason,
    'sync_current_master',coalesce(s.sync_current_master,false) or private.copy_resume_operation_id(a.id,s.version) is not null,
    'current_master_operation_id',private.copy_resume_operation_id(a.id,s.version),
    'resume_authorized',private.copy_resume_policy_authorized(a.id,s.version),
    'platform_positions',coalesce((
      select jsonb_agg(jsonb_build_object(
        'contract',fills.contract,'position_side',fills.position_side,'size',fills.size
      ) order by fills.contract,fills.position_side)
      from (
        select i.contract,i.position_side,sum(i.filled_size) size
        from private.copy_order_intents i
        where i.trading_account_id=a.id and i.filled_size<>0
        group by i.contract,i.position_side
        having sum(i.filled_size)<>0
      ) fills
    ),'[]'::jsonb),
    'unresolved_orders',(select count(*) from private.copy_order_intents i
      where i.trading_account_id=a.id and i.submit_attempts>0 and (
        (i.status in ('SUBMITTING','ACKNOWLEDGED','PARTIALLY_FILLED','UNKNOWN') and not i.exchange_terminal)
        or (i.filled_size<>0 and i.observation_confirmed_at is null and i.created_at>=(
          select control.updated_at from public.copy_system_control control where control.singleton
        ))
      )),
    'expected_contracts',(select coalesce(jsonb_agg(distinct p.contract),'[]'::jsonb)
      from public.copy_position_states p where p.trading_account_id=a.id),
    'positions',b.positions,'member_positions',b.member_positions,'baseline_version',b.resume_version
    ) order by a.id),'[]'::jsonb)
    from private.trading_accounts a
    left join private.copy_resume_sessions s on s.trading_account_id=a.id
    left join private.member_copy_onboarding_baselines b on b.trading_account_id=a.id
    where a.account_role='MEMBER' and a.status='ACTIVE');
end;
$$;
revoke all on function public.get_copy_resume_context() from public,anon,authenticated;
grant execute on function public.get_copy_resume_context() to service_role;

create or replace function public.prepare_member_copy_resume(p_trading_account_id uuid,p_version uuid,p_snapshot jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog
as $$
declare s private.copy_resume_sessions; uid uuid; started timestamptz; observed timestamptz;
begin
  perform private.require_copy_worker_role();
  perform pg_advisory_xact_lock(hashtextextended('maetajak:copy-execution',0));
  select * into s from private.copy_resume_sessions where trading_account_id=p_trading_account_id for update;
  if not found or s.version is distinct from p_version or s.state not in ('REQUESTED','VALIDATED')
    or s.expires_at<=clock_timestamp() then raise exception 'RESUME_VERSION_OR_STATE_CHANGED'; end if;
  perform private.assert_copy_resume_policy(p_trading_account_id,p_version,p_snapshot);
  select user_id into uid from private.trading_accounts where id=p_trading_account_id and status='ACTIVE' and account_role='MEMBER';
  if uid is null or not exists(select 1 from public.profiles where id=uid and approval_status='APPROVED'
    and copy_paused and not member_halted and not close_positions_requested) then raise exception 'RESUME_MEMBER_NOT_ELIGIBLE'; end if;
  if exists(select 1 from private.copy_order_intents where trading_account_id=p_trading_account_id
    and status in ('SUBMITTING','ACKNOWLEDGED','PARTIALLY_FILLED','UNKNOWN') and not exchange_terminal)
    then raise exception 'RESUME_UNRESOLVED_ORDERS'; end if;
  started:=(p_snapshot->>'started_at')::timestamptz;
  observed:=(p_snapshot->>'observed_at')::timestamptz;
  if started is null or observed is null or started<s.requested_at or observed<started
    or observed>clock_timestamp()+interval '1 second' or started<clock_timestamp()-interval '15 seconds'
    or observed-started>interval '15 seconds' then raise exception 'RESUME_SNAPSHOT_STALE'; end if;
  if not private.copy_resume_positions_valid(p_snapshot->'master_positions')
    or not private.copy_resume_positions_valid(p_snapshot->'member_positions')
    or coalesce((p_snapshot->>'open_order_count')::integer,-1)<>0
    or coalesce((p_snapshot->>'preview_passed')::boolean,false) is not true then
    raise exception 'RESUME_SNAPSHOT_INVALID';
  end if;
  if p_snapshot->'settings' is distinct from private.copy_resume_settings(uid) then raise exception 'RESUME_SETTINGS_CHANGED'; end if;
  update private.copy_resume_sessions set state='VALIDATED',snapshot_started_at=started,snapshot_observed_at=observed,
    master_positions=p_snapshot->'master_positions',member_positions=p_snapshot->'member_positions',
    sync_current_master=private.copy_resume_operation_id(p_trading_account_id,p_version) is not null,
    settings=private.copy_resume_settings(uid),validated_at=clock_timestamp(),blocker_reason=null,updated_at=now()
    where trading_account_id=p_trading_account_id;
  insert into private.member_copy_onboarding_baselines(trading_account_id,positions,member_positions,initialized_at,updated_at,resume_version)
    values(p_trading_account_id,p_snapshot->'master_positions',p_snapshot->'member_positions',observed,now(),p_version)
    on conflict(trading_account_id) do update set positions=excluded.positions,member_positions=excluded.member_positions,
      initialized_at=excluded.initialized_at,updated_at=now(),resume_version=excluded.resume_version;
  return jsonb_build_object('state','VALIDATED','version',p_version);
end;
$$;
revoke all on function public.prepare_member_copy_resume(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.prepare_member_copy_resume(uuid,uuid,jsonb) to service_role;

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
  perform private.assert_copy_resume_policy(p_trading_account_id,p_version,p_snapshot);
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
revoke all on function public.activate_member_copy_resume(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.activate_member_copy_resume(uuid,uuid,jsonb) to service_role;

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
    where private.copy_resume_policy_authorized(i.trading_account_id,i.resume_version)
      and r.singleton and session.state in ('ACTIVE','CLOSING') and a.status='ACTIVE' and g.status='VERIFIED'
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
    where private.copy_resume_policy_authorized(i.trading_account_id,i.resume_version)
      and i.id=p_intent_id and i.resume_version=p_version and i.status='SUBMITTING' and i.submission_authorized_at is null and s.state in ('ACTIVE','CLOSING')
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

create or replace function private.guard_copy_resume_order()
returns trigger language plpgsql security definer set search_path=pg_catalog
as $$
declare s private.copy_resume_sessions;
begin
  if new.status not in ('PLANNED','QUEUED','SUBMITTING') then return new; end if;
  perform pg_advisory_xact_lock(hashtextextended('maetajak:copy-execution',0));
  select * into s from private.copy_resume_sessions where trading_account_id=new.trading_account_id;
  if not private.copy_resume_policy_authorized(new.trading_account_id,new.resume_version)
    or coalesce(s.state,'') not in ('ACTIVE','CLOSING') or new.resume_version is distinct from s.version
    or new.source_observed_at is null or new.source_observed_at<s.activated_at
    or new.source_observed_at<clock_timestamp()-interval '15 seconds'
    or new.source_observed_at>clock_timestamp()+interval '1 second'
    or not exists(select 1 from public.profiles p where p.id=new.user_id and p.approval_status='APPROVED'
      and (not p.copy_paused or (p.close_positions_requested and new.reduce_only and new.target_size=0 and s.state='CLOSING'))
      and not p.member_halted and (not p.reduce_only or new.reduce_only))
    or not exists(select 1 from public.copy_system_control where singleton and execution_enabled and not emergency_halted)
    or exists(select 1 from private.copy_order_intents i where i.trading_account_id=new.trading_account_id and i.contract=new.contract
      and (i.position_side=new.position_side or new.position_mode='single') and i.id<>new.id
      and i.submit_attempts>0
      and (i.status in ('SUBMITTING','ACKNOWLEDGED','UNKNOWN')
        or (i.status='PARTIALLY_FILLED' and not i.exchange_terminal)
        or (i.resume_version=s.version and i.filled_size<>0 and i.observation_confirmed_at is null))) then return null; end if;
  return new;
end;
$$;
revoke all on function private.guard_copy_resume_order() from public,anon,authenticated;
