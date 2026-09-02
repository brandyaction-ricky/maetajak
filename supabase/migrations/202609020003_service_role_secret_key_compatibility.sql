-- Supabase secret keys (`sb_secret_...`) are authorized by PostgREST as the
-- service_role database role, but do not populate the legacy JWT claim GUC.
-- Function EXECUTE privileges remain the authorization boundary.
create or replace function public.get_or_initialize_member_copy_baselines(
  p_trading_account_id uuid,
  p_master_positions jsonb,
  p_member_positions jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare result jsonb;
begin
  if not exists (
    select 1 from private.trading_accounts
    where id = p_trading_account_id and account_role = 'MEMBER' and status = 'ACTIVE'
  ) then
    raise exception 'ACTIVE_MEMBER_ACCOUNT_REQUIRED';
  end if;

  insert into private.member_copy_onboarding_baselines(
    trading_account_id, positions, member_positions
  ) values (
    p_trading_account_id,
    coalesce((
      select jsonb_agg(jsonb_build_object(
        'contract', item->>'contract',
        'position_side', coalesce(nullif(item->>'position_side', ''), case when (item->>'size')::numeric < 0 then 'SHORT' else 'LONG' end),
        'size', (item->>'size')::numeric
      ) order by item->>'contract', item->>'position_side')
      from jsonb_array_elements(coalesce(p_master_positions, '[]'::jsonb)) item
      where nullif(item->>'contract', '') is not null and coalesce((item->>'size')::numeric, 0) <> 0
    ), '[]'::jsonb),
    coalesce((
      select jsonb_agg(jsonb_build_object(
        'contract', item->>'contract',
        'position_side', coalesce(nullif(item->>'position_side', ''), case when (item->>'size')::numeric < 0 then 'SHORT' else 'LONG' end),
        'size', (item->>'size')::numeric
      ) order by item->>'contract', item->>'position_side')
      from jsonb_array_elements(coalesce(p_member_positions, '[]'::jsonb)) item
      where nullif(item->>'contract', '') is not null and coalesce((item->>'size')::numeric, 0) <> 0
    ), '[]'::jsonb)
  )
  on conflict (trading_account_id) do nothing;

  select jsonb_build_object(
    'initialized_at', baseline.initialized_at,
    'positions', baseline.positions,
    'member_positions', baseline.member_positions
  ) into result
  from private.member_copy_onboarding_baselines baseline
  where baseline.trading_account_id = p_trading_account_id;
  return result;
end;
$$;

revoke all on function public.get_or_initialize_member_copy_baselines(uuid, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function public.get_or_initialize_member_copy_baselines(uuid, jsonb, jsonb)
  to service_role;

notify pgrst, 'reload schema';
