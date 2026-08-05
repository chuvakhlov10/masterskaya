'use strict';

const crypto = require('node:crypto');

const ALLOWED_ORIGIN = 'https://chuvakhlov10.github.io';
const ABLY_CHANNEL = 'masterskaya-sync';
const TOKEN_TTL_SECONDS = 60 * 60;
const MAX_BODY_BYTES = 2_048;
const SESSION_HEADER = 'x-masterskaya-session';
const SESSION_ISSUER = 'masterskaya-storage-gateway';
const SESSION_AUDIENCE = 'masterskaya-web';

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
  if (origin === ALLOWED_ORIGIN) {
    headers['Access-Control-Allow-Origin'] = ALLOWED_ORIGIN;
  }
  return headers;
}

function reply(statusCode, payload, origin, extraHeaders = {}) {
  const isEmpty = statusCode === 204;
  return {
    statusCode,
    headers: corsHeaders(origin, {
      'Content-Type': 'application/json; charset=utf-8',
      ...extraHeaders,
    }),
    isBase64Encoded: false,
    body: isEmpty ? '' : JSON.stringify(payload),
  };
}

function makeError(code, statusCode = 401) {
  const error = new Error(code);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function normalizeClientId(value) {
  const clientId = String(value || '').trim();
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(clientId)) return null;
  return clientId;
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

function parseAblyKey(value) {
  const apiKey = String(value || '').trim();
  const separator = apiKey.indexOf(':');
  if (separator <= 0 || separator === apiKey.length - 1) return null;
  const keyName = apiKey.slice(0, separator);
  const secret = apiKey.slice(separator + 1);
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(keyName)) return null;
  if (!/^[A-Za-z0-9_-]{16,}$/.test(secret)) return null;
  return { keyName, secret };
}

function base64UrlJson(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function parseBase64Json(value) {
  try {
    return JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function parseSessionSecret(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  let bytes;
  try {
    bytes = Buffer.from(raw, 'base64');
  } catch {
    return null;
  }
  return bytes.length >= 32 ? bytes : null;
}

function sessionVersion(env) {
  const value = Number.parseInt(String(env.MASTERSKAYA_SESSION_VERSION || '1'), 10);
  return Number.isInteger(value) && value > 0 ? value : 1;
}

function verifyStorageSession({ token, secret, nowMs = Date.now(), version = 1 }) {
  const key = Buffer.isBuffer(secret) ? secret : parseSessionSecret(secret);
  if (!key) throw makeError('SESSION_AUTH_NOT_CONFIGURED', 503);

  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw makeError('SESSION_REQUIRED', 401);
  const [encodedHeader, encodedClaims, signature] = parts;
  const expected = crypto
    .createHmac('sha256', key)
    .update(`${encodedHeader}.${encodedClaims}`, 'utf8')
    .digest('base64url');
  const suppliedBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (suppliedBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(suppliedBuffer, expectedBuffer)) {
    throw makeError('SESSION_INVALID', 401);
  }

  const header = parseBase64Json(encodedHeader);
  const claims = parseBase64Json(encodedClaims);
  const now = Math.floor(Number(nowMs) / 1000);
  if (!header || header.alg !== 'HS256' || header.typ !== 'JWT') throw makeError('SESSION_INVALID', 401);
  if (!claims || claims.iss !== SESSION_ISSUER || claims.aud !== SESSION_AUDIENCE) {
    throw makeError('SESSION_INVALID', 401);
  }
  if (claims.scope !== 'storage' || claims.sv !== version || !normalizeClientId(claims.clientId)) {
    throw makeError('SESSION_INVALID', 401);
  }
  if (!Number.isFinite(claims.iat) || !Number.isFinite(claims.exp)) throw makeError('SESSION_INVALID', 401);
  if (claims.iat > now + 120) throw makeError('SESSION_INVALID', 401);
  if (claims.exp <= now) throw makeError('SESSION_EXPIRED', 401);
  return claims;
}

function createAblyJwt({ apiKey, clientId, nowMs = Date.now() }) {
  const parsed = parseAblyKey(apiKey);
  if (!parsed) throw new Error('ABLY_KEY_INVALID');

  const issuedAt = Math.floor(Number(nowMs) / 1000);
  const expiresAt = issuedAt + TOKEN_TTL_SECONDS;
  const header = {
    typ: 'JWT',
    alg: 'HS256',
    kid: parsed.keyName,
  };
  const claims = {
    iat: issuedAt,
    exp: expiresAt,
    'x-ably-capability': JSON.stringify({
      [ABLY_CHANNEL]: ['publish', 'subscribe'],
    }),
    'x-ably-clientId': clientId,
  };

  const unsigned = `${base64UrlJson(header)}.${base64UrlJson(claims)}`;
  const signature = crypto
    .createHmac('sha256', parsed.secret)
    .update(unsigned, 'utf8')
    .digest('base64url');

  return {
    token: `${unsigned}.${signature}`,
    expiresAt: expiresAt * 1000,
  };
}

function createHandler({ fetchImpl = globalThis.fetch, env = process.env, now = () => Date.now() } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch implementation is required');

  return async function handler(event = {}) {
    const headers = normalizeHeaders(event.headers);
    const origin = headers.origin || '';
    const method = String(event.httpMethod || '').toUpperCase();

    if (method === 'OPTIONS') {
      if (origin !== ALLOWED_ORIGIN) return reply(403, { ok: false, error: 'ORIGIN_DENIED' }, origin);
      return reply(204, null, origin, {
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, X-Masterskaya-Session',
        'Access-Control-Max-Age': '600',
      });
    }

    if (origin !== ALLOWED_ORIGIN) return reply(403, { ok: false, error: 'ORIGIN_DENIED' }, origin);
    if (method !== 'POST') {
      return reply(405, { ok: false, error: 'METHOD_NOT_ALLOWED' }, origin, {
        Allow: 'POST, OPTIONS',
      });
    }

    let body;
    try {
      body = parseBody(event);
    } catch {
      return reply(400, { ok: false, error: 'INVALID_JSON_BODY' }, origin);
    }

    const clientId = normalizeClientId(body?.clientId);
    if (!clientId) return reply(400, { ok: false, error: 'CLIENT_ID_INVALID' }, origin);

    const suppliedSession = String(headers[SESSION_HEADER] || '').trim();
    if (!suppliedSession) return reply(401, { ok: false, error: 'SESSION_REQUIRED' }, origin);
    try {
      verifyStorageSession({
        token: suppliedSession,
        secret: env.MASTERSKAYA_SESSION_SECRET,
        nowMs: now(),
        version: sessionVersion(env),
      });
    } catch (error) {
      return reply(error.statusCode || 401, { ok: false, error: error.code || 'SESSION_INVALID' }, origin);
    }

    const apiKey = String(env.ABLY_API_KEY || '').trim();
    let tokenDetails;
    try {
      tokenDetails = createAblyJwt({ apiKey, clientId, nowMs: now() });
    } catch {
      return reply(503, { ok: false, error: 'ABLY_AUTH_NOT_CONFIGURED' }, origin);
    }

    return reply(200, {
      ok: true,
      token: tokenDetails.token,
      expiresAt: tokenDetails.expiresAt,
      clientId,
    }, origin);
  };
}

const handler = createHandler();

module.exports = {
  ALLOWED_ORIGIN,
  ABLY_CHANNEL,
  SESSION_AUDIENCE,
  SESSION_ISSUER,
  TOKEN_TTL_SECONDS,
  createAblyJwt,
  createHandler,
  handler,
  normalizeClientId,
  parseAblyKey,
  parseBody,
  parseSessionSecret,
  verifyStorageSession,
};
