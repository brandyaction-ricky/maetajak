-- The Master is a signal source only. It may read Futures positions but must never place orders.
create or replace function private.enforce_master_read_only_marker()
returns trigger language plpgsql set search_path = public, pg_temp
as $$
begin
  if new.connection_role = 'MASTER' then
    new.futures_trade := false;
  end if;
  return new;
end;
$$;

drop trigger if exists enforce_master_read_only_marker on private.gate_api_credentials;
create trigger enforce_master_read_only_marker
before insert or update of connection_role, futures_trade on private.gate_api_credentials
for each row execute function private.enforce_master_read_only_marker();

update private.gate_api_credentials
set futures_trade = false, updated_at = now()
where connection_role = 'MASTER' and futures_trade;

-- Include the credential role so the Worker can require Read Only for Master and Read/Write for members.
drop function if exists public.claim_gate_api_verification_jobs(integer);
create function public.claim_gate_api_verification_jobs(p_limit integer default 5)
returns table (
  job_id bigint, user_id uuid, connection_role text, gate_uid text, api_key text, secret_key text
)
language plpgsql security definer set search_path = public, pg_temp
as $$
declare encryption_key text;
begin
  select decrypted_secret into encryption_key
  from vault.decrypted_secrets where name = 'gate_api_credentials_key';
  if encryption_key is null then raise exception 'ENCRYPTION_KEY_NOT_CONFIGURED'; end if;

  return query
  with claimed as (
    select job.id
    from private.gate_api_verification_jobs as job
    where job.run_after <= now()
      and (job.claimed_at is null or job.claimed_at < now() - interval '2 minutes')
    order by job.created_at
    for update skip locked
    limit greatest(1, least(coalesce(p_limit, 5), 20))
  ), updated_jobs as (
    update private.gate_api_verification_jobs as job
    set claimed_at = now(), attempts = job.attempts + 1, updated_at = now()
    from claimed where job.id = claimed.id
    returning job.id, job.user_id
  ), marked as (
    update private.gate_api_credentials as credentials
    set status = 'VERIFYING', updated_at = now()
    from updated_jobs where credentials.user_id = updated_jobs.user_id
    returning credentials.user_id
  )
  select updated_jobs.id, credentials.user_id, credentials.connection_role, credentials.gate_uid,
    pgp_sym_decrypt(credentials.api_key_ciphertext, encryption_key),
    pgp_sym_decrypt(credentials.secret_key_ciphertext, encryption_key)
  from updated_jobs
  join private.gate_api_credentials as credentials on credentials.user_id = updated_jobs.user_id
  join marked on marked.user_id = updated_jobs.user_id;
end;
$$;
revoke all on function public.claim_gate_api_verification_jobs(integer) from public, anon, authenticated;
grant execute on function public.claim_gate_api_verification_jobs(integer) to service_role;

create or replace function public.complete_gate_api_verification(
  p_job_id bigint, p_success boolean, p_gate_user_id text default null,
  p_error_code text default null, p_error_message text default null,
  p_worker_public_ip text default null
)
returns void language plpgsql security definer set search_path = public, pg_temp
as $$
declare target_user_id uuid;
declare target_connection_role text;
begin
  if p_success and nullif(trim(p_worker_public_ip), '') is null then raise exception 'WORKER_IP_REQUIRED'; end if;
  select job.user_id, credentials.connection_role into target_user_id, target_connection_role
  from private.gate_api_verification_jobs job
  join private.gate_api_credentials credentials on credentials.user_id = job.user_id
  where job.id = p_job_id for update of job;
  if target_user_id is null then raise exception 'JOB_NOT_FOUND'; end if;

  update private.gate_api_credentials set
    status = case when p_success then 'VERIFIED' else 'ERROR' end,
    futures_read = p_success,
    futures_trade = p_success and target_connection_role = 'MEMBER',
    ip_whitelisted = p_success,
    withdrawal_disabled = p_success,
    permissions_confirmed = p_success,
    gate_user_id = nullif(trim(p_gate_user_id), ''),
    verification_version = case when p_success then 2 else 1 end,
    verified_worker_ip = case when p_success then trim(p_worker_public_ip)::inet else null end,
    last_error_code = case when p_success then null else left(coalesce(p_error_code, 'VERIFICATION_FAILED'), 80) end,
    last_error = case when p_success then null else left(coalesce(p_error_message, 'Gate.io verification failed'), 300) end,
    last_checked_at = now(), verified_at = case when p_success then now() else null end, updated_at = now()
  where user_id = target_user_id;

  if p_success then
    insert into private.trading_accounts(user_id, credential_user_id, account_role, settle, status, is_primary, updated_at)
    values(target_user_id, target_user_id, target_connection_role, 'usdt', 'ACTIVE', true, now())
    on conflict(credential_user_id, account_role, settle) do update set status = 'ACTIVE', updated_at = now();
  else
    update private.trading_accounts set status = 'ERROR', updated_at = now()
    where credential_user_id = target_user_id and account_role = target_connection_role;
  end if;

  delete from private.gate_api_verification_jobs where id = p_job_id;
  insert into public.admin_audit_logs(action, target_user_id, next_value)
  values(case when p_success then 'GATE_API_VERIFIED' else 'GATE_API_VERIFICATION_FAILED' end, target_user_id,
    jsonb_build_object('success', p_success, 'connection_role', target_connection_role,
      'futures_trade', p_success and target_connection_role = 'MEMBER',
      'verification_version', case when p_success then 2 else 1 end, 'error_code', p_error_code));
end;
$$;
revoke all on function public.complete_gate_api_verification(bigint, boolean, text, text, text, text) from public, anon, authenticated;
grant execute on function public.complete_gate_api_verification(bigint, boolean, text, text, text, text) to service_role;

-- Master credentials are available to the Worker only when Read is verified and Trade is disabled.
create or replace function public.get_copy_worker_context()
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $$
declare encryption_key text;
declare result jsonb;
begin
  select decrypted_secret into encryption_key from vault.decrypted_secrets where name = 'gate_api_credentials_key';
  if encryption_key is null then raise exception 'ENCRYPTION_KEY_NOT_CONFIGURED'; end if;

  select jsonb_build_object(
    'system', (select jsonb_build_object('execution_enabled', c.execution_enabled, 'emergency_halted', c.emergency_halted,
      'halt_reason', c.halt_reason, 'slippage_ratio', c.max_order_slippage_ratio) from public.copy_system_control c where c.singleton),
    'master', (select jsonb_build_object(
      'trading_account_id', a.id, 'user_id', a.user_id, 'gate_uid', g.gate_uid,
      'api_key', pgp_sym_decrypt(g.api_key_ciphertext, encryption_key),
      'secret_key', pgp_sym_decrypt(g.secret_key_ciphertext, encryption_key)
    ) from private.trading_accounts a join private.gate_api_credentials g on g.user_id = a.credential_user_id
      where a.account_role = 'MASTER' and a.status = 'ACTIVE' and g.status = 'VERIFIED'
        and g.futures_read and not g.futures_trade
      order by a.updated_at desc limit 1),
    'members', coalesce((select jsonb_agg(jsonb_build_object(
      'trading_account_id', a.id, 'user_id', a.user_id, 'gate_uid', g.gate_uid,
      'api_key', pgp_sym_decrypt(g.api_key_ciphertext, encryption_key),
      'secret_key', pgp_sym_decrypt(g.secret_key_ciphertext, encryption_key),
      'copy_ratio', p.copy_ratio, 'max_position_ratio', p.max_position_ratio,
      'copy_paused', p.copy_paused, 'halted', p.member_halted, 'reduce_only', p.reduce_only,
      'close_positions_requested', p.close_positions_requested,
      'daily_loss_limit_pct', p.daily_loss_limit_pct, 'max_drawdown_pct', p.max_drawdown_pct,
      'max_leverage', p.max_leverage,
      'day_start_equity', (select s.total_equity from private.copy_account_snapshots s
        where s.trading_account_id = a.id and s.observed_at >= date_trunc('day', now()) order by s.observed_at limit 1),
      'peak_equity', (select max(s.total_equity) from private.copy_account_snapshots s where s.trading_account_id = a.id),
      'previous_states', coalesce((select jsonb_agg(jsonb_build_object(
        'contract', s.contract, 'state', s.state, 'actual_size', s.actual_size,
        'last_observed_at', s.last_observed_at,
        'known_fill_delta', coalesce((select sum(i.filled_size) from private.copy_order_intents i
          where i.trading_account_id = a.id and i.contract = s.contract
            and i.updated_at > coalesce(s.last_observed_at, '-infinity'::timestamptz) and i.filled_size <> 0), 0),
        'has_unresolved_order', exists(select 1 from private.copy_order_intents i
          where i.trading_account_id = a.id and i.contract = s.contract
            and i.status in ('SUBMITTING','ACKNOWLEDGED','PARTIALLY_FILLED','UNKNOWN'))
      ) order by s.contract) from public.copy_position_states s where s.trading_account_id = a.id), '[]'::jsonb)
    ) order by p.created_at) from private.trading_accounts a
      join private.gate_api_credentials g on g.user_id = a.credential_user_id
      join public.profiles p on p.id = a.user_id
      where a.account_role = 'MEMBER' and a.status = 'ACTIVE' and g.status = 'VERIFIED'
        and g.futures_read and g.futures_trade and p.role = 'MEMBER' and p.approval_status = 'APPROVED'), '[]'::jsonb)
  ) into result;
  return result;
end;
$$;
revoke all on function public.get_copy_worker_context() from public, anon, authenticated;
grant execute on function public.get_copy_worker_context() to service_role;
