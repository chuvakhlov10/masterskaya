'use strict';

const base = require('./index.js');

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

  return async function handler(event = {}) {
    const headers = normalizeHeaders(event.headers);
    const suppliedSession = String(headers[SESSION_HEADER] || '').trim();
    if (!suppliedSession) return delegatedHandler(event);

    const origin = headers.origin || '';
    const method = String(event.httpMethod || '').toUpperCase();
    if (origin !== base.ALLOWED_ORIGIN) return reply(403, { ok: false, error: 'ORIGIN_DENIED' }, origin);
    if (method !== 'POST') return reply(405, { ok: false, error: 'METHOD_NOT_ALLOWED' }, origin);

    let body;
    try {
      body = parseBody(event);
    } catch {
      return reply(400, { ok: false, error: 'INVALID_JSON_BODY' }, origin);
    }
    if (!base.normalizeClientId(body?.clientId)) {
      return reply(400, { ok: false, error: 'CLIENT_ID_INVALID' }, origin);
    }

    try {
      base.verifyStorageSession({
        token: suppliedSession,
        secret: env.MASTERSKAYA_SESSION_SECRET,
        nowMs: now(),
        version: Number.parseInt(String(env.MASTERSKAYA_SESSION_VERSION || '1'), 10) || 1,
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
  DEFAULT_STORAGE_GATEWAY_URL,
  createHandler,
  handler,
  verifyActiveDevice,
};
