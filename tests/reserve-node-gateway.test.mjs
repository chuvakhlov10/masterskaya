import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
import {Readable} from 'node:stream';
const require=createRequire(import.meta.url);
const base=require('../yandex-storage-function/index.js');
const {createReserveHandlers,createNodeAdapter}=require('../server/node-gateway.js');
const {createReserveServer}=require('../server/start-reserve.js');
const NOW=Date.now(),secret=crypto.randomBytes(32).toString('base64'),deviceId='device-reserve-123';
const env={GITHUB_APP_ID:'123',GITHUB_APP_PRIVATE_KEY_B64:'test-only-key',MASTERSKAYA_SESSION_SECRET:secret,MASTERSKAYA_SESSION_VERSION:'2',ABLY_API_KEY:'app123.key456:abcdefghijklmnopqrstuvwxyz012345'};
const token=base.createSessionToken({secret,clientId:deviceId,subject:'device:'+deviceId,nowMs:NOW,version:2}).token;
const event=(body,session=token)=>({httpMethod:'POST',headers:{origin:base.ALLOWED_ORIGIN,'x-masterskaya-session':session},body:JSON.stringify(body)});
function fixture(overrides={}) {
  return {env,now:()=>NOW,fetchImpl:async()=>{throw new Error('Unexpected external network: reserve must not call Yandex');},
    appClient:{installationToken:async()=> 'installation-token',request:async()=>({status:200,payload:{content:'e30=',sha:'a'.repeat(40)}})},
    deviceAuthService:{authorize:async claims=>({id:claims.clientId,name:'Ноутбук',lastSeenAt:NOW})},...overrides};
}

test('reserve accepts the existing signed device session for stock/data access',async()=>{
  const handlers=createReserveHandlers(fixture());
  const result=await handlers.storage(event({action:'github',storageProtocolVersion:4,method:'GET',path:'status.json',ref:'data-backups'}));
  assert.equal(result.statusCode,200);
  assert.equal(JSON.parse(result.body).sha,'a'.repeat(40));
  assert.equal(result.headers['Access-Control-Allow-Origin'],base.ALLOWED_ORIGIN);
});

test('reserve health checks current registry and Github App without a Yandex request',async()=>{
  const handlers=createReserveHandlers(fixture());
  for(const handler of [handlers.storage,handlers.ably]) {
    const result=await handler(event({action:'health'}));
    const body=JSON.parse(result.body);
    assert.equal(result.statusCode,200);
    assert.equal(body.authenticated,true);
    assert.equal(body.checks.deviceRegistry,'ok');
    assert.equal(body.provider,'node-reserve');
    assert.equal(result.body.includes(secret),false);
    assert.equal(result.body.includes(env.GITHUB_APP_PRIVATE_KEY_B64),false);
  }
});

test('Ably token is issued after local reserve device validation',async()=>{
  const result=await createReserveHandlers(fixture()).ably(event({clientId:'ably-client-123'}));
  assert.equal(result.statusCode,200);
  assert.equal(JSON.parse(result.body).token.split('.').length,3);
});

test('a revoked device is denied by both reserve handlers',async()=>{
  const handlers=createReserveHandlers(fixture({deviceAuthService:{authorize:async()=>{const err=new Error('DEVICE_REVOKED');err.code='DEVICE_REVOKED';err.statusCode=401;throw err;}}}));
  for(const [handler,body] of [[handlers.storage,{action:'session-check'}],[handlers.ably,{clientId:'ably-client-123'}]]) {
    const result=await handler(event(body));
    assert.equal(result.statusCode,401);
    assert.equal(JSON.parse(result.body).error,'DEVICE_REVOKED');
  }
});

test('missing reserve secrets fail closed and wrong origin cannot access it',async()=>{
  const handlers=createReserveHandlers({env:{},now:()=>NOW,fetchImpl:async()=>{throw new Error('No network expected');}});
  assert.notEqual((await handlers.storage(event({action:'github',method:'GET',path:'status.json'}))).statusCode,200);
  assert.notEqual((await handlers.ably(event({clientId:'ably-client-123'}))).statusCode,200);
  const wrong=event({action:'health'});wrong.headers.origin='https://attacker.example';
  assert.equal((await handlers.storage(wrong)).statusCode,403);
  assert.equal((await handlers.ably(wrong)).statusCode,403);
});

function mockResponse(){return {headers:{},setHeader(key,value){this.headers[key]=value;},end(body){this.body=body;}};}
test('large journal passes the reserve HTTP adapter, device authorization and epoch gate',async()=>{
  const journal={schemaVersion:4,epoch:1,ops:[{opId:'large-history',type:'delta',location:'main',marker:'A',delta:1,comment:'x'.repeat(2_300_000)}]};
  const content=Buffer.from(JSON.stringify(journal)).toString('base64');
  assert.ok(content.length>3_000_000);
  let authorized=0,stored;
  const handlers=createReserveHandlers(fixture({env:{...env,MASTERSKAYA_MIN_STORAGE_PROTOCOL:'4',MASTERSKAYA_STOCK_EPOCH:'1'},
    deviceAuthService:{authorize:async claims=>{authorized++;return {id:claims.clientId};}},
    appClient:{request:async body=>{base.normalizeRepoRequest(body);stored=body;return {status:200,payload:{content:{sha:'b'.repeat(40)}}};}}
  }));
  const body={action:'github',storageProtocolVersion:4,method:'PUT',path:'data/stock-ops.json',body:{message:'update stock-ops',sha:'a'.repeat(40),content}};
  const req=event(body),res=mockResponse();
  await createNodeAdapter(handlers.storage)({method:'POST',headers:req.headers,body:req.body},res);
  assert.equal(res.statusCode,200);assert.equal(authorized,1);
  assert.equal(stored.body.content,content);assert.equal(stored.body.sha,'a'.repeat(40));
  const denied=await handlers.storage(event({...body,storageProtocolVersion:1}));
  assert.equal(denied.statusCode,426);
  const wrongEpoch=Buffer.from(JSON.stringify({...journal,epoch:2})).toString('base64');
  assert.equal((await handlers.storage(event({...body,body:{...body.body,content:wrongEpoch}}))).statusCode,428);
  assert.throws(()=>base.normalizeRepoRequest({...body,body:{...body.body,content:'A'.repeat(4_000_004)}}),error=>error.code==='GITHUB_BODY_INVALID');
});
test('adapter handles platform-parsed JSON, oversized bodies and parsing errors',async()=>{
  let calls=0;
  const adapter=createNodeAdapter(async event=>{calls++;assert.deepEqual(event.body,{action:'health'});return {statusCode:200,headers:{'Cache-Control':'no-store'},body:'{"ok":true}'};});
  const res=mockResponse();await adapter({method:'POST',headers:{},body:{action:'health'}},res);
  assert.equal(res.statusCode,200);assert.equal(calls,1);
  const big=mockResponse();await adapter({method:'POST',headers:{},body:'x'.repeat(4100001)},big);
  assert.equal(big.statusCode,413);assert.equal(calls,1);
  const invalid=mockResponse();await adapter({headers:{},get body(){throw new Error('platform parser error');}},invalid);
  assert.equal(invalid.statusCode,400);assert.equal(calls,1);
  const stream=Readable.from([Buffer.alloc(2050001),Buffer.alloc(2050001)]);stream.headers={};stream.method='POST';
  const streamed=mockResponse();await adapter(stream,streamed);assert.equal(streamed.statusCode,413);
});

test('adapter hides unhandled server errors and sends safe CORS headers',async()=>{
  const res=mockResponse();
  await createNodeAdapter(async()=>{throw new Error(secret);})({headers:{origin:base.ALLOWED_ORIGIN},body:{}},res);
  assert.equal(res.statusCode,503);
  assert.equal(res.headers['Access-Control-Allow-Origin'],base.ALLOWED_ORIGIN);
  assert.equal(res.body.includes(secret),false);
});

test('standalone reserve server handles real HTTP, CORS preflight and both routes',async()=>{
  const server=createReserveServer(fixture());
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const url='http://127.0.0.1:'+server.address().port;
  try {
    for(const path of ['/api/storage','/api/ably']) {
      const result=await fetch(url+path,{method:'POST',headers:event({}).headers,body:JSON.stringify({action:'health'})});
      assert.equal(result.status,200);assert.equal((await result.json()).authenticated,true);
      const options=await fetch(url+path,{method:'OPTIONS',headers:{origin:base.ALLOWED_ORIGIN,'access-control-request-method':'POST','access-control-request-headers':'x-masterskaya-session,content-type'}});
      assert.equal(options.status,204);
      assert.equal(options.headers.get('Access-Control-Allow-Origin'),base.ALLOWED_ORIGIN);
    }
    assert.equal((await fetch(url+'/missing')).status,404);
    assert.equal((await fetch(url+'/constructor')).status,404);
  } finally {await new Promise(resolve=>server.close(resolve));}
});
