import { createHash, createHmac } from 'node:crypto';

export const GATE_API_BASE_URL = 'https://api.gateio.ws';
export const FUTURES_ACCOUNT_PATH = '/api/v4/futures/usdt/accounts';
export const UNIFIED_ACCOUNT_PATH = '/api/v4/unified/accounts';
export const FUTURES_POSITIONS_PATH = '/api/v4/futures/usdt/positions';
export const FUTURES_CONTRACTS_PATH = '/api/v4/futures/usdt/contracts';
export const FUTURES_ORDERS_PATH = '/api/v4/futures/usdt/orders';
export const FUTURES_TRADES_PATH = '/api/v4/futures/usdt/my_trades';
export const FUTURES_TRADES_TIME_RANGE_PATH = '/api/v4/futures/usdt/my_trades_timerange';
export const FUTURES_ACCOUNT_BOOK_PATH = '/api/v4/futures/usdt/account_book';
export const FUTURES_POSITION_MODE_PATH = '/api/v4/futures/usdt/set_position_mode';
export const ACCOUNT_DETAIL_PATH = '/api/v4/account/detail';
export const ACCOUNT_MAIN_KEYS_PATH = '/api/v4/account/main_keys';
export const GATE_CHANNEL_ID_PATTERN = /^[a-z0-9]{1,19}$/;

export class GateApiError extends Error {
  constructor(message, { code = 'GATE_API_ERROR', status = 0, payload = null, path = '', outcomeUnknown = false } = {}) {
    super(message);
    this.name = 'GateApiError';
    this.code = code;
    this.status = status;
    this.payload = payload;
    this.path = path;
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

export function mapGateError(status, payload, path = '') {
  const label = String(payload?.label || '').toUpperCase();
  if (label.includes('IP') || label.includes('WHITE')) return { code: 'IP_NOT_ALLOWED', message: 'Trading Worker IP가 Gate.io Whitelist에 등록되지 않았습니다.' };
  if (status === 401 || label.includes('INVALID_KEY') || label.includes('INVALID_SIGNATURE')) return { code: 'INVALID_CREDENTIALS', message: 'API Key 또는 Secret Key가 올바르지 않습니다.' };
  if ((status === 403 || label.includes('FORBIDDEN') || label.includes('PERMISSION')) && path.startsWith('/api/v4/unified/')) {
    return { code: 'UNIFIED_READ_REQUIRED', message: '통합계정 자산 조회를 위해 Unified Read 권한을 확인해 주세요.' };
  }
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
    const mapped = mapGateError(response.status, payload, path);
    throw new GateApiError(mapped.message, {
      code: mapped.code, status: response.status, payload, path,
      outcomeUnknown: isWrite && (response.status >= 500 || response.status === 408),
    });
  }
  return { payload, status: response.status };
}

export function matchingKeyInfo(apiKey, keys) {
  // Gate's current OpenAPI schema returns the authenticated key as one
  // AccountKeyInfo object. Older responses returned a list whose `key` value
  // could be matched against the caller's API key.
  if (keys && !Array.isArray(keys) && typeof keys === 'object') return keys;

  const matches = (Array.isArray(keys) ? keys : []).filter((item) => {
    const listedKey = String(item?.key || '');
    if (!listedKey) return false;
    if (listedKey === apiKey) return true;
    const visiblePrefix = listedKey.split('*', 1)[0];
    return visiblePrefix.length >= 4 && apiKey.startsWith(visiblePrefix);
  });
  return matches.length === 1 ? matches[0] : null;
}

function normalizePermissionName(value) {
  const name = String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (['futures', 'perpetual', 'perpetual_futures', 'perpetual_contract', 'contract'].includes(name)) {
    return 'futures';
  }
  return name;
}

function normalizeReadOnly(value) {
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  const normalized = String(value ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (['true', '1', 'read', 'readonly', 'read_only'].includes(normalized)) return true;
  if (['false', '0', 'write', 'readwrite', 'read_write', 'read_and_write'].includes(normalized)) return false;
  return null;
}

export function normalizeGatePermissions(keyInfo) {
  const rawPermissions = keyInfo?.perms ?? keyInfo?.permissions ?? keyInfo?.key?.perms ?? keyInfo?.key?.permissions ?? [];
  const entries = Array.isArray(rawPermissions)
    ? rawPermissions
    : rawPermissions && typeof rawPermissions === 'object'
      ? Object.entries(rawPermissions).map(([name, permission]) => (
          permission && typeof permission === 'object' ? { name, ...permission } : { name, access: permission }
        ))
      : [];

  return entries.map((permission) => {
    if (typeof permission === 'string') {
      const [name, access] = permission.split(/[:=]/, 2);
      return { name: normalizePermissionName(name), readOnly: normalizeReadOnly(access) };
    }
    return {
      name: normalizePermissionName(permission?.name ?? permission?.permission ?? permission?.type),
      readOnly: normalizeReadOnly(
        permission?.read_only ?? permission?.readOnly ?? permission?.readonly
        ?? permission?.access ?? permission?.permission_mode ?? permission?.mode,
      ),
    };
  }).filter((permission) => permission.name);
}

export async function verifyGateAccount({ gateUid, apiKey, secretKey, expectedPublicIp, requiresTradingPermission = true, fetchImpl = fetch, baseUrl = GATE_API_BASE_URL }) {
  if (!expectedPublicIp) {
    return { success: false, errorCode: 'WORKER_IP_NOT_CONFIGURED', errorMessage: '고정 Worker IP가 아직 설정되지 않았습니다.' };
  }
  try {
    // Keep these checks sequential so a failure in the new main-keys endpoint
    // cannot be misreported as a Futures read failure. Gate added main_keys in
    // API v4.105.11 and access can differ from the Futures account endpoint.
    const futuresResponse = await gateRequest({ apiKey, secretKey, path: FUTURES_ACCOUNT_PATH, fetchImpl, baseUrl });
    const gateUserId = futuresResponse.payload?.user == null ? '' : String(futuresResponse.payload.user);
    if (!gateUserId || gateUserId !== String(gateUid)) {
      return { success: false, gateUserId, errorCode: 'UID_MISMATCH', errorMessage: '입력한 UID와 API Key 계정이 일치하지 않습니다.' };
    }
    const detailResponse = await gateRequest({ apiKey, secretKey, path: ACCOUNT_DETAIL_PATH, fetchImpl, baseUrl });
    if (detailResponse.payload?.user_id != null && String(detailResponse.payload.user_id) !== String(gateUid)) {
      return { success: false, gateUserId, errorCode: 'UID_MISMATCH', errorMessage: '입력한 UID와 API Key 계정이 일치하지 않습니다.' };
    }
    const ipWhitelist = Array.isArray(detailResponse.payload?.ip_whitelist) ? detailResponse.payload.ip_whitelist.map(String) : [];
    if (!ipWhitelist.includes(String(expectedPublicIp))) {
      return { success: false, gateUserId, errorCode: 'IP_NOT_ALLOWED', errorMessage: 'Gate.io API IP Whitelist에 현재 Worker 고정 IP를 등록해 주세요.' };
    }
    let keysResponse;
    try {
      keysResponse = await gateRequest({ apiKey, secretKey, path: ACCOUNT_MAIN_KEYS_PATH, fetchImpl, baseUrl });
    } catch (error) {
      if (error instanceof GateApiError) {
        return {
          success: false,
          gateUserId,
          errorCode: error.status === 403 ? 'API_PERMISSION_LOOKUP_DENIED' : 'API_PERMISSION_LOOKUP_FAILED',
          errorMessage: error.status === 403
            ? 'Gate.io가 선물 계정 조회는 허용했지만 API 권한 정보 조회를 거부했습니다.'
            : 'Gate.io API 권한 정보 조회에 실패했습니다.',
          diagnostic: {
            path: error.path || ACCOUNT_MAIN_KEYS_PATH,
            status: error.status || 0,
            label: String(error.payload?.label || '').slice(0, 80),
          },
        };
      }
      throw error;
    }
    const keyInfo = matchingKeyInfo(apiKey, keysResponse.payload);
    if (!keyInfo || Number(keyInfo.state || 0) !== 1) {
      return { success: false, gateUserId, errorCode: 'API_KEY_DETAILS_UNAVAILABLE', errorMessage: 'API Key 상태와 권한 정보를 확인할 수 없습니다.' };
    }
    const permissions = normalizeGatePermissions(keyInfo);
    const futuresPermission = permissions.find((permission) => permission.name === 'futures');
    if (!futuresPermission) {
      return { success: false, gateUserId, errorCode: 'FUTURES_READ_REQUIRED', errorMessage: 'Perpetual Futures 권한을 활성화해 주세요.' };
    }
    if (futuresPermission.readOnly === null) {
      return { success: false, gateUserId, errorCode: 'FUTURES_PERMISSION_DETAILS_UNAVAILABLE', errorMessage: 'Perpetual Futures의 Read Only/Read-Write 상태를 확인할 수 없습니다.' };
    }
    const futuresTrade = futuresPermission.readOnly === false;
    if (!requiresTradingPermission && futuresTrade) {
      return { success: false, gateUserId, errorCode: 'MASTER_READ_ONLY_REQUIRED', errorMessage: 'Master API의 Perpetual Futures 권한을 Read Only로 설정해 주세요.' };
    }
    if (requiresTradingPermission && !futuresTrade) {
      return { success: false, gateUserId, errorCode: 'FUTURES_TRADE_REQUIRED', errorMessage: 'Perpetual Futures 권한을 Read-Write로 설정해 주세요.' };
    }
    const unsafePermission = permissions.find((permission) => permission.name !== 'futures' && permission.readOnly === false);
    if (unsafePermission) {
      return { success: false, gateUserId, errorCode: 'EXCESS_API_PERMISSIONS', errorMessage: `${unsafePermission.name} 쓰기 권한을 비활성화하고 Futures 권한만 사용해 주세요.` };
    }
    return { success: true, gateUserId, futuresRead: true, futuresTrade, ipWhitelisted: true, withdrawalDisabled: true };
  } catch (error) {
    return {
      success: false,
      errorCode: error instanceof GateApiError ? error.code : 'GATE_UNREACHABLE',
      errorMessage: error instanceof GateApiError ? error.message : 'Gate.io API에 연결하지 못했습니다.',
      diagnostic: error instanceof GateApiError ? {
        path: error.path || '', status: error.status || 0, label: String(error.payload?.label || '').slice(0, 80),
      } : undefined,
    };
  }
}

export async function getFuturesAccount(options) {
  const { payload } = await gateRequest({ ...options, path: FUTURES_ACCOUNT_PATH });
  // Gate only populates `total` for classic futures accounts. Unified margin
  // modes (1-3) must use the unified-account equity endpoint; fields such as
  // `cross_margin_balance` are not account equity in those modes.
  const classicTotal = Number(payload?.total || 0);
  const crossMarginBalance = Number(payload?.cross_margin_balance || 0);
  const marginMode = Number(payload?.margin_mode || 0);
  let total;
  if (marginMode > 0 || (!(classicTotal > 0) && !(crossMarginBalance > 0))) {
    const unified = await gateRequest({ ...options, path: UNIFIED_ACCOUNT_PATH });
    total = Number(unified.payload?.unified_account_total_equity || 0);
  } else {
    total = classicTotal > 0 ? classicTotal : crossMarginBalance;
  }
  const available = Number(payload?.available ?? payload?.cross_available ?? 0);
  if (!(total > 0) || (available > 0 && total < available * 0.5)) {
    throw new GateApiError('Gate.io 계정 자산 값을 안전하게 확인할 수 없습니다.', { code: 'INVALID_ACCOUNT_EQUITY', path: FUTURES_ACCOUNT_PATH });
  }
  return {
    user: payload?.user == null ? '' : String(payload.user),
    total,
    available,
    unrealisedPnl: Number(payload?.unrealised_pnl ?? payload?.unrealized_pnl ?? payload?.cross_unrealised_pnl ?? 0),
    positionMode: String(payload?.position_mode || (payload?.in_dual_mode ? 'dual' : 'single')),
  };
}

export function normalizeGatePositions(payload) {
  const positions = (Array.isArray(payload) ? payload : []).map((position) => ({
    contract: String(position.contract || ''),
    size: Number(position.size || 0),
    markPrice: Number(position.mark_price || 0),
    entryPrice: Number(position.entry_price || 0),
    leverage: Number(position.lever ?? (Number(position.leverage || 0) > 0 ? position.leverage : position.cross_leverage_limit) ?? 0),
    mode: String(position.mode || 'single'),
    positionSide: String(position.mode || '').toLowerCase() === 'dual_long' ? 'LONG'
      : String(position.mode || '').toLowerCase() === 'dual_short' ? 'SHORT'
        : Number(position.size || 0) < 0 ? 'SHORT' : 'LONG',
    posMarginMode: String(position.pos_margin_mode || (Number(position.leverage || 0) > 0 ? 'isolated' : 'cross')),
    pid: position.pid == null ? null : String(position.pid),
  })).filter((position) => position.contract && Number.isFinite(position.size) && position.size !== 0);
  const legs = new Set();
  for (const position of positions) {
    const leg = `${position.contract}:${position.positionSide}`;
    if (legs.has(leg)) {
      throw new GateApiError('같은 방향의 분할 포지션은 아직 안전하게 복사할 수 없습니다.', { code: 'SPLIT_POSITION_UNSUPPORTED' });
    }
    legs.add(leg);
  }
  return positions;
}

export async function getFuturesPositions(options) {
  // Gate's official API defines `holding=true` as the explicit real/open
  // position query. Omitting it can return an empty list for unified accounts
  // even while the account has an open perpetual position.
  const { payload } = await gateRequest({
    ...options,
    path: FUTURES_POSITIONS_PATH,
    query: { holding: true, limit: 100, offset: 0 },
  });
  const positions = normalizeGatePositions(payload);
  if (positions.length) return positions;

  // Some unified accounts return an empty list here even with open positions.
  // Discover recently traded contracts, then use Gate's authoritative
  // single-contract endpoint for each candidate instead of special-casing BTC.
  const recent = await gateRequest({
    ...options,
    path: FUTURES_TRADES_PATH,
    query: { limit: 100, offset: 0 },
  });
  const candidates = [...new Set((Array.isArray(recent.payload) ? recent.payload : [])
    .map((trade) => String(trade.contract || ''))
    .filter(Boolean))].slice(0, 20);
  const singles = [];
  for (const contract of candidates) {
    try {
      const single = await gateRequest({ ...options, path: `${FUTURES_POSITIONS_PATH}/${encodeURIComponent(contract)}` });
      if (Array.isArray(single.payload)) singles.push(...single.payload);
      else if (single.payload) singles.push(single.payload);
    } catch (error) {
      const notFound = error instanceof GateApiError
        && (error.status === 404 || String(error.payload?.label || '').toUpperCase() === 'POSITION_NOT_FOUND');
      if (!notFound) throw error;
    }
  }
  return normalizeGatePositions(singles);
}

export async function setFuturesPositionMode({ positionMode = 'dual', ...options }) {
  if (!['single', 'dual'].includes(positionMode)) {
    throw new GateApiError('지원하지 않는 Gate 포지션 모드입니다.', { code: 'INVALID_POSITION_MODE' });
  }
  const { payload } = await gateRequest({
    ...options,
    method: 'POST',
    path: FUTURES_POSITION_MODE_PATH,
    query: { position_mode: positionMode },
    expiresAtMs: Date.now() + 5_000,
  });
  return payload;
}

export async function setFuturesLeverage({ contract, leverage, marginMode = 'cross', positionSide, ...options }) {
  const normalizedLeverage = Number(leverage);
  if (!contract || !Number.isFinite(normalizedLeverage) || normalizedLeverage < 1 || normalizedLeverage > 100) {
    throw new GateApiError('마스터 레버리지 값이 올바르지 않습니다.', { code: 'INVALID_MASTER_LEVERAGE' });
  }
  if (!['cross', 'isolated'].includes(marginMode)) {
    throw new GateApiError('마스터 증거금 모드를 확인할 수 없습니다.', { code: 'INVALID_MARGIN_MODE' });
  }
  const dualSide = positionSide === 'LONG' ? 'dual_long' : positionSide === 'SHORT' ? 'dual_short' : '';
  const { payload } = await gateRequest({
    ...options,
    method: 'POST',
    path: `${FUTURES_POSITIONS_PATH}/${encodeURIComponent(contract)}/set_leverage`,
    query: { leverage: normalizedLeverage, margin_mode: marginMode, dual_side: dualSide },
    expiresAtMs: Date.now() + 5_000,
  });
  return payload;
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

export async function placeFuturesOrder({ contract, size, reduceOnly = false, text, slippageRatio = 0.005, pid = null, ...options }) {
  const requestBody = { contract, size: String(size), price: '0', tif: 'ioc', reduce_only: Boolean(reduceOnly), text, market_order_slip_ratio: String(slippageRatio) };
  if (pid != null && pid !== '') requestBody.pid = String(pid);
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

export async function getFuturesAccountBook({ from, to, limit = 1000, offset = 0, ...options }) {
  const { payload } = await gateRequest({
    ...options, path: FUTURES_ACCOUNT_BOOK_PATH,
    query: { from, to, limit: Math.min(Math.max(Number(limit) || 100, 1), 1000), offset },
  });
  return Array.isArray(payload) ? payload : [];
}

export async function getMyFuturesTradesInRange({ from, to, limit = 1000, offset = 0, ...options }) {
  const { payload } = await gateRequest({
    ...options, path: FUTURES_TRADES_TIME_RANGE_PATH,
    query: { from, to, limit: Math.min(Math.max(Number(limit) || 100, 1), 1000), offset },
  });
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
