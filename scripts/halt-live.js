import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
const reason = process.env.COPY_HALT_REASON || 'OPERATOR_EMERGENCY_HALT';
const { data, error } = await supabase.rpc('set_copy_live_activation', { p_enable: false, p_confirmation: 'HALT', p_reason: reason });
if (error) throw error;
console.log(JSON.stringify({ halted: true, control: data }));
