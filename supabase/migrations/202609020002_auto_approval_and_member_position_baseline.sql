-- Confirmed email accounts no longer wait for a separate administrator approval.
create or replace function public.auto_approve_confirmed_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare changed_profile public.profiles;
begin
  if new.email_confirmed_at is null then
    return new;
  end if;

  update public.profiles
  set approval_status = 'APPROVED',
      approved_at = coalesce(approved_at, new.email_confirmed_at, now()),
      approved_by = null,
      updated_at = now()
  where id = new.id
    and role = 'MEMBER'
    and approval_status = 'PENDING'
  returning * into changed_profile;

  if found then
    insert into public.admin_audit_logs (
      actor_id, action, target_user_id, previous_value, next_value
    ) values (
      null,
      'USER_AUTO_APPROVED_EMAIL_CONFIRMED',
      new.id,
      jsonb_build_object('approval_status', 'PENDING'),
      to_jsonb(changed_profile)
    );
  end if;
  return new;
end;
$$;

revoke all on function public.auto_approve_confirmed_user() from public, anon, authenticated;

drop trigger if exists zz_auto_approve_confirmed_user on auth.users;
create trigger zz_auto_approve_confirmed_user
  after insert or update of email_confirmed_at on auth.users
  for each row
  when (new.email_confirmed_at is not null)
  execute procedure public.auto_approve_confirmed_user();

-- Bring already-confirmed legacy members into the same rule once.
with changed as (
  update public.profiles profile
  set approval_status = 'APPROVED',
      approved_at = coalesce(profile.approved_at, auth_user.email_confirmed_at, now()),
      approved_by = null,
      updated_at = now()
  from auth.users auth_user
  where auth_user.id = profile.id
    and auth_user.email_confirmed_at is not null
    and profile.role = 'MEMBER'
    and profile.approval_status = 'PENDING'
  returning profile.*
)
insert into public.admin_audit_logs (actor_id, action, target_user_id, previous_value, next_value)
select null, 'USER_AUTO_APPROVED_EMAIL_CONFIRMED', id,
  jsonb_build_object('approval_status', 'PENDING'), to_jsonb(changed)
from changed;

-- Preserve every member position that existed before the first copy cycle.
alter table private.member_copy_onboarding_baselines
  add column if not exists member_positions jsonb not null default '[]'::jsonb;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'member_copy_onboarding_baselines_member_positions_array'
      and conrelid = 'private.member_copy_onboarding_baselines'::regclass
  ) then
    alter table private.member_copy_onboarding_baselines
      add constraint member_copy_onboarding_baselines_member_positions_array
      check (jsonb_typeof(member_positions) = 'array');
  end if;
end;
$$;

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
  if coalesce(current_setting('request.jwt.claim.role', true), '') <> 'service_role' then
    raise exception 'SERVICE_ROLE_REQUIRED';
  end if;
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
    'initialized_at', initialized_at,
    'positions', positions,
    'member_positions', member_positions
  ) into result
  from private.member_copy_onboarding_baselines
  where trading_account_id = p_trading_account_id;
  return result;
end;
$$;

revoke all on function public.get_or_initialize_member_copy_baselines(uuid, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function public.get_or_initialize_member_copy_baselines(uuid, jsonb, jsonb)
  to service_role;

comment on column private.member_copy_onboarding_baselines.member_positions is
  'Member positions observed before the first copy cycle. They are preserved and copy deltas are added on top.';
