create or replace function private.queue_copy_entry_alert()
returns trigger
language plpgsql
security definer
set search_path=pg_catalog
as $$
declare
  member_label text;
  contract_multiplier numeric;
  fill_notional_usdt numeric;
  fill_notional_label text;
begin
  if new.reduce_only or new.filled_size=0
    or (new.status<>'FILLED' and not new.exchange_terminal)
    or (old.filled_size<>0 and (old.status='FILLED' or old.exchange_terminal)) then
    return new;
  end if;

  select coalesce(nullif(p.nickname,''),nullif(p.full_name,''),'회원 계정')
    into member_label
  from public.profiles p
  where p.id=new.user_id;

  select cp.quanto_multiplier
    into contract_multiplier
  from private.copy_current_positions cp
  where cp.trading_account_id=new.trading_account_id
    and cp.contract=new.contract
    and cp.position_side=new.position_side
  limit 1;

  if new.average_fill_price>0 and contract_multiplier>0 then
    fill_notional_usdt :=
      abs(new.filled_size) * new.average_fill_price * contract_multiplier;
    fill_notional_label :=
      trim(to_char(round(fill_notional_usdt,2),'FM999999999999990.00')) || ' USDT';
  else
    fill_notional_label := '계산 확인 필요';
  end if;

  insert into private.copy_entry_alert_outbox(intent_id,safe_payload)
  values(new.id,jsonb_build_object(
    'member',coalesce(member_label,'회원 계정'),
    'contract',new.contract,
    'position_side',new.position_side,
    '체결 금액 (USDT)',fill_notional_label,
    'average_fill_price',new.average_fill_price,
    'target_leverage',new.target_leverage,
    'margin_mode',new.margin_mode,
    'result_status',new.status
  ))
  on conflict(intent_id) do nothing;

  return new;
end;
$$;

revoke all on function private.queue_copy_entry_alert()
  from public,anon,authenticated;
