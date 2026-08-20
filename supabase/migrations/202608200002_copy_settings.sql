alter table public.profiles
  add column if not exists copy_ratio numeric not null default 100
    check (copy_ratio in (50, 100, 150, 200)),
  add column if not exists max_position_ratio numeric not null default 30
    check (max_position_ratio in (20, 30, 40));

create or replace function public.update_my_copy_settings(
  new_copy_ratio numeric,
  new_max_position_ratio numeric
)
returns public.profiles
language plpgsql
security definer
set search_path = public
as $$
declare
  updated_profile public.profiles;
begin
  if auth.uid() is null then
    raise exception 'AUTH_REQUIRED';
  end if;
  if not exists (
    select 1 from public.profiles
    where id = auth.uid() and approval_status = 'APPROVED'
  ) then
    raise exception 'APPROVAL_REQUIRED';
  end if;
  if new_copy_ratio not in (50, 100, 150, 200) then
    raise exception 'INVALID_COPY_RATIO';
  end if;
  if new_max_position_ratio not in (20, 30, 40) then
    raise exception 'INVALID_MAX_POSITION_RATIO';
  end if;

  update public.profiles
  set copy_ratio = new_copy_ratio,
      max_position_ratio = new_max_position_ratio,
      updated_at = now()
  where id = auth.uid()
  returning * into updated_profile;

  return updated_profile;
end;
$$;

revoke all on function public.update_my_copy_settings(numeric, numeric) from public;
grant execute on function public.update_my_copy_settings(numeric, numeric) to authenticated;
