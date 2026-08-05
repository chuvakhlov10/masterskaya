import test from 'node:test';
import assert from 'node:assert/strict';

import {
  checkServerHealth,
  healthErrorText,
} from '../src/server-health.js';

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: key => values.get(key) || null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
  };
}

const SESSION_TOKEN = 'header.payload.signature';
const SESSION_KEY = 'masterskaya_storage_session_v1';

function response(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('health client checks storage and Ably in parallel with the device session', async () => {
  const storage = memoryStorage({
    [SESSION_KEY]: JSON.stringify({
      token: SESSION_TOKEN,
      expiresAt: Date.now() + 60_000,
      clientId: 'device-health-client',
    }),
  });
  const calls = [];
  const result = await checkServerHealth({
    storage,
    storageEndpoint: 'https://storage.example.test',
    ablyEndpoint: 'https://ably.example.test',
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      const service = String(url).includes('storage')
        ? 'masterskaya-storage-gateway'
        : 'masterskaya-ably-auth';
      return response({
        ok: true,
        service,
        version: '1.3.1',
        protocolVersion: 3,
        buildId: 'abcdef123456',
        buildDate: '2026-08-05T10:00:00Z',
        checks: { runtime: 'ok' },
      });
    },
  });

  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.options.headers['X-Masterskaya-Session'], SESSION_TOKEN);
    assert.deepEqual(JSON.parse(call.options.body), { action: 'health' });
  }
  assert.equal(result.storage.ok, true);
  assert.equal(result.ably.ok, true);
  assert.equal(result.session.clientId, 'device-health-client');
  assert.equal(result.storage.version, '1.3.1');
});

test('one failed health endpoint does not hide the other endpoint result', async () => {
  const storage = memoryStorage();
  const result = await checkServerHealth({
    storage,
    storageEndpoint: 'https://storage.example.test',
    ablyEndpoint: 'https://ably.example.test',
    fetchImpl: async url => {
      if (String(url).includes('storage')) throw new Error('network down');
      return response({
        ok: true,
        service: 'masterskaya-ably-auth',
        version: '1.3.1',
        protocolVersion: 3,
        checks: { runtime: 'ok' },
      });
    },
  });
  assert.equal(result.storage.ok, false);
  assert.equal(result.storage.error, 'HEALTH_REQUEST_FAILED');
  assert.equal(result.ably.ok, true);
});

test('health error messages are safe and user-readable', () => {
  assert.equal(healthErrorText('HEALTH_REQUEST_TIMEOUT'), 'Сервер не ответил вовремя');
  assert.equal(healthErrorText('DEVICE_REVOKED'), 'Доступ устройства отключён');
});
