'use strict';

const base = require('./index.js');

const FUNCTION_NAME = 'masterskaya-ably-auth';
const FUNCTION_VERSION = '1.3.1';
const PROTOCOL_VERSION = 3;
const BUILD_ID = '__MASTERSKAYA_BUILD_ID__';
const BUILD_DATE = '__MASTERSKAYA_BUILD_DATE__';
const DEFAULT_STORAGE_GATEWAY_URL = 'https://functions.yandexcloud.net/d4ep5fmjtp6t09f06tvt';
const SESSION_HEADER = 'x-masterskaya-session';
const DEVICE_CHECK_TIMEOUT_MS = 8_000;
const MAX_BODY_BYTES = 2_048;

function normalizeHeaders(headers = {}) {
  const result = Object.create(null);
  for (const [name, value] of Object.entries(headers || {})) {
    result[String(name).toLowerCase()] = String(value ?? '');
  }
  return result;
}

function reply(statusCode, payload, origin) {
  const headers = {
    'Cache-Control': 'no-store, max-age=0',
    'Content-Type': 'application/json; charset=utf-8',
    Vary: 'Origin',
  };
  if (origin === base.ALLOWED_ORIGIN) headers['Access-Control-Allow-Origin'] = base.ALLOWED_ORIGIN;
  return {
    statusCode,
    headers,
    isBase64Encoded: false,
    body: JSON.stringify(payload),
  };
}

function parseBody(event = {}) {
  let body = event.body;
  if (body === undefined || body === null || body === '') return {};
  if (typeof body === 'object' && !Buffer.isBuffer(body)) return body;
  if (event.isBase64Encoded) body = Buffer.from(String(body), 'base64').toString('utf8');
  const text = String(body);
  if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) throw new Error('BODY_TOO_LARGE');
  return JSON.parse(text);
}

async function readJsonSafe(response) {
  try { return await response.json(); }
  catch { return null; }
}

async function verifyActiveDevice({
  sessionToken,
  fetchImpl,
  storageGatewayUrl = DEFAULT_STORAGE_GATEWAY_URL,
  timeoutMs = DEVICE_CHECK_TIMEOUT_MS,
}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(storageGatewayUrl, {
      method: 'POST',
      headers: {
        Origin: base.ALLOWED_ORIGIN,
        'Content-Type': 'application/json',
        'X-Masterskaya-Session': sessionToken,
      },
      body: JSON.stringify({ action: 'session-check' }),
      signal: controller.signal,
      cache: 'no-store',
    });
  } catch (cause) {
    const error = new Error(cause?.name === 'AbortError' ? 'DEVICE_AUTH_CHECK_TIMEOUT' : 'DEVICE_AUTH_CHECK_FAILED');
    error.code = error.message;
    error.statusCode = 503;
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  const payload = await readJsonSafe(response);
  if (!response.ok) {
    const error = new Error(String(payload?.error || 'DEVICE_AUTH_CHECK_FAILED'));
    error.code = error.message;
    error.statusCode = [400, 401, 403, 404, 410].includes(response.status) ? response.status : 503;
    throw error;
  }
  if (payload?.ok !== true || typeof payload?.device?.id !== 'string') {
    const error = new Error('DEVICE_AUTH_CHECK_INVALID');
    error.code = error.message;
    error.statusCode = 503;
    throw error;
  }
  return payload.device;
}

function createHandler({
  fetchImpl = globalThis.fetch,
  env = process.env,
  now = () => Date.now(),
  storageGatewayUrl = env.MASTERSKAYA_STORAGE_GATEWAY_URL || DEFAULT_STORAGE_GATEWAY_URL,
} = {}) {
  const delegatedHandler = base.createHandler({ fetchImpl, env, now });
  const sessionVersion = Number.parseInt(String(env.MASTERSKAYA_SESSION_VERSION || '1'), 10) || 1;

  return async function handler(event = {}) {
    const headers = normalizeHeaders(event.headers);
    const origin = headers.origin || '';
    const method = String(event.httpMethod || '').toUpperCase();

    let body;
    try {
      body = parseBody(event);
    } catch {
      return reply(400, { ok: false, error: 'INVALID_JSON_BODY' }, origin);
    }

    const action = String(body?.action || '').trim();
    const suppliedSession = String(headers[SESSION_HEADER] || '').trim();

    if (action === 'health') {
      if (origin !== base.ALLOWED_ORIGIN) return reply(403, { ok: false, error: 'ORIGIN_DENIED' }, origin);
      if (method !== 'POST') return reply(405, { ok: false, error: 'METHOD_NOT_ALLOWED' }, origin);

      const result = {
        ok: true,
        service: FUNCTION_NAME,
        version: FUNCTION_VERSION,
        protocolVersion: PROTOCOL_VERSION,
        buildId: BUILD_ID,
        buildDate: BUILD_DATE,
        serverTime: new Date(now()).toISOString(),
        checks: {
          runtime: 'ok',
          ablyConfig: env.ABLY_API_KEY ? 'configured' : 'missing',
          sessionAuth: env.MASTERSKAYA_SESSION_SECRET ? 'configured' : 'missing',
          storageGateway: 'not_checked',
          deviceRegistry: 'not_checked',
        },
      };

      if (!suppliedSession) return reply(200, result, origin);

      try {
        const claims = base.verifyStorageSession({
          token: suppliedSession,
          secret: env.MASTERSKAYA_SESSION_SECRET,
          nowMs: now(),
          version: sessionVersion,
        });
        const device = await verifyActiveDevice({
          sessionToken: suppliedSession,
          fetchImpl,
          storageGatewayUrl,
        });
        result.authenticated = true;
        result.device = { id: claims.clientId, name: device.name };
        result.checks.storageGateway = 'ok';
        result.checks.deviceRegistry = 'ok';
        return reply(200, result, origin);
      } catch (error) {
        return reply(error.statusCode || 503, {
          ...result,
          ok: false,
          error: error.code || 'DEVICE_AUTH_CHECK_FAILED',
          checks: {
            ...result.checks,
            storageGateway: 'error',
            deviceRegistry: 'error',
          },
        }, origin);
      }
    }

    if (!suppliedSession) return delegatedHandler(event);
    if (origin !== base.ALLOWED_ORIGIN) return reply(403, { ok: false, error: 'ORIGIN_DENIED' }, origin);
    if (method !== 'POST') return reply(405, { ok: false, error: 'METHOD_NOT_ALLOWED' }, origin);
    if (!base.normalizeClientId(body?.clientId)) {
      return reply(400, { ok: false, error: 'CLIENT_ID_INVALID' }, origin);
    }

    try {
      base.verifyStorageSession({
        token: suppliedSession,
        secret: env.MASTERSKAYA_SESSION_SECRET,
        nowMs: now(),
        version: sessionVersion,
      });
      await verifyActiveDevice({
        sessionToken: suppliedSession,
        fetchImpl,
        storageGatewayUrl,
      });
    } catch (error) {
      return reply(error.statusCode || 401, { ok: false, error: error.code || 'SESSION_INVALID' }, origin);
    }

    return delegatedHandler(event);
  };
}

const handler = createHandler();

module.exports = {
  BUILD_DATE,
  BUILD_ID,
  DEFAULT_STORAGE_GATEWAY_URL,
  FUNCTION_NAME,
  FUNCTION_VERSION,
  PROTOCOL_VERSION,
  createHandler,
  handler,
  verifyActiveDevice,
};
