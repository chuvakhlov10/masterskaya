import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  ALLOWED_ORIGIN,
  createHandler,
  verifyStorageSession,
} = require('../yandex-function/index.js');

const SESSION_SECRET = crypto.randomBytes(32).toString('base64');
const NOW = Date.parse('2026-08-04T21:00:00Z');
const GOOD_KEY = 'app123.key456:abcdefghijklmnopqrstuvwxyz012345';

function base64UrlJson(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function createStorageSession({ version = 2, expiresAt = Math.floor(NOW / 1000) + 3600 } = {}) {
  const header = base64UrlJson({ typ: 'JWT', alg: 'HS256' });
  const claims = base64UrlJson({
    iss: 'masterskaya-storage-gateway',
    aud: 'masterskaya-web',
    sub: 'github:123',
    iat: Math.floor(NOW / 1000),
    exp: expiresAt,
    clientId: 'web-device-1234',
    scope: 'storage',
    sv: version,
    jti: 'session-test',
  });
  const unsigned = `${header}.${claims}`;
  const signature = crypto
    .createHmac('sha256', Buffer.from(SESSION_SECRET, 'base64'))
    .update(unsigned, 'utf8')
    .digest('base64url');
  return `${unsigned}.${signature}`;
}

function makeEvent(sessionToken) {
  return {
    httpMethod: 'POST',
    headers: {
      origin: ALLOWED_ORIGIN,
      'content-type': 'application/json',
      'x-masterskaya-session': sessionToken,
    },
    body: JSON.stringify({ clientId: 'ably-client-1234' }),
    isBase64Encoded: false,
  };
}

function makeHandler(env = {}) {
  let githubCalls = 0;
  const handler = createHandler({
    env: {
      ABLY_API_KEY: GOOD_KEY,
      MASTERSKAYA_SESSION_SECRET: SESSION_SECRET,
      MASTERSKAYA_SESSION_VERSION: '2',
      ...env,
    },
    now: () => NOW,
    fetchImpl: async () => {
      githubCalls += 1;
      throw new Error('GitHub must not be called for a valid storage session');
    },
  });
  return { handler, githubCalls: () => githubCalls };
}

test('valid storage session issues an Ably JWT without calling GitHub', async () => {
  const { handler, githubCalls } = makeHandler();
  const response = await handler(makeEvent(createStorageSession()));
  const payload = JSON.parse(response.body);

  assert.equal(response.statusCode, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.clientId, 'ably-client-1234');
  assert.equal(typeof payload.token, 'string');
  assert.equal(githubCalls(), 0);
});

test('wrong session version is rejected without legacy downgrade', async () => {
  const { handler, githubCalls } = makeHandler();
  const response = await handler(makeEvent(createStorageSession({ version: 1 })));

  assert.equal(response.statusCode, 401);
  assert.equal(JSON.parse(response.body).error, 'SESSION_INVALID');
  assert.equal(githubCalls(), 0);
});

test('missing shared secret fails closed', async () => {
  const { handler, githubCalls } = makeHandler({ MASTERSKAYA_SESSION_SECRET: '' });
  const response = await handler(makeEvent(createStorageSession()));

  assert.equal(response.statusCode, 503);
  assert.equal(JSON.parse(response.body).error, 'SESSION_AUTH_NOT_CONFIGURED');
  assert.equal(githubCalls(), 0);
});

test('expired storage session is rejected', () => {
  assert.throws(
    () => verifyStorageSession({
      token: createStorageSession({ expiresAt: Math.floor(NOW / 1000) - 1 }),
      secret: SESSION_SECRET,
      nowMs: NOW,
      version: 2,
    }),
    error => error.code === 'SESSION_EXPIRED',
  );
});

test('CORS preflight advertises the storage session header', async () => {
  const { handler } = makeHandler();
  const response = await handler({
    httpMethod: 'OPTIONS',
    headers: { origin: ALLOWED_ORIGIN },
    body: '',
  });

  assert.equal(response.statusCode, 204);
  assert.match(response.headers['Access-Control-Allow-Headers'], /X-Masterskaya-Session/);
});
