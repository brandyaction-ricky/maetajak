-- Allow the deployment host to determine whether a verified pre-deployment
-- LIVE system may be resumed. No browser role can call this function.
create or replace function public.get_copy_live_resume_eligibility()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  result jsonb;
begin
  if coalesce(current_setting('request.jwt.claim.role', true), '') <> 'service_role' then
    raise exception 'SERVICE_ROLE_REQUIRED';
  end if;

  select jsonb_build_object(
    'eligible', c.execution_enabled
      and not c.emergency_halted
      and r.mode = 'LIVE'
      and r.heartbeat_at > now() - interval '30 seconds'
      and r.consecutive_failures = 0
      and r.last_error_code is null,
    'execution_enabled', c.execution_enabled,
    'emergency_halted', c.emergency_halted,
    'worker_mode', r.mode,
    'worker_healthy', coalesce(r.heartbeat_at > now() - interval '30 seconds', false),
    'consecutive_failures', coalesce(r.consecutive_failures, 0)
  ) into result
  from public.copy_system_control c
  left join private.copy_worker_runtime r on r.singleton
  where c.singleton;

  return coalesce(result, jsonb_build_object('eligible', false));
end;
$$;

revoke all on function public.get_copy_live_resume_eligibility() from public, anon, authenticated;
grant execute on function public.get_copy_live_resume_eligibility() to service_role;
