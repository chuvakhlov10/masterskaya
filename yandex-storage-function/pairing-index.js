'use strict';

const base = require('./index.js');
const { createDeviceAuthService, normalizeDeviceName } = require('./device-auth.js');

const SESSION_HEADER = 'x-masterskaya-session';
const MAX_BODY_BYTES = 3_000_000;
const GITHUB_API = 'https://api.github.com';
const GITHUB_TIMEOUT_MS = 20_000;
const INTERNAL_PATHS = new Set(['auth/devices.json', 'auth/pairings.json', 'auth/recovery.json']);

function makeError(code, statusCode = 500, cause) {
  const error = new Error(code);
  error.code = code;
  error.statusCode = statusCode;
  if (cause) error.cause = cause;
  return error;
}

function normalizeHeaders(headers = {}) {
  const result = Object.create(null);
  for (const [name, value] of Object.entries(headers || {})) {
    result[String(name).toLowerCase()] = String(value ?? '');
  }
  return result;
}

function corsHeaders(origin, extra = {}) {
  const headers = {
    'Cache-Control': 'no-store, max-age=0',
    Vary: 'Origin',
    ...extra,
  };
  if (origin === base.ALLOWED_ORIGIN) headers['Access-Control-Allow-Origin'] = base.ALLOWED_ORIGIN;
  return headers;
}

function reply(statusCode, payload, origin, extraHeaders = {}) {
  return {
    statusCode,
    headers: corsHeaders(origin, {
      'Content-Type': 'application/json; charset=utf-8',
      ...extraHeaders,
    }),
    isBase64Encoded: false,
    body: statusCode === 204 ? '' : JSON.stringify(payload),
  };
}

function parseBody(event = {}) {
  let body = event.body;
  if (body === undefined || body === null || body === '') return {};
  if (typeof body === 'object' && !Buffer.isBuffer(body)) return body;
  if (event.isBase64Encoded) body = Buffer.from(String(body), 'base64').toString('utf8');
  const text = String(body);
  if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) throw makeError('BODY_TOO_LARGE', 413);
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw makeError('INVALID_JSON_BODY', 400, cause);
  }
}

function encodeRepoPath(path) {
  return path.split('/').map(segment => encodeURIComponent(segment)).join('/');
}

async function readJsonSafe(response) {
  try { return await response.json(); }
  catch { return null; }
}

async function fetchWithTimeout(fetchImpl, url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GITHUB_TIMEOUT_MS);
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal, cache: 'no-store' });
  } catch (cause) {
    if (cause?.name === 'AbortError') throw makeError('GITHUB_REQUEST_TIMEOUT', 503, cause);
    throw makeError('GITHUB_REQUEST_FAILED', 503, cause);
  } finally {
    clearTimeout(timeout);
  }
}

function createAppClientWithInternalAccess({ fetchImpl, env, now }) {
  const publicClient = base.createGitHubAppClient({ fetchImpl, env, now });
  async function requestInternal({ method, path, body }) {
    const normalizedMethod = String(method || '').toUpperCase();
    const normalizedPath = String(path || '');
    if (!['GET', 'PUT', 'DELETE'].includes(normalizedMethod) || !INTERNAL_PATHS.has(normalizedPath)) {
      throw makeError('INTERNAL_PATH_DENIED', 403);
    }
    const url = `${GITHUB_API}/repos/${base.OWNER}/${base.REPO}/contents/${encodeRepoPath(normalizedPath)}`;
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await publicClient.installationToken(attempt > 0);
      const headers = {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': base.GITHUB_API_VERSION,
        'User-Agent': 'masterskaya-device-auth',
      };
      const options = { method: normalizedMethod, headers };
      if (body !== undefined) {
        headers['Content-Type'] = 'application/json';
        options.body = JSON.stringify(body);
      }
      const response = await fetchWithTimeout(fetchImpl, url, options);
      if (response.status === 401 && attempt === 0) continue;
      const payload = response.status === 204 ? null : await readJsonSafe(response);
      return { status: response.status, ok: response.ok, payload };
    }
    throw makeError('GITHUB_REQUEST_FAILED', 503);
  }
  return { ...publicClient, requestInternal };
}

function sessionVersion(env) {
  const value = Number.parseInt(String(env.MASTERSKAYA_SESSION_VERSION || '1'), 10);
  return Number.isInteger(value) && value > 0 ? value : 1;
}

function storageProtocolVersion(value) {
  const number = Number.parseInt(String(value || ''), 10);
  return Number.isInteger(number) && number > 0 ? number : 1;
}

function minimumStorageProtocol(env) {
  return storageProtocolVersion(env.MASTERSKAYA_MIN_STORAGE_PROTOCOL || 1);
}

function requiredStockEpoch(env) {
  const number = Number.parseInt(String(env.MASTERSKAYA_STOCK_EPOCH || '0'), 10);
  return Number.isInteger(number) && number > 0 ? number : 0;
}

function readStockJournalEnvelope(body) {
  try {
    const encoded = String(body?.body?.content || '').replace(/\s+/g, '');
    const value = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function requireStockWriteProtocol(body, env) {
  const method = String(body?.method || '').toUpperCase();
  const path = String(body?.path || '');
  if (method !== 'PUT' || path !== 'data/stock-ops.json') return;
  if (storageProtocolVersion(body.storageProtocolVersion) < minimumStorageProtocol(env)) {
    throw makeError('STORAGE_PROTOCOL_UPGRADE_REQUIRED', 426);
  }
  const epoch = requiredStockEpoch(env);
  if (epoch > 0) {
    const journal = readStockJournalEnvelope(body);
    if (Number(journal?.schemaVersion) !== 4 || Number(journal?.epoch) !== epoch || !Array.isArray(journal?.ops)) {
      throw makeError('STOCK_ARCHIVE_EPOCH_REQUIRED', 428);
    }
  }
}

function createHandler({
  fetchImpl = globalThis.fetch,
  env = process.env,
  now = () => Date.now(),
  appClient: providedAppClient,
  deviceAuthService: providedDeviceAuthService,
} = {}) {
  if (typeof fetchImpl !== 'function' && !providedAppClient) throw makeError('FETCH_UNAVAILABLE', 503);
  const secret = base.parseSessionSecret(env.MASTERSKAYA_SESSION_SECRET);
  const version = sessionVersion(env);
  let appClient = providedAppClient || null;
  let deviceAuthService = providedDeviceAuthService || null;

  function requireSecret() {
    if (!secret) throw makeError('SESSION_AUTH_NOT_CONFIGURED', 503);
    return secret;
  }

  function getAppClient() {
    if (!appClient) appClient = createAppClientWithInternalAccess({ fetchImpl, env, now });
    return appClient;
  }

  function getDeviceAuthService() {
    if (!deviceAuthService) {
      deviceAuthService = createDeviceAuthService({
        appClient: getAppClient(),
        now,
        recoverySecret: requireSecret(),
      });
    }
    return deviceAuthService;
  }

  function createDeviceSession(clientId) {
    return base.createSessionToken({
      secret: requireSecret(),
      clientId,
      subject: `device:${clientId}`,
      nowMs: now(),
      version,
    });
  }

  return async function handler(event = {}) {
    const headers = normalizeHeaders(event.headers);
    const origin = headers.origin || '';
    const method = String(event.httpMethod || '').toUpperCase();

    if (method === 'OPTIONS') {
      if (origin !== base.ALLOWED_ORIGIN) return reply(403, { ok: false, error: 'ORIGIN_DENIED' }, origin);
      return reply(204, null, origin, {
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, X-Masterskaya-Session',
        'Access-Control-Max-Age': '600',
      });
    }
    if (origin !== base.ALLOWED_ORIGIN) return reply(403, { ok: false, error: 'ORIGIN_DENIED' }, origin);
    if (method !== 'POST') return reply(405, { ok: false, error: 'METHOD_NOT_ALLOWED' }, origin, { Allow: 'POST, OPTIONS' });

    let body;
    try {
      body = parseBody(event);
    } catch (error) {
      return reply(error.statusCode || 400, { ok: false, error: error.code || 'INVALID_JSON_BODY' }, origin);
    }

    const action = String(body?.action || '').trim();
    try {
      if (action === 'pairing-redeem') {
        const clientId = base.normalizeClientId(body.clientId);
        if (!clientId) throw makeError('CLIENT_ID_INVALID', 400);
        const device = await getDeviceAuthService().redeemPairing({
          code: body.code,
          clientId,
          deviceName: normalizeDeviceName(body.deviceName),
        });
        const session = createDeviceSession(device.id);
        return reply(200, {
          ok: true,
          sessionToken: session.token,
          expiresAt: session.expiresAt,
          clientId: device.id,
          device,
        }, origin);
      }

      if (action === 'recovery-redeem') {
        const clientId = base.normalizeClientId(body.clientId);
        if (!clientId) throw makeError('CLIENT_ID_INVALID', 400);
        const recovered = await getDeviceAuthService().redeemRecovery({
          code: body.code,
          clientId,
          deviceName: body.deviceName,
        });
        const session = createDeviceSession(recovered.device.id);
        return reply(200, {
          ok: true,
          sessionToken: session.token,
          expiresAt: session.expiresAt,
          clientId: recovered.device.id,
          device: recovered.device,
          replacementRecoveryCode: recovered.replacementCode,
        }, origin);
      }

      const claims = base.verifySessionToken({
        token: headers[SESSION_HEADER],
        secret: requireSecret(),
        nowMs: now(),
        version,
      });
      const auth = getDeviceAuthService();

      if (action === 'renew') {
        const device = await auth.authorize(claims, body.deviceName);
        const session = createDeviceSession(device.id);
        return reply(200, {
          ok: true,
          sessionToken: session.token,
          expiresAt: session.expiresAt,
          clientId: device.id,
          device,
        }, origin);
      }

      if (action === 'github') {
        await auth.authorize(claims, body.deviceName);
        requireStockWriteProtocol(body, env);
        const result = await getAppClient().request(body);
        return reply(result.status, result.payload, origin);
      }

      if (action === 'devices') {
        const devices = await auth.listDevices(claims, body.deviceName);
        return reply(200, { ok: true, devices, currentClientId: claims.clientId }, origin);
      }

      if (action === 'pairing-create') {
        const pairing = await auth.createPairing(claims, body.deviceName);
        return reply(200, { ok: true, ...pairing }, origin);
      }

      if (action === 'recovery-rotate') {
        const recovery = await auth.rotateRecovery(claims, body.deviceName);
        return reply(200, { ok: true, recoveryCode: recovery.code, generation: recovery.generation }, origin);
      }

      if (action === 'device-rename') {
        const device = await auth.renameDevice(claims, body.targetClientId, body.deviceName);
        return reply(200, { ok: true, device }, origin);
      }

      if (action === 'device-revoke') {
        const device = await auth.revokeDevice(claims, body.targetClientId);
        return reply(200, { ok: true, device }, origin);
      }

      throw makeError('ACTION_INVALID', 400);
    } catch (error) {
      const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : 503;
      const code = typeof error?.code === 'string' ? error.code : 'GATEWAY_FAILED';
      return reply(statusCode, { ok: false, error: code }, origin);
    }
  };
}

const handler = createHandler();

module.exports = {
  createAppClientWithInternalAccess,
  createHandler,
  handler,
  minimumStorageProtocol,
  requiredStockEpoch,
  requireStockWriteProtocol,
  storageProtocolVersion,
};
