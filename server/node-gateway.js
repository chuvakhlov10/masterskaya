'use strict';

const storage = require('../yandex-storage-function/device-index.js');
const ably = require('../yandex-function/device-aware-index.js');
const { ALLOWED_ORIGIN } = require('../yandex-storage-function/index.js');
const INTERNAL_STORAGE_URL = 'https://masterskaya-internal.invalid/storage';
const MAX_BODY_BYTES = 3_000_000;

function createReserveHandlers({env=process.env,fetchImpl=globalThis.fetch,now=Date.now,
  appClient,deviceAuthService}={}) {
  const storageHandler=storage.createHandler({env,fetchImpl,now,appClient,deviceAuthService});
  const reserveFetch=async(url,options)=>{
    if(String(url)!==INTERNAL_STORAGE_URL) return fetchImpl(url,options);
    // Live authorization verifies the device through the local reserve storage
    // handler. It has no runtime dependency on the Yandex function URL.
    const result=await storageHandler({httpMethod:options.method,headers:options.headers,body:options.body});
    return new Response(result.statusCode===204?null:result.body,{status:result.statusCode,headers:result.headers});
  };
  const withMetadata=handler=>async event=>{
    const result=await handler(event);
    try {
      const body=typeof event.body==='object'?event.body:JSON.parse(event.body||'{}');
      if(body?.action==='health') {
        result.body=JSON.stringify({...JSON.parse(result.body),provider:env.MASTERSKAYA_RESERVE_PROVIDER||'node-reserve',
          buildId:env.MASTERSKAYA_BUILD_ID||env.VERCEL_GIT_COMMIT_SHA||'reserve-local',buildDate:env.MASTERSKAYA_BUILD_DATE||null});
      }
    } catch {}
    return result;
  };
  return {storage:withMetadata(storageHandler),ably:withMetadata(ably.createHandler({env,fetchImpl:reserveFetch,now,storageGatewayUrl:INTERNAL_STORAGE_URL}))};
}

function sendError(res,status,code,origin) {
  res.statusCode=status;
  res.setHeader('Content-Type','application/json; charset=utf-8');
  res.setHeader('Cache-Control','no-store');
  if(origin===ALLOWED_ORIGIN) res.setHeader('Access-Control-Allow-Origin',ALLOWED_ORIGIN);
  res.end(JSON.stringify({ok:false,error:code}));
}

function createNodeAdapter(handler) {
  return async function endpoint(req,res) {
    const origin=String(req.headers?.origin||'');
    let body;
    try {
      body=req.body;
      if(body===undefined) {
        const chunks=[];let bytes=0;
        for await(const chunk of req) {
          bytes+=Buffer.byteLength(chunk);
          if(bytes>MAX_BODY_BYTES) { sendError(res,413,'BODY_TOO_LARGE',origin);return; }
          chunks.push(Buffer.from(chunk));
        }
        body=Buffer.concat(chunks).toString('utf8');
      }
      const encoded=typeof body==='object' && !Buffer.isBuffer(body)?JSON.stringify(body):String(body||'');
      if(Buffer.byteLength(encoded)>MAX_BODY_BYTES) { sendError(res,413,'BODY_TOO_LARGE',origin);return; }
    } catch { sendError(res,400,'INVALID_JSON_BODY',origin);return; }
    try {
      const result=await handler({httpMethod:req.method,headers:req.headers,body});
      res.statusCode=result.statusCode;
      for(const [key,value] of Object.entries(result.headers||{})) res.setHeader(key,value);
      res.end(result.statusCode===204?'':result.body);
    } catch { sendError(res,503,'RESERVE_SERVICE_UNAVAILABLE',origin); }
  };
}

module.exports={createReserveHandlers,createNodeAdapter};
