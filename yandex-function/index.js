'use strict';

const crypto = require('node:crypto');

const ALLOWED_ORIGIN = 'https://chuvakhlov10.github.io';
const DATA_REPOSITORY_URL = 'https://api.github.com/repos/chuvakhlov10/masterskaya-data';
const ABLY_CHANNEL = 'masterskaya-sync';
const TOKEN_TTL_SECONDS = 60 * 60;
const GITHUB_TIMEOUT_MS = 8_000;
const MAX_BODY_BYTES = 2_048;
const TOKEN_HEADER = 'x-masterskaya-github-token';

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

async function verifyGitHubPushAccess(token, fetchImpl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GITHUB_TIMEOUT_MS);
  try {
    const response = await fetchImpl(DATA_REPOSITORY_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'masterskaya-yandex-ably-auth',
      },
      signal: controller.signal,
      cache: 'no-store',
    });

    if ([401, 403, 404].includes(response.status)) return { ok: false, denied: true };
    if (!response.ok) throw new Error(`GITHUB_HTTP_${response.status}`);
    const repository = await response.json();
    const permissions = repository?.permissions || {};
    return {
      ok: permissions.push === true || permissions.admin === true || permissions.maintain === true,
    };
  } finally {
    clearTimeout(timeout);
  }
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
        'Access-Control-Allow-Headers': 'Content-Type, X-Masterskaya-GitHub-Token',
        'Access-Control-Max-Age': '600',
      });
    }

    if (origin !== ALLOWED_ORIGIN) return reply(403, { ok: false, error: 'ORIGIN_DENIED' }, origin);
    if (method !== 'POST') {
      return reply(405, { ok: false, error: 'METHOD_NOT_ALLOWED' }, origin, {
        Allow: 'POST, OPTIONS',
      });
    }

    const githubToken = String(headers[TOKEN_HEADER] || '').trim();
    if (!/^[^\s]{20,512}$/.test(githubToken)) {
      return reply(401, { ok: false, error: 'GITHUB_TOKEN_REQUIRED' }, origin);
    }

    let body;
    try {
      body = parseBody(event);
    } catch {
      return reply(400, { ok: false, error: 'INVALID_JSON_BODY' }, origin);
    }

    const clientId = normalizeClientId(body?.clientId);
    if (!clientId) return reply(400, { ok: false, error: 'CLIENT_ID_INVALID' }, origin);

    let access;
    try {
      access = await verifyGitHubPushAccess(githubToken, fetchImpl);
    } catch {
      return reply(503, { ok: false, error: 'GITHUB_ACCESS_CHECK_FAILED' }, origin);
    }
    if (!access.ok) return reply(403, { ok: false, error: 'GITHUB_ACCESS_DENIED' }, origin);

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
  TOKEN_TTL_SECONDS,
  createAblyJwt,
  createHandler,
  handler,
  normalizeClientId,
  parseAblyKey,
  parseBody,
  verifyGitHubPushAccess,
};
