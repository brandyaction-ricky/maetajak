-- [03_BUGFIX] HOTFIX (대표 승인 A, 2026-09-22 KST): reversal guard must ignore legacy fills.
-- Only change vs prod body (20260914172954): `and i.resume_version is not null` in the
-- `pending` unconfirmed-fill clause. guard_version stays 1 (worker/execution-safety.js:78).
-- Self-verifying: aborts if prod drifted since review; rolls back if result != reviewed draft.
do $$ begin
  if md5(pg_get_functiondef('private.copy_reversal_entry_context(private.copy_order_intents)'::regprocedure))
     <> 'd697b17a15e2f862b1b3561ed63c3c09' then
    raise exception 'PROD_FUNCTION_DRIFT: copy_reversal_entry_context changed since review';
  end if;
end $$;

CREATE OR REPLACE FUNCTION private.copy_reversal_entry_context(p_intent private.copy_order_intents)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'pg_catalog'
AS $function$
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
        or (i.filled_size<>0 and i.observation_confirmed_at is null and i.resume_version is not null))) into pending;
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
$function$;
revoke all on function private.copy_reversal_entry_context(private.copy_order_intents) from public,anon,authenticated,service_role;

do $$ begin
  if md5(pg_get_functiondef('private.copy_reversal_entry_context(private.copy_order_intents)'::regprocedure))
     <> '2e11ae5801d6cf71923aecab546fb315' then
    raise exception 'POSTCHECK_FAILED: applied body differs from reviewed draft';
  end if;
end $$;