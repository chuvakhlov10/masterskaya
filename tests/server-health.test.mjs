import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const storageBase = require('../yandex-storage-function/index.js');
const storageHealth = require('../yandex-storage-function/device-index.js');
const ablyBase = require('../yandex-function/index.js');
const ablyHealth = require('../yandex-function/device-aware-index.js');

const SECRET = crypto.randomBytes(32).toString('base64');
const NOW = Date.parse('2026-08-05T10:00:00Z');
const DEVICE_ID = 'device-health-123';

function storageEvent(body, token = '') {
  return {
    httpMethod: 'POST',
    headers: {
      origin: storageBase.ALLOWED_ORIGIN,
      ...(token ? { 'x-masterskaya-session': token } : {}),
    },
    body: JSON.stringify(body),
  };
}

function sessionToken() {
  return storageBase.createSessionToken({
    secret: SECRET,
    clientId: DEVICE_ID,
    subject: `device:${DEVICE_ID}`,
    nowMs: NOW,
    version: 2,
  }).token;
}

const storageEnv = {
  GITHUB_APP_ID: '4488480',
  GITHUB_APP_PRIVATE_KEY_B64: 'configured-for-test',
  MASTERSKAYA_SESSION_SECRET: SECRET,
  MASTERSKAYA_SESSION_VERSION: '2',
};

test('storage health exposes safe version metadata without requiring a session', async () => {
  const handler = storageHealth.createHandler({
    env: storageEnv,
    now: () => NOW,
    appClient: { requestInternal: async () => { throw new Error('not expected'); } },
    deviceAuthService: { authorize: async () => { throw new Error('not expected'); } },
    fetchImpl: async () => { throw new Error('network not expected'); },
  });
  const response = await handler(storageEvent({ action: 'health' }));
  const payload = JSON.parse(response.body);
  assert.equal(response.statusCode, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.service, 'masterskaya-storage-gateway');
  assert.equal(payload.version, '1.4.1');
  assert.equal(payload.protocolVersion, 3);
  assert.equal(payload.checks.runtime, 'ok');
  assert.equal(payload.checks.deviceRegistry, 'not_checked');
  assert.equal(payload.authenticated, undefined);
  assert.equal(JSON.stringify(payload).includes(SECRET), false);
});

test('authenticated storage health verifies registry and GitHub App access', async () => {
  let authorized = 0;
  let installationTokens = 0;
  const handler = storageHealth.createHandler({
    env: storageEnv,
    now: () => NOW,
    appClient: {
      requestInternal: async () => { throw new Error('not expected'); },
      installationToken: async () => { installationTokens++; return 'installation-token'; },
    },
    deviceAuthService: {
      authorize: async claims => {
        authorized++;
        return { id: claims.clientId, name: 'Ноутбук' };
      },
    },
    fetchImpl: async () => { throw new Error('network not expected'); },
  });
  const response = await handler(storageEvent({ action: 'health' }, sessionToken()));
  const payload = JSON.parse(response.body);
  assert.equal(response.statusCode, 200);
  assert.equal(payload.authenticated, true);
  assert.equal(payload.device.id, DEVICE_ID);
  assert.equal(payload.checks.deviceRegistry, 'ok');
  assert.equal(payload.checks.githubApp, 'ok');
  assert.equal(authorized, 1);
  assert.equal(installationTokens, 1);
});

function ablyEvent(body, token = '') {
  return {
    httpMethod: 'POST',
    headers: {
      origin: ablyBase.ALLOWED_ORIGIN,
      ...(token ? { 'x-masterskaya-session': token } : {}),
    },
    body: JSON.stringify(body),
  };
}

const ablyEnv = {
  ABLY_API_KEY: 'app123.key456:abcdefghijklmnopqrstuvwxyz012345',
  MASTERSKAYA_SESSION_SECRET: SECRET,
  MASTERSKAYA_SESSION_VERSION: '2',
};

test('authenticated Ably health verifies the storage gateway and device registry', async () => {
  let checks = 0;
  const token = sessionToken();
  const handler = ablyHealth.createHandler({
    env: ablyEnv,
    now: () => NOW,
    fetchImpl: async (_url, options) => {
      checks++;
      assert.deepEqual(JSON.parse(options.body), { action: 'session-check' });
      assert.equal(options.headers['X-Masterskaya-Session'], token);
      return new Response(JSON.stringify({
        ok: true,
        device: { id: DEVICE_ID, name: 'Ноутбук', lastSeenAt: NOW },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  const response = await handler(ablyEvent({ action: 'health' }, token));
  const payload = JSON.parse(response.body);
  assert.equal(response.statusCode, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.service, 'masterskaya-ably-auth');
  assert.equal(payload.version, '1.4.1');
  assert.equal(payload.protocolVersion, 3);
  assert.equal(payload.checks.storageGateway, 'ok');
  assert.equal(payload.checks.deviceRegistry, 'ok');
  assert.equal(checks, 1);
});

test('Ably health fails closed when storage registry validation fails', async () => {
  const handler = ablyHealth.createHandler({
    env: ablyEnv,
    now: () => NOW,
    fetchImpl: async () => new Response(JSON.stringify({ ok: false, error: 'DEVICE_REVOKED' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    }),
  });
  const response = await handler(ablyEvent({ action: 'health' }, sessionToken()));
  const payload = JSON.parse(response.body);
  assert.equal(response.statusCode, 401);
  assert.equal(payload.ok, false);
  assert.equal(payload.error, 'DEVICE_REVOKED');
  assert.equal(payload.checks.storageGateway, 'error');
});
