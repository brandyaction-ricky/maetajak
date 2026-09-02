-- Public, read-only projection for the standalone Master position monitor.
-- It intentionally exposes no user, member, account, credential, order, or copy-setting data.
create or replace function public.get_public_master_positions()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with master_account as (
    select account.id
    from private.trading_accounts account
    where account.account_role = 'MASTER'
      and account.status = 'ACTIVE'
    order by account.updated_at desc
    limit 1
  ), latest_snapshot as (
    select snapshot.id, snapshot.observed_at
    from private.copy_account_snapshots snapshot
    join master_account account on account.id = snapshot.trading_account_id
    order by snapshot.observed_at desc
    limit 1
  ), open_positions as (
    select
      position.contract,
      case when position.size > 0 then 'LONG' else 'SHORT' end as side,
      position.size,
      position.entry_price,
      position.mark_price,
      position.leverage,
      abs(position.size * position.mark_price * position.quanto_multiplier) as notional,
      case when position.entry_price > 0
        then (position.mark_price - position.entry_price) * position.size * position.quanto_multiplier
        else 0 end as unrealised_pnl,
      case when position.entry_price > 0 and coalesce(position.leverage, 0) > 0
        then (position.mark_price - position.entry_price) * sign(position.size) * position.leverage * 100 / position.entry_price
        else 0 end as roe,
      position.observed_at
    from private.copy_position_snapshots position
    join latest_snapshot snapshot on snapshot.id = position.account_snapshot_id
    where position.size <> 0
  )
  select jsonb_build_object(
    'observed_at', (select observed_at from latest_snapshot),
    'positions', coalesce((
      select jsonb_agg(jsonb_build_object(
        'contract', position.contract,
        'side', position.side,
        'size', position.size,
        'entry_price', position.entry_price,
        'mark_price', position.mark_price,
        'leverage', position.leverage,
        'notional', position.notional,
        'unrealised_pnl', position.unrealised_pnl,
        'roe', position.roe,
        'observed_at', position.observed_at
      ) order by position.notional desc)
      from open_positions position
    ), '[]'::jsonb)
  );
$$;

revoke all on function public.get_public_master_positions() from public, anon, authenticated;
grant execute on function public.get_public_master_positions() to anon, authenticated;

comment on function public.get_public_master_positions() is
  'Sanitized, read-only current Master futures positions for the public monitor.';
