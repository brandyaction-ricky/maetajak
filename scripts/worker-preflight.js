import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { pathToFileURL } from 'node:url';
import { validateGateChannelId } from '../worker/gate.js';
import { normalizeTradingMode } from '../worker/runtime.js';

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
  const mode = normalizeTradingMode(env.TRADING_MODE);
  const baseUrl = env.GATE_API_BASE_URL || PRODUCTION_GATE_URL;
  const channelId = String(env.GATE_CHANNEL_ID || '').trim();
  const publicIp = String(env.WORKER_PUBLIC_IP || '').trim();
  const telegramBotToken = String(env.TELEGRAM_BOT_TOKEN || '').trim();
  const telegramChatId = String(env.TELEGRAM_CHAT_ID || '').trim();
  const telegramConfigured = Boolean(telegramBotToken && telegramChatId);
  const webhookConfigured = Boolean(String(env.ALERT_WEBHOOK_URL || '').trim());
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/i.test(env.SUPABASE_URL || '')) errors.push('SUPABASE_URL must be the production Supabase project URL');
  if (jwtRole(env.SUPABASE_SERVICE_ROLE_KEY) !== 'service_role') errors.push('SUPABASE_SERVICE_ROLE_KEY must be a server-only service role key');
  if (baseUrl !== PRODUCTION_GATE_URL) errors.push('GATE_API_BASE_URL must be https://api.gateio.ws');
  try { validateGateChannelId(channelId); } catch { errors.push('GATE_CHANNEL_ID must contain 1-19 lowercase letters or digits'); }
  if (channelId && channelId !== APPROVED_CHANNEL_ID) errors.push(`GATE_CHANNEL_ID must equal the approved Channel ID ${APPROVED_CHANNEL_ID}`);
  if (!isPublicIPv4(publicIp)) errors.push('WORKER_PUBLIC_IP must be the fixed public IPv4 assigned to this VPS');
  if (!['OBSERVE', 'DRY_RUN', 'LIVE'].includes(mode)) errors.push('TRADING_MODE must be OBSERVE, DRY_RUN, or LIVE');
  if (env.RUN_READINESS_CHECK === 'true' && mode !== 'DRY_RUN') errors.push('RUN_READINESS_CHECK=true is only allowed in DRY_RUN');
  if (mode === 'DRY_RUN' && env.RUN_READINESS_CHECK !== 'true') warnings.push('DRY_RUN will not record readiness until RUN_READINESS_CHECK=true');
  if (Boolean(telegramBotToken) !== Boolean(telegramChatId)) errors.push('TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be configured together');
  if (telegramBotToken && !/^\d+:[A-Za-z0-9_-]{20,}$/.test(telegramBotToken)) errors.push('TELEGRAM_BOT_TOKEN has an invalid format');
  if (telegramChatId && !/^(?:-?\d+|@[A-Za-z0-9_]{5,})$/.test(telegramChatId)) errors.push('TELEGRAM_CHAT_ID has an invalid format');
  if (mode === 'LIVE' && !telegramConfigured) errors.push('Telegram is required before accepting real members in LIVE');
  return {
    ok: errors.length === 0,
    errors,
    warnings,
    mode,
    gate_base_url: baseUrl,
    broker_channel_id: channelId || null,
    worker_public_ip: publicIp || null,
    alerts_configured: telegramConfigured || webhookConfigured,
    alert_provider: telegramConfigured ? 'telegram' : webhookConfigured ? 'webhook' : null,
  };
}

// 2026-11-03 Q4 review F4: the build this container reports (worker/index.js uses the same order).
export function preflightWorkerVersion(env) {
  if (env.WORKER_VERSION) return String(env.WORKER_VERSION);
  if (env.npm_package_version) return String(env.npm_package_version);
  try { return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version || 'dev'; }
  catch { return 'dev'; }
}

// A 0.6.x worker needs the DB of the 2026-11-03 release: the order gates that accept its "<version>+<sha>" build
// (20261103020000, get_copy_safety_version().worker_build_version_gate >= 1) and the service_role Master last legs
// read (20261103030000, get_copy_last_master_legs). Fails closed: any missing piece or failed read is an error.
export async function checkDatabaseCompatibility({ env, workerVersion, fetchImpl = fetch }) {
  if (!/^0\.6\./.test(workerVersion)) return { checked: false, errors: [] };
  const errors = [];
  const call = async (name) => {
    const response = await fetchImpl(`${String(env.SUPABASE_URL).replace(/\/$/, '')}/rest/v1/rpc/${name}`, {
      method: 'POST', body: '{}', signal: AbortSignal.timeout(10_000),
      headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json' },
    });
    if (!response.ok) throw new Error(`HTTP_${response.status}`);
    return response.json();
  };
  try {
    const version = await call('get_copy_safety_version');
    if (!(Number(version?.worker_build_version_gate) >= 1)) {
      errors.push(`worker ${workerVersion} requires migration 20261103020000 (get_copy_safety_version().worker_build_version_gate >= 1)`);
    }
  } catch (error) {
    errors.push(`get_copy_safety_version could not be read (${String(error?.message || 'ERROR').slice(0, 40)})`);
  }
  try {
    const legs = await call('get_copy_last_master_legs');
    if (!legs || !Array.isArray(legs.legs)) errors.push(`worker ${workerVersion} requires migration 20261103030000 (get_copy_last_master_legs)`);
  } catch (error) {
    errors.push(`get_copy_last_master_legs could not be read: migration 20261103030000 required (${String(error?.message || 'ERROR').slice(0, 40)})`);
  }
  return { checked: true, errors };
}

export async function runPreflight(env, { fetchImpl = fetch } = {}) {
  const result = validatePreflightEnvironment(env);
  const workerVersion = preflightWorkerVersion(env);
  // The database is checked only with a valid production URL and service-role key (no request otherwise).
  const database = result.ok ? await checkDatabaseCompatibility({ env, workerVersion, fetchImpl }) : { checked: false, errors: [] };
  const errors = [...result.errors, ...database.errors];
  return { ...result, ok: errors.length === 0, errors, worker_version: workerVersion, database_checked: database.checked };
}

async function main() {
  const result = await runPreflight(process.env);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
