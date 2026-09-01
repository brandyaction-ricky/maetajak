import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
}

const supabase = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const { data, error } = await supabase.rpc('get_copy_live_resume_eligibility');
if (error) throw error;

const eligible = data?.eligible === true;

console.log(JSON.stringify({
  eligible,
  execution_enabled: data?.execution_enabled === true,
  emergency_halted: data?.emergency_halted === true,
  worker_mode: data?.worker_mode || null,
  worker_healthy: data?.worker_healthy === true,
  consecutive_failures: Number(data?.consecutive_failures || 0),
}));

if (!eligible) process.exit(1);
