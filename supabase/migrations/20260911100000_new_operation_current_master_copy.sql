-- Mark only the resume generation created by an explicitly confirmed new
-- operation as a current-Master portfolio sync. Ordinary pause/resume sessions
-- continue to protect the Master and member quantities observed at resume.
-- This migration changes no account state, target, order, or LIVE control.
create or replace function public.get_copy_resume_context()
returns jsonb language plpgsql security definer set search_path=pg_catalog
as $$
begin
  perform private.require_copy_worker_role();
  return (select coalesce(jsonb_agg(jsonb_build_object(
    'trading_account_id',a.id,'version',s.version,'state',coalesce(s.state,'REQUIRED'),
    'requested_at',s.requested_at,'expires_at',s.expires_at,'blocker_reason',s.blocker_reason,
    'sync_current_master',exists(
      select 1
      from private.copy_operation_risk r
      join private.copy_operation_history h on h.id=r.operation_id
      where r.trading_account_id=a.id
        and h.trading_account_id=a.id
        and h.resume_version=s.version
    ),
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

revoke all on function public.get_copy_resume_context() from public,anon,authenticated;
grant execute on function public.get_copy_resume_context() to service_role;

comment on function public.get_copy_resume_context() is
  'Resume context; sync_current_master is true only for the active explicitly confirmed new-operation generation.';
