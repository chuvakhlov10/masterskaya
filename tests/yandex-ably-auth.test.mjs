import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  ALLOWED_ORIGIN,
  ABLY_CHANNEL,
  TOKEN_TTL_SECONDS,
  createHandler,
  normalizeClientId,
  parseAblyKey,
} = require('../yandex-function/index.js');

const GOOD_KEY = 'app123.key456:abcdefghijklmnopqrstuvwxyz012345';
const GOOD_GITHUB_TOKEN = 'github_pat_abcdefghijklmnopqrstuvwxyz012345';
const CLIENT_ID = 'client-12345678';

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function makeEvent(overrides = {}) {
  return {
    httpMethod: 'POST',
    headers: {
      origin: ALLOWED_ORIGIN,
      'x-masterskaya-github-token': GOOD_GITHUB_TOKEN,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ clientId: CLIENT_ID }),
    isBase64Encoded: false,
    ...overrides,
  };
}

function makeHandler({ permissions = { push: true }, env = { ABLY_API_KEY: GOOD_KEY }, fetchImpl, now = () => 1_800_000_000_000 } = {}) {
  const calls = [];
  const handler = createHandler({
    env,
    now,
    fetchImpl: fetchImpl || (async (_url, options) => {
      calls.push(options);
      return jsonResponse({ permissions });
    }),
  });
  return { handler, calls };
}

function decodePart(value) {
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
}

test('CORS preflight is allowed only for the GitHub Pages origin', async () => {
  const { handler, calls } = makeHandler();
  const response = await handler(makeEvent({
    httpMethod: 'OPTIONS',
    headers: { origin: ALLOWED_ORIGIN },
    body: '',
  }));

  assert.equal(response.statusCode, 204);
  assert.equal(response.headers['Access-Control-Allow-Origin'], ALLOWED_ORIGIN);
  assert.equal(response.headers['Access-Control-Allow-Methods'], 'POST, OPTIONS');
  assert.match(response.headers['Access-Control-Allow-Headers'], /X-Masterskaya-GitHub-Token/);
  assert.equal(calls.length, 0);

  const denied = await handler(makeEvent({
    httpMethod: 'OPTIONS',
    headers: { origin: 'https://evil.example' },
    body: '',
  }));
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.headers['Access-Control-Allow-Origin'], undefined);
});

test('requests from another origin are rejected before GitHub is called', async () => {
  const { handler, calls } = makeHandler();
  const response = await handler(makeEvent({
    headers: {
      origin: 'https://evil.example',
      'x-masterskaya-github-token': GOOD_GITHUB_TOKEN,
    },
  }));
  assert.equal(response.statusCode, 403);
  assert.equal(JSON.parse(response.body).error, 'ORIGIN_DENIED');
  assert.equal(calls.length, 0);
});

test('only POST is accepted after origin validation', async () => {
  const { handler } = makeHandler();
  const response = await handler(makeEvent({ httpMethod: 'GET' }));
  assert.equal(response.statusCode, 405);
  assert.equal(response.headers.Allow, 'POST, OPTIONS');
});

test('custom GitHub token header is required because Yandex strips Authorization', async () => {
  const { handler, calls } = makeHandler();
  const response = await handler(makeEvent({
    headers: { origin: ALLOWED_ORIGIN, authorization: `Bearer ${GOOD_GITHUB_TOKEN}` },
  }));
  assert.equal(response.statusCode, 401);
  assert.equal(JSON.parse(response.body).error, 'GITHUB_TOKEN_REQUIRED');
  assert.equal(calls.length, 0);
});

test('read-only GitHub access cannot receive an Ably JWT', async () => {
  const { handler } = makeHandler({ permissions: { pull: true, push: false } });
  const response = await handler(makeEvent());
  assert.equal(response.statusCode, 403);
  assert.equal(JSON.parse(response.body).error, 'GITHUB_ACCESS_DENIED');
});

test('invalid client IDs and malformed bodies fail closed', async () => {
  assert.equal(normalizeClientId(CLIENT_ID), CLIENT_ID);
  assert.equal(normalizeClientId('../bad'), null);

  const { handler } = makeHandler();
  const invalidClient = await handler(makeEvent({ body: JSON.stringify({ clientId: '../bad' }) }));
  assert.equal(invalidClient.statusCode, 400);
  assert.equal(JSON.parse(invalidClient.body).error, 'CLIENT_ID_INVALID');

  const invalidJson = await handler(makeEvent({ body: '{' }));
  assert.equal(invalidJson.statusCode, 400);
  assert.equal(JSON.parse(invalidJson.body).error, 'INVALID_JSON_BODY');
});

test('missing or malformed Ably server key never leaks configuration', async () => {
  assert.deepEqual(parseAblyKey(GOOD_KEY), {
    keyName: 'app123.key456',
    secret: 'abcdefghijklmnopqrstuvwxyz012345',
  });
  assert.equal(parseAblyKey('bad-key'), null);

  for (const env of [{}, { ABLY_API_KEY: 'bad-key' }]) {
    const { handler } = makeHandler({ env });
    const response = await handler(makeEvent());
    assert.equal(response.statusCode, 503);
    assert.deepEqual(JSON.parse(response.body), { ok: false, error: 'ABLY_AUTH_NOT_CONFIGURED' });
    assert.equal(response.body.includes('bad-key'), false);
  }
});

test('valid writer receives a signed one-hour JWT limited to the sync channel', async () => {
  const nowMs = 1_800_000_000_000;
  const { handler, calls } = makeHandler({ now: () => nowMs });
  const response = await handler(makeEvent());
  const payload = JSON.parse(response.body);

  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['Access-Control-Allow-Origin'], ALLOWED_ORIGIN);
  assert.equal(response.headers['Cache-Control'], 'no-store, max-age=0');
  assert.equal(payload.ok, true);
  assert.equal(payload.clientId, CLIENT_ID);

  const [encodedHeader, encodedClaims, signature] = payload.token.split('.');
  const header = decodePart(encodedHeader);
  const claims = decodePart(encodedClaims);

  assert.deepEqual(header, { typ: 'JWT', alg: 'HS256', kid: 'app123.key456' });
  assert.equal(claims.iat, Math.floor(nowMs / 1000));
  assert.equal(claims.exp - claims.iat, TOKEN_TTL_SECONDS);
  assert.equal(claims['x-ably-clientId'], CLIENT_ID);
  assert.deepEqual(JSON.parse(claims['x-ably-capability']), {
    [ABLY_CHANNEL]: ['publish', 'subscribe'],
  });

  const expectedSignature = crypto
    .createHmac('sha256', 'abcdefghijklmnopqrstuvwxyz012345')
    .update(`${encodedHeader}.${encodedClaims}`, 'utf8')
    .digest('base64url');
  assert.equal(signature, expectedSignature);
  assert.equal(payload.expiresAt, claims.exp * 1000);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers.Authorization, `Bearer ${GOOD_GITHUB_TOKEN}`);
});

test('base64-encoded Yandex request bodies are supported', async () => {
  const { handler } = makeHandler();
  const body = Buffer.from(JSON.stringify({ clientId: CLIENT_ID }), 'utf8').toString('base64');
  const response = await handler(makeEvent({ body, isBase64Encoded: true }));
  assert.equal(response.statusCode, 200);
});

test('GitHub availability errors return 503 without issuing a JWT', async () => {
  const { handler } = makeHandler({
    fetchImpl: async () => { throw new Error('network down'); },
  });
  const response = await handler(makeEvent());
  assert.equal(response.statusCode, 503);
  assert.equal(JSON.parse(response.body).error, 'GITHUB_ACCESS_CHECK_FAILED');
});
