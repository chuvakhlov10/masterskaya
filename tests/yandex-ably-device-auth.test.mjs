import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const storageBase = require('../yandex-storage-function/index.js');
const ablyBase = require('../yandex-function/index.js');
const { DEFAULT_STORAGE_GATEWAY_URL, createHandler } = require('../yandex-function/device-aware-index.js');

const SECRET = crypto.randomBytes(32).toString('base64');
const NOW = Date.parse('2026-08-05T08:30:00Z');
const CLIENT_ID = 'ably-client-12345678';
const DEVICE_ID = 'device-client-123';
const ENV = {
  ABLY_API_KEY:'app123.key456:abcdefghijklmnopqrstuvwxyz012345',
  MASTERSKAYA_SESSION_SECRET:SECRET,
  MASTERSKAYA_SESSION_VERSION:'2',
};

function jsonResponse(value,status=200){
  return new Response(JSON.stringify(value),{
    status,
    headers:{'content-type':'application/json'},
  });
}

function session(){
  return storageBase.createSessionToken({
    secret:SECRET,
    clientId:DEVICE_ID,
    subject:`device:${DEVICE_ID}`,
    nowMs:NOW,
    version:2,
  }).token;
}

function event(token=session()){
  return {
    httpMethod:'POST',
    headers:{
      origin:ablyBase.ALLOWED_ORIGIN,
      'x-masterskaya-session':token,
      'content-type':'application/json',
    },
    body:JSON.stringify({clientId:CLIENT_ID}),
  };
}

test('active device registry check is required before an Ably JWT is issued',async()=>{
  const calls=[];
  const handler=createHandler({
    env:ENV,
    now:()=>NOW,
    fetchImpl:async(url,options)=>{
      calls.push({url:String(url),options});
      return jsonResponse({ok:true,device:{id:DEVICE_ID,name:'Ноутбук',lastSeenAt:NOW}});
    },
  });
  const response=await handler(event());
  const payload=JSON.parse(response.body);
  assert.equal(response.statusCode,200);
  assert.equal(payload.ok,true);
  assert.equal(payload.clientId,CLIENT_ID);
  assert.equal(calls.length,1);
  assert.equal(calls[0].url,DEFAULT_STORAGE_GATEWAY_URL);
  assert.equal(calls[0].options.headers['X-Masterskaya-Session'],session());
  assert.deepEqual(JSON.parse(calls[0].options.body),{action:'session-check'});
});

test('revoked device cannot receive a fresh Ably JWT',async()=>{
  const handler=createHandler({
    env:ENV,
    now:()=>NOW,
    fetchImpl:async()=>jsonResponse({ok:false,error:'DEVICE_REVOKED'},401),
  });
  const response=await handler(event());
  assert.equal(response.statusCode,401);
  assert.deepEqual(JSON.parse(response.body),{ok:false,error:'DEVICE_REVOKED'});
});

test('device registry outage fails closed without issuing an Ably JWT',async()=>{
  const handler=createHandler({
    env:ENV,
    now:()=>NOW,
    fetchImpl:async()=>{ throw new Error('network down'); },
  });
  const response=await handler(event());
  assert.equal(response.statusCode,503);
  assert.deepEqual(JSON.parse(response.body),{ok:false,error:'DEVICE_AUTH_CHECK_FAILED'});
});
