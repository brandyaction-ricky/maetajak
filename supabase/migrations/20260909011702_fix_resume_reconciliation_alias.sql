-- Qualify columns that share names with RETURNS TABLE output parameters.
CREATE OR REPLACE FUNCTION public.claim_copy_reconciliation_jobs(p_limit integer DEFAULT 10)
 RETURNS TABLE(job_id bigint, intent_id uuid, contract text, gate_order_id text, gate_order_text text, api_key text, secret_key text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
declare encryption_key text;
begin
  perform private.require_copy_worker_role();
  perform pg_advisory_xact_lock(hashtextextended('maetajak:copy-execution',0));
  -- A new-generation claim that was never authorized cannot have reached Gate.
  update private.copy_order_intents i set status='CANCELLED',exchange_terminal=true,resolved_at=now(),
    last_error_code='UNSENT_CLAIM_EXPIRED',updated_at=now()
    where i.resume_version is not null and i.status='SUBMITTING' and i.submission_authorized_at is null
      and i.gate_order_id is null and i.submitted_at<now()-interval '30 seconds';
  insert into private.copy_reconciliation_jobs(intent_id,run_after,claimed_at,updated_at)
  select i.id,now(),null,now() from private.copy_order_intents i
  where i.status='SUBMITTING' and i.updated_at<now()-interval '30 seconds'
  on conflict on constraint copy_reconciliation_jobs_intent_id_key do nothing;
  select decrypted_secret into encryption_key from vault.decrypted_secrets where name='gate_api_credentials_key';
  return query with claimed as (
    select j.id from private.copy_reconciliation_jobs j
    where j.run_after<=now() and (j.claimed_at is null or j.claimed_at<now()-interval '1 minute')
    order by j.run_after for update skip locked
    limit greatest(1,least(coalesce(p_limit,10),50))
  ),updated as (
    update private.copy_reconciliation_jobs j
    set claimed_at=now(),attempts=j.attempts+1,updated_at=now()
    from claimed where j.id=claimed.id returning j.*
  )
  select u.id,i.id,i.contract,i.gate_order_id,i.gate_order_text,
    pgp_sym_decrypt(g.api_key_ciphertext,encryption_key),
    pgp_sym_decrypt(g.secret_key_ciphertext,encryption_key)
  from updated u
  join private.copy_order_intents i on i.id=u.intent_id
  join private.trading_accounts a on a.id=i.trading_account_id
  join private.gate_api_credentials g on g.user_id=a.credential_user_id;
end;
$function$;
notify pgrst, 'reload schema';
