'use strict';

const crypto = require('node:crypto');

const ALLOWED_ORIGIN = 'https://chuvakhlov10.github.io';
const GITHUB_API = 'https://api.github.com';
const GITHUB_API_VERSION = '2026-03-10';
const OWNER = 'chuvakhlov10';
const REPO = 'masterskaya-data';
const SESSION_ISSUER = 'masterskaya-storage-gateway';
const SESSION_AUDIENCE = 'masterskaya-web';
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const MAX_BODY_BYTES = 3_000_000;
const GITHUB_TIMEOUT_MS = 20_000;
const SESSION_HEADER = 'x-masterskaya-session';

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
  const empty = statusCode === 204;
  return {
    statusCode,
    headers: corsHeaders(origin, {
      'Content-Type': 'application/json; charset=utf-8',
      ...extraHeaders,
    }),
    isBase64Encoded: false,
    body: empty ? '' : JSON.stringify(payload),
  };
}

function makeError(code, statusCode = 500, cause) {
  const error = new Error(code);
  error.code = code;
  error.statusCode = statusCode;
  if (cause) error.cause = cause;
  return error;
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

function normalizeClientId(value) {
  const clientId = String(value || '').trim();
  return /^[A-Za-z0-9._:-]{8,128}$/.test(clientId) ? clientId : null;
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
  if (bytes.length < 32) return null;
  return bytes;
}

function sessionVersion(env) {
  const value = Number.parseInt(String(env.MASTERSKAYA_SESSION_VERSION || '1'), 10);
  return Number.isInteger(value) && value > 0 ? value : 1;
}

function createSessionToken({ secret, clientId, subject = 'device-session', nowMs = Date.now(), version = 1 }) {
  const key = Buffer.isBuffer(secret) ? secret : parseSessionSecret(secret);
  if (!key) throw makeError('SESSION_SECRET_INVALID', 503);
  const normalizedClientId = normalizeClientId(clientId);
  if (!normalizedClientId) throw makeError('CLIENT_ID_INVALID', 400);

  const issuedAt = Math.floor(Number(nowMs) / 1000);
  const expiresAt = issuedAt + SESSION_TTL_SECONDS;
  const header = { typ: 'JWT', alg: 'HS256' };
  const claims = {
    iss: SESSION_ISSUER,
    aud: SESSION_AUDIENCE,
    sub: String(subject || 'device-session').slice(0, 160),
    iat: issuedAt,
    exp: expiresAt,
    clientId: normalizedClientId,
    scope: 'storage',
    sv: version,
    jti: crypto.randomBytes(16).toString('base64url'),
  };
  const unsigned = `${base64UrlJson(header)}.${base64UrlJson(claims)}`;
  const signature = crypto.createHmac('sha256', key).update(unsigned, 'utf8').digest('base64url');
  return {
    token: `${unsigned}.${signature}`,
    expiresAt: expiresAt * 1000,
    claims,
  };
}

function verifySessionToken({ token, secret, nowMs = Date.now(), version = 1 }) {
  const key = Buffer.isBuffer(secret) ? secret : parseSessionSecret(secret);
  if (!key) throw makeError('SESSION_AUTH_NOT_CONFIGURED', 503);
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw makeError('SESSION_REQUIRED', 401);
  const [encodedHeader, encodedClaims, signature] = parts;
  const expected = crypto.createHmac('sha256', key)
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
  if (!claims || claims.iss !== SESSION_ISSUER || claims.aud !== SESSION_AUDIENCE) throw makeError('SESSION_INVALID', 401);
  if (claims.scope !== 'storage' || claims.sv !== version || !normalizeClientId(claims.clientId)) {
    throw makeError('SESSION_INVALID', 401);
  }
  if (!Number.isFinite(claims.iat) || !Number.isFinite(claims.exp)) throw makeError('SESSION_INVALID', 401);
  if (claims.iat > now + 120) throw makeError('SESSION_INVALID', 401);
  if (claims.exp <= now) throw makeError('SESSION_EXPIRED', 401);
  return claims;
}

function parsePrivateKey(value) {
  const encoded = String(value || '').trim();
  if (!encoded) return null;
  try {
    const pem = Buffer.from(encoded, 'base64').toString('utf8');
    if (!pem.includes('BEGIN') || !pem.includes('PRIVATE KEY')) return null;
    return crypto.createPrivateKey(pem);
  } catch {
    return null;
  }
}

function createGitHubAppJwt({ appId, privateKey, nowMs = Date.now() }) {
  const id = String(appId || '').trim();
  const key = privateKey?.type === 'private' ? privateKey : parsePrivateKey(privateKey);
  if (!/^\d{1,20}$/.test(id) || !key) throw makeError('GITHUB_APP_NOT_CONFIGURED', 503);
  const now = Math.floor(Number(nowMs) / 1000);
  const header = { typ: 'JWT', alg: 'RS256' };
  const claims = { iat: now - 60, exp: now + 9 * 60, iss: id };
  const unsigned = `${base64UrlJson(header)}.${base64UrlJson(claims)}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(unsigned, 'utf8'), key).toString('base64url');
  return `${unsigned}.${signature}`;
}

function githubHeaders(token, userAgent = 'masterskaya-storage-gateway') {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': GITHUB_API_VERSION,
    'User-Agent': userAgent,
  };
}

async function fetchWithTimeout(fetchImpl, url, options = {}, timeoutMs = GITHUB_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal, cache: 'no-store' });
  } catch (cause) {
    if (cause?.name === 'AbortError') throw makeError('GITHUB_REQUEST_TIMEOUT', 503, cause);
    throw makeError('GITHUB_REQUEST_FAILED', 503, cause);
  } finally {
    clearTimeout(timeout);
  }
}

async function readJsonSafe(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function encodeRepoPath(path) {
  return path.split('/').map(segment => encodeURIComponent(segment)).join('/');
}

function normalizeRepoRequest(input = {}) {
  const method = String(input.method || '').toUpperCase();
  if (!['GET', 'PUT', 'DELETE'].includes(method)) throw makeError('METHOD_NOT_ALLOWED', 405);

  const path = String(input.path || '').trim();
  if (!path || path.length > 600 || path.startsWith('/') || path.includes('\\') || path.includes('\0')) {
    throw makeError('PATH_DENIED', 403);
  }
  const segments = path.split('/');
  if (segments.some(segment => !segment || segment === '.' || segment === '..')) throw makeError('PATH_DENIED', 403);

  const ref = input.ref === undefined || input.ref === null || input.ref === '' ? null : String(input.ref);
  let kind;
  if (path === 'status.json') {
    kind = 'backup-status';
    if (method !== 'GET' || ref !== 'data-backups') throw makeError('PATH_DENIED', 403);
  } else if (/^data\/[A-Za-z0-9_-]{1,120}\.json$/.test(path)) {
    kind = 'data';
    if (ref) throw makeError('PATH_DENIED', 403);
  } else if (path.startsWith('photos/') && path.endsWith('.txt')) {
    kind = 'photo';
    if (ref) throw makeError('PATH_DENIED', 403);
  } else {
    throw makeError('PATH_DENIED', 403);
  }

  let body;
  if (method === 'PUT') {
    body = input.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw makeError('GITHUB_BODY_INVALID', 400);
    const message = String(body.message || '');
    const content = String(body.content || '');
    const sha = body.sha === undefined ? null : String(body.sha || '');
    if (!message.trim() || message.length > 240) throw makeError('GITHUB_BODY_INVALID', 400);
    if (!content || content.length > 2_900_000 || !/^[A-Za-z0-9+/=\r\n]+$/.test(content)) {
      throw makeError('GITHUB_BODY_INVALID', 400);
    }
    if (sha && !/^[a-f0-9]{40,64}$/i.test(sha)) throw makeError('GITHUB_BODY_INVALID', 400);
    body = { message, content };
    if (sha) body.sha = sha;
  } else if (method === 'DELETE') {
    body = input.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw makeError('GITHUB_BODY_INVALID', 400);
    const message = String(body.message || '');
    const sha = String(body.sha || '');
    if (!message.trim() || message.length > 240 || !/^[a-f0-9]{40,64}$/i.test(sha)) {
      throw makeError('GITHUB_BODY_INVALID', 400);
    }
    body = { message, sha };
  }

  return { method, path, ref, kind, body };
}

function createGitHubAppClient({ fetchImpl = globalThis.fetch, env = process.env, now = () => Date.now() } = {}) {
  if (typeof fetchImpl !== 'function') throw makeError('FETCH_UNAVAILABLE', 503);
  const appId = String(env.GITHUB_APP_ID || '').trim();
  const privateKey = parsePrivateKey(env.GITHUB_APP_PRIVATE_KEY_B64);
  if (!/^\d{1,20}$/.test(appId) || !privateKey) throw makeError('GITHUB_APP_NOT_CONFIGURED', 503);

  let installationId = null;
  let cachedToken = null;
  let cachedTokenExpiresAt = 0;

  const appJwt = () => createGitHubAppJwt({ appId, privateKey, nowMs: now() });

  async function resolveInstallationId() {
    if (installationId) return installationId;
    const response = await fetchWithTimeout(
      fetchImpl,
      `${GITHUB_API}/repos/${OWNER}/${REPO}/installation`,
      { method: 'GET', headers: githubHeaders(appJwt()) },
    );
    if (!response.ok) throw makeError('GITHUB_APP_INSTALLATION_NOT_FOUND', 503);
    const payload = await readJsonSafe(response);
    if (!Number.isInteger(payload?.id) || payload.id <= 0) throw makeError('GITHUB_APP_INSTALLATION_NOT_FOUND', 503);
    installationId = payload.id;
    return installationId;
  }

  async function installationToken(force = false) {
    const nowMs = now();
    if (!force && cachedToken && cachedTokenExpiresAt - nowMs > 5 * 60 * 1000) return cachedToken;
    const id = await resolveInstallationId();
    const response = await fetchWithTimeout(
      fetchImpl,
      `${GITHUB_API}/app/installations/${id}/access_tokens`,
      {
        method: 'POST',
        headers: { ...githubHeaders(appJwt()), 'Content-Type': 'application/json' },
        body: JSON.stringify({ repositories: [REPO], permissions: { contents: 'write' } }),
      },
    );
    if (!response.ok) throw makeError('GITHUB_INSTALLATION_TOKEN_FAILED', 503);
    const payload = await readJsonSafe(response);
    if (typeof payload?.token !== 'string' || payload.token.length < 20) {
      throw makeError('GITHUB_INSTALLATION_TOKEN_FAILED', 503);
    }
    const expiresAt = Date.parse(payload.expires_at || '');
    cachedToken = payload.token;
    cachedTokenExpiresAt = Number.isFinite(expiresAt) ? expiresAt : nowMs + 55 * 60 * 1000;
    return cachedToken;
  }

  async function request(repoRequest) {
    const normalized = normalizeRepoRequest(repoRequest);
    const suffix = normalized.ref ? `?ref=${encodeURIComponent(normalized.ref)}` : '';
    const url = `${GITHUB_API}/repos/${OWNER}/${REPO}/contents/${encodeRepoPath(normalized.path)}${suffix}`;

    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await installationToken(attempt > 0);
      const options = {
        method: normalized.method,
        headers: githubHeaders(token),
      };
      if (normalized.body !== undefined) {
        options.headers['Content-Type'] = 'application/json';
        options.body = JSON.stringify(normalized.body);
      }
      const response = await fetchWithTimeout(fetchImpl, url, options);
      if (response.status === 401 && attempt === 0) {
        cachedToken = null;
        cachedTokenExpiresAt = 0;
        continue;
      }
      const payload = response.status === 204 ? null : await readJsonSafe(response);
      return { status: response.status, ok: response.ok, payload };
    }
    throw makeError('GITHUB_REQUEST_FAILED', 503);
  }

  return { request, installationToken, resolveInstallationId };
}

function createHandler({ fetchImpl = globalThis.fetch, env = process.env, now = () => Date.now() } = {}) {
  if (typeof fetchImpl !== 'function') throw makeError('FETCH_UNAVAILABLE', 503);
  let appClient = null;
  const secret = parseSessionSecret(env.MASTERSKAYA_SESSION_SECRET);
  const version = sessionVersion(env);

  function requireSecret() {
    if (!secret) throw makeError('SESSION_AUTH_NOT_CONFIGURED', 503);
    return secret;
  }

  function getAppClient() {
    if (!appClient) appClient = createGitHubAppClient({ fetchImpl, env, now });
    return appClient;
  }

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
    if (method !== 'POST') return reply(405, { ok: false, error: 'METHOD_NOT_ALLOWED' }, origin, { Allow: 'POST, OPTIONS' });

    let body;
    try {
      body = parseBody(event);
    } catch (error) {
      return reply(error.statusCode || 400, { ok: false, error: error.code || 'INVALID_JSON_BODY' }, origin);
    }

    const action = String(body?.action || '').trim();
    try {
      const claims = verifySessionToken({
        token: headers[SESSION_HEADER],
        secret: requireSecret(),
        nowMs: now(),
        version,
      });

      if (action === 'renew') {
        const session = createSessionToken({
          secret,
          clientId: claims.clientId,
          subject: claims.sub,
          nowMs: now(),
          version,
        });
        return reply(200, {
          ok: true,
          sessionToken: session.token,
          expiresAt: session.expiresAt,
          clientId: claims.clientId,
        }, origin);
      }

      if (action === 'github') {
        const result = await getAppClient().request(body);
        return reply(result.status, result.payload, origin);
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
  ALLOWED_ORIGIN,
  GITHUB_API_VERSION,
  OWNER,
  REPO,
  SESSION_TTL_SECONDS,
  createGitHubAppClient,
  createGitHubAppJwt,
  createHandler,
  createSessionToken,
  handler,
  normalizeClientId,
  normalizeRepoRequest,
  parsePrivateKey,
  parseSessionSecret,
  verifySessionToken,
};
