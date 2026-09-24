-- Owner decision 2026-09-24: risk limits are fixed for every account — daily loss 15%, total drawdown 20%.
-- Applied to production on 2026-09-24 as migration version 20260924122342 (fix_member_risk_limits_15_20).
-- The production apply also carried a one-time guard that aborted unless the previous function body had
-- md5(prosrc) = ab9d0bdcbcda95ce735bef8915516429. Existing profiles were set to 15/20 by a separate audited
-- data change (admin_audit_logs action COPY_RISK_LIMITS_FIXED), not by this migration.

-- 1) New accounts start with the fixed values.
alter table public.profiles alter column daily_loss_limit_pct set default 15;
alter table public.profiles alter column max_drawdown_pct set default 20;

-- 2) Members can no longer change risk limits. The signature is kept for the member UI;
--    the two risk arguments are accepted and ignored.
create or replace function public.update_my_copy_settings(new_copy_ratio numeric, new_max_position_ratio numeric, new_daily_loss_limit_pct numeric, new_max_drawdown_pct numeric, new_max_leverage numeric)
 returns profiles
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare updated_profile public.profiles;
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED'; end if;
  if not exists (select 1 from public.profiles where id = auth.uid() and role = 'MEMBER' and approval_status = 'APPROVED') then
    raise exception 'APPROVAL_REQUIRED';
  end if;
  if new_copy_ratio < 50 or new_copy_ratio > 200 or mod(new_copy_ratio, 10) <> 0 then raise exception 'INVALID_COPY_RATIO'; end if;
  if new_max_position_ratio < 20 or new_max_position_ratio > 50 or mod(new_max_position_ratio, 10) <> 0 then raise exception 'INVALID_MAX_POSITION_RATIO'; end if;
  if new_max_leverage < 1 or new_max_leverage > 20 or trunc(new_max_leverage) <> new_max_leverage then raise exception 'INVALID_MAX_LEVERAGE'; end if;
  -- daily_loss_limit_pct / max_drawdown_pct are owner-fixed since 2026-09-24 (15% / 20%).
  -- new_daily_loss_limit_pct and new_max_drawdown_pct are ignored.
  update public.profiles set
    copy_ratio = new_copy_ratio,
    max_position_ratio = new_max_position_ratio,
    max_leverage = new_max_leverage,
    updated_at = now()
  where id = auth.uid()
  returning * into updated_profile;
  return updated_profile;
end;
$function$;
