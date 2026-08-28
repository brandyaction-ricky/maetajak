alter table public.profiles
  drop constraint if exists profiles_copy_ratio_check,
  drop constraint if exists profiles_max_position_ratio_check;

alter table public.profiles
  add constraint profiles_copy_ratio_check
    check (copy_ratio between 50 and 200 and mod(copy_ratio, 10) = 0),
  add constraint profiles_max_position_ratio_check
    check (max_position_ratio between 20 and 50 and mod(max_position_ratio, 10) = 0);

create or replace function public.update_my_copy_settings(
  new_copy_ratio numeric,
  new_max_position_ratio numeric,
  new_daily_loss_limit_pct numeric,
  new_max_drawdown_pct numeric,
  new_max_leverage numeric
)
returns public.profiles
language plpgsql security definer set search_path = public, pg_temp
as $$
declare updated_profile public.profiles;
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED'; end if;
  if not exists (select 1 from public.profiles where id = auth.uid() and role = 'MEMBER' and approval_status = 'APPROVED') then
    raise exception 'APPROVAL_REQUIRED';
  end if;
  if new_copy_ratio < 50 or new_copy_ratio > 200 or mod(new_copy_ratio, 10) <> 0 then raise exception 'INVALID_COPY_RATIO'; end if;
  if new_max_position_ratio < 20 or new_max_position_ratio > 50 or mod(new_max_position_ratio, 10) <> 0 then raise exception 'INVALID_MAX_POSITION_RATIO'; end if;
  if new_daily_loss_limit_pct < 3 or new_daily_loss_limit_pct > 10 or trunc(new_daily_loss_limit_pct) <> new_daily_loss_limit_pct then raise exception 'INVALID_DAILY_LOSS_LIMIT'; end if;
  if new_max_drawdown_pct < 10 or new_max_drawdown_pct > 20 or trunc(new_max_drawdown_pct) <> new_max_drawdown_pct then raise exception 'INVALID_DRAWDOWN_LIMIT'; end if;
  if new_max_leverage < 1 or new_max_leverage > 20 or trunc(new_max_leverage) <> new_max_leverage then raise exception 'INVALID_MAX_LEVERAGE'; end if;
  update public.profiles set
    copy_ratio = new_copy_ratio,
    max_position_ratio = new_max_position_ratio,
    daily_loss_limit_pct = new_daily_loss_limit_pct,
    max_drawdown_pct = new_max_drawdown_pct,
    max_leverage = new_max_leverage,
    updated_at = now()
  where id = auth.uid()
  returning * into updated_profile;
  return updated_profile;
end;
$$;

revoke all on function public.update_my_copy_settings(numeric, numeric, numeric, numeric, numeric) from public, anon;
grant execute on function public.update_my_copy_settings(numeric, numeric, numeric, numeric, numeric) to authenticated;
