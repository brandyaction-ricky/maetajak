create or replace function public.prune_member_symbol_daily_performance(
  p_user_id uuid,
  p_trading_date date,
  p_active_contracts text[],
  p_source_snapshot_at timestamptz
)
returns integer
language plpgsql security definer set search_path = public, pg_temp
as $$
declare deleted_count integer;
begin
  if auth.role() <> 'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  delete from public.member_symbol_daily_performance
  where user_id = p_user_id
    and trading_date = p_trading_date
    and source_snapshot_at <= p_source_snapshot_at
    and not (contract = any(coalesce(p_active_contracts, array[]::text[])));
  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;

revoke all on function public.prune_member_symbol_daily_performance(uuid, date, text[], timestamptz) from public, anon, authenticated;
grant execute on function public.prune_member_symbol_daily_performance(uuid, date, text[], timestamptz) to service_role;

delete from public.member_symbol_daily_performance
where nullif(trim(contract), '') is null;
