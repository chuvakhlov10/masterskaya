import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const base = require('../yandex-storage-function/index.js');
const { createHandler } = require('../yandex-storage-function/device-index.js');

const SECRET = crypto.randomBytes(32).toString('base64');
const NOW = Date.parse('2026-08-05T08:00:00Z');
const ENV = {
  MASTERSKAYA_SESSION_SECRET: SECRET,
  MASTERSKAYA_SESSION_VERSION: '2',
};

function event(token){
  return {
    httpMethod:'POST',
    headers:{
      origin:base.ALLOWED_ORIGIN,
      'x-masterskaya-session':token,
      'content-type':'application/json',
    },
    body:JSON.stringify({action:'session-check'}),
  };
}

function session(clientId = 'device-client-123'){
  return base.createSessionToken({
    secret:SECRET,
    clientId,
    subject:`device:${clientId}`,
    nowMs:NOW,
    version:2,
  }).token;
}

const appClient = {
  async request(){ throw new Error('not expected'); },
  async requestInternal(){ throw new Error('not expected'); },
};

test('session-check confirms an active registered device', async () => {
  const auth = {
    async authorize(claims){
      return {id:claims.clientId,name:'Ноутбук',lastSeenAt:NOW,revokedAt:null};
    },
  };
  const handler = createHandler({
    env:ENV,
    now:()=>NOW,
    appClient,
    deviceAuthService:auth,
    fetchImpl:async()=>{ throw new Error('network not expected'); },
  });
  const response = await handler(event(session()));
  assert.equal(response.statusCode,200);
  assert.deepEqual(JSON.parse(response.body),{
    ok:true,
    device:{id:'device-client-123',name:'Ноутбук',lastSeenAt:NOW},
  });
});

test('session-check denies a revoked device', async () => {
  const auth = {
    async authorize(){
      const error = new Error('DEVICE_REVOKED');
      error.code = 'DEVICE_REVOKED';
      error.statusCode = 401;
      throw error;
    },
  };
  const handler = createHandler({
    env:ENV,
    now:()=>NOW,
    appClient,
    deviceAuthService:auth,
    fetchImpl:async()=>{ throw new Error('network not expected'); },
  });
  const response = await handler(event(session('device-revoked-1')));
  assert.equal(response.statusCode,401);
  assert.equal(JSON.parse(response.body).error,'DEVICE_REVOKED');
});
