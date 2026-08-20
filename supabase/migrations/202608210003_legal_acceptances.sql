alter table public.profiles
  add column if not exists terms_version text,
  add column if not exists privacy_version text;

create table if not exists public.legal_acceptances (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  document_type text not null check (document_type in ('TERMS', 'PRIVACY')),
  document_version text not null,
  accepted_at timestamptz not null,
  acceptance_source text not null default 'SIGNUP' check (acceptance_source in ('SIGNUP', 'RECONSENT')),
  created_at timestamptz not null default now(),
  unique (user_id, document_type, document_version)
);
alter table public.legal_acceptances enable row level security;

drop policy if exists "members read own legal acceptances" on public.legal_acceptances;
create policy "members read own legal acceptances" on public.legal_acceptances
  for select to authenticated using (user_id = auth.uid() or public.is_approved_admin());
revoke insert, update, delete on public.legal_acceptances from public, anon, authenticated;
grant select on public.legal_acceptances to authenticated;

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public
as $$
declare accepted_at timestamptz;
declare accepted_terms_version text;
declare accepted_privacy_version text;
begin
  accepted_at := nullif(new.raw_user_meta_data ->> 'terms_accepted_at', '')::timestamptz;
  accepted_terms_version := nullif(new.raw_user_meta_data ->> 'terms_version', '');
  accepted_privacy_version := nullif(new.raw_user_meta_data ->> 'privacy_version', '');

  insert into public.profiles (
    id, email, full_name, phone, terms_accepted_at, terms_version, privacy_version
  ) values (
    new.id, coalesce(new.email, ''),
    coalesce(new.raw_user_meta_data ->> 'full_name', ''),
    coalesce(new.raw_user_meta_data ->> 'phone', ''),
    accepted_at, accepted_terms_version, accepted_privacy_version
  ) on conflict (id) do nothing;

  if accepted_at is not null and accepted_terms_version is not null then
    insert into public.legal_acceptances (user_id, document_type, document_version, accepted_at)
    values (new.id, 'TERMS', accepted_terms_version, accepted_at)
    on conflict (user_id, document_type, document_version) do nothing;
  end if;
  if accepted_at is not null and accepted_privacy_version is not null then
    insert into public.legal_acceptances (user_id, document_type, document_version, accepted_at)
    values (new.id, 'PRIVACY', accepted_privacy_version, accepted_at)
    on conflict (user_id, document_type, document_version) do nothing;
  end if;
  return new;
end;
$$;
revoke all on function public.handle_new_user() from public;
