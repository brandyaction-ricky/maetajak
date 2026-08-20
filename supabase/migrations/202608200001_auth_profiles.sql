create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  full_name text not null default '',
  phone text not null default '',
  role text not null default 'MEMBER' check (role in ('MEMBER', 'ADMIN')),
  approval_status text not null default 'PENDING' check (approval_status in ('PENDING', 'APPROVED', 'REJECTED', 'SUSPENDED')),
  terms_accepted_at timestamptz,
  approved_at timestamptz,
  approved_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

create or replace function public.is_approved_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'ADMIN' and approval_status = 'APPROVED'
  );
$$;

revoke all on function public.is_approved_admin() from public;
grant execute on function public.is_approved_admin() to authenticated;

drop policy if exists "profiles_select_self_or_admin" on public.profiles;
create policy "profiles_select_self_or_admin"
on public.profiles for select
to authenticated
using (id = auth.uid() or public.is_approved_admin());

create table if not exists public.admin_audit_logs (
  id bigint generated always as identity primary key,
  actor_id uuid references auth.users(id),
  action text not null,
  target_user_id uuid references auth.users(id),
  previous_value jsonb,
  next_value jsonb,
  created_at timestamptz not null default now()
);

alter table public.admin_audit_logs enable row level security;
drop policy if exists "admin_audit_select_admin" on public.admin_audit_logs;
create policy "admin_audit_select_admin"
on public.admin_audit_logs for select
to authenticated
using (public.is_approved_admin());

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name, phone, terms_accepted_at)
  values (
    new.id,
    coalesce(new.email, ''),
    coalesce(new.raw_user_meta_data ->> 'full_name', ''),
    coalesce(new.raw_user_meta_data ->> 'phone', ''),
    nullif(new.raw_user_meta_data ->> 'terms_accepted_at', '')::timestamptz
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

revoke all on function public.handle_new_user() from public;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

create or replace function public.set_user_approval(target_user_id uuid, new_status text)
returns public.profiles
language plpgsql
security definer
set search_path = public
as $$
declare
  previous_profile public.profiles;
  updated_profile public.profiles;
begin
  if not public.is_approved_admin() then
    raise exception 'ADMIN_REQUIRED';
  end if;
  if new_status not in ('APPROVED', 'REJECTED', 'SUSPENDED') then
    raise exception 'INVALID_APPROVAL_STATUS';
  end if;

  select * into previous_profile from public.profiles where id = target_user_id for update;
  if not found then raise exception 'PROFILE_NOT_FOUND'; end if;

  update public.profiles
  set approval_status = new_status,
      approved_at = case when new_status = 'APPROVED' then now() else approved_at end,
      approved_by = auth.uid(),
      updated_at = now()
  where id = target_user_id
  returning * into updated_profile;

  insert into public.admin_audit_logs (actor_id, action, target_user_id, previous_value, next_value)
  values (auth.uid(), 'USER_APPROVAL_CHANGED', target_user_id, to_jsonb(previous_profile), to_jsonb(updated_profile));
  return updated_profile;
end;
$$;

revoke all on function public.set_user_approval(uuid, text) from public;
grant execute on function public.set_user_approval(uuid, text) to authenticated;

-- 최초 관리자 계정 생성 후 아래 쿼리를 Supabase SQL Editor에서 1회 실행하세요.
-- update public.profiles set role = 'ADMIN', approval_status = 'APPROVED', approved_at = now()
-- where email = 'YOUR_ADMIN_EMAIL';
