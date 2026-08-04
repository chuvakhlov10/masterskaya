'use strict';

const DATA_REPOSITORY_URL = 'https://api.github.com/repos/chuvakhlov10/masterskaya-data';
const ABLY_CHANNEL = 'masterskaya-sync';
const TOKEN_TTL_MS = 60 * 60 * 1000;
const GITHUB_TIMEOUT_MS = 8_000;
const MAX_BODY_BYTES = 2_048;

function reply(res, statusCode, payload, extraHeaders = {}) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  for (const [name, value] of Object.entries(extraHeaders)) res.setHeader(name, value);
  res.end(JSON.stringify(payload));
}

function extractBearer(headers = {}) {
  const value = headers.authorization || headers.Authorization || '';
  const match = /^Bearer\s+([^\s]+)$/i.exec(String(value));
  return match ? match[1] : '';
}

function normalizeClientId(value) {
  const clientId = String(value || '').trim();
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(clientId)) return null;
  return clientId;
}

async function readJsonBody(req) {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
    const text = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body);
    if (!text.trim()) return {};
    return JSON.parse(text);
  }

  if (!req || typeof req[Symbol.asyncIterator] !== 'function') return {};
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_BODY_BYTES) throw new Error('BODY_TOO_LARGE');
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text.trim() ? JSON.parse(text) : {};
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
        'User-Agent': 'masterskaya-ably-auth',
      },
      signal: controller.signal,
      cache: 'no-store',
    });

    if (response.status === 401 || response.status === 403 || response.status === 404) {
      return { ok: false, denied: true };
    }
    if (!response.ok) throw new Error(`GITHUB_HTTP_${response.status}`);

    const repository = await response.json();
    const permissions = repository && repository.permissions;
    return { ok: permissions?.push === true || permissions?.admin === true || permissions?.maintain === true };
  } finally {
    clearTimeout(timeout);
  }
}

function createHandler({ createAblyRest, fetchImpl = globalThis.fetch, env = process.env } = {}) {
  if (typeof createAblyRest !== 'function') throw new Error('createAblyRest is required');
  if (typeof fetchImpl !== 'function') throw new Error('fetch implementation is required');

  return async function ablyTokenHandler(req, res) {
    if (req.method !== 'POST') {
      return reply(res, 405, { ok: false, error: 'METHOD_NOT_ALLOWED' }, { Allow: 'POST' });
    }

    const githubToken = extractBearer(req.headers);
    if (!githubToken) return reply(res, 401, { ok: false, error: 'GITHUB_TOKEN_REQUIRED' });

    let access;
    try {
      access = await verifyGitHubPushAccess(githubToken, fetchImpl);
    } catch (error) {
      return reply(res, 503, { ok: false, error: 'GITHUB_ACCESS_CHECK_FAILED' });
    }
    if (!access.ok) return reply(res, 403, { ok: false, error: 'GITHUB_ACCESS_DENIED' });

    const apiKey = String(env.ABLY_API_KEY || '').trim();
    if (!apiKey) return reply(res, 503, { ok: false, error: 'ABLY_AUTH_NOT_CONFIGURED' });

    let body;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      return reply(res, 400, { ok: false, error: 'INVALID_JSON_BODY' });
    }

    const clientId = normalizeClientId(body?.clientId);
    if (!clientId) return reply(res, 400, { ok: false, error: 'CLIENT_ID_INVALID' });

    try {
      const ably = createAblyRest(apiKey);
      const tokenDetails = await ably.auth.requestToken({
        clientId,
        ttl: TOKEN_TTL_MS,
        capability: JSON.stringify({
          [ABLY_CHANNEL]: ['publish', 'subscribe'],
        }),
      });
      return reply(res, 200, tokenDetails);
    } catch (error) {
      return reply(res, 502, { ok: false, error: 'ABLY_TOKEN_REQUEST_FAILED' });
    }
  };
}

module.exports = {
  ABLY_CHANNEL,
  TOKEN_TTL_MS,
  createHandler,
  extractBearer,
  normalizeClientId,
  readJsonBody,
  verifyGitHubPushAccess,
};
