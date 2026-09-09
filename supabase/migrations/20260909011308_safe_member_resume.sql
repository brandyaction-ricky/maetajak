-- Apply only while real execution is halted. This migration never enables copying.
do $$ begin
  if not exists(select 1 from public.copy_system_control where singleton and not execution_enabled and emergency_halted) then
    raise exception 'HALTED_DEPLOYMENT_REQUIRED';
  end if;
end $$;

-- Reviewed against the deployed hedge-mode schema. No live activation.
-- All existing accounts require a new, explicitly requested resume session.
create table private.copy_resume_sessions (
  trading_account_id uuid primary key references private.trading_accounts(id) on delete cascade,
  version uuid not null default gen_random_uuid(),
  state text not null default 'REQUIRED' check (state in ('REQUIRED','REQUESTED','VALIDATED','ACTIVE','CLOSING','PAUSED','BLOCKED')),
  requested_at timestamptz,
  requested_by uuid,
  expires_at timestamptz,
  snapshot_started_at timestamptz,
  snapshot_observed_at timestamptz,
  validated_at timestamptz,
  activated_at timestamptz,
  blocker_reason text,
  master_positions jsonb,
  member_positions jsonb,
  settings jsonb,
  updated_at timestamptz not null default now()
);
alter table private.copy_resume_sessions enable row level security;
revoke all on private.copy_resume_sessions from public, anon, authenticated;
insert into private.copy_resume_sessions(trading_account_id)
select id from private.trading_accounts where account_role='MEMBER';
alter table private.member_copy_onboarding_baselines add column resume_version uuid;
alter table private.copy_order_intents add column resume_version uuid;
alter table private.copy_order_intents add column source_observed_at timestamptz;
alter table private.copy_order_intents add column exchange_terminal boolean not null default false;
alter table private.copy_order_intents add column position_match_at timestamptz;
alter table private.copy_order_intents add column observation_confirmed_at timestamptz;
alter table private.copy_order_intents add column submission_authorized_at timestamptz;
create index copy_intents_resume_guard_idx on private.copy_order_intents
  (trading_account_id, resume_version, contract, position_side)
  where submit_attempts > 0 and observation_confirmed_at is null;
create index copy_intents_unresolved_resume_idx on private.copy_order_intents
  (trading_account_id, status) where status in ('SUBMITTING','ACKNOWLEDGED','PARTIALLY_FILLED','UNKNOWN');

create function private.require_copy_worker_role()
returns void language plpgsql security invoker set search_path=pg_catalog
as $$
begin
  if coalesce(nullif(current_setting('request.jwt.claim.role',true),''),
      nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'role',
      nullif(current_setting('role',true),'none'),'') <> 'service_role' then
    raise exception 'SERVICE_ROLE_REQUIRED';
  end if;
end;
$$;
revoke all on function private.require_copy_worker_role() from public, anon, authenticated;

create function private.copy_resume_positions_valid(p_positions jsonb)
returns boolean language plpgsql immutable set search_path=pg_catalog
as $$
declare p jsonb; keys text[] := '{}'; k text; qty numeric;
begin
  if p_positions is null or jsonb_typeof(p_positions)<>'array' then return false; end if;
  for p in select value from jsonb_array_elements(p_positions) loop
    if jsonb_typeof(p)<>'object' or (p->>'contract') is null
      or (p->>'contract') !~ '^[A-Z0-9_]{2,80}$'
      or coalesce(p->>'position_side','') not in ('LONG','SHORT')
      or jsonb_typeof(p->'size') is distinct from 'number' then return false; end if;
    qty := (p->>'size')::numeric;
    if abs(qty)>9007199254740991 or qty=0
      or (qty<0) <> ((p->>'position_side')='SHORT') then return false; end if;
    k := (p->>'contract')||':'||(p->>'position_side');
    if k=any(keys) then return false; end if;
    keys := array_append(keys,k);
  end loop;
  return true;
exception when others then return false;
end;
$$;
revoke all on function private.copy_resume_positions_valid(jsonb) from public, anon, authenticated;

create function private.copy_resume_settings(p_user_id uuid)
returns jsonb language sql stable set search_path=pg_catalog
as $$
  select jsonb_build_object('copy_ratio',copy_ratio,'max_position_ratio',max_position_ratio,
    'daily_loss_limit_pct',daily_loss_limit_pct,'max_drawdown_pct',max_drawdown_pct,
    'max_leverage',max_leverage)
  from public.profiles where id=p_user_id;
$$;
revoke all on function private.copy_resume_settings(uuid) from public, anon, authenticated;

create function private.request_member_copy_resume(p_user_id uuid)
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
    -- Repeated clicks do not reset an in-progress snapshot/version.
    if s.state not in ('REQUESTED','VALIDATED') or s.expires_at<=clock_timestamp() then
      update private.copy_resume_sessions set version=gen_random_uuid(),state='REQUESTED',
        requested_at=clock_timestamp(),requested_by=auth.uid(),
        expires_at=clock_timestamp()+interval '5 minutes',
        snapshot_started_at=null,snapshot_observed_at=null,validated_at=null,activated_at=null,
        master_positions=null,member_positions=null,settings=null,blocker_reason=null,updated_at=now()
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
revoke all on function private.request_member_copy_resume(uuid) from public, anon, authenticated;

create or replace function public.set_my_copy_pause(p_mode text)
returns jsonb language plpgsql security definer set search_path=pg_catalog
as $$
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED'; end if;
  if p_mode is null or p_mode not in ('HOLD','CLOSE','RESUME') then raise exception 'INVALID_PAUSE_MODE'; end if;
  if p_mode='RESUME' then return private.request_member_copy_resume(auth.uid()); end if;
  perform pg_advisory_xact_lock(hashtextextended('maetajak:copy-execution',0));
  update public.profiles set copy_paused=true,close_positions_requested=p_mode='CLOSE',
    reduce_only=case when p_mode='CLOSE' then true else reduce_only end,updated_at=now()
    where id=auth.uid() and role='MEMBER' and approval_status='APPROVED';
  if not found then raise exception 'APPROVED_MEMBER_REQUIRED'; end if;
  if p_mode='CLOSE' then
    insert into private.copy_resume_sessions(trading_account_id,state,activated_at)
      select id,'CLOSING',clock_timestamp() from private.trading_accounts where user_id=auth.uid() and account_role='MEMBER' and status='ACTIVE'
      on conflict(trading_account_id) do update set version=gen_random_uuid(),state='CLOSING',activated_at=clock_timestamp(),updated_at=now();
  end if;
  update private.copy_resume_sessions s set state='PAUSED',blocker_reason='MEMBER_PAUSED',updated_at=now()
    from private.trading_accounts a where a.id=s.trading_account_id and a.user_id=auth.uid() and p_mode='HOLD';
  update private.copy_order_intents set status='CANCELLED',resolved_at=now(),updated_at=now()
    where user_id=auth.uid() and status in ('PLANNED','QUEUED') and submit_attempts=0;
  insert into public.copy_events(user_id,event_type,severity,safe_payload)
    values(auth.uid(),'SYMBOL_PAUSED','INFO',jsonb_build_object('mode',p_mode));
  return jsonb_build_object('mode',p_mode,'copy_paused',true,'close_positions_requested',p_mode='CLOSE');
end;
$$;
revoke all on function public.set_my_copy_pause(text) from public, anon;
grant execute on function public.set_my_copy_pause(text) to authenticated;

create or replace function public.set_member_copy_control(p_user_id uuid,p_mode text,p_reason text default null)
returns jsonb language plpgsql security definer set search_path=pg_catalog
as $$
declare result jsonb;
begin
  if not public.is_approved_admin() then raise exception 'ADMIN_REQUIRED'; end if;
  if p_mode is null or p_mode not in ('PAUSE','REDUCE_ONLY','HALT','RESUME') then raise exception 'INVALID_CONTROL_MODE'; end if;
  perform pg_advisory_xact_lock(hashtextextended('maetajak:copy-execution',0));
  if p_mode='RESUME' then
    update public.profiles set member_halted=false where id=p_user_id and role='MEMBER';
    result:=private.request_member_copy_resume(p_user_id);
  else
    update public.profiles set copy_paused=p_mode in ('PAUSE','HALT'),member_halted=p_mode='HALT',
      reduce_only=p_mode='REDUCE_ONLY',close_positions_requested=false,updated_at=now()
      where id=p_user_id and role='MEMBER';
    if not found then raise exception 'MEMBER_NOT_FOUND'; end if;
    update private.copy_resume_sessions s set
      state=case when p_mode='REDUCE_ONLY' and s.state='ACTIVE' then 'ACTIVE' else 'PAUSED' end,
      blocker_reason='ADMIN_'||p_mode,updated_at=now()
      from private.trading_accounts a where a.id=s.trading_account_id and a.user_id=p_user_id;
    update private.copy_order_intents set status='CANCELLED',resolved_at=now(),updated_at=now()
      where user_id=p_user_id and status in ('PLANNED','QUEUED') and submit_attempts=0;
    result:=jsonb_build_object('mode',p_mode);
  end if;
  insert into public.admin_audit_logs(actor_id,action,target_user_id,next_value)
    values(auth.uid(),'MEMBER_COPY_CONTROL_UPDATED',p_user_id,
      jsonb_build_object('mode',p_mode,'reason',left(p_reason,160)));
  return result||jsonb_build_object('user_id',p_user_id);
end;
$$;
revoke all on function public.set_member_copy_control(uuid,text,text) from public, anon;
grant execute on function public.set_member_copy_control(uuid,text,text) to authenticated;

create function public.get_copy_resume_context()
returns jsonb language plpgsql security definer set search_path=pg_catalog
as $$
begin
  perform private.require_copy_worker_role();
  return (select coalesce(jsonb_agg(jsonb_build_object(
    'trading_account_id',a.id,'version',s.version,'state',coalesce(s.state,'REQUIRED'),
    'requested_at',s.requested_at,'expires_at',s.expires_at,'blocker_reason',s.blocker_reason,
    'unresolved_orders',(select count(*) from private.copy_order_intents i
      where i.trading_account_id=a.id and i.status in ('SUBMITTING','ACKNOWLEDGED','PARTIALLY_FILLED','UNKNOWN')
      and not i.exchange_terminal),
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
revoke all on function public.get_copy_resume_context() from public, anon, authenticated;
grant execute on function public.get_copy_resume_context() to service_role;

create function public.report_member_copy_resume_blocker(p_trading_account_id uuid,p_version uuid,p_reason text)
returns void language plpgsql security definer set search_path=pg_catalog
as $$
begin
  perform private.require_copy_worker_role();
  update private.copy_resume_sessions set blocker_reason=left(p_reason,80),
    state=case when expires_at<=clock_timestamp() then 'BLOCKED' else state end,updated_at=now()
    where trading_account_id=p_trading_account_id and version=p_version and state in ('REQUESTED','VALIDATED');
end;
$$;
revoke all on function public.report_member_copy_resume_blocker(uuid,uuid,text) from public, anon, authenticated;
grant execute on function public.report_member_copy_resume_blocker(uuid,uuid,text) to service_role;

create function public.prepare_member_copy_resume(p_trading_account_id uuid,p_version uuid,p_snapshot jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog
as $$
declare s private.copy_resume_sessions; uid uuid; started timestamptz; observed timestamptz;
begin
  perform private.require_copy_worker_role();
  perform pg_advisory_xact_lock(hashtextextended('maetajak:copy-execution',0));
  select * into s from private.copy_resume_sessions where trading_account_id=p_trading_account_id for update;
  if not found or s.version is distinct from p_version or s.state not in ('REQUESTED','VALIDATED')
    or s.expires_at<=clock_timestamp() then raise exception 'RESUME_VERSION_OR_STATE_CHANGED'; end if;
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
    settings=private.copy_resume_settings(uid),validated_at=clock_timestamp(),blocker_reason=null,updated_at=now()
    where trading_account_id=p_trading_account_id;
  insert into private.member_copy_onboarding_baselines(trading_account_id,positions,member_positions,initialized_at,updated_at,resume_version)
    values(p_trading_account_id,p_snapshot->'master_positions',p_snapshot->'member_positions',observed,now(),p_version)
    on conflict(trading_account_id) do update set positions=excluded.positions,member_positions=excluded.member_positions,
      initialized_at=excluded.initialized_at,updated_at=now(),resume_version=excluded.resume_version;
  return jsonb_build_object('state','VALIDATED','version',p_version);
end;
$$;
revoke all on function public.prepare_member_copy_resume(uuid,uuid,jsonb) from public, anon, authenticated;
grant execute on function public.prepare_member_copy_resume(uuid,uuid,jsonb) to service_role;

create function public.activate_member_copy_resume(p_trading_account_id uuid,p_version uuid,p_snapshot jsonb)
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

create function public.get_member_copy_resume_status(p_user_id uuid default auth.uid())
returns jsonb language plpgsql security definer set search_path=pg_catalog
as $$
begin
  if auth.uid() is null or (p_user_id<>auth.uid() and not public.is_approved_admin()) then raise exception 'AUTH_REQUIRED'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('state',coalesce(s.state,'REQUIRED'),'requested_at',s.requested_at,
    'activated_at',s.activated_at,'reason',s.blocker_reason)),'[]'::jsonb)
    from private.trading_accounts a left join private.copy_resume_sessions s on s.trading_account_id=a.id
    where a.user_id=p_user_id and a.account_role='MEMBER' and a.status='ACTIVE');
end;
$$;
revoke all on function public.get_member_copy_resume_status(uuid) from public, anon;
grant execute on function public.get_member_copy_resume_status(uuid) to authenticated;

-- A queued order is eligible only under the precise resume generation and
-- current position observation used to plan it. Pause/claim share one lock.
create function private.guard_copy_resume_order()
returns trigger language plpgsql security definer set search_path=pg_catalog
as $$
declare s private.copy_resume_sessions;
begin
  if new.status not in ('PLANNED','QUEUED','SUBMITTING') then return new; end if;
  perform pg_advisory_xact_lock(hashtextextended('maetajak:copy-execution',0));
  select * into s from private.copy_resume_sessions where trading_account_id=new.trading_account_id;
  if coalesce(s.state,'') not in ('ACTIVE','CLOSING') or new.resume_version is distinct from s.version
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
revoke all on function private.guard_copy_resume_order() from public, anon, authenticated;
create trigger guard_copy_resume_order before insert or update of status on private.copy_order_intents
for each row execute function private.guard_copy_resume_order();

create or replace function public.get_copy_order_observation_guards()
returns jsonb language plpgsql security definer set search_path=pg_catalog
as $$
begin
  perform private.require_copy_worker_role();
  return (select coalesce(jsonb_agg(g),'[]'::jsonb) from (
    select distinct i.trading_account_id,i.contract,i.position_side
    from private.copy_order_intents i join private.copy_resume_sessions s
      on s.trading_account_id=i.trading_account_id
    where i.submit_attempts>0 and (i.status in ('SUBMITTING','ACKNOWLEDGED','UNKNOWN')
      or (i.status='PARTIALLY_FILLED' and not i.exchange_terminal)
      or (i.resume_version=s.version and i.filled_size<>0 and i.observation_confirmed_at is null))) g);
end;
$$;
revoke all on function public.get_copy_order_observation_guards() from public, anon, authenticated;
grant execute on function public.get_copy_order_observation_guards() to service_role;

create function public.confirm_copy_order_observation(p_trading_account_id uuid,p_version uuid,p_positions jsonb,p_started_at timestamptz,p_observed_at timestamptz)
returns integer language plpgsql security definer set search_path=pg_catalog
as $$
declare n integer;
begin
  perform private.require_copy_worker_role();
  if p_started_at is null or p_observed_at is null or p_started_at<clock_timestamp()-interval '15 seconds'
    or p_observed_at<p_started_at or p_observed_at>clock_timestamp()+interval '1 second'
    or not private.copy_resume_positions_valid(p_positions) then raise exception 'OBSERVATION_INVALID'; end if;
  perform pg_advisory_xact_lock(hashtextextended('maetajak:copy-execution',0));
  if not exists(select 1 from private.copy_resume_sessions where trading_account_id=p_trading_account_id
    and version=p_version and state in ('ACTIVE','CLOSING')) then return 0; end if;
  with measured as (
    select i.id,abs(coalesce((select (p->>'size')::numeric from jsonb_array_elements(p_positions) p
      where p->>'contract'=i.contract and p->>'position_side'=i.position_side),0)
      -(i.actual_size_at_plan+i.filled_size))<=0.000000001 as matched
    from private.copy_order_intents i where i.trading_account_id=p_trading_account_id and i.resume_version=p_version
      and i.observation_confirmed_at is null and i.filled_size<>0 and p_started_at>i.resolved_at
      and (i.status in ('FILLED','CANCELLED','REJECTED') or i.exchange_terminal)
  )
  update private.copy_order_intents i set
    observation_confirmed_at=case when m.matched and i.position_match_at is not null
      and p_started_at>=i.position_match_at+interval '2 seconds' then p_observed_at end,
    position_match_at=case when m.matched then coalesce(i.position_match_at,p_observed_at) end
    from measured m where m.id=i.id;
  get diagnostics n=row_count;
  return n;
end;
$$;
revoke all on function public.confirm_copy_order_observation(uuid,uuid,jsonb,timestamptz,timestamptz) from public, anon, authenticated;
grant execute on function public.confirm_copy_order_observation(uuid,uuid,jsonb,timestamptz,timestamptz) to service_role;

-- The recorder supplies the resume version; old worker payloads cannot create orders.
-- Existing read-only polling RPCs remain compatible during the DB-first rollout.


drop function if exists public.claim_copy_order_intents(integer);
create function public.claim_copy_order_intents(p_limit integer default 10)
returns table(intent_id uuid,user_id uuid,contract text,position_side text,delta_size numeric,
  reduce_only boolean,target_leverage numeric,margin_mode text,position_mode text,pid text,
  gate_order_text text,idempotency_key text,api_key text,secret_key text,slippage_ratio numeric,
  trading_account_id uuid,resume_version uuid,source_observed_at timestamptz)
language plpgsql security definer set search_path=pg_catalog,extensions
as $$
declare item private.copy_order_intents; claimed private.copy_order_intents; encryption_key text;
begin
  perform private.require_copy_worker_role();
  perform pg_advisory_xact_lock(hashtextextended('maetajak:copy-execution',0));
  if not exists(select 1 from public.copy_system_control c cross join private.copy_worker_runtime r
    where c.singleton and r.singleton and c.execution_enabled and not c.emergency_halted
      and r.mode='LIVE' and r.worker_version='0.4.0' and r.gate_base_url='https://api.gateio.ws'
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
        claimed.trading_account_id,claimed.resume_version,claimed.source_observed_at
      from private.trading_accounts a join private.gate_api_credentials g on g.user_id=a.credential_user_id
        cross join public.copy_system_control c where a.id=claimed.trading_account_id and c.singleton;
    end if;
  end loop;
end;
$$;
revoke all on function public.claim_copy_order_intents(integer) from public,anon,authenticated;
grant execute on function public.claim_copy_order_intents(integer) to service_role;

create function public.authorize_copy_order_submission(p_intent_id uuid,p_version uuid)
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
      and r.singleton and r.mode='LIVE' and r.worker_version='0.4.0'
      and r.heartbeat_at>now()-interval '30 seconds' and r.consecutive_failures=0) into permitted;
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

create function public.clear_member_copy_resume_baseline_legs(p_trading_account_id uuid,p_version uuid,p_positions jsonb)
returns void language plpgsql security definer set search_path=pg_catalog
as $$
begin
  perform private.require_copy_worker_role();
  perform pg_advisory_xact_lock(hashtextextended('maetajak:copy-execution',0));
  if not exists(select 1 from private.copy_resume_sessions where trading_account_id=p_trading_account_id
    and version=p_version and state='ACTIVE') then raise exception 'RESUME_VERSION_OR_STATE_CHANGED'; end if;
  update private.member_copy_onboarding_baselines b set positions=coalesce((
    select jsonb_agg(p) from jsonb_array_elements(b.positions) p where not exists(
      select 1 from jsonb_array_elements(p_positions) c where c->>'contract'=p->>'contract' and c->>'position_side'=p->>'position_side'
    )),'[]'::jsonb),updated_at=now()
    where b.trading_account_id=p_trading_account_id and b.resume_version=p_version;
end;
$$;
revoke all on function public.clear_member_copy_resume_baseline_legs(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.clear_member_copy_resume_baseline_legs(uuid,uuid,jsonb) to service_role;


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
      set member_halted = true, updated_at = now()
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
    or coalesce(p_error_code,'') like '%ORDER_QUANTITY_MISMATCH%' then
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
  if p_filled_size is null or abs(p_filled_size)>abs(target.delta_size)
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


create function private.invalidate_member_copy_resume()
returns trigger language plpgsql security definer set search_path=pg_catalog
as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('maetajak:copy-execution',0));
  if new.copy_paused or new.member_halted or new.approval_status<>'APPROVED'
    or row(new.copy_ratio,new.max_position_ratio,new.daily_loss_limit_pct,new.max_drawdown_pct,new.max_leverage)
      is distinct from row(old.copy_ratio,old.max_position_ratio,old.daily_loss_limit_pct,old.max_drawdown_pct,old.max_leverage) then
    update private.copy_resume_sessions s set state='PAUSED',blocker_reason='MEMBER_CONTROL_CHANGED',updated_at=now()
      from private.trading_accounts a where a.id=s.trading_account_id and a.user_id=new.id
        and s.state='ACTIVE';
    if row(new.copy_ratio,new.max_position_ratio,new.daily_loss_limit_pct,new.max_drawdown_pct,new.max_leverage)
      is distinct from row(old.copy_ratio,old.max_position_ratio,old.daily_loss_limit_pct,old.max_drawdown_pct,old.max_leverage) then
      new.copy_paused:=true;
      update private.copy_resume_sessions s set state='PAUSED',blocker_reason='COPY_SETTINGS_CHANGED',updated_at=now()
        from private.trading_accounts a where a.id=s.trading_account_id and a.user_id=new.id;
    end if;
  end if;
  if old.copy_paused and not new.copy_paused and new.role='MEMBER'
    and exists(select 1 from private.trading_accounts a left join private.copy_resume_sessions s on s.trading_account_id=a.id
      where a.user_id=new.id and a.status='ACTIVE' and a.account_role='MEMBER' and coalesce(s.state,'REQUIRED')<>'ACTIVE') then
    raise exception 'VALIDATED_RESUME_REQUIRED';
  end if;
  return new;
end;
$$;
revoke all on function private.invalidate_member_copy_resume() from public,anon,authenticated;
create trigger invalidate_member_copy_resume before update of copy_paused,member_halted,approval_status,copy_ratio,max_position_ratio,daily_loss_limit_pct,max_drawdown_pct,max_leverage
on public.profiles for each row execute function private.invalidate_member_copy_resume();

create function private.invalidate_copy_account_resume()
returns trigger language plpgsql security definer set search_path=pg_catalog
as $$
begin
  if old.status is distinct from new.status then
    perform pg_advisory_xact_lock(hashtextextended('maetajak:copy-execution',0));
    update private.copy_resume_sessions set state='PAUSED',blocker_reason='TRADING_ACCOUNT_CHANGED',updated_at=now()
      where trading_account_id=new.id or new.account_role='MASTER';
  end if;
  return new;
end;
$$;
revoke all on function private.invalidate_copy_account_resume() from public,anon,authenticated;
create trigger invalidate_copy_account_resume after update of status on private.trading_accounts
for each row execute function private.invalidate_copy_account_resume();

create function private.invalidate_copy_credential_resume()
returns trigger language plpgsql security definer set search_path=pg_catalog
as $$
begin
  if row(old.status,old.api_key_ciphertext,old.secret_key_ciphertext,old.gate_uid)
    is distinct from row(new.status,new.api_key_ciphertext,new.secret_key_ciphertext,new.gate_uid) then
    perform pg_advisory_xact_lock(hashtextextended('maetajak:copy-execution',0));
    update private.copy_resume_sessions s set state='PAUSED',blocker_reason='GATE_CREDENTIAL_CHANGED',updated_at=now()
      where exists(select 1 from private.trading_accounts a where a.credential_user_id=new.user_id
        and (a.account_role='MASTER' or a.id=s.trading_account_id));
  end if;
  return new;
end;
$$;
revoke all on function private.invalidate_copy_credential_resume() from public,anon,authenticated;
create trigger invalidate_copy_credential_resume after update of status,api_key_ciphertext,secret_key_ciphertext,gate_uid
on private.gate_api_credentials for each row execute function private.invalidate_copy_credential_resume();

create function public.get_copy_safety_version()
returns jsonb language plpgsql security definer set search_path=pg_catalog
as $$
begin
  perform private.require_copy_worker_role();
  return jsonb_build_object('schema_version',2,'worker_version','0.4.0','resume_requires_validation',true);
end;
$$;
revoke all on function public.get_copy_safety_version() from public,anon,authenticated;
grant execute on function public.get_copy_safety_version() to service_role;


CREATE OR REPLACE FUNCTION public.claim_copy_reconciliation_jobs(p_limit integer DEFAULT 10)
 RETURNS TABLE(job_id bigint, intent_id uuid, contract text, gate_order_id text, gate_order_text text, api_key text, secret_key text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
declare encryption_key text;
begin
  perform private.require_copy_worker_role();
  perform pg_advisory_xact_lock(hashtextextended('maetajak:copy-execution',0));
  -- A new-generation claim that was never authorized cannot have reached Gate.
  update private.copy_order_intents set status='CANCELLED',exchange_terminal=true,resolved_at=now(),
    last_error_code='UNSENT_CLAIM_EXPIRED',updated_at=now()
    where resume_version is not null and status='SUBMITTING' and submission_authorized_at is null
      and gate_order_id is null and submitted_at<now()-interval '30 seconds';
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
    pgp_sym_decrypt(g.secret_key_ciphertext,encryption_key)
  from updated u
  join private.copy_order_intents i on i.id=u.intent_id
  join private.trading_accounts a on a.id=i.trading_account_id
  join private.gate_api_credentials g on g.user_id=a.credential_user_id;
end;
$function$;



create function public.advance_member_copy_resume_baseline_legs(p_trading_account_id uuid,p_version uuid,p_positions jsonb)
returns void language plpgsql security definer set search_path=pg_catalog
as $$
begin
  perform private.require_copy_worker_role();
  perform pg_advisory_xact_lock(hashtextextended('maetajak:copy-execution',0));
  if not exists(select 1 from private.copy_resume_sessions where trading_account_id=p_trading_account_id
    and version=p_version and state='ACTIVE') then raise exception 'RESUME_VERSION_OR_STATE_CHANGED'; end if;
  if jsonb_typeof(p_positions) is distinct from 'array' then raise exception 'BASELINE_UPDATE_INVALID'; end if;
  update private.member_copy_onboarding_baselines b set positions=coalesce((
    select jsonb_agg(jsonb_build_object('contract',q.contract,'position_side',q.side,'size',q.size)) from (
      select p->>'contract' as contract,p->>'position_side' as side,
        case when c is null then (p->>'size')::numeric
          when sign((p->>'size')::numeric)<>sign((c->>'size')::numeric) then 0
          else sign((p->>'size')::numeric)*least(abs((p->>'size')::numeric),abs((c->>'size')::numeric)) end as size
      from jsonb_array_elements(b.positions) p left join lateral (
        select c from jsonb_array_elements(p_positions) c
        where c->>'contract'=p->>'contract' and c->>'position_side'=p->>'position_side' limit 1
      ) change on true
    ) q where q.size<>0),'[]'::jsonb),updated_at=now()
    where b.trading_account_id=p_trading_account_id and b.resume_version=p_version;
end;
$$;
revoke all on function public.advance_member_copy_resume_baseline_legs(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.advance_member_copy_resume_baseline_legs(uuid,uuid,jsonb) to service_role;

notify pgrst, 'reload schema';
