import { createClient } from '@supabase/supabase-js';
import { verifyGateAccount } from './gate.js';

const supabaseUrl = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const pollIntervalMs = Math.max(2_000, Number(process.env.POLL_INTERVAL_MS || 5_000));
if (!supabaseUrl || !serviceRoleKey) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');

const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
let running = false;

export async function runVerificationBatch() {
  if (running) return;
  running = true;
  try {
    const { data: jobs, error } = await supabase.rpc('claim_gate_api_verification_jobs', { p_limit: 5 });
    if (error) throw error;
    for (const job of jobs || []) {
      const result = await verifyGateAccount({ gateUid: job.gate_uid, apiKey: job.api_key, secretKey: job.secret_key, baseUrl: process.env.GATE_API_BASE_URL });
      const { error: completionError } = await supabase.rpc('complete_gate_api_verification', {
        p_job_id: job.job_id, p_success: result.success, p_gate_user_id: result.gateUserId || null,
        p_error_code: result.errorCode || null, p_error_message: result.errorMessage || null,
      });
      if (completionError) throw completionError;
    }
  } catch (error) {
    console.error('[gate-verification]', error instanceof Error ? error.message : 'unknown error');
  } finally { running = false; }
}

await runVerificationBatch();
setInterval(runVerificationBatch, pollIntervalMs);

