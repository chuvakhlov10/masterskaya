import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  ALLOWED_ORIGIN,
  GITHUB_API_VERSION,
  REPO,
  SESSION_TTL_SECONDS,
  createGitHubAppClient,
  createGitHubAppJwt,
  createHandler,
  createSessionToken,
  normalizeRepoRequest,
  verifySessionToken,
} = require('../yandex-storage-function/index.js');

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const PRIVATE_KEY_B64 = Buffer.from(privateKey.export({ type: 'pkcs8', format: 'pem' })).toString('base64');
const SESSION_SECRET = crypto.randomBytes(32).toString('base64');
const NOW = Date.parse('2026-08-04T20:00:00Z');
const ENV = {
  GITHUB_APP_ID: '4488480',
  GITHUB_APP_PRIVATE_KEY_B64: PRIVATE_KEY_B64,
  MASTERSKAYA_SESSION_SECRET: SESSION_SECRET,
  MASTERSKAYA_SESSION_VERSION: '1',
};

function jsonResponse(value, status = 200) {
  return new Response(value === null ? null : JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function event(body, headers = {}) {
  return {
    httpMethod: 'POST',
    headers: { origin: ALLOWED_ORIGIN, 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    isBase64Encoded: false,
  };
}

function decodeJwt(token) {
  const [head, claims] = token.split('.');
  return {
    head: JSON.parse(Buffer.from(head, 'base64url').toString('utf8')),
    claims: JSON.parse(Buffer.from(claims, 'base64url').toString('utf8')),
    unsigned: `${head}.${claims}`,
    signature: token.split('.')[2],
  };
}

test('storage gateway CORS preflight is limited to the GitHub Pages origin', async () => {
  const handler = createHandler({ env: ENV, fetchImpl: async () => assert.fail('network not expected') });
  const ok = await handler({ httpMethod: 'OPTIONS', headers: { origin: ALLOWED_ORIGIN }, body: '' });
  assert.equal(ok.statusCode, 204);
  assert.match(ok.headers['Access-Control-Allow-Headers'], /X-Masterskaya-Session/);
  assert.doesNotMatch(ok.headers['Access-Control-Allow-Headers'], /GitHub/i);
  const denied = await handler({ httpMethod: 'OPTIONS', headers: { origin: 'https://evil.example' }, body: '' });
  assert.equal(denied.statusCode, 403);
});

test('session renewal preserves the device identity and rotates the token', async () => {
  const original = createSessionToken({ secret: SESSION_SECRET, clientId: 'device-client-123', subject: 'github:123', nowMs: NOW, version: 1 });
  const handler = createHandler({ env: ENV, now: () => NOW + 1000, fetchImpl: async () => assert.fail('network not expected') });
  const response = await handler(event(
    { action: 'renew' },
    { 'x-masterskaya-session': original.token },
  ));
  assert.equal(response.statusCode, 200);
  const payload = JSON.parse(response.body);
  assert.notEqual(payload.sessionToken, original.token);
  const claims = verifySessionToken({ token: payload.sessionToken, secret: SESSION_SECRET, nowMs: NOW + 1000, version: 1 });
  assert.equal(claims.clientId, 'device-client-123');
  assert.equal(claims.sub, 'github:123');
});

test('expired or wrong-version sessions are rejected', () => {
  const expired = createSessionToken({ secret: SESSION_SECRET, clientId: 'device-client-123', nowMs: NOW - (SESSION_TTL_SECONDS + 1) * 1000, version: 1 });
  assert.throws(
    () => verifySessionToken({ token: expired.token, secret: SESSION_SECRET, nowMs: NOW, version: 1 }),
    error => error.code === 'SESSION_EXPIRED',
  );
  const current = createSessionToken({ secret: SESSION_SECRET, clientId: 'device-client-123', nowMs: NOW, version: 1 });
  assert.throws(
    () => verifySessionToken({ token: current.token, secret: SESSION_SECRET, nowMs: NOW, version: 2 }),
    error => error.code === 'SESSION_INVALID',
  );
});

test('GitHub App JWT is RS256 signed and valid for less than ten minutes', () => {
  const token = createGitHubAppJwt({ appId: '4488480', privateKey, nowMs: NOW });
  const decoded = decodeJwt(token);
  assert.deepEqual(decoded.head, { typ: 'JWT', alg: 'RS256' });
  assert.equal(decoded.claims.iss, '4488480');
  assert.equal(decoded.claims.iat, Math.floor(NOW / 1000) - 60);
  assert.equal(decoded.claims.exp, Math.floor(NOW / 1000) + 540);
  assert.equal(
    crypto.verify('RSA-SHA256', Buffer.from(decoded.unsigned), publicKey, Buffer.from(decoded.signature, 'base64url')),
    true,
  );
});

test('installation token is repository-scoped, contents-only, and cached', async () => {
  const calls = [];
  const client = createGitHubAppClient({
    env: ENV,
    now: () => NOW,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith(`/repos/chuvakhlov10/${REPO}/installation`)) return jsonResponse({ id: 7654321 });
      if (url.endsWith('/app/installations/7654321/access_tokens')) {
        return jsonResponse({ token: 'ghs_new_stateless_format_token_123456789', expires_at: '2026-08-04T21:00:00Z' });
      }
      assert.fail(`unexpected ${url}`);
    },
  });
  const first = await client.installationToken();
  const second = await client.installationToken();
  assert.equal(first, second);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.headers['X-GitHub-Api-Version'], GITHUB_API_VERSION);
  const body = JSON.parse(calls[1].options.body);
  assert.deepEqual(body, { repositories: [REPO], permissions: { contents: 'write' } });
});

test('gateway forwards an allowed data GET with an installation token', async () => {
  const session = createSessionToken({ secret: SESSION_SECRET, clientId: 'device-client-123', nowMs: NOW, version: 1 });
  const calls = [];
  const handler = createHandler({
    env: ENV,
    now: () => NOW,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith(`/repos/chuvakhlov10/${REPO}/installation`)) return jsonResponse({ id: 1 });
      if (url.endsWith('/app/installations/1/access_tokens')) return jsonResponse({ token: 'ghs_installation_token_abcdefghijklmnopqrstuvwxyz', expires_at: '2026-08-04T21:00:00Z' });
      if (url.endsWith(`/repos/chuvakhlov10/${REPO}/contents/data/records.json`)) return jsonResponse({ sha: 'a'.repeat(40), content: 'W10=' });
      assert.fail(`unexpected ${url}`);
    },
  });
  const response = await handler(event(
    { action: 'github', method: 'GET', path: 'data/records.json' },
    { 'x-masterskaya-session': session.token },
  ));
  assert.equal(response.statusCode, 200);
  assert.equal(JSON.parse(response.body).sha, 'a'.repeat(40));
  assert.match(calls.at(-1).options.headers.Authorization, /^Bearer ghs_/);
});

test('gateway forwards a validated PUT without widening repository access', async () => {
  const session = createSessionToken({ secret: SESSION_SECRET, clientId: 'device-client-123', nowMs: NOW, version: 1 });
  let putCall;
  const handler = createHandler({
    env: ENV,
    now: () => NOW,
    fetchImpl: async (url, options) => {
      if (url.endsWith('/installation')) return jsonResponse({ id: 1 });
      if (url.includes('/access_tokens')) return jsonResponse({ token: 'ghs_installation_token_abcdefghijklmnopqrstuvwxyz', expires_at: '2026-08-04T21:00:00Z' });
      putCall = { url, options };
      return jsonResponse({ content: { sha: 'b'.repeat(40) } }, 200);
    },
  });
  const response = await handler(event(
    {
      action: 'github',
      method: 'PUT',
      path: 'data/records.json',
      body: { message: 'update records', content: 'W10=', sha: 'a'.repeat(40) },
    },
    { 'x-masterskaya-session': session.token },
  ));
  assert.equal(response.statusCode, 200);
  assert.equal(putCall.options.method, 'PUT');
  assert.deepEqual(JSON.parse(putCall.options.body), { message: 'update records', content: 'W10=', sha: 'a'.repeat(40) });
});

test('path policy allows backup status only as read-only data-backups access', () => {
  assert.deepEqual(
    normalizeRepoRequest({ method: 'GET', path: 'status.json', ref: 'data-backups' }),
    { method: 'GET', path: 'status.json', ref: 'data-backups', kind: 'backup-status', body: undefined },
  );
  assert.throws(() => normalizeRepoRequest({ method: 'PUT', path: 'status.json', ref: 'data-backups', body: {} }), /PATH_DENIED/);
  assert.throws(() => normalizeRepoRequest({ method: 'GET', path: '.github/workflows/evil.yml' }), /PATH_DENIED/);
  assert.throws(() => normalizeRepoRequest({ method: 'GET', path: 'data/../secret.json' }), /PATH_DENIED/);
});

test('checkpoint and monthly archives are read-only through the device gateway', () => {
  assert.equal(
    normalizeRepoRequest({ method: 'GET', path: 'data/stock-checkpoint.json' }).kind,
    'stock-checkpoint',
  );
  assert.equal(
    normalizeRepoRequest({ method: 'GET', path: 'archives/stock-ops/2026-07.json' }).kind,
    'stock-archive',
  );
  assert.throws(
    () => normalizeRepoRequest({ method: 'PUT', path: 'data/stock-checkpoint.json', body: { message: 'x', content: 'W10=' } }),
    /PATH_DENIED/,
  );
  assert.throws(
    () => normalizeRepoRequest({ method: 'PUT', path: 'archives/stock-ops/2026-07.json', body: { message: 'x', content: 'W10=' } }),
    /PATH_DENIED/,
  );
});

test('missing server secrets fail closed without exposing configuration', async () => {
  const handler = createHandler({ env: {}, fetchImpl: async () => assert.fail('network not expected') });
  const response = await handler(event({ action: 'renew' }));
  assert.equal(response.statusCode, 503);
  assert.deepEqual(JSON.parse(response.body), { ok: false, error: 'SESSION_AUTH_NOT_CONFIGURED' });
});
