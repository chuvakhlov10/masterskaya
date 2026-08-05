import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const storageAuth = require('../yandex-storage-function/index.js');
const {
  ALLOWED_ORIGIN,
  ABLY_CHANNEL,
  TOKEN_TTL_SECONDS,
  createHandler,
  normalizeClientId,
  parseAblyKey,
} = require('../yandex-function/index.js');

const GOOD_KEY = 'app123.key456:abcdefghijklmnopqrstuvwxyz012345';
const CLIENT_ID = 'client-12345678';
const SESSION_SECRET = crypto.randomBytes(32).toString('base64');
const NOW = 1_800_000_000_000;
const ENV = {
  ABLY_API_KEY: GOOD_KEY,
  MASTERSKAYA_SESSION_SECRET: SESSION_SECRET,
  MASTERSKAYA_SESSION_VERSION: '1',
};

function sessionToken(nowMs = NOW) {
  return storageAuth.createSessionToken({
    secret: SESSION_SECRET,
    clientId: CLIENT_ID,
    subject: `device:${CLIENT_ID}`,
    nowMs,
    version: 1,
  }).token;
}

function makeEvent(overrides = {}) {
  return {
    httpMethod: 'POST',
    headers: {
      origin: ALLOWED_ORIGIN,
      'x-masterskaya-session': sessionToken(),
      'content-type': 'application/json',
    },
    body: JSON.stringify({ clientId: CLIENT_ID }),
    isBase64Encoded: false,
    ...overrides,
  };
}

function decodePart(value) {
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
}

test('CORS preflight allows only the session header from the application origin', async () => {
  const handler = createHandler({ env: ENV, now: () => NOW, fetchImpl: async () => assert.fail('network not expected') });
  const response = await handler(makeEvent({ httpMethod: 'OPTIONS', headers: { origin: ALLOWED_ORIGIN }, body: '' }));
  assert.equal(response.statusCode, 204);
  assert.equal(response.headers['Access-Control-Allow-Origin'], ALLOWED_ORIGIN);
  assert.match(response.headers['Access-Control-Allow-Headers'], /X-Masterskaya-Session/);
  assert.doesNotMatch(response.headers['Access-Control-Allow-Headers'], /GitHub/i);
});

test('missing or invalid device session is rejected', async () => {
  const handler = createHandler({ env: ENV, now: () => NOW, fetchImpl: async () => assert.fail('network not expected') });
  const missing = await handler(makeEvent({ headers: { origin: ALLOWED_ORIGIN } }));
  assert.equal(missing.statusCode, 401);
  assert.equal(JSON.parse(missing.body).error, 'SESSION_REQUIRED');
  const invalid = await handler(makeEvent({ headers: { origin: ALLOWED_ORIGIN, 'x-masterskaya-session': 'bad.token.value' } }));
  assert.equal(invalid.statusCode, 401);
  assert.equal(JSON.parse(invalid.body).error, 'SESSION_INVALID');
});

test('valid device session receives a signed one-hour JWT limited to the sync channel', async () => {
  const handler = createHandler({ env: ENV, now: () => NOW, fetchImpl: async () => assert.fail('network not expected') });
  const response = await handler(makeEvent());
  const payload = JSON.parse(response.body);
  assert.equal(response.statusCode, 200);
  assert.equal(payload.clientId, CLIENT_ID);
  const [encodedHeader, encodedClaims, signature] = payload.token.split('.');
  const header = decodePart(encodedHeader);
  const claims = decodePart(encodedClaims);
  assert.deepEqual(header, { typ: 'JWT', alg: 'HS256', kid: 'app123.key456' });
  assert.equal(claims.exp - claims.iat, TOKEN_TTL_SECONDS);
  assert.equal(claims['x-ably-clientId'], CLIENT_ID);
  assert.deepEqual(JSON.parse(claims['x-ably-capability']), { [ABLY_CHANNEL]: ['publish', 'subscribe'] });
  const expected = crypto.createHmac('sha256', 'abcdefghijklmnopqrstuvwxyz012345')
    .update(`${encodedHeader}.${encodedClaims}`, 'utf8').digest('base64url');
  assert.equal(signature, expected);
});

test('invalid client IDs and missing Ably configuration fail closed', async () => {
  assert.equal(normalizeClientId(CLIENT_ID), CLIENT_ID);
  assert.equal(normalizeClientId('../bad'), null);
  assert.deepEqual(parseAblyKey(GOOD_KEY), { keyName: 'app123.key456', secret: 'abcdefghijklmnopqrstuvwxyz012345' });
  const invalidClientHandler = createHandler({ env: ENV, now: () => NOW, fetchImpl: async () => assert.fail('network not expected') });
  const invalidClient = await invalidClientHandler(makeEvent({ body: JSON.stringify({ clientId: '../bad' }) }));
  assert.equal(invalidClient.statusCode, 400);
  const missingKeyHandler = createHandler({
    env: { MASTERSKAYA_SESSION_SECRET: SESSION_SECRET, MASTERSKAYA_SESSION_VERSION: '1' },
    now: () => NOW,
    fetchImpl: async () => assert.fail('network not expected'),
  });
  const missingKey = await missingKeyHandler(makeEvent());
  assert.equal(missingKey.statusCode, 503);
  assert.equal(JSON.parse(missingKey.body).error, 'ABLY_AUTH_NOT_CONFIGURED');
});
