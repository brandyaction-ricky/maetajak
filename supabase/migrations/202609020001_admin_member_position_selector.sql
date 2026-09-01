-- Admin-only dashboard data for switching between Master and member positions.
create or replace function public.get_admin_live_trading_data()
returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare result jsonb;
begin
  if not public.is_approved_admin() then raise exception 'ADMIN_REQUIRED'; end if;
  select jsonb_build_object(
    'master_positions',coalesce((select jsonb_agg(jsonb_build_object(
      'contract',p.contract,'size',p.size,'mark_price',p.mark_price,'entry_price',p.entry_price,
      'leverage',p.leverage,'quanto_multiplier',p.quanto_multiplier,
      'unrealised_pnl',(p.mark_price-p.entry_price)*p.size*p.quanto_multiplier,'observed_at',p.observed_at
    ) order by p.contract)
      from private.copy_position_snapshots p join private.trading_accounts a on a.id=p.trading_account_id
      where a.account_role='MASTER' and p.account_snapshot_id=(select s.id from private.copy_account_snapshots s where s.trading_account_id=a.id order by s.observed_at desc limit 1)),'[]'::jsonb),
    'position_members',coalesce((select jsonb_agg(jsonb_build_object(
      'user_id',p.id,'name',p.full_name,'email',p.email
    ) order by coalesce(p.full_name,p.email))
      from public.profiles p where p.role='MEMBER' and p.approval_status='APPROVED'),'[]'::jsonb),
    'member_positions',coalesce((select jsonb_agg(jsonb_build_object(
      'user_id',a.user_id,'name',profile.full_name,'email',profile.email,
      'contract',position.contract,'size',position.size,
      'side',case when position.size>0 then 'LONG' else 'SHORT' end,
      'entry_price',position.entry_price,'mark_price',position.mark_price,'leverage',position.leverage,
      'quanto_multiplier',position.quanto_multiplier,
      'notional',abs(position.size*position.mark_price*position.quanto_multiplier),
      'margin',case when coalesce(position.leverage,0)>0 then abs(position.size*position.mark_price*position.quanto_multiplier)/position.leverage else null end,
      'unrealised_pnl',case when position.entry_price>0 then (position.mark_price-position.entry_price)*position.size*position.quanto_multiplier else 0 end,
      'roe',case when position.entry_price>0 and coalesce(position.leverage,0)>0 then (position.mark_price-position.entry_price)*sign(position.size)*position.leverage*100/position.entry_price else null end,
      'observed_at',position.observed_at
    ) order by coalesce(profile.full_name,profile.email),abs(position.size*position.mark_price*position.quanto_multiplier) desc)
      from private.trading_accounts a
      join public.profiles profile on profile.id=a.user_id
      join private.copy_account_snapshots snapshot on snapshot.id=(select latest.id from private.copy_account_snapshots latest where latest.trading_account_id=a.id order by latest.observed_at desc limit 1)
      join private.copy_position_snapshots position on position.account_snapshot_id=snapshot.id and position.size<>0
      where a.account_role='MEMBER' and a.status='ACTIVE'),'[]'::jsonb),
    'member_states',coalesce((select jsonb_agg(jsonb_build_object(
      'name',p.full_name,'email',p.email,'contract',s.contract,'state',s.state,
      'target_size',s.target_size,'actual_size',s.actual_size,
      'actual_notional',abs(s.actual_size*latest.mark_price*latest.quanto_multiplier),
      'delta_size',s.delta_size,'pause_reason',s.pause_reason,'observed_at',s.last_observed_at
    ) order by s.updated_at desc)
      from public.copy_position_states s join public.profiles p on p.id=s.user_id
      left join lateral (select ps.mark_price,ps.quanto_multiplier from private.copy_position_snapshots ps
        where ps.trading_account_id=s.trading_account_id and ps.contract=s.contract order by ps.observed_at desc limit 1) latest on true),'[]'::jsonb),
    'orders',coalesce((select jsonb_agg(jsonb_build_object(
      'name',p.full_name,'email',p.email,'contract',i.contract,'delta_size',i.delta_size,
      'filled_size',i.filled_size,'status',i.status,'gate_order_id',i.gate_order_id,
      'error_code',i.last_error_code,'created_at',i.created_at,'updated_at',i.updated_at
    ) order by i.created_at desc)
      from (select * from private.copy_order_intents order by created_at desc limit 100) i
      join public.profiles p on p.id=i.user_id),'[]'::jsonb)
  ) into result;
  return result;
end;
$$;

revoke all on function public.get_admin_live_trading_data() from public,anon;
grant execute on function public.get_admin_live_trading_data() to authenticated;
