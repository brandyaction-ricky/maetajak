-- CT-QA-RESUME-OWNERSHIP-001. Definitions only; no production backfill, member
-- activation, execution flag changes, order cancellation or reconciliation.
-- Old fill aggregates are NOT ownership evidence. Start a journal only from a
-- verified pre-fill baseline, then consume each observed terminal fill once.
create table private.copy_ownership_checkpoints (
  trading_account_id uuid primary key references private.trading_accounts(id),
  resume_version uuid not null,
  revision bigint not null default 1,
  status text not null check(status in ('CONFIRMED','UNKNOWN')),
  protected_positions jsonb not null,
  copy_positions jsonb not null default '[]',
  observed_at timestamptz not null,
  source_cycle_id uuid,
  reason text
);
create table private.copy_ownership_fills (
  intent_id uuid primary key references private.copy_order_intents(id),
  trading_account_id uuid not null references private.copy_ownership_checkpoints(trading_account_id),
  resume_version uuid not null,
  filled_size numeric not null,
  confirmed_at timestamptz not null
);
create index copy_ownership_fills_account_idx on private.copy_ownership_fills(trading_account_id);
create index copy_ownership_intents_account_idx on private.copy_order_intents(trading_account_id,resolved_at,id) where filled_size<>0;
alter table private.copy_ownership_checkpoints enable row level security;
alter table private.copy_ownership_fills enable row level security;
revoke all on private.copy_ownership_checkpoints,private.copy_ownership_fills from public,anon,authenticated,service_role;
alter table private.member_copy_onboarding_baselines add column copy_positions jsonb not null default '[]';
alter table private.copy_resume_sessions add column validation_evidence jsonb;

-- Canonical, signed, per-leg arithmetic; never net LONG against SHORT.
create function private.copy_position_sum(p_positions jsonb)
returns jsonb language sql immutable set search_path=pg_catalog as $$
  select coalesce(jsonb_agg(jsonb_build_object('contract',contract,'position_side',side,'size',size)
    order by contract,side),'[]') from (
    select p->>'contract' contract,p->>'position_side' side,sum((p->>'size')::numeric) size
    from jsonb_array_elements(p_positions) p group by 1,2 having sum((p->>'size')::numeric)<>0
  ) positions
$$;
revoke all on function private.copy_position_sum(jsonb) from public,anon,authenticated;

create function private.observe_copy_ownership()
returns trigger language plpgsql security definer set search_path=pg_catalog as $$
declare proof private.copy_ownership_checkpoints; baseline private.member_copy_onboarding_baselines;
  actual jsonb; copied jsonb; expected jsonb; item private.copy_order_intents;
  applied uuid[] := '{}'; invalid boolean := false;
begin
  if new.status<>'VERIFIED' then return new; end if;
  perform pg_advisory_xact_lock(hashtextextended('maetajak:copy-execution',0));
  select * into baseline from private.member_copy_onboarding_baselines where trading_account_id=new.trading_account_id;
  if not found then return new; end if; -- not a member baseline
  select private.copy_position_sum(coalesce(jsonb_agg(jsonb_build_object('contract',p.contract,
    'position_side',p.position_side,'size',p.size)),'[]')) into actual
    from private.copy_current_positions p where p.trading_account_id=new.trading_account_id and p.copy_cycle_id=new.cycle_id;
  select * into proof from private.copy_ownership_checkpoints where trading_account_id=new.trading_account_id for update;
  if not found then
    -- A migration must not silently bless an already traded/legacy account.
    if exists(select 1 from private.copy_order_intents where trading_account_id=new.trading_account_id and filled_size<>0)
      or actual is distinct from private.copy_position_sum(baseline.member_positions) then return new; end if;
    insert into private.copy_ownership_checkpoints(trading_account_id,resume_version,status,
      protected_positions,observed_at,source_cycle_id)
      values(new.trading_account_id,baseline.resume_version,'CONFIRMED',actual,new.observed_at,new.cycle_id);
    return new;
  end if;
  if proof.status='UNKNOWN' or new.observed_at<=proof.observed_at then return new; end if;
  -- A pending/ambiguous fill is not failure and is not reusable ownership.
  if exists(select 1 from private.copy_order_intents i where i.trading_account_id=new.trading_account_id
    and ((i.submit_attempts>0 and i.status in ('SUBMITTING','ACKNOWLEDGED','UNKNOWN','PARTIALLY_FILLED') and not i.exchange_terminal)
      or (i.filled_size<>0 and i.observation_confirmed_at is null))) then return new; end if;
  copied:=proof.copy_positions;
  for item in select i.* from private.copy_order_intents i
    where i.trading_account_id=new.trading_account_id and i.filled_size<>0
      and not exists(select 1 from private.copy_ownership_fills f where f.intent_id=i.id)
    order by i.resolved_at,i.id
  loop
    expected:=private.copy_position_sum(proof.protected_positions||copied);
    if item.resume_version is distinct from proof.resume_version or item.observation_confirmed_at is null
      -- cycle observed_at is the read START, confirmation is the account read
      -- END. Compare to this verified write, not to the earlier cycle start.
      or item.observation_confirmed_at>new.verified_at
      or (not item.exchange_terminal and item.status not in ('FILLED','CANCELLED','REJECTED'))
      or item.actual_size_at_plan is distinct from coalesce((select (p->>'size')::numeric
        from jsonb_array_elements(expected) p where p->>'contract'=item.contract and p->>'position_side'=item.position_side),0)
      then invalid:=true; exit; end if;
    copied:=private.copy_position_sum(copied||jsonb_build_array(jsonb_build_object(
      'contract',item.contract,'position_side',item.position_side,'size',item.filled_size)));
    applied:=array_append(applied,item.id);
  end loop;
  if invalid or not private.copy_resume_positions_valid(copied)
    or actual is distinct from private.copy_position_sum(proof.protected_positions||copied)
    or exists(select 1 from private.copy_ownership_fills f join private.copy_order_intents i on i.id=f.intent_id
      where f.trading_account_id=new.trading_account_id and (f.filled_size<>i.filled_size
        or f.resume_version is distinct from i.resume_version or f.confirmed_at is distinct from i.observation_confirmed_at)) then
    update private.copy_ownership_checkpoints set status='UNKNOWN',reason='OBSERVED_OWNERSHIP_MISMATCH',revision=revision+1
      where trading_account_id=new.trading_account_id;
    -- Only unsubmitted engine candidates, never Gate orders, are invalidated.
    update private.copy_order_intents set status='CANCELLED',last_error_code='COPY_OWNERSHIP_UNKNOWN',updated_at=now()
      where trading_account_id=new.trading_account_id and status in ('PLANNED','QUEUED') and submit_attempts=0;
    update public.copy_position_states set state=case when state='MANUAL_OVERRIDE' then state else 'PAUSED' end,
      pause_reason='COPY_OWNERSHIP_UNKNOWN'
      where trading_account_id=new.trading_account_id;
  else
    insert into private.copy_ownership_fills(intent_id,trading_account_id,resume_version,filled_size,confirmed_at)
      select id,trading_account_id,resume_version,filled_size,observation_confirmed_at
      from private.copy_order_intents where id=any(applied);
    update private.copy_ownership_checkpoints set copy_positions=copied,observed_at=new.observed_at,
      source_cycle_id=new.cycle_id,revision=revision+1 where trading_account_id=new.trading_account_id;
  end if;
  return new;
end;
$$;
revoke all on function private.observe_copy_ownership() from public,anon,authenticated;
create trigger copy_ownership_after_verified_cycle after insert or update on private.copy_current_verifications
  for each row execute function private.observe_copy_ownership();

create function private.copy_resume_ownership(p_account uuid,p_version uuid,p_master jsonb,p_member jsonb)
returns jsonb language plpgsql set search_path=pg_catalog as $$
declare proof private.copy_ownership_checkpoints; protected jsonb; copied jsonb; masters jsonb; anchors jsonb;
begin
  if not private.copy_resume_positions_valid(p_master) or not private.copy_resume_positions_valid(p_member)
    then raise exception 'RESUME_POLICY_EVIDENCE_REQUIRED'; end if;
  if exists(select 1 from private.copy_order_intents i where i.trading_account_id=p_account
    and ((i.submit_attempts>0 and i.status in ('SUBMITTING','ACKNOWLEDGED','UNKNOWN','PARTIALLY_FILLED') and not i.exchange_terminal)
      or (i.filled_size<>0 and i.observation_confirmed_at is null))) then raise exception 'RESUME_UNRESOLVED_OWNERSHIP'; end if;
  select * into proof from private.copy_ownership_checkpoints where trading_account_id=p_account;
  if found then
    if proof.status<>'CONFIRMED'
      or private.copy_position_sum(p_member) is distinct from private.copy_position_sum(proof.protected_positions||proof.copy_positions)
      or exists(select 1 from private.copy_order_intents i where i.trading_account_id=p_account and i.filled_size<>0
        and not exists(select 1 from private.copy_ownership_fills f where f.intent_id=i.id and f.filled_size=i.filled_size
          and f.resume_version=i.resume_version and f.confirmed_at=i.observation_confirmed_at))
      then raise exception 'RESUME_COPY_OWNERSHIP_UNKNOWN'; end if;
    protected:=proof.protected_positions; copied:=proof.copy_positions;
  else
    if exists(select 1 from private.copy_order_intents where trading_account_id=p_account and filled_size<>0)
      then raise exception 'RESUME_COPY_OWNERSHIP_UNKNOWN'; end if;
    -- First enrollment, no platform fills: protect pre-existing holdings. This
    -- is protection by policy, NOT a claim that these are known personal trades.
    protected:=private.copy_position_sum(p_member); copied:='[]';
  end if;
  if exists(select 1 from jsonb_array_elements(copied) c where not exists(
    select 1 from jsonb_array_elements(p_master) m where m->>'contract'=c->>'contract'
      and m->>'position_side'=c->>'position_side' and sign((m->>'size')::numeric)=sign((c->>'size')::numeric)))
    then raise exception 'RESUME_COPY_SOURCE_MISSING'; end if;
  select coalesce(jsonb_agg(m order by m->>'contract',m->>'position_side'),'[]') into masters
    from jsonb_array_elements(p_master) m where not exists(select 1 from jsonb_array_elements(copied) c
      where c->>'contract'=m->>'contract' and c->>'position_side'=m->>'position_side');
  select coalesce(jsonb_agg(jsonb_build_object('contract',c->>'contract','position_side',c->>'position_side',
    'resume_version',p_version,'master_copyable_size',(m->>'size')::numeric,
    'target_size',(c->>'size')::numeric+coalesce((p->>'size')::numeric,0),
    'protected_member_size',coalesce((p->>'size')::numeric,0),
    'lock_reason','CONFIRMED_COPY_CONTINUATION') order by c->>'contract',c->>'position_side'),'[]') into anchors
    from jsonb_array_elements(copied) c
    join jsonb_array_elements(p_master) m on m->>'contract'=c->>'contract' and m->>'position_side'=c->>'position_side'
    left join jsonb_array_elements(protected) p on p->>'contract'=c->>'contract' and p->>'position_side'=c->>'position_side';
  return jsonb_build_object('revision',coalesce(proof.revision,0),'source_resume_version',proof.resume_version,
    'master_positions',masters,'member_positions',protected,'copy_positions',copied,'target_anchors',anchors);
end;
$$;
revoke all on function private.copy_resume_ownership(uuid,uuid,jsonb,jsonb) from public,anon,authenticated;
create function public.get_member_copy_resume_ownership(p_trading_account_id uuid,p_version uuid,p_master_positions jsonb,p_member_positions jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
begin
  perform private.require_copy_worker_role();
  perform pg_advisory_xact_lock(hashtextextended('maetajak:copy-execution',0));
  if not exists(select 1 from private.copy_resume_sessions where trading_account_id=p_trading_account_id
    and version=p_version and state in ('REQUESTED','VALIDATED')) then raise exception 'RESUME_VERSION_OR_STATE_CHANGED'; end if;
  return private.copy_resume_ownership(p_trading_account_id,p_version,p_master_positions,p_member_positions);
end;
$$;
revoke all on function public.get_member_copy_resume_ownership(uuid,uuid,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.get_member_copy_resume_ownership(uuid,uuid,jsonb,jsonb) to service_role;

-- Keep v1 for flat NEW_OPERATION / fill-free first enrollment. An old worker
-- cannot silently convert confirmed or legacy COPY exposure to personal stock.
alter function private.assert_copy_resume_policy(uuid,uuid,jsonb) rename to assert_copy_resume_policy_v1;
create function private.assert_copy_resume_policy(p_account uuid,p_version uuid,p_snapshot jsonb)
returns void language plpgsql set search_path=pg_catalog as $$
declare ownership jsonb;
begin
  if exists(select 1 from private.copy_ownership_checkpoints where trading_account_id=p_account and status='UNKNOWN')
    then raise exception 'RESUME_COPY_OWNERSHIP_UNKNOWN'; end if;
  if not private.copy_resume_policy_authorized(p_account,p_version) then raise exception 'RESUME_CURRENT_MASTER_AUTHORIZATION_REQUIRED'; end if;
  if p_snapshot->>'resume_policy_version'='2' then
    if private.copy_resume_operation_id(p_account,p_version) is not null
      or p_snapshot->>'resume_mode' is distinct from 'FUTURE_ONLY'
      or p_snapshot->>'current_master_operation_id' is not null then raise exception 'RESUME_FUTURE_ONLY_BASELINE_REQUIRED'; end if;
    ownership:=private.copy_resume_ownership(p_account,p_version,p_snapshot->'observed_master_positions',p_snapshot->'observed_member_positions');
    if p_snapshot->'ownership' is distinct from ownership
      or p_snapshot->'master_positions' is distinct from ownership->'master_positions'
      or p_snapshot->'member_positions' is distinct from ownership->'member_positions'
      then raise exception 'RESUME_OWNERSHIP_EVIDENCE_CHANGED'; end if;
  else
    perform private.assert_copy_resume_policy_v1(p_account,p_version,p_snapshot);
    if private.copy_resume_operation_id(p_account,p_version) is null then
      ownership:=private.copy_resume_ownership(p_account,p_version,p_snapshot->'observed_master_positions',p_snapshot->'observed_member_positions');
      if ownership->'copy_positions'<>'[]'::jsonb then raise exception 'RESUME_OWNERSHIP_POLICY_REQUIRED'; end if;
    end if;
  end if;
end;
$$;
revoke all on function private.assert_copy_resume_policy(uuid,uuid,jsonb) from public,anon,authenticated;

-- Private implementation functions cannot be invoked as alternate public RPCs.
alter function public.prepare_member_copy_resume(uuid,uuid,jsonb) set schema private;
alter function private.prepare_member_copy_resume(uuid,uuid,jsonb) rename to prepare_member_copy_resume_core;
revoke all on function private.prepare_member_copy_resume_core(uuid,uuid,jsonb) from public,anon,authenticated,service_role;
create function public.prepare_member_copy_resume(p_trading_account_id uuid,p_version uuid,p_snapshot jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare result jsonb; anchor jsonb;
begin
  perform private.require_copy_worker_role();
  perform pg_advisory_xact_lock(hashtextextended('maetajak:copy-execution',0));
  perform private.assert_copy_resume_policy(p_trading_account_id,p_version,p_snapshot);
  result:=private.prepare_member_copy_resume_core(p_trading_account_id,p_version,p_snapshot);
  update private.copy_resume_sessions set validation_evidence=p_snapshot - 'started_at' - 'observed_at'
    where trading_account_id=p_trading_account_id;
  update private.member_copy_onboarding_baselines set copy_positions=coalesce(p_snapshot->'ownership'->'copy_positions','[]')
    where trading_account_id=p_trading_account_id;
  for anchor in select value from jsonb_array_elements(coalesce(p_snapshot->'ownership'->'target_anchors','[]')) loop
    insert into private.copy_target_anchors(trading_account_id,contract,position_side,resume_version,
      master_copyable_size,target_size,protected_member_size,lock_reason,observed_at)
    values(p_trading_account_id,anchor->>'contract',anchor->>'position_side',p_version,
      (anchor->>'master_copyable_size')::numeric,(anchor->>'target_size')::numeric,
      (anchor->>'protected_member_size')::numeric,'CONFIRMED_COPY_CONTINUATION',(p_snapshot->>'observed_at')::timestamptz)
    on conflict(trading_account_id,contract,position_side) do update set resume_version=excluded.resume_version,
      master_copyable_size=excluded.master_copyable_size,target_size=excluded.target_size,
      protected_member_size=excluded.protected_member_size,lock_reason=excluded.lock_reason,
      observed_at=excluded.observed_at,updated_at=now();
  end loop;
  return result;
end;
$$;
revoke all on function public.prepare_member_copy_resume(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.prepare_member_copy_resume(uuid,uuid,jsonb) to service_role;

alter function public.activate_member_copy_resume(uuid,uuid,jsonb) set schema private;
alter function private.activate_member_copy_resume(uuid,uuid,jsonb) rename to activate_member_copy_resume_core;
revoke all on function private.activate_member_copy_resume_core(uuid,uuid,jsonb) from public,anon,authenticated,service_role;
create function public.activate_member_copy_resume(p_trading_account_id uuid,p_version uuid,p_snapshot jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare result jsonb;
begin
  perform private.require_copy_worker_role();
  perform pg_advisory_xact_lock(hashtextextended('maetajak:copy-execution',0));
  perform private.assert_copy_resume_policy(p_trading_account_id,p_version,p_snapshot);
  if not exists(select 1 from private.copy_resume_sessions where trading_account_id=p_trading_account_id
    and version=p_version and validation_evidence=p_snapshot - 'started_at' - 'observed_at')
    then raise exception 'RESUME_OWNERSHIP_EVIDENCE_CHANGED'; end if;
  if exists(select 1 from jsonb_array_elements(coalesce(p_snapshot->'ownership'->'target_anchors','[]')) a
    where not exists(select 1 from private.copy_target_anchors t where t.trading_account_id=p_trading_account_id
      and t.contract=a->>'contract' and t.position_side=a->>'position_side' and t.resume_version=p_version
      and t.master_copyable_size=(a->>'master_copyable_size')::numeric and t.target_size=(a->>'target_size')::numeric
      and t.protected_member_size=(a->>'protected_member_size')::numeric))
    then raise exception 'RESUME_OWNERSHIP_ANCHOR_CHANGED'; end if;
  result:=private.activate_member_copy_resume_core(p_trading_account_id,p_version,p_snapshot);
  if result->>'state'='ACTIVE' then
    insert into private.copy_ownership_checkpoints(trading_account_id,resume_version,status,protected_positions,copy_positions,observed_at)
      values(p_trading_account_id,p_version,'CONFIRMED',p_snapshot->'member_positions',
        coalesce(p_snapshot->'ownership'->'copy_positions','[]'),(p_snapshot->>'observed_at')::timestamptz)
      on conflict(trading_account_id) do update set resume_version=excluded.resume_version,status='CONFIRMED',
        protected_positions=excluded.protected_positions,copy_positions=excluded.copy_positions,
        observed_at=excluded.observed_at,revision=private.copy_ownership_checkpoints.revision+1,reason=null;
  end if;
  return result;
end;
$$;
revoke all on function public.activate_member_copy_resume(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.activate_member_copy_resume(uuid,uuid,jsonb) to service_role;

alter function public.get_copy_resume_context() set schema private;
alter function private.get_copy_resume_context() rename to get_copy_resume_context_core;
revoke all on function private.get_copy_resume_context_core() from public,anon,authenticated,service_role;
create function public.get_copy_resume_context()
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
begin
  perform private.require_copy_worker_role();
  return (select coalesce(jsonb_agg(s||jsonb_build_object('copy_positions',coalesce(b.copy_positions,'[]'),
    'ownership_status',p.status)),'[]') from jsonb_array_elements(private.get_copy_resume_context_core()) s
    left join private.member_copy_onboarding_baselines b on b.trading_account_id=(s->>'trading_account_id')::uuid
    left join private.copy_ownership_checkpoints p on p.trading_account_id=b.trading_account_id);
end;
$$;
revoke all on function public.get_copy_resume_context() from public,anon,authenticated;
grant execute on function public.get_copy_resume_context() to service_role;
create or replace function private.copy_resume_policy_authorized(p_account uuid,p_version uuid)
returns boolean language sql stable set search_path=pg_catalog as $$
  select exists(select 1 from private.copy_resume_sessions s where s.trading_account_id=p_account and s.version=p_version
    and (not s.sync_current_master or private.copy_resume_operation_id(p_account,p_version) is not null))
    and not exists(select 1 from private.copy_ownership_checkpoints where trading_account_id=p_account and status='UNKNOWN')
$$;

-- Serialize the absent/stale-row lease check AND upsert. A singleton row alone
-- does not prevent two different workers from acquiring an expired lease.
create or replace function public.copy_worker_heartbeat(p_worker_id text,p_worker_version text,p_gate_base_url text,
  p_public_ip text default null,p_broker_channel_id text default null,p_mode text default 'OBSERVE',p_test_passed boolean default false)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare runtime private.copy_worker_runtime; expected_channel_id text;
  supplied_channel_id text:=nullif(trim(p_broker_channel_id),''); acquired_at timestamptz;
begin
  perform private.require_copy_worker_role();
  if nullif(trim(p_worker_id),'') is null or length(p_worker_id)>120 or p_worker_id<>trim(p_worker_id) then raise exception 'INVALID_WORKER_ID'; end if;
  if p_mode is null or p_mode not in ('OBSERVE','DRY_RUN','LIVE') then raise exception 'INVALID_WORKER_MODE'; end if;
  if p_test_passed and p_mode<>'DRY_RUN' then raise exception 'DRY_RUN_REQUIRED_FOR_READINESS'; end if;
  select broker_channel_id into expected_channel_id from public.copy_system_control where singleton;
  if supplied_channel_id is not null and supplied_channel_id !~ '^[a-z0-9]{1,19}$' then raise exception 'INVALID_BROKER_CHANNEL_ID'; end if;
  if supplied_channel_id is not null and supplied_channel_id is distinct from expected_channel_id then raise exception 'BROKER_CHANNEL_ID_MISMATCH'; end if;
  if p_mode in ('DRY_RUN','LIVE') and supplied_channel_id is null then raise exception 'BROKER_CHANNEL_ID_REQUIRED'; end if;
  if p_mode='LIVE' and (nullif(trim(p_public_ip),'') is null or p_gate_base_url is distinct from 'https://api.gateio.ws') then raise exception 'LIVE_WORKER_CONFIGURATION_REQUIRED'; end if;
  perform pg_advisory_xact_lock(hashtextextended('maetajak:worker-lease',0));
  acquired_at:=clock_timestamp();
  if exists(select 1 from private.copy_worker_runtime r where r.singleton and r.worker_id is distinct from p_worker_id
    and r.heartbeat_at>acquired_at-interval '30 seconds') then raise exception 'WORKER_LEASE_HELD'; end if;
  insert into private.copy_worker_runtime(singleton,worker_id,worker_version,gate_base_url,public_ip,broker_channel_id,mode,
    heartbeat_at,last_test_passed_at,started_at,updated_at)
  values(true,p_worker_id,left(p_worker_version,80),left(p_gate_base_url,200),nullif(trim(p_public_ip),'')::inet,
    supplied_channel_id,p_mode,acquired_at,case when p_test_passed then acquired_at end,acquired_at,acquired_at)
  on conflict(singleton) do update set worker_id=excluded.worker_id,worker_version=excluded.worker_version,
    gate_base_url=excluded.gate_base_url,public_ip=excluded.public_ip,broker_channel_id=excluded.broker_channel_id,
    mode=excluded.mode,heartbeat_at=excluded.heartbeat_at,
    last_test_passed_at=case when p_test_passed then acquired_at else private.copy_worker_runtime.last_test_passed_at end,
    started_at=case when private.copy_worker_runtime.worker_id is distinct from p_worker_id then acquired_at
      else coalesce(private.copy_worker_runtime.started_at,acquired_at) end,updated_at=acquired_at returning * into runtime;
  return jsonb_build_object('mode',runtime.mode,'broker_channel_id',runtime.broker_channel_id,
    'heartbeat_at',runtime.heartbeat_at,'test_passed_at',runtime.last_test_passed_at);
end;
$$;
revoke all on function public.copy_worker_heartbeat(text,text,text,text,text,text,boolean) from public,anon,authenticated;
grant execute on function public.copy_worker_heartbeat(text,text,text,text,text,text,boolean) to service_role;
