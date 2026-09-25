-- K4 (operator decision 2026-09-25): members manage their own pre-copy holdings by hand while copying
-- continues. A change the platform journal cannot explain is attributed to the member's own quantity
-- first instead of latching the whole account UNKNOWN. A sale that reaches COPY locks only that leg.
-- With worker 0.5.0 an ACTIVE member's change keeps the old UNKNOWN latch (0.5.0 cannot honour attribution).
set lock_timeout = '5s';

do $guard$
declare f record; current_md5 text;
begin
  for f in select * from (values
    ('private.observe_copy_ownership()','644f7d0371833cdaa62a72fc186169fb'),
    ('public.get_copy_resume_context()','70cdf27e4a1279c0769f96eb44ee8f3f'),
    ('public.get_copy_safety_version()','53b6cce9e9a7d862f832d377c4ec7f37')
  ) v(sig, reviewed_md5) loop
    select md5(prosrc) into current_md5 from pg_proc where oid=to_regprocedure(f.sig);
    if current_md5 is distinct from f.reviewed_md5 then
      raise exception 'ABORT_FUNCTION_DRIFT % md5=%', f.sig, current_md5;
    end if;
  end loop;
end $guard$;

-- A member change is attributed only after the same holdings were read twice (>= 2 s apart): one lagging Gate
-- read must not relabel COPY as the member's own or lock a leg.
alter table private.copy_ownership_checkpoints add column if not exists pending_member_change jsonb;
alter table private.copy_ownership_checkpoints add column if not exists pending_member_change_at timestamptz;

-- Base: 20260924162948 (md5 644f7d03). Only the normal (non-CLOSING) branch's final block changes.
create or replace function private.observe_copy_ownership()
returns trigger language plpgsql security definer set search_path=pg_catalog as $$
declare proof private.copy_ownership_checkpoints; baseline private.member_copy_onboarding_baselines;
  actual jsonb; copied jsonb; expected jsonb; item private.copy_order_intents;
  applied uuid[] := '{}'; invalid boolean := false;
  closing_session private.copy_resume_sessions; closing boolean := false; has_proof boolean := false;
  protected_next jsonb; copy_next jsonb; copy_base jsonb; ambiguous boolean; changes jsonb;
begin
  if new.status<>'VERIFIED' then return new; end if;
  perform pg_advisory_xact_lock(hashtextextended('maetajak:copy-execution',0));
  select * into baseline from private.member_copy_onboarding_baselines where trading_account_id=new.trading_account_id;
  if not found then return new; end if; -- not a member baseline
  select private.copy_position_sum(coalesce(jsonb_agg(jsonb_build_object('contract',p.contract,
    'position_side',p.position_side,'size',p.size)),'[]')) into actual
    from private.copy_current_positions p where p.trading_account_id=new.trading_account_id and p.copy_cycle_id=new.cycle_id;
  select s.* into closing_session from private.copy_resume_sessions s
    join private.trading_accounts a on a.id=s.trading_account_id
    join public.profiles pr on pr.id=a.user_id
    where s.trading_account_id=new.trading_account_id and s.state='CLOSING' and pr.close_positions_requested;
  closing := found;
  select * into proof from private.copy_ownership_checkpoints where trading_account_id=new.trading_account_id for update;
  has_proof := found;
  if closing then
    -- An order in flight, or a fill of the closing generation not yet observed, is still changing the
    -- holdings: wait for it.
    if exists(select 1 from private.copy_order_intents i where i.trading_account_id=new.trading_account_id
      and ((i.submit_attempts>0 and i.status in ('SUBMITTING','ACKNOWLEDGED','UNKNOWN','PARTIALLY_FILLED') and not i.exchange_terminal)
        or (i.filled_size<>0 and i.observation_confirmed_at is null and i.resume_version=closing_session.version))) then return new; end if;
    -- A terminal fill of an OLDER generation (e.g. CLOSE pressed seconds after a fill) can no longer be
    -- confirmed, because confirmation is scoped to the current generation. A verified read that started
    -- at least 5 s after it resolved already includes it.
    update private.copy_order_intents i set observation_confirmed_at=new.verified_at
      where i.trading_account_id=new.trading_account_id and i.filled_size<>0 and i.resume_version is not null
        and i.resume_version is distinct from closing_session.version and i.observation_confirmed_at is null
        and (i.exchange_terminal or i.status in ('FILLED','CANCELLED','REJECTED'))
        and i.resolved_at<new.observed_at-interval '5 seconds';
    if exists(select 1 from private.copy_order_intents i where i.trading_account_id=new.trading_account_id
      and i.filled_size<>0 and i.observation_confirmed_at is null and i.resume_version is not null) then return new; end if;
    if has_proof and new.observed_at<=proof.observed_at then return new; end if;
    if actual='[]'::jsonb then
      -- Nothing is held any more: nothing is left to attribute.
      protected_next:='[]'; copy_next:='[]';
    elsif not has_proof or proof.status<>'CONFIRMED' then
      -- Ownership that is unknown is never assigned to anyone while something is still held.
      return new;
    else
      -- Fills of the pre-CLOSE generation that the per-fill journal had not consumed yet belong to the
      -- COPY they created (CLOSE may be pressed seconds after a fill).
      if proof.resume_version is distinct from closing_session.version then
        select private.copy_position_sum(proof.copy_positions||coalesce(jsonb_agg(jsonb_build_object(
            'contract',i.contract,'position_side',i.position_side,'size',i.filled_size)),'[]'))
          into copy_base from private.copy_order_intents i
          where i.trading_account_id=new.trading_account_id and i.filled_size<>0
            and i.resume_version=proof.resume_version
            and not exists(select 1 from private.copy_ownership_fills f where f.intent_id=i.id);
      else
        copy_base:=proof.copy_positions;
      end if;
      -- Per leg, only the platform's own (reduce-only) close fills are explained: they consume COPY
      -- first, then protected. Holdings above that are a member's own addition (protected). Holdings
      -- BELOW it (a manual sale, TP/SL, liquidation) cannot be attributed: the ledger becomes UNKNOWN
      -- and is reset only once the account is flat. Quantity never moves between COPY and protected.
      with legs as (
        select l.c, l.s, case when l.s='SHORT' then -1 else 1 end sg,
          coalesce((select abs((x->>'size')::numeric) from jsonb_array_elements(actual) x
            where x->>'contract'=l.c and x->>'position_side'=l.s),0) h_q,
          coalesce((select abs((x->>'size')::numeric) from jsonb_array_elements(proof.protected_positions) x
            where x->>'contract'=l.c and x->>'position_side'=l.s),0) p_q,
          coalesce((select abs((x->>'size')::numeric) from jsonb_array_elements(copy_base) x
            where x->>'contract'=l.c and x->>'position_side'=l.s),0) k_q,
          coalesce((select (case when l.s='SHORT' then 1 else -1 end)*sum(i.filled_size)
            from private.copy_order_intents i
            where i.trading_account_id=new.trading_account_id and i.contract=l.c and i.position_side=l.s
              and i.resume_version=closing_session.version and i.filled_size<>0
              and i.observation_confirmed_at is not null
              and not exists(select 1 from private.copy_ownership_fills f where f.intent_id=i.id)),0) r_q
        from (select x->>'contract' c,x->>'position_side' s from jsonb_array_elements(actual) x
          union select x->>'contract',x->>'position_side' from jsonb_array_elements(proof.protected_positions) x
          union select x->>'contract',x->>'position_side' from jsonb_array_elements(copy_base) x) l
      ), calc as (
        select c,s,sg,h_q,r_q,greatest(0,k_q-r_q) k1,p_q-greatest(0,r_q-k_q) p1,p_q+k_q-r_q e_q from legs
      )
      select coalesce(bool_or(r_q<0 or p1<0 or h_q<e_q),false),
        coalesce(jsonb_agg(jsonb_build_object('contract',c,'position_side',s,'size',sg*(p1+h_q-e_q))
          order by c,s) filter (where p1+h_q-e_q<>0),'[]'),
        coalesce(jsonb_agg(jsonb_build_object('contract',c,'position_side',s,'size',sg*k1)
          order by c,s) filter (where k1<>0),'[]')
        into ambiguous,protected_next,copy_next from calc;
      if ambiguous or not private.copy_resume_positions_valid(copy_base) then
        update private.copy_ownership_checkpoints set status='UNKNOWN',reason='CLOSE_OWNERSHIP_AMBIGUOUS',
          revision=revision+1 where trading_account_id=new.trading_account_id;
        return new;
      end if;
    end if;
    if not private.copy_resume_positions_valid(protected_next) or not private.copy_resume_positions_valid(copy_next)
      or private.copy_position_sum(protected_next||copy_next) is distinct from actual then return new; end if;
    insert into private.copy_ownership_checkpoints(trading_account_id,resume_version,status,protected_positions,
      copy_positions,observed_at,source_cycle_id,reason)
      values(new.trading_account_id,closing_session.version,'CONFIRMED',protected_next,copy_next,new.observed_at,
        new.cycle_id,'CLOSE_OWNERSHIP_RECONCILED')
      on conflict(trading_account_id) do update set resume_version=excluded.resume_version,status='CONFIRMED',
        protected_positions=excluded.protected_positions,copy_positions=excluded.copy_positions,
        observed_at=excluded.observed_at,source_cycle_id=excluded.source_cycle_id,reason=excluded.reason,
        revision=private.copy_ownership_checkpoints.revision+1
      where private.copy_ownership_checkpoints.status<>'CONFIRMED'
        or private.copy_ownership_checkpoints.resume_version is distinct from excluded.resume_version
        or private.copy_ownership_checkpoints.protected_positions is distinct from excluded.protected_positions
        or private.copy_ownership_checkpoints.copy_positions is distinct from excluded.copy_positions;
    -- The split above is derived from verified holdings that include every confirmed fill.
    insert into private.copy_ownership_fills(intent_id,trading_account_id,resume_version,filled_size,confirmed_at)
      select i.id,i.trading_account_id,i.resume_version,i.filled_size,i.observation_confirmed_at
      from private.copy_order_intents i
      where i.trading_account_id=new.trading_account_id and i.filled_size<>0
        and i.resume_version is not null and i.observation_confirmed_at is not null
      on conflict(intent_id) do update set filled_size=excluded.filled_size,resume_version=excluded.resume_version,
        confirmed_at=excluded.confirmed_at
      where (private.copy_ownership_fills.filled_size,private.copy_ownership_fills.resume_version,
          private.copy_ownership_fills.confirmed_at)
        is distinct from (excluded.filled_size,excluded.resume_version,excluded.confirmed_at);
    return new;
  end if;
  if not has_proof then
    -- A migration must not silently bless an already traded/legacy account.
    if exists(select 1 from private.copy_order_intents where trading_account_id=new.trading_account_id and filled_size<>0)
      or actual is distinct from private.copy_position_sum(baseline.member_positions) then return new; end if;
    insert into private.copy_ownership_checkpoints(trading_account_id,resume_version,status,
      protected_positions,observed_at,source_cycle_id)
      values(new.trading_account_id,baseline.resume_version,'CONFIRMED',actual,new.observed_at,new.cycle_id);
    return new;
  end if;
  if proof.status='UNKNOWN' or new.observed_at<=proof.observed_at then return new; end if;
  -- K4: a member may trade the same leg right after a platform fill, so the worker's exact "held = planned +
  -- filled" confirmation may never match. A terminal fill of this generation is included in any verified read
  -- that started 30 s after it resolved; the rest of the difference is then the member's own change.
  update private.copy_order_intents i set observation_confirmed_at=new.verified_at
    where i.trading_account_id=new.trading_account_id and i.filled_size<>0 and i.resume_version=proof.resume_version
      and i.observation_confirmed_at is null and (i.exchange_terminal or i.status in ('FILLED','CANCELLED','REJECTED'))
      and i.resolved_at<new.observed_at-interval '30 seconds';
  -- A pending/ambiguous fill is not failure and is not reusable ownership.
  if exists(select 1 from private.copy_order_intents i where i.trading_account_id=new.trading_account_id
    and ((i.submit_attempts>0 and i.status in ('SUBMITTING','ACKNOWLEDGED','UNKNOWN','PARTIALLY_FILLED') and not i.exchange_terminal)
      or (i.filled_size<>0 and i.observation_confirmed_at is null and i.resume_version is not null))) then return new; end if;
  copied:=proof.copy_positions;
  for item in select i.* from private.copy_order_intents i
    where i.trading_account_id=new.trading_account_id and i.filled_size<>0 and i.resume_version is not null
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
    or exists(select 1 from private.copy_ownership_fills f join private.copy_order_intents i on i.id=f.intent_id
      where f.trading_account_id=new.trading_account_id and (f.filled_size<>i.filled_size
        or f.resume_version is distinct from i.resume_version or f.confirmed_at is distinct from i.observation_confirmed_at))
    -- K4: a holding the platform journal cannot explain is attributed to the member only when every leg is
    -- a well-formed position of the current generation; anything else keeps the old UNKNOWN latch.
    or (actual is distinct from private.copy_position_sum(proof.protected_positions||copied)
      and (not private.copy_resume_positions_valid(actual)
        or not private.copy_resume_positions_valid(proof.protected_positions)
        or baseline.resume_version is distinct from proof.resume_version)) then
    update private.copy_ownership_checkpoints set status='UNKNOWN',reason='OBSERVED_OWNERSHIP_MISMATCH',revision=revision+1
      where trading_account_id=new.trading_account_id;
    -- Only unsubmitted engine candidates, never Gate orders, are invalidated.
    update private.copy_order_intents set status='CANCELLED',last_error_code='COPY_OWNERSHIP_UNKNOWN',updated_at=now()
      where trading_account_id=new.trading_account_id and status in ('PLANNED','QUEUED') and submit_attempts=0;
    update public.copy_position_states set state=case when state='MANUAL_OVERRIDE' then state else 'PAUSED' end,
      pause_reason='COPY_OWNERSHIP_UNKNOWN'
      where trading_account_id=new.trading_account_id;
    return new;
  end if;
  protected_next:=proof.protected_positions;
  if actual is distinct from private.copy_position_sum(proof.protected_positions||copied) then
    -- K4 (operator decision 2026-09-25): holdings a member changed by hand are the member's own. Per leg the
    -- unexplained change d = held - (protected + copy) is taken from / added to the member's own quantity
    -- first. Only a sale larger than the member's own quantity reaches COPY: then the leg keeps what is
    -- held as COPY and its anchor is locked (MEMBER_REDUCED_COPY_POSITION) so the worker neither buys the
    -- sold COPY back nor trades that leg again until the member resumes.
    with legs as (
      select l.c, l.s, case when l.s='SHORT' then -1 else 1 end sg,
        coalesce((select abs((x->>'size')::numeric) from jsonb_array_elements(actual) x
          where x->>'contract'=l.c and x->>'position_side'=l.s),0) a_q,
        coalesce((select abs((x->>'size')::numeric) from jsonb_array_elements(proof.protected_positions) x
          where x->>'contract'=l.c and x->>'position_side'=l.s),0) p_q,
        coalesce((select abs((x->>'size')::numeric) from jsonb_array_elements(copied) x
          where x->>'contract'=l.c and x->>'position_side'=l.s),0) c_q
      from (select x->>'contract' c,x->>'position_side' s from jsonb_array_elements(actual) x
        union select x->>'contract',x->>'position_side' from jsonb_array_elements(proof.protected_positions) x
        union select x->>'contract',x->>'position_side' from jsonb_array_elements(copied) x) l
    ), calc as (
      select c,s,sg,a_q,p_q,c_q,a_q-p_q-c_q d,(a_q<c_q) reduced from legs
    ), split as (
      select *, case when reduced then 0 else p_q+d end p1, case when reduced then a_q else c_q end c1 from calc
    )
    select private.copy_position_sum(coalesce(jsonb_agg(jsonb_build_object('contract',c,'position_side',s,'size',sg*p1))
        filter (where p1<>0),'[]')),
      private.copy_position_sum(coalesce(jsonb_agg(jsonb_build_object('contract',c,'position_side',s,'size',sg*c1))
        filter (where c1<>0),'[]')),
      coalesce(jsonb_agg(jsonb_build_object('contract',c,'position_side',s,'delta',sg*d,'reduced_copy',reduced,
        'protected_before',sg*p_q,'protected_after',sg*p1,'copy_before',sg*c_q,'copy_after',sg*c1)) filter (where d<>0),'[]')
      into protected_next,copy_next,changes from split;
    -- A COPY reduction can only be locked on a leg that has an anchor of this generation.
    if exists(select 1 from jsonb_array_elements(changes) x where (x->>'reduced_copy')::boolean
        and not exists(select 1 from private.copy_target_anchors t where t.trading_account_id=new.trading_account_id
          and t.contract=x->>'contract' and t.position_side=x->>'position_side' and t.resume_version=proof.resume_version))
      or private.copy_position_sum(protected_next||copy_next) is distinct from actual
      -- While the member is copying, only a K4 worker (which marked every changed leg this cycle) targets the
      -- ledger's own quantity and excludes own growth from its risk caps. Worker 0.5.0 does not: keep its latch.
      or (exists(select 1 from private.copy_resume_sessions r where r.trading_account_id=new.trading_account_id
            and r.state='ACTIVE')
        and exists(select 1 from jsonb_array_elements(changes) x where not exists(select 1 from public.copy_position_states ps
          where ps.trading_account_id=new.trading_account_id and ps.contract=x->>'contract'
            and ps.position_side=x->>'position_side' and ps.last_cycle_id=new.cycle_id
            and ps.pause_reason in ('MEMBER_POSITION_RECONCILING','MEMBER_REDUCED_COPY_POSITION')))) then
      update private.copy_ownership_checkpoints set status='UNKNOWN',reason='OBSERVED_OWNERSHIP_MISMATCH',revision=revision+1
        where trading_account_id=new.trading_account_id;
      update private.copy_order_intents set status='CANCELLED',last_error_code='COPY_OWNERSHIP_UNKNOWN',updated_at=now()
        where trading_account_id=new.trading_account_id and status in ('PLANNED','QUEUED') and submit_attempts=0;
      update public.copy_position_states set state=case when state='MANUAL_OVERRIDE' then state else 'PAUSED' end,
        pause_reason='COPY_OWNERSHIP_UNKNOWN'
        where trading_account_id=new.trading_account_id;
      return new;
    end if;
    -- Two reads: the first sighting is only remembered (the worker keeps the leg on hold meanwhile).
    if proof.pending_member_change is distinct from actual or proof.pending_member_change_at is null
      or proof.pending_member_change_at<=proof.observed_at
      or proof.pending_member_change_at>new.observed_at-interval '2 seconds' then
      update private.copy_ownership_checkpoints set pending_member_change=actual,
        pending_member_change_at=case when pending_member_change is distinct from actual
          or pending_member_change_at is null or pending_member_change_at<=observed_at
          then new.observed_at else pending_member_change_at end
        where trading_account_id=new.trading_account_id;
      return new;
    end if;
    -- Every anchor of a changed leg carries the member's new own quantity (its COPY decision is unchanged), so
    -- no worker version targets the old own quantity: 0.5.0 uses target_size as is, K4 workers rebase it.
    update private.copy_target_anchors t set
        target_size=case when (x->>'reduced_copy')::boolean then (x->>'copy_after')::numeric
          else t.target_size+(x->>'protected_after')::numeric-(x->>'protected_before')::numeric end,
        protected_member_size=(x->>'protected_after')::numeric,
        lock_reason=case when (x->>'reduced_copy')::boolean then 'MEMBER_REDUCED_COPY_POSITION' else t.lock_reason end,
        observed_at=greatest(t.observed_at,new.observed_at),updated_at=now()
      from jsonb_array_elements(changes) x
      where t.trading_account_id=new.trading_account_id
        and t.contract=x->>'contract' and t.position_side=x->>'position_side' and t.resume_version=proof.resume_version;
    -- A plan made this cycle against the old own quantity (worker 0.5.0 may not have noticed the change) never
    -- reaches Gate.
    update private.copy_order_intents i set status='CANCELLED',last_error_code='MEMBER_POSITION_CHANGED',updated_at=now()
      from jsonb_array_elements(changes) x
      where i.trading_account_id=new.trading_account_id and i.contract=x->>'contract' and i.position_side=x->>'position_side'
        and i.status in ('PLANNED','QUEUED') and i.submit_attempts=0;
    -- The worker reads protected sizes from the onboarding baseline; keep it equal to the ledger.
    update private.member_copy_onboarding_baselines set member_positions=protected_next,updated_at=now()
      where trading_account_id=new.trading_account_id;
    insert into public.copy_events(user_id,contract,position_side,event_type,severity,cycle_id,safe_payload)
      select a.user_id,x->>'contract',x->>'position_side','MANUAL_OVERRIDE_DETECTED',
        case when (x->>'reduced_copy')::boolean then 'WARNING' else 'INFO' end,new.cycle_id,
        x||jsonb_build_object('reason',case when (x->>'reduced_copy')::boolean then 'MEMBER_REDUCED_COPY_POSITION'
          else 'MEMBER_OWN_POSITION_CHANGED' end,'resume_version',proof.resume_version)
      from jsonb_array_elements(changes) x cross join private.trading_accounts a where a.id=new.trading_account_id;
    copied:=copy_next;
  end if;
  insert into private.copy_ownership_fills(intent_id,trading_account_id,resume_version,filled_size,confirmed_at)
    select id,trading_account_id,resume_version,filled_size,observation_confirmed_at
    from private.copy_order_intents where id=any(applied);
  update private.copy_ownership_checkpoints set copy_positions=copied,protected_positions=protected_next,
    pending_member_change=null,pending_member_change_at=null,
    reason=case when changes is null or changes='[]'::jsonb then reason else 'MEMBER_CHANGE_ABSORBED' end,
    observed_at=new.observed_at,source_cycle_id=new.cycle_id,revision=revision+1 where trading_account_id=new.trading_account_id;
  return new;
end;
$$;
revoke all on function private.observe_copy_ownership() from public,anon,authenticated;

-- The worker compares each member leg with the ledger (member's own + COPY + confirmed fills not yet
-- journaled) and holds a leg the ledger does not explain yet. Additive keys only.
create or replace function public.get_copy_resume_context()
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
begin
  perform private.require_copy_worker_role();
  return (select coalesce(jsonb_agg(s||jsonb_build_object('copy_positions',coalesce(b.copy_positions,'[]'),
    'ownership_status',p.status,
    'resume_member_positions',(select r.member_positions from private.copy_resume_sessions r
      where r.trading_account_id=(s->>'trading_account_id')::uuid and r.version::text=s->>'version'),
    'ledger_protected_positions',case when p.status='CONFIRMED' and p.resume_version::text=s->>'version'
      then p.protected_positions end,
    'ledger_positions',case when p.status='CONFIRMED' and p.resume_version::text=s->>'version'
      then private.copy_position_sum(p.protected_positions||p.copy_positions||coalesce((
        select jsonb_agg(jsonb_build_object('contract',i.contract,'position_side',i.position_side,'size',i.filled_size))
        from private.copy_order_intents i where i.trading_account_id=p.trading_account_id
          and i.resume_version=p.resume_version and i.filled_size<>0
          and not exists(select 1 from private.copy_ownership_fills f where f.intent_id=i.id)),'[]')) end)),'[]')
    from jsonb_array_elements(private.get_copy_resume_context_core()) s
    left join private.member_copy_onboarding_baselines b on b.trading_account_id=(s->>'trading_account_id')::uuid
    left join private.copy_ownership_checkpoints p on p.trading_account_id=b.trading_account_id);
end;
$$;
revoke all on function public.get_copy_resume_context() from public,anon,authenticated;
grant execute on function public.get_copy_resume_context() to service_role;

create or replace function public.get_copy_safety_version()
returns jsonb language plpgsql security definer set search_path=pg_catalog
as $$
begin
  perform private.require_copy_worker_role();
  return jsonb_build_object('schema_version',3,'worker_version','0.5.0','resume_requires_validation',true,
    'current_state_atomic',true,'trade_alert_exchange_verification',true,'reliability_patch',1,
    'member_own_position_absorption',1);
end;
$$;
revoke all on function public.get_copy_safety_version() from public,anon,authenticated;
grant execute on function public.get_copy_safety_version() to service_role;

notify pgrst, 'reload schema';
