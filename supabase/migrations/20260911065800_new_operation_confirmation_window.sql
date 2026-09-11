-- Keep the account observation strict enough for risk resets while allowing an
-- administrator enough time to review the values and enter the required reason.
create or replace function private.member_new_operation_preview(p_user_id uuid)
returns jsonb language plpgsql stable set search_path=pg_catalog
as $$
declare
  p public.profiles; a private.trading_accounts; c private.copy_current_accounts;
  v private.copy_current_verifications; s private.copy_resume_sessions; r private.copy_operation_risk;
  blockers text[]:='{}'; settings jsonb; fingerprint text; n integer;
begin
  select * into p from public.profiles where id=p_user_id;
  if not found or p.role<>'MEMBER' or p.approval_status<>'APPROVED'
    or not (p.copy_paused or p.member_halted) or p.close_positions_requested then
    blockers:=array_append(blockers,'MEMBER_NOT_ELIGIBLE');
  end if;
  select count(*) into n from private.trading_accounts
    where user_id=p_user_id and account_role='MEMBER' and status='ACTIVE';
  if n<>1 then blockers:=array_append(blockers,'ACCOUNT_NOT_UNIQUE'); end if;
  select * into a from private.trading_accounts
    where user_id=p_user_id and account_role='MEMBER' and status='ACTIVE' order by id limit 1;
  select * into c from private.copy_current_accounts where trading_account_id=a.id;
  select * into v from private.copy_current_verifications where trading_account_id=a.id;
  select * into s from private.copy_resume_sessions where trading_account_id=a.id;
  select * into r from private.copy_operation_risk where trading_account_id=a.id;
  if v.status is distinct from 'VERIFIED' or c.copy_cycle_id is distinct from v.cycle_id
    or c.observed_at is distinct from v.observed_at or not exists(
      select 1 from private.gate_api_credentials g where g.user_id=a.credential_user_id
        and g.status='VERIFIED' and g.futures_read and g.futures_trade) then
    blockers:=array_append(blockers,'ACCOUNT_NOT_VERIFIED');
  end if;
  if c.observed_at is null or c.observed_at<clock_timestamp()-interval '2 minutes'
    or c.observed_at>clock_timestamp()+interval '1 second' then
    blockers:=array_append(blockers,'ACCOUNT_SNAPSHOT_STALE');
  end if;
  if c.total_equity is null or c.total_equity<=0 or c.total_equity::text in ('NaN','Infinity','-Infinity') then
    blockers:=array_append(blockers,'INVALID_EQUITY');
  end if;
  if exists(select 1 from private.copy_current_positions where trading_account_id=a.id and size<>0) then
    blockers:=array_append(blockers,'OPEN_POSITIONS');
  end if;
  if exists(select 1 from private.copy_order_intents i where i.trading_account_id=a.id
    and (i.status in ('SUBMITTING','ACKNOWLEDGED','UNKNOWN')
      or (i.status='PARTIALLY_FILLED' and not i.exchange_terminal)
      or (i.resume_version is not null and i.filled_size<>0 and i.observation_confirmed_at is null))) then
    blockers:=array_append(blockers,'UNRESOLVED_ORDERS');
  end if;
  if s.state in ('REQUESTED','VALIDATED') and s.expires_at>clock_timestamp()
    and exists(select 1 from private.copy_operation_history h where h.id=r.operation_id and h.resume_version=s.version) then
    blockers:=array_append(blockers,'NEW_OPERATION_PENDING');
  end if;
  settings:=private.copy_resume_settings(p_user_id);
  fingerprint:=md5(jsonb_build_object('user_id',p_user_id,'email',p.email,'account_id',a.id,
    'settings',settings,'copy_paused',p.copy_paused,'member_halted',p.member_halted,
    'close_requested',p.close_positions_requested,'operation_id',r.operation_id,
    'resume_version',s.version,'resume_state',s.state)::text);
  return jsonb_build_object('user_id',p_user_id,'member_name',p.full_name,'member_email',p.email,
    'account_id',a.id,'equity',c.total_equity,'observed_at',c.observed_at,
    'previous_peak_equity',coalesce(r.peak_equity,c.peak_equity),
    'previous_day_start_equity',coalesce(r.day_start_equity,c.day_start_equity),
    'previous_operation_id',r.operation_id,'settings',settings,'fingerprint',fingerprint,
    'eligible',cardinality(blockers)=0,'blockers',to_jsonb(blockers));
end;
$$;

create or replace function public.start_member_new_operation(
  p_user_id uuid,p_request_id uuid,p_expected_equity numeric,p_expected_observed_at timestamptz,
  p_expected_fingerprint text,p_confirmation text,p_reason text
)
returns jsonb language plpgsql security definer set search_path=pg_catalog
as $$
declare preview jsonb; a_id uuid; existing private.copy_operation_history; receipt jsonb;
  new_version uuid; observed timestamptz; reason text:=btrim(p_reason);
begin
  if auth.uid() is null or auth.role() is distinct from 'authenticated' or not public.is_approved_admin() then
    raise exception 'ADMIN_REQUIRED';
  end if;
  if p_request_id is null then raise exception 'REQUEST_ID_REUSED'; end if;
  perform pg_advisory_xact_lock(hashtextextended('maetajak:copy-execution',0));
  select * into existing from private.copy_operation_history where id=p_request_id;
  if found then
    if existing.user_id is distinct from p_user_id or existing.requested_by is distinct from auth.uid() then
      raise exception 'REQUEST_ID_REUSED';
    end if;
    return existing.receipt||jsonb_build_object('replayed',true);
  end if;
  perform 1 from public.profiles where id=p_user_id for update;
  perform 1 from private.trading_accounts where user_id=p_user_id and account_role='MEMBER' for update;
  perform 1 from private.copy_current_accounts c join private.trading_accounts a on a.id=c.trading_account_id
    where a.user_id=p_user_id and a.account_role='MEMBER' for update of c;
  preview:=private.member_new_operation_preview(p_user_id);
  if p_confirmation is distinct from ('NEW_OPERATION:'||(preview->>'member_email')) then raise exception 'CONFIRMATION_REQUIRED'; end if;
  if reason is null or length(reason) not between 1 and 200 then raise exception 'REASON_REQUIRED'; end if;
  if not (preview->>'eligible')::boolean then raise exception '%',preview->'blockers'->>0; end if;
  observed:=(preview->>'observed_at')::timestamptz;
  if p_expected_equity is distinct from (preview->>'equity')::numeric
    or p_expected_fingerprint is distinct from preview->>'fingerprint'
    or p_expected_observed_at is null or p_expected_observed_at<clock_timestamp()-interval '10 minutes'
    or p_expected_observed_at>observed then raise exception 'PREVIEW_CHANGED'; end if;
  a_id:=(preview->>'account_id')::uuid;
  update public.profiles set member_halted=false,copy_paused=true,reduce_only=false,
    close_positions_requested=false,updated_at=now() where id=p_user_id;
  update private.copy_resume_sessions set state='PAUSED',blocker_reason='NEW_OPERATION_REQUESTED',updated_at=now()
    where trading_account_id=a_id;
  perform private.request_member_copy_resume(p_user_id);
  select version into new_version from private.copy_resume_sessions where trading_account_id=a_id;
  receipt:=jsonb_build_object('mode','NEW_OPERATION','operation_id',p_request_id,'user_id',p_user_id,
    'state','REQUESTED','resume_version',new_version,'start_equity',(preview->>'equity')::numeric,
    'copy_paused',true,'replayed',false);
  insert into private.copy_operation_history(id,trading_account_id,user_id,requested_by,reason,
    start_equity,source_observed_at,previous_risk,settings,resume_version,receipt)
  values(p_request_id,a_id,p_user_id,auth.uid(),reason,(preview->>'equity')::numeric,observed,
    jsonb_build_object('operation_id',preview->'previous_operation_id',
      'peak_equity',preview->'previous_peak_equity','day_start_equity',preview->'previous_day_start_equity'),
    preview->'settings',new_version,receipt);
  insert into private.copy_operation_risk(trading_account_id,operation_id,equity_day,day_start_equity,peak_equity,observed_at)
  values(a_id,p_request_id,(observed at time zone 'Asia/Seoul')::date,(preview->>'equity')::numeric,
    (preview->>'equity')::numeric,observed)
  on conflict(trading_account_id) do update set operation_id=excluded.operation_id,equity_day=excluded.equity_day,
    day_start_equity=excluded.day_start_equity,peak_equity=excluded.peak_equity,observed_at=excluded.observed_at;
  insert into public.admin_audit_logs(actor_id,action,target_user_id,previous_value,next_value)
  values(auth.uid(),'MEMBER_NEW_OPERATION_STARTED',p_user_id,
    jsonb_build_object('peak_equity',preview->'previous_peak_equity','operation_id',preview->'previous_operation_id'),
    receipt||jsonb_build_object('reason',reason,'settings',preview->'settings'));
  return receipt;
end;
$$;

revoke all on function private.member_new_operation_preview(uuid) from public,anon,authenticated;
revoke all on function public.start_member_new_operation(uuid,uuid,numeric,timestamptz,text,text,text) from public,anon;
grant execute on function public.start_member_new_operation(uuid,uuid,numeric,timestamptz,text,text,text) to authenticated;

notify pgrst, 'reload schema';
