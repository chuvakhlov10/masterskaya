import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  ABLY_CHANNEL,
  TOKEN_TTL_MS,
  createHandler,
  normalizeClientId,
} = require('../api/ably-token-core.cjs');

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function makeResponse() {
  const headers = new Map();
  return {
    statusCode: 0,
    body: '',
    setHeader(name, value) { headers.set(String(name).toLowerCase(), String(value)); },
    getHeader(name) { return headers.get(String(name).toLowerCase()); },
    end(value = '') { this.body = String(value); },
    json() { return JSON.parse(this.body); },
  };
}

function makeRequest(overrides = {}) {
  return {
    method: 'POST',
    headers: { authorization: 'Bearer github-token' },
    body: { clientId: 'client-12345678' },
    ...overrides,
  };
}

function makeHandler({ permissions = { push: true }, env = { ABLY_API_KEY: 'server-only-key' }, requestToken } = {}) {
  const calls = [];
  const handler = createHandler({
    env,
    fetchImpl: async (_url, options) => {
      calls.push({ type: 'github', options });
      return jsonResponse({ permissions });
    },
    createAblyRest: (key) => {
      calls.push({ type: 'ably-client', key });
      return {
        auth: {
          requestToken: async (params) => {
            calls.push({ type: 'token', params });
            if (requestToken) return requestToken(params);
            return { token: 'short-lived-token', expires: Date.now() + TOKEN_TTL_MS, clientId: params.clientId };
          },
        },
      };
    },
  });
  return { handler, calls };
}

test('endpoint accepts only POST', async () => {
  const { handler } = makeHandler();
  const res = makeResponse();
  await handler(makeRequest({ method: 'GET' }), res);
  assert.equal(res.statusCode, 405);
  assert.equal(res.getHeader('allow'), 'POST');
  assert.equal(res.json().error, 'METHOD_NOT_ALLOWED');
});

test('endpoint requires a GitHub bearer token', async () => {
  const { handler, calls } = makeHandler();
  const res = makeResponse();
  await handler(makeRequest({ headers: {} }), res);
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().error, 'GITHUB_TOKEN_REQUIRED');
  assert.equal(calls.length, 0);
});

test('read-only GitHub access cannot receive an Ably token', async () => {
  const { handler, calls } = makeHandler({ permissions: { pull: true, push: false } });
  const res = makeResponse();
  await handler(makeRequest(), res);
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error, 'GITHUB_ACCESS_DENIED');
  assert.equal(calls.some(call => call.type === 'token'), false);
});

test('missing server secret fails closed without exposing configuration', async () => {
  const { handler, calls } = makeHandler({ env: {} });
  const res = makeResponse();
  await handler(makeRequest(), res);
  assert.equal(res.statusCode, 503);
  assert.deepEqual(res.json(), { ok: false, error: 'ABLY_AUTH_NOT_CONFIGURED' });
  assert.equal(calls.some(call => call.type === 'ably-client'), false);
});

test('valid user receives a one-hour token limited to the sync channel', async () => {
  const { handler, calls } = makeHandler();
  const res = makeResponse();
  await handler(makeRequest(), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.getHeader('cache-control'), 'no-store, max-age=0');
  assert.equal(res.json().token, 'short-lived-token');

  const tokenCall = calls.find(call => call.type === 'token');
  assert.ok(tokenCall);
  assert.equal(tokenCall.params.clientId, 'client-12345678');
  assert.equal(tokenCall.params.ttl, TOKEN_TTL_MS);
  assert.deepEqual(JSON.parse(tokenCall.params.capability), {
    [ABLY_CHANNEL]: ['publish', 'subscribe'],
  });
});

test('client id validation rejects unsafe or missing values', async () => {
  assert.equal(normalizeClientId('client-12345678'), 'client-12345678');
  assert.equal(normalizeClientId('../bad'), null);
  assert.equal(normalizeClientId('tiny'), null);

  const { handler, calls } = makeHandler();
  const res = makeResponse();
  await handler(makeRequest({ body: { clientId: '../bad' } }), res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'CLIENT_ID_INVALID');
  assert.equal(calls.some(call => call.type === 'token'), false);
});
