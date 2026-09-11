-- Add a user-confirmed new operating period. Deployment creates no periods,
-- resets no account, changes no existing risk limit and requests no resume.
create table private.copy_operation_history (
  id uuid primary key,
  trading_account_id uuid not null references private.trading_accounts(id),
  user_id uuid not null references public.profiles(id),
  requested_by uuid not null,
  reason text not null check(length(reason) between 1 and 200),
  started_at timestamptz not null default clock_timestamp(),
  start_equity numeric not null check(start_equity>0 and start_equity::text not in ('NaN','Infinity','-Infinity')),
  source_observed_at timestamptz not null,
  previous_risk jsonb not null,
  settings jsonb not null,
  resume_version uuid not null,
  receipt jsonb not null
);
create index copy_operation_history_account_idx on private.copy_operation_history(trading_account_id,started_at desc);
alter table private.copy_operation_history enable row level security;
revoke all on private.copy_operation_history from public,anon,authenticated;

create table private.copy_operation_risk (
  trading_account_id uuid primary key references private.trading_accounts(id),
  operation_id uuid not null references private.copy_operation_history(id),
  equity_day date not null,
  day_start_equity numeric not null check(day_start_equity>=0),
  peak_equity numeric not null check(peak_equity>0),
  observed_at timestamptz not null
);
alter table private.copy_operation_risk enable row level security;
revoke all on private.copy_operation_risk from public,anon,authenticated;

create function private.observe_copy_operation_risk()
returns trigger language plpgsql security definer set search_path=pg_catalog
as $$
declare observed_day date := (new.observed_at at time zone 'Asia/Seoul')::date;
begin
  if new.total_equity::text in ('NaN','Infinity','-Infinity') then raise exception 'INVALID_EQUITY'; end if;
  update private.copy_operation_risk r set
    day_start_equity=case when observed_day>r.equity_day then new.total_equity else r.day_start_equity end,
    equity_day=greatest(r.equity_day,observed_day),
    peak_equity=greatest(r.peak_equity,new.total_equity),observed_at=new.observed_at
  where r.trading_account_id=new.trading_account_id and new.observed_at>r.observed_at;
  return new;
end;
$$;
revoke all on function private.observe_copy_operation_risk() from public,anon,authenticated;
create trigger observe_copy_operation_risk after insert or update on private.copy_current_accounts
  for each row execute function private.observe_copy_operation_risk();

-- Read-only helper. Public entrypoints below authenticate an actual admin.
create function private.member_new_operation_preview(p_user_id uuid)
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
  if c.observed_at is null or c.observed_at<clock_timestamp()-interval '15 seconds'
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
revoke all on function private.member_new_operation_preview(uuid) from public,anon,authenticated;

create function public.get_member_new_operation_preview(p_user_id uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog
as $$
begin
  if auth.uid() is null or auth.role() is distinct from 'authenticated' or not public.is_approved_admin() then
    raise exception 'ADMIN_REQUIRED';
  end if;
  return private.member_new_operation_preview(p_user_id);
end;
$$;
revoke all on function public.get_member_new_operation_preview(uuid) from public,anon;
grant execute on function public.get_member_new_operation_preview(uuid) to authenticated;

create function public.start_member_new_operation(
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
    or p_expected_observed_at is null or p_expected_observed_at<clock_timestamp()-interval '15 seconds'
    or p_expected_observed_at>observed then raise exception 'PREVIEW_CHANGED'; end if;
  a_id:=(preview->>'account_id')::uuid;
  -- The operator explicitly requests a new generation, not an automatic reset
  -- on an ordinary resume/deposit. Keep the account paused for Worker checks.
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
revoke all on function public.start_member_new_operation(uuid,uuid,numeric,timestamptz,text,text,text) from public,anon;
grant execute on function public.start_member_new_operation(uuid,uuid,numeric,timestamptz,text,text,text) to authenticated;

-- Accounts without a user-created operation retain the existing risk basis.
create or replace function public.get_copy_worker_context()
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  encryption_key text;
  result jsonb;
  observation_guards jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'SERVICE_ROLE_REQUIRED';
  end if;

  select decrypted_secret
  into encryption_key
  from vault.decrypted_secrets
  where name = 'gate_api_credentials_key';

  if encryption_key is null then
    raise exception 'ENCRYPTION_KEY_NOT_CONFIGURED';
  end if;

  observation_guards := public.get_copy_order_observation_guards();

  select jsonb_build_object(
    'system', (
      select jsonb_build_object(
        'execution_enabled', control.execution_enabled,
        'emergency_halted', control.emergency_halted,
        'halt_reason', control.halt_reason,
        'slippage_ratio', control.max_order_slippage_ratio
      )
      from public.copy_system_control control
      where control.singleton
    ),
    'master', (
      select jsonb_build_object(
        'trading_account_id', account.id,
        'user_id', account.user_id,
        'gate_uid', credentials.gate_uid,
        'api_key', pgp_sym_decrypt(credentials.api_key_ciphertext, encryption_key),
        'secret_key', pgp_sym_decrypt(credentials.secret_key_ciphertext, encryption_key)
      )
      from private.trading_accounts account
      join private.gate_api_credentials credentials
        on credentials.user_id = account.credential_user_id
      where account.account_role = 'MASTER'
        and account.status = 'ACTIVE'
        and credentials.status = 'VERIFIED'
        and credentials.futures_read
        and not credentials.futures_trade
      order by account.updated_at desc
      limit 1
    ),
    'members', coalesce((
      select jsonb_agg(jsonb_build_object(
        'trading_account_id', account.id,
        'user_id', account.user_id,
        'gate_uid', credentials.gate_uid,
        'api_key', pgp_sym_decrypt(credentials.api_key_ciphertext, encryption_key),
        'secret_key', pgp_sym_decrypt(credentials.secret_key_ciphertext, encryption_key),
        'copy_ratio', profile.copy_ratio,
        'max_position_ratio', profile.max_position_ratio,
        'copy_paused', profile.copy_paused,
        'halted', profile.member_halted,
        'reduce_only', profile.reduce_only,
        'close_positions_requested', profile.close_positions_requested,
        'daily_loss_limit_pct', profile.daily_loss_limit_pct,
        'max_drawdown_pct', profile.max_drawdown_pct,
        'max_leverage', profile.max_leverage,
        'day_start_equity', coalesce(operation_risk.day_start_equity,current_account.day_start_equity),
        'peak_equity', coalesce(operation_risk.peak_equity,current_account.peak_equity),
        'operation_id', operation_risk.operation_id,
        'current_state_observed_at', current_account.observed_at,
        'previous_states', coalesce((
          select jsonb_agg(jsonb_build_object(
            'contract', state.contract,
            'position_side', state.position_side,
            'state', state.state,
            'actual_size', state.actual_size,
            'target_leverage', state.target_leverage,
            'margin_mode', state.margin_mode,
            'position_mode', state.position_mode,
            'last_observed_at', state.last_observed_at,
            'known_fill_delta', coalesce((
              select sum(intent.filled_size)
              from private.copy_order_intents intent
              where intent.trading_account_id = account.id
                and intent.contract = state.contract
                and intent.position_side = state.position_side
                and intent.updated_at > coalesce(state.last_observed_at, '-infinity'::timestamptz)
                and intent.filled_size <> 0
            ), 0),
            'has_unresolved_order', observation_guards @> jsonb_build_array(
              jsonb_build_object(
                'trading_account_id', account.id,
                'contract', state.contract,
                'position_side', state.position_side
              )
            )
          ) order by state.contract, state.position_side)
          from public.copy_position_states state
          where state.trading_account_id = account.id
        ), '[]'::jsonb)
      ) order by profile.created_at)
      from private.trading_accounts account
      join private.gate_api_credentials credentials
        on credentials.user_id = account.credential_user_id
      join public.profiles profile
        on profile.id = account.user_id
      left join private.copy_current_accounts current_account
        on current_account.trading_account_id = account.id
      left join private.copy_operation_risk operation_risk
        on operation_risk.trading_account_id = account.id
      where account.account_role = 'MEMBER'
        and account.status = 'ACTIVE'
        and credentials.status = 'VERIFIED'
        and credentials.futures_read
        and credentials.futures_trade
        and profile.role = 'MEMBER'
        and profile.approval_status = 'APPROVED'
    ), '[]'::jsonb)
  ) into result;

  return result;
end;
$$;

revoke all on function public.get_copy_worker_context() from public, anon, authenticated;
grant execute on function public.get_copy_worker_context() to service_role;

