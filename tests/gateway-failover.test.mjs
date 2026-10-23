import test from 'node:test';
import assert from 'node:assert/strict';
import {createGatewayFailover} from '../src/gateway-failover.js';
import {storageGatewayRequest,renewStorageSession} from '../src/storage-gateway.js';

const endpoint='https://primary.example/storage', reserveEndpoint='https://reserve.example/api/storage';
const response=(data,status=200)=>new Response(JSON.stringify(data),{status});

test('stock writes above the deployed primary content cap go directly to reserve unchanged',async()=>{
  const primary='https://functions.yandexcloud.net/d4ep5fmjtp6t09f06tvt';
  for(const size of [2_900_000,2_900_004]) {
    const calls=[],transport=createGatewayFailover();
    const body={action:'github',method:'PUT',path:'data/stock-ops.json',storageProtocolVersion:4,
      body:{message:'update stock-ops',sha:'a'.repeat(40),content:'e30='.repeat(size/4)}};
    await transport.send({endpoint:primary,reserveEndpoint,body,headers:{'X-Masterskaya-Session':'signed-session'},fetchImpl:async(url,request)=>{
      calls.push(url);assert.equal(request.body,JSON.stringify(body));
      assert.equal(request.headers['X-Masterskaya-Session'],'signed-session');return response({ok:true});
    }});
    assert.deepEqual(calls,[size>2_900_000?reserveEndpoint:primary]);
  }
});

test('large stock reserve rejection preserves conflict handling without replaying to primary',async()=>{
  const primary='https://functions.yandexcloud.net/d4ep5fmjtp6t09f06tvt';
  for(const status of [401,409,503]) {
    const calls=[];
    await assert.rejects(createGatewayFailover().send({endpoint:primary,reserveEndpoint,
      body:{action:'github',method:'PUT',body:{content:'e30='.repeat(725001)}},fetchImpl:async url=>{
        calls.push(url);return response({error:'REJECTED'},status);
      }}),error=>error.status===status);
    assert.deepEqual(calls,[reserveEndpoint]);
  }
});

test('timeout sends the identical stock write to reserve, cools primary and probes recovery',async()=>{
  let clock=1000;
  const transport=createGatewayFailover({now:()=>clock});
  const calls=[];
  let primaryDown=true;
  const options={endpoint,reserveEndpoint,timeoutMs:5,headers:{'X-Masterskaya-Session':'signed-session'},
    body:{action:'github',method:'PUT',path:'stock.json',body:{sha:'old-sha',content:'e30='}},
    fetchImpl:async(url,request)=>{
      calls.push({url,body:request.body,headers:request.headers});
      if(url===endpoint && primaryDown) return new Promise((resolve,reject)=>request.signal.addEventListener('abort',()=>reject(new DOMException('timeout','AbortError'))));
      return response({sha:'new-sha'});
    }};
  assert.deepEqual(await transport.send(options),{sha:'new-sha'});
  assert.deepEqual(calls.map(c=>c.url),[endpoint,reserveEndpoint]);
  assert.equal(calls[0].body,calls[1].body);
  assert.deepEqual(calls[0].headers,calls[1].headers);
  assert.equal(transport.lastRoute(endpoint).route,'reserve');
  await transport.send(options);
  assert.equal(calls[2].url,reserveEndpoint);
  clock+=60001;primaryDown=false;
  await transport.send(options);
  assert.equal(calls[3].url,endpoint);
  assert.equal(transport.lastRoute(endpoint).route,'primary');
});

test('authorization, conflicts and invalid writes are never replayed',async()=>{
  for(const status of [400,401,403,409,413]) {
    for(const json of [true,false]) {
      const transport=createGatewayFailover();let calls=0;
      await assert.rejects(transport.send({endpoint,reserveEndpoint,body:{action:'github'},fetchImpl:async()=>{
        calls++;return json?response({error:'REJECTED'},status):new Response('<html>Denied</html>',{status});
      }}),error=>error.status===status);
      assert.equal(calls,1);
    }
  }
});

test('one-time pairing and recovery requests are not automatically replayed',async()=>{
  for(const action of ['pair','recover','pair-create','recovery-consume','unknown-action']) {
    let calls=0;
    await assert.rejects(createGatewayFailover().send({endpoint,reserveEndpoint,body:{action},fetchImpl:async()=>{
      calls++;throw new TypeError('network down');
    }}),error=>error.code==='GATEWAY_REQUEST_FAILED');
    assert.equal(calls,1);
  }
});

test('transient HTTP and broken success responses fail over',async()=>{
  for(const status of [408,425,429,500,502,503,504,200]) {
    const calls=[];
    await createGatewayFailover().send({endpoint,reserveEndpoint,body:{action:'health'},fetchImpl:async url=>{
      calls.push(url);return url===endpoint?new Response('<html>Gateway error</html>',{status}):response({ok:true});
    }});
    assert.deepEqual(calls,[endpoint,reserveEndpoint]);
  }
});

test('lost primary PUT acknowledgement exposes SHA conflict for existing read/merge path',async()=>{
  let committed=false;const calls=[];
  await assert.rejects(createGatewayFailover().send({endpoint,reserveEndpoint,body:{action:'github',method:'PUT',body:{sha:'old'}},fetchImpl:async url=>{
    calls.push(url);
    if(url===endpoint){committed=true;throw new TypeError('connection lost after commit');}
    assert.equal(committed,true);return response({error:'SHA_CONFLICT'},409);
  }}),error=>error.status===409);
  assert.deepEqual(calls,[endpoint,reserveEndpoint]);
});

test('invalid or credential-bearing reserve URLs fail before sending the session',async()=>{
  for(const reserveEndpoint of ['http://reserve.example','https://user:secret@reserve.example','https://reserve.example?token=secret','https://reserve.example#token']) {
    let calls=0;
    await assert.rejects(createGatewayFailover().send({endpoint,reserveEndpoint,body:{action:'health'},fetchImpl:async()=>{calls++;}}));
    assert.equal(calls,0);
  }
});

function storageFixture(){
  const values=new Map([['masterskaya_storage_session_v1',JSON.stringify({token:'old.session.signature',clientId:'device-12345678',expiresAt:Date.now()+864000000})],['records_local','[{"id":"pending-record"}]']]);
  return {getItem:key=>values.get(key)||null,setItem:(key,value)=>values.set(key,String(value)),removeItem:key=>values.delete(key)};
}

test('storage failure on both servers preserves session and local pending records',async()=>{
  const storage=storageFixture(),before=storage.getItem('records_local');
  await assert.rejects(storageGatewayRequest({endpoint:'https://both-down.example',reserveEndpoint,method:'PUT',path:'records.json',body:{sha:'old',content:'e30='},storage,maxAttempts:1,fetchImpl:async()=>{throw new TypeError('down');}}));
  assert.ok(storage.getItem('masterskaya_storage_session_v1'));
  assert.equal(storage.getItem('records_local'),before);
});

test('session renewal and a storage write work through reserve without repairing the device',async()=>{
  const storage=storageFixture(),calls=[];
  const target='https://renew-reserve.example';
  const fetchImpl=async(url,request)=>{
    calls.push({url,body:JSON.parse(request.body),token:request.headers['X-Masterskaya-Session']});
    if(url===target) throw new TypeError('Yandex unavailable');
    return response(calls.at(-1).body.action==='renew'?{ok:true,sessionToken:'new.session.signature',clientId:'device-12345678',expiresAt:Date.now()+864000000}:{content:'e30=',sha:'new-sha'});
  };
  await renewStorageSession({endpoint:target,reserveEndpoint,storage,fetchImpl});
  await storageGatewayRequest({endpoint:target,reserveEndpoint,method:'PUT',path:'records.json',body:{sha:'old',content:'e30='},storage,fetchImpl});
  assert.deepEqual(calls.map(c=>c.url),[target,reserveEndpoint,reserveEndpoint]);
  assert.equal(calls[1].token,'old.session.signature');
  assert.equal(calls[2].token,'new.session.signature');
  assert.equal(calls[2].body.body.sha,'old');
});
