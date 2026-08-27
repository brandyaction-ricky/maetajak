-- Supabase installs pgcrypto in the extensions schema. These SECURITY DEFINER
-- functions previously used an intentionally narrow search_path that omitted
-- extensions, so pgp_sym_encrypt/decrypt could not be resolved at runtime.
-- The extensions schema is Supabase-managed; keep pg_temp last.

alter function public.save_gate_api_credentials(text, text, text, boolean)
  set search_path = public, extensions, pg_temp;

alter function public.save_admin_gate_api_credentials(text, text, text, boolean)
  set search_path = public, extensions, pg_temp;

alter function public.claim_gate_api_verification_jobs(integer)
  set search_path = public, extensions, pg_temp;

alter function public.get_copy_worker_context()
  set search_path = public, extensions, pg_temp;

alter function public.claim_copy_order_intents(integer)
  set search_path = public, extensions, pg_temp;

alter function public.claim_copy_reconciliation_jobs(integer)
  set search_path = public, extensions, pg_temp;

alter function public.disable_my_gate_api_connection(text)
  set search_path = public, extensions, pg_temp;

alter function public.disable_admin_master_gate_api_connection(text)
  set search_path = public, extensions, pg_temp;
