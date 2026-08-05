'use strict';

const base = require('./index.js');
const pairing = require('./pairing-index.js');
const { createDeviceAuthService } = require('./device-auth.js');

const SESSION_HEADER = 'x-masterskaya-session';
const MAX_BODY_BYTES = 4_096;

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
  if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) throw makeError('BODY_TOO_LARGE', 413);
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw makeError('INVALID_JSON_BODY', 400, cause);
  }
}

function sessionVersion(env) {
  const value = Number.parseInt(String(env.MASTERSKAYA_SESSION_VERSION || '1'), 10);
  return Number.isInteger(value) && value > 0 ? value : 1;
}

function createHandler({
  fetchImpl = globalThis.fetch,
  env = process.env,
  now = () => Date.now(),
  appClient: providedAppClient,
  deviceAuthService: providedDeviceAuthService,
} = {}) {
  const delegatedHandler = pairing.createHandler({
    fetchImpl,
    env,
    now,
    appClient: providedAppClient,
    deviceAuthService: providedDeviceAuthService,
  });
  let appClient = providedAppClient || null;
  let deviceAuthService = providedDeviceAuthService || null;

  function getDeviceAuthService() {
    if (deviceAuthService) return deviceAuthService;
    if (!appClient) appClient = pairing.createAppClientWithInternalAccess({ fetchImpl, env, now });
    deviceAuthService = createDeviceAuthService({ appClient, now });
    return deviceAuthService;
  }

  return async function handler(event = {}) {
    const headers = normalizeHeaders(event.headers);
    const origin = headers.origin || '';
    const method = String(event.httpMethod || '').toUpperCase();
    let body;
    try {
      body = parseBody(event);
    } catch {
      return delegatedHandler(event);
    }

    if (String(body?.action || '').trim() !== 'session-check') return delegatedHandler(event);

    if (origin !== base.ALLOWED_ORIGIN) return reply(403, { ok: false, error: 'ORIGIN_DENIED' }, origin);
    if (method !== 'POST') return reply(405, { ok: false, error: 'METHOD_NOT_ALLOWED' }, origin);

    try {
      const claims = base.verifySessionToken({
        token: headers[SESSION_HEADER],
        secret: env.MASTERSKAYA_SESSION_SECRET,
        nowMs: now(),
        version: sessionVersion(env),
      });
      const device = await getDeviceAuthService().authorize(claims, body.deviceName);
      return reply(200, {
        ok: true,
        device: {
          id: device.id,
          name: device.name,
          lastSeenAt: device.lastSeenAt,
        },
      }, origin);
    } catch (error) {
      const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : 503;
      const code = typeof error?.code === 'string' ? error.code : 'DEVICE_AUTH_CHECK_FAILED';
      return reply(statusCode, { ok: false, error: code }, origin);
    }
  };
}

const handler = createHandler();

module.exports = {
  createHandler,
  handler,
};
