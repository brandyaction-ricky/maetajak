import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const confirmation = process.env.COPY_ACTIVATION_CONFIRMATION;
if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
if (confirmation !== 'ENABLE_LIVE_COPY_TRADING') throw new Error('Set COPY_ACTIVATION_CONFIRMATION=ENABLE_LIVE_COPY_TRADING');
const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
const { data, error } = await supabase.rpc('set_copy_live_activation', { p_enable: true, p_confirmation: confirmation, p_reason: 'DEPLOYMENT_CHECKLIST_COMPLETED' });
if (error) throw error;
console.log(JSON.stringify({ activated: true, control: data }));
