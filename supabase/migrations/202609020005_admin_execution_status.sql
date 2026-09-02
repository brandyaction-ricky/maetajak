-- Read-only admin execution diagnostics. This function never mutates copy state.
create or replace function public.get_admin_execution_status(
  p_hours integer default 24,
  p_user_id uuid default null,
  p_contract text default null,
  p_status text default null,
  p_limit integer default 200
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  result jsonb;
begin
  if not public.is_approved_admin() then
    raise exception 'ADMIN_REQUIRED';
  end if;

  with order_rows as (
    select
      'ORDER'::text as record_type,
      i.id::text as record_id,
      i.user_id,
      p.full_name as member_name,
      p.email as member_email,
      i.contract,
      case when i.delta_size < 0 then 'SHORT' else 'LONG' end as position_side,
      i.target_size,
      i.actual_size_at_plan as actual_size,
      i.delta_size,
      i.filled_size,
      i.status,
      i.gate_order_id,
      i.last_error_code as reason_code,
      a.http_status,
      a.gate_label,
      a.result_status as attempt_status,
      i.created_at as occurred_at,
      i.updated_at
    from private.copy_order_intents i
    join public.profiles p on p.id = i.user_id
    left join lateral (
      select ca.http_status, ca.gate_label, ca.result_status
      from private.copy_order_attempts ca
      where ca.intent_id = i.id
      order by ca.attempt_number desc
      limit 1
    ) a on true
    where i.created_at >= now() - make_interval(hours => greatest(1, least(coalesce(p_hours, 24), 2160)))
      and (p_user_id is null or i.user_id = p_user_id)
      and (nullif(trim(p_contract), '') is null or i.contract ilike '%' || trim(p_contract) || '%')
  ), blocked_rows as (
    select
      'STATE'::text as record_type,
      s.id::text as record_id,
      s.user_id,
      p.full_name as member_name,
      p.email as member_email,
      s.contract,
      case when s.target_size < 0 or s.actual_size < 0 then 'SHORT' else 'LONG' end as position_side,
      s.target_size,
      s.actual_size,
      s.delta_size,
      0::numeric as filled_size,
      'BLOCKED'::text as status,
      null::text as gate_order_id,
      coalesce(nullif(s.pause_reason, ''), s.state) as reason_code,
      null::integer as http_status,
      null::text as gate_label,
      null::text as attempt_status,
      s.updated_at as occurred_at,
      s.updated_at
    from public.copy_position_states s
    join public.profiles p on p.id = s.user_id
    where s.state in ('MANUAL_OVERRIDE', 'PAUSED', 'ERROR', 'HALTED')
      and s.updated_at >= now() - make_interval(hours => greatest(1, least(coalesce(p_hours, 24), 2160)))
      and (p_user_id is null or s.user_id = p_user_id)
      and (nullif(trim(p_contract), '') is null or s.contract ilike '%' || trim(p_contract) || '%')
      and not exists (
        select 1 from order_rows o
        where o.user_id = s.user_id and o.contract = s.contract
          and abs(extract(epoch from (o.occurred_at - s.updated_at))) < 5
      )
  ), combined as (
    select * from order_rows
    union all
    select * from blocked_rows
  ), filtered as (
    select * from combined c
    where nullif(upper(trim(p_status)), '') is null
       or upper(trim(p_status)) = 'ALL'
       or case upper(trim(p_status))
            when 'FILLED' then c.status = 'FILLED'
            when 'PENDING' then c.status in ('PLANNED','QUEUED','SUBMITTING','ACKNOWLEDGED','PARTIALLY_FILLED')
            when 'FAILED' then c.status in ('REJECTED','CANCELLED')
            when 'CHECK' then c.status = 'UNKNOWN'
            when 'BLOCKED' then c.status = 'BLOCKED'
            else c.status = upper(trim(p_status))
          end
    order by occurred_at desc
    limit greatest(1, least(coalesce(p_limit, 200), 500))
  )
  select jsonb_build_object(
    'rows', coalesce(jsonb_agg(to_jsonb(f) order by f.occurred_at desc), '[]'::jsonb),
    'members', coalesce((
      select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.full_name, 'email', p.email) order by p.full_name, p.email)
      from public.profiles p where p.role = 'MEMBER' and p.approval_status = 'APPROVED'
    ), '[]'::jsonb)
  ) into result
  from filtered f;

  return coalesce(result, jsonb_build_object('rows', '[]'::jsonb, 'members', '[]'::jsonb));
end;
$$;

revoke all on function public.get_admin_execution_status(integer, uuid, text, text, integer) from public, anon;
grant execute on function public.get_admin_execution_status(integer, uuid, text, text, integer) to authenticated;

comment on function public.get_admin_execution_status(integer, uuid, text, text, integer) is
  'Admin-only read model for order outcomes and blocked copy-position states; exposes no credentials.';
