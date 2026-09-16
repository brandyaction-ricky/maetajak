-- CT-QA-REVERSAL-ORDERING-001. Definitions only; no data repair or operational actions.
-- Reversal admission is a verified dependency, never UUID/claim sort priority.
create function private.copy_reversal_entry_context(p_intent private.copy_order_intents)
returns jsonb language plpgsql stable set search_path=pg_catalog as $$
declare opposite text; master_account uuid; master_size numeric; actual_size numeric;
  protected_size numeric; copied_size numeric; proof private.copy_ownership_checkpoints;
  verified boolean := false; permitted boolean := false; pending boolean;
begin
  opposite:=case when p_intent.position_side='LONG' then 'SHORT' else 'LONG' end;
  if p_intent.reduce_only then return jsonb_build_object('allowed',true); end if;
  select master_account_id into master_account from private.copy_cycles where id=p_intent.cycle_id;
  -- Absence is zero only in complete, fresh observations of BOTH accounts.
  if master_account is null or (select count(*) from private.copy_current_verifications v
      join private.copy_current_accounts a on a.trading_account_id=v.trading_account_id
      where v.trading_account_id in (master_account,p_intent.trading_account_id)
        and v.cycle_id=p_intent.cycle_id and v.status='VERIFIED'
        and a.copy_cycle_id=v.cycle_id and a.observed_at=v.observed_at
        and v.observed_at>=clock_timestamp()-interval '15 seconds')<>2
    then return jsonb_build_object('allowed',false,'reason','REVERSAL_OBSERVATION_REQUIRED'); end if;
  select coalesce(sum(size),0) into master_size from private.copy_current_positions
    where trading_account_id=master_account and copy_cycle_id=p_intent.cycle_id
      and contract=p_intent.contract and position_side=opposite;
  select coalesce(sum(size),0) into actual_size from private.copy_current_positions
    where trading_account_id=p_intent.trading_account_id and copy_cycle_id=p_intent.cycle_id
      and contract=p_intent.contract and position_side=opposite;
  select * into proof from private.copy_ownership_checkpoints where trading_account_id=p_intent.trading_account_id;
  if found then
    select coalesce(sum((p->>'size')::numeric),0) into protected_size
      from jsonb_array_elements(proof.protected_positions) p where p->>'contract'=p_intent.contract and p->>'position_side'=opposite;
    select coalesce(sum((p->>'size')::numeric),0) into copied_size
      from jsonb_array_elements(proof.copy_positions) p where p->>'contract'=p_intent.contract and p->>'position_side'=opposite;
    verified:=proof.status='CONFIRMED' and proof.resume_version=p_intent.resume_version
      and proof.source_cycle_id=p_intent.cycle_id and actual_size=protected_size+copied_size;
  else
    -- A verified flat new account has no retiring exposure. Non-flat accounts
    -- require the journal; old fills are never used for automatic backfill.
    protected_size:=0; copied_size:=0;
    verified:=actual_size=0 and not exists(select 1 from private.copy_order_intents
      where trading_account_id=p_intent.trading_account_id and contract=p_intent.contract
        and position_side=opposite and filled_size<>0);
  end if;
  select exists(select 1 from private.copy_order_intents i
    where i.trading_account_id=p_intent.trading_account_id and i.contract=p_intent.contract
      and i.position_side=opposite and i.id<>p_intent.id
      and ((i.submit_attempts>0 and i.status in ('SUBMITTING','ACKNOWLEDGED','UNKNOWN','PARTIALLY_FILLED') and not i.exchange_terminal)
        or (i.filled_size<>0 and i.observation_confirmed_at is null))) into pending;
  -- Both Master legs are an intentional hedge, not a reversal. Fresh exchange
  -- preflight checks the proof again if that Master leg disappears after claim.
  permitted:=master_size<>0 or (verified and copied_size=0 and actual_size=protected_size and not pending);
  return jsonb_build_object('guard_version',1,'allowed',permitted,
    'reason',case when permitted then null else 'COPY_REVERSAL_CLOSE_REQUIRED' end,
    'intent_id',p_intent.id,'trading_account_id',p_intent.trading_account_id,
    'resume_version',p_intent.resume_version,'cycle_id',p_intent.cycle_id,'opposite_side',opposite,
    'master_opposite_size',master_size,'actual_opposite_size',actual_size,
    'protected_opposite_size',protected_size,'copy_opposite_size',copied_size,'ownership_verified',verified);
end;
$$;
revoke all on function private.copy_reversal_entry_context(private.copy_order_intents) from public,anon,authenticated,service_role;

create function public.get_copy_reversal_entry_context(p_intent_id uuid,p_version uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare item private.copy_order_intents;
begin
  perform private.require_copy_worker_role();
  perform pg_advisory_xact_lock(hashtextextended('maetajak:copy-execution',0));
  select * into item from private.copy_order_intents where id=p_intent_id
    and resume_version=p_version and status='SUBMITTING';
  if not found then return jsonb_build_object('allowed',false); end if;
  return private.copy_reversal_entry_context(item);
end;
$$;
revoke all on function public.get_copy_reversal_entry_context(uuid,uuid) from public,anon,authenticated;
grant execute on function public.get_copy_reversal_entry_context(uuid,uuid) to service_role;

create function private.guard_copy_reversal_submission()
returns trigger language plpgsql security definer set search_path=pg_catalog as $$
begin
  if new.status<>'SUBMITTING' or new.reduce_only then return new; end if;
  perform pg_advisory_xact_lock(hashtextextended('maetajak:copy-execution',0));
  if coalesce((private.copy_reversal_entry_context(new)->>'allowed')::boolean,false) then return new; end if;
  return null;
end;
$$;
revoke all on function private.guard_copy_reversal_submission() from public,anon,authenticated,service_role;
create trigger copy_reversal_submission_guard before insert or update of status on private.copy_order_intents
  for each row execute function private.guard_copy_reversal_submission();

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
      and coalesce((private.copy_reversal_entry_context(i)->>'allowed')::boolean,false)
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
      and coalesce((private.copy_reversal_entry_context(i)->>'allowed')::boolean,false)
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
