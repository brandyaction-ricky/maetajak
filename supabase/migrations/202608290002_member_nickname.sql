alter table public.profiles
  add column if not exists nickname text;

alter table public.profiles
  drop constraint if exists profiles_nickname_length_check;

alter table public.profiles
  add constraint profiles_nickname_length_check
    check (nickname is null or char_length(trim(nickname)) between 2 and 20);

create or replace function public.update_my_nickname(new_nickname text)
returns public.profiles
language plpgsql security definer set search_path = public, pg_temp
as $$
declare updated_profile public.profiles;
declare clean_nickname text := trim(new_nickname);
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED'; end if;
  if char_length(clean_nickname) < 2 or char_length(clean_nickname) > 20 then
    raise exception 'INVALID_NICKNAME';
  end if;
  update public.profiles
  set nickname = clean_nickname, updated_at = now()
  where id = auth.uid()
  returning * into updated_profile;
  return updated_profile;
end;
$$;

revoke all on function public.update_my_nickname(text) from public, anon;
grant execute on function public.update_my_nickname(text) to authenticated;
