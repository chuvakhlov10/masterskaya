import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const base = require('../yandex-storage-function/index.js');
const {
  DEVICE_REGISTRY_PATH,
  PAIRINGS_PATH,
  PAIRING_TTL_MS,
  createDeviceAuthService,
  hashPairingCode,
  normalizePairingCode,
} = require('../yandex-storage-function/device-auth.js');
const { createHandler } = require('../yandex-storage-function/pairing-index.js');

class MemoryGitHubClient {
  constructor(){ this.files = new Map(); this.counter = 1; }
  response(payload, status = 200){ return { status, ok: status >= 200 && status < 300, payload }; }
  async requestInternal({ method, path, body }){
    const current = this.files.get(path);
    if(method === 'GET'){
      if(!current) return this.response({ message: 'Not Found' }, 404);
      return this.response({ sha: current.sha, content: current.content });
    }
    if(method === 'PUT'){
      if(current && body?.sha !== current.sha) return this.response({ message: 'sha does not match' }, 409);
      if(!current && body?.sha) return this.response({ message: 'sha does not match' }, 409);
      const sha = String(this.counter++).padStart(40, 'a').slice(-40);
      this.files.set(path, { sha, content: body.content });
      return this.response({ content: { sha } }, current ? 200 : 201);
    }
    if(method === 'DELETE'){
      if(!current) return this.response({ message: 'Not Found' }, 404);
      if(body?.sha !== current.sha) return this.response({ message: 'sha does not match' }, 409);
      this.files.delete(path);
      return this.response(null, 200);
    }
    return this.response({ message: 'bad method' }, 405);
  }
  json(path){
    const file = this.files.get(path);
    if(!file) return null;
    return JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'));
  }
}

function deterministicRandom(){ return 0; }

test('legacy session auto-registers a device and lists it as current', async () => {
  const client = new MemoryGitHubClient();
  let now = 1000;
  const auth = createDeviceAuthService({ appClient: client, now: () => now, randomInt: deterministicRandom });
  const claims = { clientId: 'device-client-123', sub: 'github:123' };
  const device = await auth.authorize(claims, 'Ноутбук');
  assert.equal(device.name, 'Ноутбук');
  const registry = client.json(DEVICE_REGISTRY_PATH);
  assert.equal(registry.devices.length, 1);
  const devices = await auth.listDevices(claims);
  assert.equal(devices[0].current, true);
  assert.equal(devices[0].name, 'Ноутбук');
});

test('pairing code is one-time, lasts ten minutes, and raw code is never stored', async () => {
  const client = new MemoryGitHubClient();
  let now = 10_000;
  const auth = createDeviceAuthService({ appClient: client, now: () => now, randomInt: deterministicRandom });
  const currentClaims = { clientId: 'device-client-123', sub: 'github:123' };
  await auth.authorize(currentClaims, 'Ноутбук');
  const pairing = await auth.createPairing(currentClaims);
  assert.match(pairing.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.equal(pairing.expiresAt, now + PAIRING_TTL_MS);
  const stored = JSON.stringify(client.json(PAIRINGS_PATH));
  assert.equal(stored.includes(pairing.code.replaceAll('-', '')), false);
  assert.equal(stored.includes(hashPairingCode(pairing.code)), true);

  const device = await auth.redeemPairing({
    code: pairing.code.toLowerCase(),
    clientId: 'device-phone-456',
    deviceName: 'Телефон',
  });
  assert.equal(device.name, 'Телефон');
  assert.equal(device.source, 'pairing');

  await assert.rejects(
    () => auth.redeemPairing({ code: pairing.code, clientId: 'device-other-789', deviceName: 'Другой' }),
    error => error.code === 'PAIRING_CODE_NOT_FOUND',
  );
});

test('expired pairing code is consumed and rejected', async () => {
  const client = new MemoryGitHubClient();
  let now = 20_000;
  const auth = createDeviceAuthService({ appClient: client, now: () => now, randomInt: deterministicRandom });
  const claims = { clientId: 'device-client-123', sub: 'github:123' };
  await auth.authorize(claims);
  const pairing = await auth.createPairing(claims);
  now = pairing.expiresAt + 1;
  await assert.rejects(
    () => auth.redeemPairing({ code: pairing.code, clientId: 'device-phone-456' }),
    error => error.code === 'PAIRING_CODE_EXPIRED',
  );
});

test('a paired device can be renamed and revoked, but current device cannot revoke itself', async () => {
  const client = new MemoryGitHubClient();
  let now = 30_000;
  const auth = createDeviceAuthService({ appClient: client, now: () => now, randomInt: deterministicRandom });
  const claims = { clientId: 'device-client-123', sub: 'github:123' };
  await auth.authorize(claims, 'Ноутбук');
  const pairing = await auth.createPairing(claims);
  await auth.redeemPairing({ code: pairing.code, clientId: 'device-phone-456', deviceName: 'Телефон' });

  const renamed = await auth.renameDevice(claims, 'device-phone-456', 'Телефон Ильи');
  assert.equal(renamed.name, 'Телефон Ильи');
  const revoked = await auth.revokeDevice(claims, 'device-phone-456');
  assert.equal(revoked.revokedAt, now);
  await assert.rejects(
    () => auth.authorize({ clientId: 'device-phone-456', sub: 'device:device-phone-456' }),
    error => error.code === 'DEVICE_REVOKED',
  );
  await assert.rejects(
    () => auth.revokeDevice(claims, 'device-client-123'),
    error => error.code === 'DEVICE_SELF_REVOKE_DENIED',
  );
});

test('pairing normalization rejects ambiguous and short codes', () => {
  assert.equal(normalizePairingCode('AAAA-AAAA-AAAA'), 'AAAAAAAAAAAA');
  assert.equal(normalizePairingCode('OOOO-OOOO-OOOO'), null);
  assert.equal(normalizePairingCode('AAAA'), null);
});

const SESSION_SECRET = crypto.randomBytes(32).toString('base64');
const NOW = Date.parse('2026-08-05T07:00:00Z');
const ENV = {
  MASTERSKAYA_SESSION_SECRET: SESSION_SECRET,
  MASTERSKAYA_SESSION_VERSION: '2',
};

function event(body, headers = {}){
  return {
    httpMethod: 'POST',
    headers: { origin: base.ALLOWED_ORIGIN, ...headers },
    body: JSON.stringify(body),
  };
}

function fakeAuth(){
  return {
    async redeemPairing({clientId}){ return {id:clientId,name:'Телефон'}; },
    async registerLegacy({clientId}){ return {id:clientId,name:'Устройство'}; },
    async authorize(claims){
      if(claims.clientId === 'device-revoked-1'){
        const error = new Error('DEVICE_REVOKED');
        error.code = 'DEVICE_REVOKED';
        error.statusCode = 401;
        throw error;
      }
      return {id:claims.clientId,name:'Устройство'};
    },
    async listDevices(claims){ return [{id:claims.clientId,current:true,name:'Ноутбук'}]; },
    async createPairing(){ return {code:'AAAA-AAAA-AAAA',expiresAt:NOW+600000,createdBy:'device-client-123'}; },
    async renameDevice(){ return {id:'device-phone-456',name:'Телефон'}; },
    async revokeDevice(){ return {id:'device-phone-456',revokedAt:NOW}; },
  };
}

const appClient = {
  async request(input){ return {status:200,ok:true,payload:{echo:input.path}}; },
  async requestInternal(){ throw new Error('not used'); },
};

test('pairing redeem issues a normal shared session without a PAT', async () => {
  const handler = createHandler({
    env: ENV,
    now: () => NOW,
    appClient,
    deviceAuthService: fakeAuth(),
    fetchImpl: async () => { throw new Error('network not expected'); },
  });
  const response = await handler(event({
    action:'pairing-redeem',
    code:'AAAA-AAAA-AAAA',
    clientId:'device-phone-456',
    deviceName:'Телефон',
  }));
  assert.equal(response.statusCode, 200);
  const payload = JSON.parse(response.body);
  const claims = base.verifySessionToken({
    token: payload.sessionToken,
    secret: SESSION_SECRET,
    nowMs: NOW,
    version: 2,
  });
  assert.equal(claims.clientId, 'device-phone-456');
  assert.equal(claims.sub, 'device:device-phone-456');
});

test('devices and pairing-create use the active device session', async () => {
  const handler = createHandler({
    env: ENV,
    now: () => NOW,
    appClient,
    deviceAuthService: fakeAuth(),
    fetchImpl: async () => { throw new Error('network not expected'); },
  });
  const session = base.createSessionToken({
    secret: SESSION_SECRET,
    clientId:'device-client-123',
    subject:'device:device-client-123',
    nowMs:NOW,
    version:2,
  });
  const headers = {'x-masterskaya-session':session.token};
  const devices = await handler(event({action:'devices'}, headers));
  assert.equal(JSON.parse(devices.body).devices[0].name, 'Ноутбук');
  const pairing = await handler(event({action:'pairing-create'}, headers));
  assert.equal(JSON.parse(pairing.body).code, 'AAAA-AAAA-AAAA');
});

test('revoked device is denied before a GitHub data request', async () => {
  let requests = 0;
  const client = {
    ...appClient,
    async request(){ requests++; return {status:200,ok:true,payload:{}}; },
  };
  const handler = createHandler({
    env: ENV,
    now: () => NOW,
    appClient: client,
    deviceAuthService: fakeAuth(),
    fetchImpl: async () => { throw new Error('network not expected'); },
  });
  const session = base.createSessionToken({
    secret: SESSION_SECRET,
    clientId:'device-revoked-1',
    subject:'device:device-revoked-1',
    nowMs:NOW,
    version:2,
  });
  const response = await handler(event(
    {action:'github',method:'GET',path:'data/records.json'},
    {'x-masterskaya-session':session.token},
  ));
  assert.equal(response.statusCode, 401);
  assert.equal(JSON.parse(response.body).error, 'DEVICE_REVOKED');
  assert.equal(requests, 0);
});
