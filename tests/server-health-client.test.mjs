import test from 'node:test';
import assert from 'node:assert/strict';

import {
  checkServerHealth,
  checkReserveHealth,
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

function pairedStorage() {
  return memoryStorage({ [SESSION_KEY]: JSON.stringify({ token: SESSION_TOKEN,
    expiresAt: Date.now() + 10 * 86400000, clientId: 'device-health-client' }) });
}
const reserveStorage = 'https://reserve.example.test/storage';
const reserveAbly = 'https://reserve.example.test/ably';
function reserveHealthPayload(url, extra = {}) {
  return { ok: true, service: String(url).includes('storage') ? 'masterskaya-storage-gateway' : 'masterskaya-ably-auth',
    version: '1.5.4', authenticated: true,
    checks: { deviceRegistry: 'ok', githubApp: 'ok' }, ...extra };
}

test('reserve readiness requires authenticated registry checks and a real repository read', async () => {
  const calls=[];
  const result=await checkReserveHealth({ storage: pairedStorage(), storageEndpoint: reserveStorage, ablyEndpoint: reserveAbly,
    fetchImpl: async (url, options) => {
      const body=JSON.parse(options.body);calls.push({url,body});
      assert.equal(options.headers['X-Masterskaya-Session'], SESSION_TOKEN);
      if(body.action === 'github') {
        assert.equal(url,reserveStorage);assert.equal(body.method,'GET');
        assert.equal(body.path,'status.json');assert.equal(body.ref,'data-backups');
        return response({sha:'a'.repeat(40),content:'e30='});
      }
      return response(reserveHealthPayload(url));
    } });
  assert.equal(calls.length,3);assert.equal(result.ready,true);assert.equal(result.readOk,true);
  assert.equal(result.storage.gatewayRoute,'reserve');assert.equal(result.ably.gatewayRoute,'reserve');
  assert.equal(JSON.stringify(result).includes(SESSION_TOKEN),false);
});

test('a reserve with a rejected session cannot log the device out of the primary', async () => {
  const storage=pairedStorage(),before=storage.getItem(SESSION_KEY);let calls=0;
  const result=await checkReserveHealth({storage,storageEndpoint:reserveStorage,ablyEndpoint:reserveAbly,
    fetchImpl:async()=>{calls++;return response({error:'SESSION_INVALID'},401);} });
  assert.equal(result.ready,false);assert.equal(result.readOk,false);assert.equal(calls,2);
  assert.equal(storage.getItem(SESSION_KEY),before);
});

test('anonymous or incomplete health checks cannot report the reserve as ready', async () => {
  for(const extra of [{authenticated:false},{checks:{deviceRegistry:'not_checked',githubApp:'ok'}},{checks:{deviceRegistry:'ok',githubApp:'unavailable'}}]) {
    let calls=0;
    const result=await checkReserveHealth({storage:pairedStorage(),storageEndpoint:reserveStorage,ablyEndpoint:reserveAbly,
      fetchImpl:async url=>{calls++;return response(reserveHealthPayload(url,extra));} });
    assert.equal(result.ready,false);assert.equal(calls,2);
  }
});

test('failed repository access does not report reserve readiness', async () => {
  const result=await checkReserveHealth({storage:pairedStorage(),storageEndpoint:reserveStorage,ablyEndpoint:reserveAbly,
    fetchImpl:async(url,options)=>JSON.parse(options.body).action==='health' ? response(reserveHealthPayload(url)) : response({error:'PATH_DENIED'},403)});
  assert.equal(result.ready,false);assert.equal(result.readOk,false);assert.equal(result.error,'PATH_DENIED');
});
