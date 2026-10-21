// Gate UID signup (deploy with verify_jwt = false).
// Members register with their Gate.io UID as the login ID. Supabase Auth still needs an
// email, so the account gets a synthetic, never-mailed address `${uid}@uid.maetajak.trading`
// and is created already confirmed. No email is sent. The profile starts PENDING and an
// administrator approves it (set_user_approval). The password is never logged or stored here.
import { createClient } from 'jsr:@supabase/supabase-js@2';

const UID_LOGIN_DOMAIN = 'uid.maetajak.trading';
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

type ErrorCode = 'INVALID_INPUT' | 'UID_TAKEN' | 'SIGNUP_FAILED';

function json(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
const fail = (status: number, error: ErrorCode) => json(status, { ok: false, error });

interface SignupInput {
  uid: string;
  password: string;
  full_name: string;
  phone: string;
  terms_accepted_at: string;
  terms_version: string;
  privacy_version: string;
}

function shortText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text && text.length <= max ? text : null;
}

function validate(body: unknown): SignupInput | null {
  if (!body || typeof body !== 'object') return null;
  const input = body as Record<string, unknown>;
  const uid = typeof input.uid === 'string' ? input.uid.trim() : '';
  const password = typeof input.password === 'string' ? input.password : '';
  const fullName = typeof input.full_name === 'string' ? input.full_name.trim() : '';
  const phone = typeof input.phone === 'string' ? input.phone.trim() : '';
  const termsAcceptedAt = shortText(input.terms_accepted_at, 40);
  const termsVersion = shortText(input.terms_version, 40);
  const privacyVersion = shortText(input.privacy_version, 40);
  if (!/^\d{4,15}$/.test(uid)) return null;
  if (password.length < 8 || password.length > 72) return null;
  const nameLength = [...fullName].length;
  if (nameLength < 1 || nameLength > 40) return null;
  if (!/^[0-9+\- ]{8,20}$/.test(phone)) return null;
  if (!termsAcceptedAt || Number.isNaN(Date.parse(termsAcceptedAt))) return null;
  if (!termsVersion || !privacyVersion) return null;
  return {
    uid,
    password,
    full_name: fullName,
    phone,
    terms_accepted_at: new Date(termsAcceptedAt).toISOString(),
    terms_version: termsVersion,
    privacy_version: privacyVersion,
  };
}

function isAlreadyRegistered(error: { code?: string; message?: string } | null) {
  if (!error) return false;
  return error.code === 'email_exists' || error.code === 'user_already_exists'
    || /already (been )?registered|already exists/i.test(error.message || '');
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return fail(405, 'INVALID_INPUT');

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, 'INVALID_INPUT');
  }
  const input = validate(body);
  if (!input) return fail(400, 'INVALID_INPUT');

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceRoleKey) {
    console.error('uid-signup: missing service configuration');
    return fail(500, 'SIGNUP_FAILED');
  }
  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const uidTaken = async () => {
    const { data, error } = await admin.from('profiles').select('id').eq('gate_uid', input.uid).limit(1);
    if (error) throw new Error(`profile lookup failed: ${error.code || 'unknown'}`);
    return Array.isArray(data) && data.length > 0;
  };

  try {
    if (await uidTaken()) return fail(409, 'UID_TAKEN');
  } catch (error) {
    console.error('uid-signup:', (error as Error).message);
    return fail(500, 'SIGNUP_FAILED');
  }

  const { error } = await admin.auth.admin.createUser({
    email: `${input.uid}@${UID_LOGIN_DOMAIN}`,
    password: input.password,
    email_confirm: true,
    user_metadata: {
      full_name: input.full_name,
      phone: input.phone,
      gate_uid: input.uid,
      terms_accepted_at: input.terms_accepted_at,
      terms_version: input.terms_version,
      privacy_version: input.privacy_version,
    },
  });

  if (error) {
    if (isAlreadyRegistered(error)) return fail(409, 'UID_TAKEN');
    // A concurrent signup for the same UID loses on the profiles.gate_uid unique index.
    try {
      if (await uidTaken()) return fail(409, 'UID_TAKEN');
    } catch {
      // fall through to the generic failure
    }
    console.error('uid-signup: createUser failed', error.code || error.status || 'unknown');
    return fail(500, 'SIGNUP_FAILED');
  }

  return json(200, { ok: true });
});
