create table private.open_order_cancel_jobs (
  id bigint generated always as identity primary key,
  trading_account_id uuid not null unique references private.trading_accounts(id) on delete cascade,
  state text not null default 'PENDING' check (state in ('PENDING','PROCESSING','SUCCEEDED','FAILED')),
  requested_by uuid references auth.users(id),
  reason text,
  attempts integer not null default 0,
  run_after timestamptz not null default now(),
  claimed_at timestamptz,
  cancelled_count integer,
  remaining_count integer,
  last_error_code text,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table private.open_order_cancel_jobs enable row level security;
revoke all on private.open_order_cancel_jobs from public, anon, authenticated;

create function public.request_cancel_member_open_orders(p_user_id uuid, p_reason text default null)
returns jsonb language plpgsql security definer set search_path=pg_catalog
as $$
declare account_id uuid; job_id bigint;
begin
  if not public.is_approved_admin() then raise exception 'ADMIN_REQUIRED'; end if;
  perform pg_advisory_xact_lock(hashtextextended('maetajak:copy-execution',0));
  if not exists(select 1 from public.copy_system_control where singleton and not execution_enabled and emergency_halted)
    then raise exception 'GLOBAL_HALT_REQUIRED'; end if;
  select a.id into account_id from private.trading_accounts a
    join public.profiles p on p.id=a.user_id
    where a.user_id=p_user_id and a.account_role='MEMBER' and a.status='ACTIVE'
      and p.role='MEMBER' and p.approval_status='APPROVED'
    order by a.created_at limit 1;
  if account_id is null then raise exception 'ACTIVE_MEMBER_ACCOUNT_REQUIRED'; end if;
  update public.profiles set copy_paused=true,member_halted=true,reduce_only=false,
    close_positions_requested=false,updated_at=now() where id=p_user_id;
  update private.copy_resume_sessions set state='PAUSED',blocker_reason='OPEN_ORDER_CANCELLATION_REQUESTED',updated_at=now()
    where trading_account_id=account_id;
  insert into private.open_order_cancel_jobs(trading_account_id,state,requested_by,reason,attempts,run_after,
      claimed_at,cancelled_count,remaining_count,last_error_code,completed_at,updated_at)
    values(account_id,'PENDING',auth.uid(),left(p_reason,160),0,now(),null,null,null,null,null,now())
    on conflict(trading_account_id) do update set state='PENDING',requested_by=excluded.requested_by,
      reason=excluded.reason,attempts=0,run_after=now(),claimed_at=null,cancelled_count=null,
      remaining_count=null,last_error_code=null,completed_at=null,updated_at=now()
    returning id into job_id;
  insert into public.admin_audit_logs(actor_id,action,target_user_id,next_value)
    values(auth.uid(),'OPEN_ORDER_CANCELLATION_REQUESTED',p_user_id,
      jsonb_build_object('job_id',job_id,'reason',left(p_reason,160)));
  return jsonb_build_object('job_id',job_id,'state','PENDING');
end;
$$;
revoke all on function public.request_cancel_member_open_orders(uuid,text) from public,anon;
grant execute on function public.request_cancel_member_open_orders(uuid,text) to authenticated;

create function public.claim_open_order_cancel_jobs(p_limit integer default 5)
returns table(job_id bigint,api_key text,secret_key text)
language plpgsql security definer set search_path=public,extensions,pg_temp
as $$
declare encryption_key text;
begin
  perform private.require_copy_worker_role();
  if not exists(select 1 from public.copy_system_control where singleton and not execution_enabled and emergency_halted)
    then raise exception 'GLOBAL_HALT_REQUIRED'; end if;
  select decrypted_secret into encryption_key from vault.decrypted_secrets where name='gate_api_credentials_key';
  return query with claimed as (
    select j.id from private.open_order_cancel_jobs j
    join private.trading_accounts a on a.id=j.trading_account_id and a.status='ACTIVE' and a.account_role='MEMBER'
    join private.gate_api_credentials g on g.user_id=a.credential_user_id and g.status='VERIFIED' and g.futures_trade
    cross join private.copy_worker_runtime r
    where r.singleton and g.verified_worker_ip=r.public_ip and j.attempts<5 and j.run_after<=now()
      and (j.state in ('PENDING','FAILED') or (j.state='PROCESSING' and j.claimed_at<now()-interval '1 minute'))
    order by j.run_after,j.id for update of j skip locked
    limit greatest(1,least(coalesce(p_limit,5),20))
  ), updated as (
    update private.open_order_cancel_jobs j set state='PROCESSING',claimed_at=now(),attempts=j.attempts+1,updated_at=now()
    from claimed where j.id=claimed.id returning j.*
  )
  select u.id,pgp_sym_decrypt(g.api_key_ciphertext,encryption_key),pgp_sym_decrypt(g.secret_key_ciphertext,encryption_key)
  from updated u join private.trading_accounts a on a.id=u.trading_account_id
  join private.gate_api_credentials g on g.user_id=a.credential_user_id;
end;
$$;
revoke all on function public.claim_open_order_cancel_jobs(integer) from public,anon,authenticated;
grant execute on function public.claim_open_order_cancel_jobs(integer) to service_role;

create function public.complete_open_order_cancel_job(p_job_id bigint,p_success boolean,
  p_cancelled_count integer,p_remaining_count integer,p_error_code text default null)
returns void language plpgsql security definer set search_path=pg_catalog
as $$
declare job private.open_order_cancel_jobs; target_user uuid;
begin
  perform private.require_copy_worker_role();
  select * into job from private.open_order_cancel_jobs where id=p_job_id for update;
  if not found or job.state<>'PROCESSING' then return; end if;
  select user_id into target_user from private.trading_accounts where id=job.trading_account_id;
  if p_success and coalesce(p_remaining_count,-1)<>0 then raise exception 'OPEN_ORDERS_REMAIN'; end if;
  update private.open_order_cancel_jobs set
    state=case when p_success then 'SUCCEEDED' else 'FAILED' end,
    cancelled_count=greatest(coalesce(p_cancelled_count,0),0),remaining_count=p_remaining_count,
    last_error_code=case when p_success then null else left(coalesce(p_error_code,'UNKNOWN'),80) end,
    completed_at=case when p_success then now() else null end,
    claimed_at=null,run_after=case when p_success then run_after else now()+interval '1 minute' end,updated_at=now()
    where id=p_job_id;
  insert into public.copy_events(user_id,event_type,severity,safe_payload)
    values(target_user,case when p_success then 'OPEN_ORDERS_CANCELLED' else 'OPEN_ORDER_CANCEL_FAILED' end,
      case when p_success then 'WARNING' else 'CRITICAL' end,
      jsonb_build_object('cancelled_count',greatest(coalesce(p_cancelled_count,0),0),
        'remaining_count',p_remaining_count,'error_code',left(p_error_code,80)));
end;
$$;
revoke all on function public.complete_open_order_cancel_job(bigint,boolean,integer,integer,text) from public,anon,authenticated;
grant execute on function public.complete_open_order_cancel_job(bigint,boolean,integer,integer,text) to service_role;
