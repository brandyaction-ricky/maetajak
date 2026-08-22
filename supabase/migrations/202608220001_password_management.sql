-- Secure member password recovery request audit.
-- Supabase Auth sends the recovery email; no password is generated or stored here.

create or replace function public.request_member_password_reset(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  target_profile public.profiles;
begin
  if not public.is_approved_admin() then
    raise exception 'ADMIN_REQUIRED';
  end if;

  select * into target_profile
  from public.profiles
  where id = p_user_id and role = 'MEMBER';

  if target_profile.id is null then
    raise exception 'MEMBER_NOT_FOUND';
  end if;

  insert into public.admin_audit_logs (actor_id, action, target_user_id, next_value)
  values (
    auth.uid(),
    'MEMBER_PASSWORD_RESET_REQUESTED',
    target_profile.id,
    jsonb_build_object('delivery', 'SUPABASE_RECOVERY_EMAIL')
  );

  return jsonb_build_object(
    'user_id', target_profile.id,
    'email', target_profile.email
  );
end;
$$;

revoke all on function public.request_member_password_reset(uuid) from public;
grant execute on function public.request_member_password_reset(uuid) to authenticated;
