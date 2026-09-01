create table if not exists private.gate_broker_daily_metrics (
  trading_date date primary key,
  trading_volume numeric not null default 0 check (trading_volume >= 0),
  commission numeric not null default 0,
  user_ids text[] not null default '{}',
  record_count integer not null default 0 check (record_count >= 0),
  observed_at timestamptz not null,
  updated_at timestamptz not null default now()
);

create table if not exists private.gate_broker_sync_status (
  singleton boolean primary key default true check (singleton),
  status text not null check (status in ('SYNCED', 'NOT_CONFIGURED', 'ERROR')),
  error_code text,
  observed_at timestamptz not null default now()
);

revoke all on private.gate_broker_daily_metrics from public, anon, authenticated;
revoke all on private.gate_broker_sync_status from public, anon, authenticated;

create or replace function public.upsert_gate_broker_metrics(
  p_rows jsonb,
  p_observed_at timestamptz default now()
)
returns integer
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  changed integer := 0;
begin
  if auth.role() <> 'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  if jsonb_typeof(coalesce(p_rows, '[]'::jsonb)) <> 'array' then raise exception 'ROWS_MUST_BE_ARRAY'; end if;

  insert into private.gate_broker_daily_metrics (
    trading_date, trading_volume, commission, user_ids, record_count, observed_at, updated_at
  )
  select
    (row->>'date')::date,
    greatest(coalesce((row->>'trading_volume')::numeric, 0), 0),
    coalesce((row->>'commission')::numeric, 0),
    coalesce(array(select jsonb_array_elements_text(coalesce(row->'user_ids', '[]'::jsonb))), '{}'),
    greatest(coalesce((row->>'record_count')::integer, 0), 0),
    coalesce(p_observed_at, now()), now()
  from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) row
  where row ? 'date'
  on conflict (trading_date) do update set
    trading_volume = excluded.trading_volume,
    commission = excluded.commission,
    user_ids = excluded.user_ids,
    record_count = excluded.record_count,
    observed_at = excluded.observed_at,
    updated_at = now()
  where private.gate_broker_daily_metrics.observed_at <= excluded.observed_at;
  get diagnostics changed = row_count;

  insert into private.gate_broker_sync_status(singleton, status, error_code, observed_at)
  values (true, 'SYNCED', null, coalesce(p_observed_at, now()))
  on conflict (singleton) do update set status = 'SYNCED', error_code = null, observed_at = excluded.observed_at;
  return changed;
end;
$$;

create or replace function public.report_gate_broker_sync_status(
  p_status text,
  p_error_code text default null,
  p_observed_at timestamptz default now()
)
returns void
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
begin
  if auth.role() <> 'service_role' then raise exception 'SERVICE_ROLE_REQUIRED'; end if;
  if p_status not in ('SYNCED', 'NOT_CONFIGURED', 'ERROR') then raise exception 'INVALID_STATUS'; end if;
  insert into private.gate_broker_sync_status(singleton, status, error_code, observed_at)
  values (true, p_status, left(p_error_code, 80), coalesce(p_observed_at, now()))
  on conflict (singleton) do update set
    status = excluded.status, error_code = excluded.error_code, observed_at = excluded.observed_at;
end;
$$;

create or replace function public.get_admin_gate_broker_metrics(
  p_start_date date default current_date - 29,
  p_end_date date default current_date
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, private, pg_temp
as $$
declare
  range_start date := greatest(coalesce(p_start_date, current_date - 29), current_date - 364);
  range_end date := least(coalesce(p_end_date, current_date), current_date);
  result jsonb;
begin
  if not public.is_approved_admin() then raise exception 'ADMIN_REQUIRED'; end if;
  if range_start > range_end then raise exception 'INVALID_DATE_RANGE'; end if;

  with daily as (
    select trading_date, trading_volume, commission, user_ids, record_count, observed_at
    from private.gate_broker_daily_metrics
    where trading_date between range_start and range_end
  ), unique_users as (
    select count(distinct user_id) as users
    from daily cross join lateral unnest(daily.user_ids) user_id
  )
  select jsonb_build_object(
    'range_start', range_start,
    'range_end', range_end,
    'source', 'GATE_BROKER_API',
    'totals', jsonb_build_object(
      'trading_volume', coalesce((select sum(trading_volume) from daily), 0),
      'commission', coalesce((select sum(commission) from daily), 0),
      'users', coalesce((select users from unique_users), 0),
      'records', coalesce((select sum(record_count) from daily), 0)
    ),
    'daily', coalesce((select jsonb_agg(jsonb_build_object(
      'date', trading_date,
      'trading_volume', trading_volume,
      'commission', commission,
      'users', cardinality(user_ids)
    ) order by trading_date) from daily), '[]'::jsonb),
    'sync', coalesce((select jsonb_build_object(
      'status', status, 'error_code', error_code, 'observed_at', observed_at
    ) from private.gate_broker_sync_status where singleton), jsonb_build_object('status', 'NOT_CONFIGURED'))
  ) into result;
  return result;
end;
$$;

revoke all on function public.upsert_gate_broker_metrics(jsonb, timestamptz) from public, anon, authenticated;
revoke all on function public.report_gate_broker_sync_status(text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.get_admin_gate_broker_metrics(date, date) from public, anon;
grant execute on function public.upsert_gate_broker_metrics(jsonb, timestamptz) to service_role;
grant execute on function public.report_gate_broker_sync_status(text, text, timestamptz) to service_role;
grant execute on function public.get_admin_gate_broker_metrics(date, date) to authenticated;
