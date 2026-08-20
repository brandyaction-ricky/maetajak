import { createHash, createHmac } from 'node:crypto';

export const GATE_API_BASE_URL = 'https://api.gateio.ws';
export const FUTURES_ACCOUNT_PATH = '/api/v4/futures/usdt/accounts';

export function buildGateHeaders({ apiKey, secretKey, method = 'GET', path, query = '', body = '', timestamp = Math.floor(Date.now() / 1000) }) {
  const hashedPayload = createHash('sha512').update(body).digest('hex');
  const source = [method.toUpperCase(), path, query, hashedPayload, timestamp].join('\n');
  return { Accept: 'application/json', KEY: apiKey, Timestamp: String(timestamp), SIGN: createHmac('sha512', secretKey).update(source).digest('hex') };
}

function mapGateError(status, payload) {
  const label = String(payload?.label || '').toUpperCase();
  if (label.includes('IP') || label.includes('WHITE')) return { code: 'IP_NOT_ALLOWED', message: 'Trading Worker IP가 Gate.io Whitelist에 등록되지 않았습니다.' };
  if (status === 401 || label.includes('INVALID_KEY') || label.includes('INVALID_SIGNATURE')) return { code: 'INVALID_CREDENTIALS', message: 'API Key 또는 Secret Key가 올바르지 않습니다.' };
  if (status === 403 || label.includes('FORBIDDEN') || label.includes('PERMISSION')) return { code: 'FUTURES_READ_REQUIRED', message: 'Perpetual Futures Read 권한을 확인해 주세요.' };
  return { code: 'GATE_API_ERROR', message: 'Gate.io API 응답을 확인하지 못했습니다.' };
}

export async function verifyGateAccount({ gateUid, apiKey, secretKey, fetchImpl = fetch, baseUrl = GATE_API_BASE_URL }) {
  const headers = buildGateHeaders({ apiKey, secretKey, path: FUTURES_ACCOUNT_PATH });
  let response;
  try {
    response = await fetchImpl(`${baseUrl || GATE_API_BASE_URL}${FUTURES_ACCOUNT_PATH}`, { method: 'GET', headers, signal: AbortSignal.timeout(10_000) });
  } catch {
    return { success: false, errorCode: 'GATE_UNREACHABLE', errorMessage: 'Gate.io API에 연결하지 못했습니다.' };
  }
  let payload = null;
  try { payload = await response.json(); } catch { /* Empty or non-JSON Gate error. */ }
  if (!response.ok) {
    const mapped = mapGateError(response.status, payload);
    return { success: false, errorCode: mapped.code, errorMessage: mapped.message };
  }
  const gateUserId = payload?.user == null ? '' : String(payload.user);
  if (!gateUserId || gateUserId !== String(gateUid)) {
    return { success: false, gateUserId, errorCode: 'UID_MISMATCH', errorMessage: '입력한 UID와 API Key 계정이 일치하지 않습니다.' };
  }
  return { success: true, gateUserId };
}

