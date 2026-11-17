import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { gunzipSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildAll } from '../scripts/build-yandex-functions.mjs';
const require=createRequire(import.meta.url);
const base=require('../yandex-storage-function/index.js');
const source=require('../yandex-storage-function/device-index.js');
const {createNodeAdapter}=require('../server/node-gateway.js');
const {compressResponse}=require('../yandex-storage-function/http-response.js');
const now=Date.now(),secret=crypto.randomBytes(32).toString('base64');
const token=base.createSessionToken({secret,clientId:'size-regression-device',nowMs:now}).token;
const journal={schemaVersion:1,epoch:1,ops:Array.from({length:18000},(_,i)=>({
  opId:crypto.createHash('sha256').update(String(i)).digest('hex'),type:'delta',
  workshop:'SMART',category:'Домофонные ключи',marker:'Проверочная маркировка '+i,
  delta:-1,timestamp:now+i,recordId:'rec-'+i,comment:'Продажа; возврат; без изменения истории',
}))};
const bytes=Buffer.from(JSON.stringify(journal));
const sha=crypto.createHash('sha1').update('blob '+bytes.length+'\0').update(bytes).digest('hex');
const payload={sha,size:bytes.length,encoding:'base64',content:bytes.toString('base64').match(/.{1,60}/g).join('\n')+'\n'};
const event={httpMethod:'POST',headers:{origin:base.ALLOWED_ORIGIN,'x-masterskaya-session':token},
  body:JSON.stringify({action:'github',method:'GET',path:'data/stock-ops.json',storageProtocolVersion:4})};
const options={env:{MASTERSKAYA_SESSION_SECRET:secret},now:()=>now,
  appClient:{request:async()=>({status:200,ok:true,payload})},
  deviceAuthService:{authorize:async()=>({id:'size-regression-device'})}};
function checkResponse(result) {
  assert.ok(Buffer.byteLength(JSON.stringify({...result,isBase64Encoded:false,body:JSON.stringify(payload)}))>3.5*1024*1024);
  assert.equal(result.statusCode,200);
  assert.equal(result.headers['Content-Encoding'],'gzip');
  assert.equal(result.headers['Access-Control-Allow-Origin'],base.ALLOWED_ORIGIN);
  assert.match(result.headers['Cache-Control'],/no-store/);
  assert.equal(result.isBase64Encoded,true);
  assert.ok(Buffer.byteLength(JSON.stringify(result))<3.5*1024*1024,'complete invocation response must fit');
  const decoded=JSON.parse(gunzipSync(Buffer.from(result.body,'base64')).toString('utf8'));
  assert.deepEqual(decoded,payload);
  assert.deepEqual(Buffer.from(decoded.content,'base64'),bytes);
  assert.equal(decoded.sha,sha);
}
test('authenticated journal response fits invocation limit and preserves exact content and SHA',async()=>{
  const handler=source.createHandler(options);
  checkResponse(await handler(event));
  const denied=await handler({...event,headers:{origin:base.ALLOWED_ORIGIN}});
  assert.equal(denied.statusCode,401);
  assert.equal(denied.isBase64Encoded,false);
  assert.equal(JSON.parse(denied.body).error,'SESSION_REQUIRED');
});
test('generated single-file deployment preserves compression without external dependencies',async()=>{
  const out=mkdtempSync(join(tmpdir(),'storage-size-bundle-'));
  try {
    buildAll({outputDir:out,buildId:'size-regression',buildDate:new Date(now).toISOString()});
    const bundled=require(join(out,'storage/index.js'));
    checkResponse(await bundled.createHandler(options)(event));
  } finally {rmSync(out,{recursive:true,force:true});}
});
test('existing fetch clients read gzip JSON over real HTTP through the reserve adapter',async()=>{
  const server=http.createServer(createNodeAdapter(source.createHandler(options)));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const res=await fetch('http://127.0.0.1:'+server.address().port,{method:'POST',headers:event.headers,body:event.body});
    assert.equal(res.status,200);
    assert.equal(res.headers.get('content-encoding'),'gzip');
    assert.deepEqual(await res.json(),payload);
  } finally {await new Promise(resolve=>server.close(resolve));}
});
test('small responses, errors, empty preflight and already encoded responses stay unchanged',()=>{
  for(const response of [
    {statusCode:200,body:'{"ok":true}',isBase64Encoded:false},
    {statusCode:204,body:'',isBase64Encoded:false},
    {statusCode:503,body:'x'.repeat(200000),isBase64Encoded:false},
    {statusCode:200,body:'e30=',isBase64Encoded:true},
  ]) assert.equal(compressResponse(response),response);
});
