// Administrator-issued temporary password (deploy with verify_jwt = true).
// No email is ever sent: an approved ADMIN issues a one-time temporary password for a MEMBER,
// it is returned once to the admin's browser and the member changes it on the account page.
// The password is never logged and never written to the database or the audit log.
import { createClient } from 'jsr:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
// No 0/O, 1/l/I: easy to read aloud or retype.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
const PASSWORD_LENGTH = 12;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type ErrorCode = 'AUTH_REQUIRED' | 'ADMIN_REQUIRED' | 'INVALID_INPUT' | 'MEMBER_NOT_FOUND' | 'RESET_FAILED';

function json(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
const fail = (status: number, error: ErrorCode) => json(status, { error });

// Uniform choice from the alphabet: reject bytes past the largest multiple of its length.
function temporaryPassword(): string {
  const limit = 256 - (256 % ALPHABET.length);
  let out = '';
  while (out.length < PASSWORD_LENGTH) {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    for (const byte of bytes) {
      if (byte >= limit) continue;
      out += ALPHABET[byte % ALPHABET.length];
      if (out.length === PASSWORD_LENGTH) break;
    }
  }
  return out;
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return fail(405, 'INVALID_INPUT');

  const authorization = request.headers.get('Authorization') || '';
  const token = authorization.replace(/^Bearer\s+/i, '').trim();
  if (!token) return fail(401, 'AUTH_REQUIRED');

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    console.error('admin-reset-password: missing service configuration');
    return fail(500, 'RESET_FAILED');
  }
  const authOptions = { persistSession: false, autoRefreshToken: false };

  // Resolve the caller from their own JWT.
  const callerClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authorization } },
    auth: authOptions,
  });
  const { data: callerData, error: callerError } = await callerClient.auth.getUser(token);
  const callerId = callerData?.user?.id;
  if (callerError || !callerId) return fail(401, 'AUTH_REQUIRED');

  const admin = createClient(supabaseUrl, serviceRoleKey, { auth: authOptions });
  const { data: callerProfile, error: callerProfileError } = await admin
    .from('profiles').select('id').eq('id', callerId).eq('role', 'ADMIN').eq('approval_status', 'APPROVED')
    .maybeSingle();
  if (callerProfileError) {
    console.error('admin-reset-password: caller lookup failed', callerProfileError.code || 'unknown');
    return fail(500, 'RESET_FAILED');
  }
  if (!callerProfile) return fail(403, 'ADMIN_REQUIRED');

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, 'INVALID_INPUT');
  }
  const userId = body && typeof body === 'object' ? (body as Record<string, unknown>).user_id : null;
  if (typeof userId !== 'string' || !UUID_PATTERN.test(userId)) return fail(400, 'INVALID_INPUT');

  const { data: target, error: targetError } = await admin
    .from('profiles').select('id').eq('id', userId).eq('role', 'MEMBER').maybeSingle();
  if (targetError) {
    console.error('admin-reset-password: target lookup failed', targetError.code || 'unknown');
    return fail(500, 'RESET_FAILED');
  }
  if (!target) return fail(404, 'MEMBER_NOT_FOUND');

  const password = temporaryPassword();
  const { error: updateError } = await admin.auth.admin.updateUserById(userId, { password });
  if (updateError) {
    console.error('admin-reset-password: auth update failed', updateError.code || updateError.status || 'unknown');
    return fail(500, 'RESET_FAILED');
  }

  const issuedAt = new Date().toISOString();
  const { error: auditError } = await admin.from('admin_audit_logs').insert({
    actor_id: callerId,
    action: 'MEMBER_TEMP_PASSWORD_ISSUED',
    target_user_id: userId,
    next_value: { issued_at: issuedAt },
  });
  // The old password is already replaced: still hand the new one to the admin.
  if (auditError) console.error('admin-reset-password: audit insert failed', auditError.code || 'unknown');

  return json(200, { temporary_password: password, issued_at: issuedAt });
});
