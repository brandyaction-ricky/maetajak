-- Every explicitly requested resume reconciles the platform-managed component
-- to the Master's current portfolio. Independently held quantities are the
-- residual after subtracting durable, confirmed platform fills.
-- No account state or LIVE control is changed by this migration.
alter table private.copy_resume_sessions
  add column sync_current_master boolean not null default false;

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
        sync_current_master=true,updated_at=now()
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
    'sync_current_master',coalesce(s.sync_current_master,false),
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

comment on function public.get_copy_resume_context() is
  'Resume context with current-Master reconciliation and durable platform-fill attribution.';
