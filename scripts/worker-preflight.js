import { isIP } from 'node:net';
import { pathToFileURL } from 'node:url';
import { validateGateChannelId } from '../worker/gate.js';

const PRODUCTION_GATE_URL = 'https://api.gateio.ws';
const APPROVED_CHANNEL_ID = 'maetajak';

function isPublicIPv4(value) {
  if (isIP(value) !== 4) return false;
  const [a, b, c] = value.split('.').map(Number);
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && c === 2) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

function jwtRole(token) {
  if (!token || token.startsWith('sb_secret_')) return token?.startsWith('sb_secret_') ? 'service_role' : null;
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1] || '', 'base64url').toString('utf8'));
    return payload.role || null;
  } catch { return null; }
}

export function validatePreflightEnvironment(env) {
  const errors = [];
  const warnings = [];
  const mode = String(env.TRADING_MODE || 'OBSERVE').toUpperCase();
  const baseUrl = env.GATE_API_BASE_URL || PRODUCTION_GATE_URL;
  const channelId = String(env.GATE_CHANNEL_ID || '').trim();
  const publicIp = String(env.WORKER_PUBLIC_IP || '').trim();
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/i.test(env.SUPABASE_URL || '')) errors.push('SUPABASE_URL must be the production Supabase project URL');
  if (jwtRole(env.SUPABASE_SERVICE_ROLE_KEY) !== 'service_role') errors.push('SUPABASE_SERVICE_ROLE_KEY must be a server-only service role key');
  if (baseUrl !== PRODUCTION_GATE_URL) errors.push('GATE_API_BASE_URL must be https://api.gateio.ws');
  try { validateGateChannelId(channelId); } catch { errors.push('GATE_CHANNEL_ID must contain 1-19 lowercase letters or digits'); }
  if (channelId && channelId !== APPROVED_CHANNEL_ID) errors.push(`GATE_CHANNEL_ID must equal the approved Channel ID ${APPROVED_CHANNEL_ID}`);
  if (!isPublicIPv4(publicIp)) errors.push('WORKER_PUBLIC_IP must be the fixed public IPv4 assigned to this VPS');
  if (!['OBSERVE', 'DRY_RUN', 'LIVE'].includes(mode)) errors.push('TRADING_MODE must be OBSERVE, DRY_RUN, or LIVE');
  if (env.RUN_READINESS_CHECK === 'true' && mode !== 'DRY_RUN') errors.push('RUN_READINESS_CHECK=true is only allowed in DRY_RUN');
  if (mode === 'DRY_RUN' && env.RUN_READINESS_CHECK !== 'true') warnings.push('DRY_RUN will not record readiness until RUN_READINESS_CHECK=true');
  if (mode === 'LIVE' && !env.ALERT_WEBHOOK_URL) errors.push('ALERT_WEBHOOK_URL is required before accepting real members in LIVE');
  return { ok: errors.length === 0, errors, warnings, mode, gate_base_url: baseUrl, broker_channel_id: channelId || null, worker_public_ip: publicIp || null, alerts_configured: Boolean(env.ALERT_WEBHOOK_URL) };
}

async function main() {
  const result = validatePreflightEnvironment(process.env);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
