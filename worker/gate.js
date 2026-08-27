import { createHash, createHmac } from 'node:crypto';

export const GATE_API_BASE_URL = 'https://api.gateio.ws';
export const FUTURES_ACCOUNT_PATH = '/api/v4/futures/usdt/accounts';
export const FUTURES_POSITIONS_PATH = '/api/v4/futures/usdt/positions';
export const FUTURES_CONTRACTS_PATH = '/api/v4/futures/usdt/contracts';
export const FUTURES_ORDERS_PATH = '/api/v4/futures/usdt/orders';
export const FUTURES_TRADES_PATH = '/api/v4/futures/usdt/my_trades';
export const ACCOUNT_DETAIL_PATH = '/api/v4/account/detail';
export const ACCOUNT_MAIN_KEYS_PATH = '/api/v4/account/main_keys';
export const GATE_CHANNEL_ID_PATTERN = /^[a-z0-9]{1,19}$/;

export class GateApiError extends Error {
  constructor(message, { code = 'GATE_API_ERROR', status = 0, payload = null, outcomeUnknown = false } = {}) {
    super(message);
    this.name = 'GateApiError';
    this.code = code;
    this.status = status;
    this.payload = payload;
    this.outcomeUnknown = outcomeUnknown;
  }
}

export function validateGateChannelId(channelId) {
  const normalized = String(channelId || '').trim();
  if (!GATE_CHANNEL_ID_PATTERN.test(normalized)) {
    throw new GateApiError('Gate API Broker Channel ID 설정이 올바르지 않습니다.', { code: 'INVALID_GATE_CHANNEL_ID' });
  }
  return normalized;
}

export function buildGateHeaders({ apiKey, secretKey, method = 'GET', path, query = '', body = '', timestamp = Math.floor(Date.now() / 1000), channelId = '' }) {
  const hashedPayload = createHash('sha512').update(body).digest('hex');
  const source = [method.toUpperCase(), path, query, hashedPayload, timestamp].join('\n');
  const headers = { Accept: 'application/json', KEY: apiKey, Timestamp: String(timestamp), SIGN: createHmac('sha512', secretKey).update(source).digest('hex') };
  if (path.startsWith('/api/v4/futures/')) headers['X-Gate-Size-Decimal'] = '1';
  if (channelId) headers['X-Gate-Channel-Id'] = validateGateChannelId(channelId);
  return headers;
}

export function mapGateError(status, payload) {
  const label = String(payload?.label || '').toUpperCase();
  if (label.includes('IP') || label.includes('WHITE')) return { code: 'IP_NOT_ALLOWED', message: 'Trading Worker IP가 Gate.io Whitelist에 등록되지 않았습니다.' };
  if (status === 401 || label.includes('INVALID_KEY') || label.includes('INVALID_SIGNATURE')) return { code: 'INVALID_CREDENTIALS', message: 'API Key 또는 Secret Key가 올바르지 않습니다.' };
  if (status === 403 || label.includes('FORBIDDEN') || label.includes('PERMISSION')) return { code: 'FUTURES_READ_REQUIRED', message: 'Perpetual Futures Read 권한을 확인해 주세요.' };
  return { code: 'GATE_API_ERROR', message: 'Gate.io API 응답을 확인하지 못했습니다.' };
}

function encodeQuery(query = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
  }
  return params.toString();
}

export function parseGateJson(text) {
  if (!text) return null;
  const int64Safe = text.replace(/("(?:id|order_id)"\s*:\s*)(-?\d{16,})/g, '$1"$2"');
  return JSON.parse(int64Safe);
}

export async function gateRequest({
  apiKey, secretKey, method = 'GET', path, query = {}, body,
  fetchImpl = fetch, baseUrl = GATE_API_BASE_URL, timeoutMs = 10_000, expiresAtMs, channelId = '',
}) {
  const normalizedMethod = method.toUpperCase();
  const isWrite = normalizedMethod !== 'GET';
  const brokerChannelId = isWrite ? validateGateChannelId(channelId) : (channelId ? validateGateChannelId(channelId) : '');
  const queryString = typeof query === 'string' ? query : encodeQuery(query);
  const bodyString = body === undefined ? '' : JSON.stringify(body);
  const headers = buildGateHeaders({ apiKey, secretKey, method: normalizedMethod, path, query: queryString, body: bodyString, channelId: brokerChannelId });
  if (bodyString) headers['Content-Type'] = 'application/json';
  if (expiresAtMs) headers['X-Gate-Exptime'] = String(Math.trunc(expiresAtMs));
  let response;
  try {
    response = await fetchImpl(`${baseUrl || GATE_API_BASE_URL}${path}${queryString ? `?${queryString}` : ''}`, {
      method, headers, body: bodyString || undefined, signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new GateApiError(isWrite ? '주문 결과를 확인하지 못했습니다.' : 'Gate.io API에 연결하지 못했습니다.', {
      code: error?.name === 'TimeoutError' ? 'GATE_TIMEOUT' : 'GATE_UNREACHABLE', outcomeUnknown: isWrite,
    });
  }
  let payload = null;
  try { payload = parseGateJson(await response.text()); } catch { /* Gate can return an empty error response. */ }
  if (!response.ok) {
    const mapped = mapGateError(response.status, payload);
    throw new GateApiError(mapped.message, {
      code: mapped.code, status: response.status, payload,
      outcomeUnknown: isWrite && (response.status >= 500 || response.status === 408),
    });
  }
  return { payload, status: response.status };
}

function matchingKeyInfo(apiKey, keys) {
  const matches = (Array.isArray(keys) ? keys : []).filter((item) => {
    const listedKey = String(item?.key || '');
    if (!listedKey) return false;
    if (listedKey === apiKey) return true;
    const visiblePrefix = listedKey.split('*', 1)[0];
    return visiblePrefix.length >= 4 && apiKey.startsWith(visiblePrefix);
  });
  return matches.length === 1 ? matches[0] : null;
}

export async function verifyGateAccount({ gateUid, apiKey, secretKey, expectedPublicIp, requiresTradingPermission = true, fetchImpl = fetch, baseUrl = GATE_API_BASE_URL }) {
  if (!expectedPublicIp) {
    return { success: false, errorCode: 'WORKER_IP_NOT_CONFIGURED', errorMessage: '고정 Worker IP가 아직 설정되지 않았습니다.' };
  }
  try {
    const [futuresResponse, detailResponse, keysResponse] = await Promise.all([
      gateRequest({ apiKey, secretKey, path: FUTURES_ACCOUNT_PATH, fetchImpl, baseUrl }),
      gateRequest({ apiKey, secretKey, path: ACCOUNT_DETAIL_PATH, fetchImpl, baseUrl }),
      gateRequest({ apiKey, secretKey, path: ACCOUNT_MAIN_KEYS_PATH, fetchImpl, baseUrl }),
    ]);
    const gateUserId = futuresResponse.payload?.user == null ? '' : String(futuresResponse.payload.user);
    if (!gateUserId || gateUserId !== String(gateUid)) {
      return { success: false, gateUserId, errorCode: 'UID_MISMATCH', errorMessage: '입력한 UID와 API Key 계정이 일치하지 않습니다.' };
    }
    if (detailResponse.payload?.user_id != null && String(detailResponse.payload.user_id) !== String(gateUid)) {
      return { success: false, gateUserId, errorCode: 'UID_MISMATCH', errorMessage: '입력한 UID와 API Key 계정이 일치하지 않습니다.' };
    }
    const ipWhitelist = Array.isArray(detailResponse.payload?.ip_whitelist) ? detailResponse.payload.ip_whitelist.map(String) : [];
    if (!ipWhitelist.includes(String(expectedPublicIp))) {
      return { success: false, gateUserId, errorCode: 'IP_NOT_ALLOWED', errorMessage: 'Gate.io API IP Whitelist에 현재 Worker 고정 IP를 등록해 주세요.' };
    }
    const keyInfo = matchingKeyInfo(apiKey, keysResponse.payload);
    if (!keyInfo || Number(keyInfo.state || 0) !== 1) {
      return { success: false, gateUserId, errorCode: 'API_KEY_DETAILS_UNAVAILABLE', errorMessage: 'API Key 상태와 권한 정보를 확인할 수 없습니다.' };
    }
    const permissions = Array.isArray(keyInfo.perms) ? keyInfo.perms : [];
    const futuresPermission = permissions.find((permission) => permission?.name === 'futures');
    if (!futuresPermission) {
      return { success: false, gateUserId, errorCode: 'FUTURES_READ_REQUIRED', errorMessage: 'Perpetual Futures 권한을 활성화해 주세요.' };
    }
    const futuresTrade = futuresPermission.read_only === false;
    if (!requiresTradingPermission && futuresTrade) {
      return { success: false, gateUserId, errorCode: 'MASTER_READ_ONLY_REQUIRED', errorMessage: 'Master API의 Perpetual Futures 권한을 Read Only로 설정해 주세요.' };
    }
    if (requiresTradingPermission && !futuresTrade) {
      return { success: false, gateUserId, errorCode: 'FUTURES_TRADE_REQUIRED', errorMessage: 'Perpetual Futures 권한을 Read-Write로 설정해 주세요.' };
    }
    const unsafePermission = permissions.find((permission) => permission?.name !== 'futures' && permission?.read_only === false);
    if (unsafePermission) {
      return { success: false, gateUserId, errorCode: 'EXCESS_API_PERMISSIONS', errorMessage: `${unsafePermission.name} 쓰기 권한을 비활성화하고 Futures 권한만 사용해 주세요.` };
    }
    return { success: true, gateUserId, futuresRead: true, futuresTrade, ipWhitelisted: true, withdrawalDisabled: true };
  } catch (error) {
    return { success: false, errorCode: error instanceof GateApiError ? error.code : 'GATE_UNREACHABLE', errorMessage: error instanceof GateApiError ? error.message : 'Gate.io API에 연결하지 못했습니다.' };
  }
}

export async function getFuturesAccount(options) {
  const { payload } = await gateRequest({ ...options, path: FUTURES_ACCOUNT_PATH });
  return { user: payload?.user == null ? '' : String(payload.user), total: Number(payload?.total || 0), available: Number(payload?.available || 0), unrealisedPnl: Number(payload?.unrealised_pnl || 0) };
}

export function normalizeGatePositions(payload) {
  const positions = (Array.isArray(payload) ? payload : []).map((position) => ({
    contract: String(position.contract || ''),
    size: Number(position.size || 0),
    markPrice: Number(position.mark_price || 0),
    entryPrice: Number(position.entry_price || 0),
    leverage: Number(position.lever ?? position.leverage ?? position.cross_leverage_limit ?? 0),
    mode: String(position.mode || 'single'),
    posMarginMode: String(position.pos_margin_mode || ''),
  })).filter((position) => position.contract && Number.isFinite(position.size) && position.size !== 0);
  const contracts = new Set();
  for (const position of positions) {
    if (contracts.has(position.contract)) {
      throw new GateApiError('동일 종목의 롱·숏 동시 포지션은 아직 안전하게 복사할 수 없습니다.', { code: 'HEDGED_POSITION_UNSUPPORTED' });
    }
    contracts.add(position.contract);
  }
  return positions;
}

export async function getFuturesPositions(options) {
  const { payload } = await gateRequest({ ...options, path: FUTURES_POSITIONS_PATH });
  return normalizeGatePositions(payload);
}

export async function getFuturesContracts({ fetchImpl = fetch, baseUrl = GATE_API_BASE_URL } = {}) {
  const response = await fetchImpl(`${baseUrl || GATE_API_BASE_URL}${FUTURES_CONTRACTS_PATH}`, { method: 'GET', headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new GateApiError('Gate.io 계약 정보를 불러오지 못했습니다.', { status: response.status });
  const payload = await response.json();
  return new Map((Array.isArray(payload) ? payload : []).map((contract) => {
    const orderSizeMin = Math.max(Number.EPSILON, Number(contract.order_size_min || 1));
    const orderSizeMax = Math.max(0, Number(contract.order_size_max || 0));
    const marketOrderSizeMax = Math.max(0, Number(contract.market_order_size_max || 0));
    return [String(contract.name), {
      name: String(contract.name), quantoMultiplier: Number(contract.quanto_multiplier || 0),
      sizeStep: contract.enable_decimal ? orderSizeMin : 1, orderSizeMin, orderSizeMax,
      marketOrderSizeMax, inDelisting: Boolean(contract.in_delisting),
    }];
  }));
}

export async function placeFuturesOrder({ contract, size, reduceOnly = false, text, slippageRatio = 0.005, ...options }) {
  const requestBody = { contract, size: String(size), price: '0', tif: 'ioc', reduce_only: Boolean(reduceOnly), text, market_order_slip_ratio: String(slippageRatio) };
  const { payload, status } = await gateRequest({ ...options, method: 'POST', path: FUTURES_ORDERS_PATH, body: requestBody, expiresAtMs: Date.now() + 5_000 });
  return { payload, status, requestBody };
}

export async function getFuturesOrder({ orderId, ...options }) {
  const { payload } = await gateRequest({ ...options, path: `${FUTURES_ORDERS_PATH}/${encodeURIComponent(orderId)}` });
  return payload;
}

export async function listFuturesOrders({ status = 'finished', contract, limit = 100, ...options }) {
  const { payload } = await gateRequest({ ...options, path: FUTURES_ORDERS_PATH, query: { status, contract, limit } });
  return Array.isArray(payload) ? payload : [];
}

export async function findFuturesOrderByText({ text, contract, ...options }) {
  for (const status of ['open', 'finished']) {
    const orders = await listFuturesOrders({ ...options, status, contract });
    const match = orders.find((order) => String(order.text || '') === String(text));
    if (match) return match;
  }
  return null;
}

export async function getOrderTrades({ orderId, contract, ...options }) {
  const { payload } = await gateRequest({ ...options, path: FUTURES_TRADES_PATH, query: { order: orderId, contract, limit: 100 } });
  return Array.isArray(payload) ? payload : [];
}

export function summarizeGateOrder(order, trades = []) {
  const originalSize = Number(order?.size || 0);
  const left = Number(order?.left || 0);
  let filledSize = originalSize - left;
  let averageFillPrice = Number(order?.fill_price || 0) || null;
  if (trades.length) {
    const signed = Math.sign(originalSize || Number(trades[0]?.size || 0)) || 1;
    const absoluteSize = trades.reduce((sum, trade) => sum + Math.abs(Number(trade.size || 0)), 0);
    const notional = trades.reduce((sum, trade) => sum + Math.abs(Number(trade.size || 0)) * Number(trade.price || 0), 0);
    filledSize = signed * absoluteSize;
    averageFillPrice = absoluteSize ? notional / absoluteSize : averageFillPrice;
  }
  const status = String(order?.status || '').toLowerCase();
  const finishAs = String(order?.finish_as || '').toLowerCase();
  const final = status === 'finished';
  const fullyFilled = final && left === 0 && Math.abs(filledSize) > 0;
  const partiallyFilled = Math.abs(filledSize) > 0 && !fullyFilled;
  return { gateOrderId: order?.id == null ? null : String(order.id), filledSize, averageFillPrice, finalStatus: fullyFilled ? 'FILLED' : partiallyFilled ? 'PARTIALLY_FILLED' : final ? (finishAs === 'cancelled' ? 'CANCELLED' : 'REJECTED') : 'ACKNOWLEDGED', finishAs: finishAs || null, left };
}
