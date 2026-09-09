create or replace function public.claim_open_order_cancel_jobs(p_limit integer default 5)
returns table(job_id bigint,api_key text,secret_key text)
language plpgsql security definer set search_path=public,extensions,pg_temp
as $$
declare encryption_key text;
begin
  perform private.require_copy_worker_role();

  -- This maintenance queue is intentionally inactive during LIVE copying.
  -- A normal LIVE cycle must see an empty queue instead of a worker failure.
  if not exists(
    select 1 from public.copy_system_control
    where singleton and not execution_enabled and emergency_halted
  ) then return; end if;

  select decrypted_secret into encryption_key
  from vault.decrypted_secrets
  where name='gate_api_credentials_key';

  return query with claimed as (
    select j.id from private.open_order_cancel_jobs j
    join private.trading_accounts a
      on a.id=j.trading_account_id and a.status='ACTIVE' and a.account_role='MEMBER'
    join private.gate_api_credentials g
      on g.user_id=a.credential_user_id and g.status='VERIFIED' and g.futures_trade
    cross join private.copy_worker_runtime r
    where r.singleton
      and g.verified_worker_ip=r.public_ip
      and j.attempts<5
      and j.run_after<=now()
      and (
        j.state in ('PENDING','FAILED')
        or (j.state='PROCESSING' and j.claimed_at<now()-interval '1 minute')
      )
    order by j.run_after,j.id
    for update of j skip locked
    limit greatest(1,least(coalesce(p_limit,5),20))
  ), updated as (
    update private.open_order_cancel_jobs j
    set state='PROCESSING',claimed_at=now(),attempts=j.attempts+1,updated_at=now()
    from claimed
    where j.id=claimed.id
    returning j.*
  )
  select
    u.id,
    pgp_sym_decrypt(g.api_key_ciphertext,encryption_key),
    pgp_sym_decrypt(g.secret_key_ciphertext,encryption_key)
  from updated u
  join private.trading_accounts a on a.id=u.trading_account_id
  join private.gate_api_credentials g on g.user_id=a.credential_user_id;
end;
$$;

revoke all on function public.claim_open_order_cancel_jobs(integer)
  from public,anon,authenticated;
grant execute on function public.claim_open_order_cancel_jobs(integer)
  to service_role;
