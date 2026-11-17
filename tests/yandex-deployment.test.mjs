import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {deploy,FUNCTION_ID,versionRequest,validateArtifact} from '../scripts/deploy-yandex-storage.mjs';
const commit='c'.repeat(40),archive=Buffer.from('synthetic-test-archive');
const current={id:'previous-version',functionId:FUNCTION_ID,status:'ACTIVE',runtime:'nodejs22',entrypoint:'index.handler',
  resources:{memory:'134217728'},executionTimeout:'30s',serviceAccountId:'runtime-account',
  environment:{GITHUB_APP_ID:'12345',GITHUB_APP_PRIVATE_KEY_B64:'test-key-do-not-log',MASTERSKAYA_SESSION_SECRET:'test-secret-do-not-log',MASTERSKAYA_SESSION_VERSION:'2',MASTERSKAYA_STOCK_EPOCH:'1'},
  secrets:[{id:'lockbox-id',versionId:'lockbox-version',key:'key',environmentVariable:'SECRET'}],
  connectivity:{networkId:'network'},namedServiceAccounts:{extra:'other-account'},concurrency:'1',
  logOptions:{folderId:'folder'},storageMounts:[],mounts:[],tmpfsSize:'0',metadataOptions:{awsV1HttpEndpoint:'DISABLED'},
  asyncInvocationConfig:{retriesCount:'1'},tags:['$latest','custom-tag'],createdAt:'2026-11-17T00:00:00Z',imageSize:'100'};
const baseline={ok:true,service:'masterskaya-storage-gateway',version:'1.5.4',buildId:'old',protocolVersion:4,
  minimumStorageProtocol:4,requiredStockEpoch:1,checks:{sessionAuth:'configured',githubAppConfig:'configured'}};
function fixture({changeDuringPreflight=false,operationError=false,wrongBuild=false,alreadyDeployed=false}={}) {
  const writes=[],reports=[];
  let gets=0,healthCalls=0;
  return {writes,reports,options:{archive,commit,expectedVersion:'1.5.5',expectedProtocol:4,pause:async()=>{},report:s=>reports.push(s),
    health:async()=>{
      const before=healthCalls++===0;
      return {...baseline,...(!wrongBuild && (!before||alreadyDeployed)?{buildId:commit,version:'1.5.5'}:{})};
    },
    api:async(method,path,body)=>{
      if(method==='POST') {writes.push(body);return {id:'operation-1',done:false};}
      if(path.startsWith('/operations/'))return operationError?{id:'operation-1',done:true,error:{message:'do-not-print'}}:
        {id:'operation-1',done:true,response:{id:'new-version'}};
      gets++;
      return structuredClone({...current,...(changeDuringPreflight&&gets===2?{id:'concurrent-version'}:{}),
        ...(writes.length?{id:'new-version'}:{})});
    },
  }};
}
test('version request preserves all configuration and secrets without mutating the active version',()=>{
  const before=structuredClone(current),request=versionRequest(current,archive,commit);
  for(const key of ['environment','secrets','resources','serviceAccountId','namedServiceAccounts','connectivity','metadataOptions','logOptions','mounts','asyncInvocationConfig','concurrency']) {
    assert.deepEqual(request[key],current[key]);
  }
  assert.equal(request.content,archive.toString('base64'));
  assert.equal(request.functionId,FUNCTION_ID);
  assert.equal(request.tag,undefined);
  assert.equal(request.id,undefined);
  request.environment.MASTERSKAYA_SESSION_SECRET='mutated-local-copy';
  assert.deepEqual(current,before);
});
test('deployment aborts on unknown configuration, wrong target, runtime or inactive version',()=>{
  for(const change of [{newUnknownConfig:true},{functionId:'different-function'},{runtime:'nodejs20'},{status:'CREATING'},{entrypoint:'other.handler'}]) {
    assert.throws(()=>versionRequest({...current,...change},archive,commit));
  }
});
test('artifact must match both approved commit and manifest checksum',()=>{
  const bundle=Buffer.from('synthetic bundle'),manifest={buildId:commit,targets:{storage:{sha256:createHash('sha256').update(bundle).digest('hex')}}};
  validateArtifact(bundle,manifest,commit);
  assert.throws(()=>validateArtifact(Buffer.from('changed bundle'),manifest,commit));
  assert.throws(()=>validateArtifact(bundle,manifest,'a'.repeat(40)));
});
test('unavailable or masked active secrets stop deployment; complete Lockbox bindings are preserved',()=>{
  for(const value of [undefined,'','***','[REDACTED]']) {
    const active=structuredClone(current);
    active.environment.MASTERSKAYA_SESSION_SECRET=value;
    assert.throws(()=>versionRequest(active,archive,commit),/CURRENT_CONFIGURATION_UNAVAILABLE/);
  }
  const lockbox=structuredClone(current);
  delete lockbox.environment.MASTERSKAYA_SESSION_SECRET;
  lockbox.secrets.push({id:'session-secret',versionId:'pinned-secret-version',key:'session',environmentVariable:'MASTERSKAYA_SESSION_SECRET'});
  assert.deepEqual(versionRequest(lockbox,archive,commit).secrets,lockbox.secrets);
});
test('successful deployment polls operation, preserves settings and verifies exact live build',async()=>{
  const f=fixture(),result=await deploy(f.options);
  assert.deepEqual(result,{status:'deployed',previousVersionId:current.id,versionId:'new-version',commit});
  assert.equal(f.writes.length,1);
  assert.deepEqual(f.writes[0].environment,current.environment);
  assert.deepEqual(f.reports,['Previous version: previous-version']);
  assert.ok(!JSON.stringify(f.reports).includes(current.environment.MASTERSKAYA_SESSION_SECRET));
});
test('changed active version aborts before writing',async()=>{
  const f=fixture({changeDuringPreflight:true});
  await assert.rejects(deploy(f.options),/CURRENT_VERSION_CHANGED/);
  assert.equal(f.writes.length,0);
});
test('operation failure and stale live build cannot be reported as successful deployment',async()=>{
  const failed=fixture({operationError:true});
  await assert.rejects(deploy(failed.options),/DEPLOY_OPERATION_FAILED/);
  const stale=fixture({wrongBuild:true});
  await assert.rejects(deploy(stale.options),/DEPLOY_BUILD_MISMATCH/);
});
test('retrying the same deployed commit does not create another version',async()=>{
  const f=fixture({alreadyDeployed:true});
  assert.equal((await deploy(f.options)).status,'unchanged');
  assert.equal(f.writes.length,0);
});
test('missing session configuration or changed stock epoch prevents a readiness claim',async()=>{
  const missing=fixture();missing.options.health=async()=>({...baseline,checks:{sessionAuth:'missing'}});
  await assert.rejects(deploy(missing.options),/SESSION_CONFIGURATION_MISSING/);
  assert.equal(missing.writes.length,0);
  const changed=fixture();let calls=0;
  changed.options.health=async()=>({...baseline,...(calls++?{buildId:commit,version:'1.5.5',requiredStockEpoch:2}:{})});
  await assert.rejects(deploy(changed.options),/DEPLOY_HEALTH_CHANGED_requiredStockEpoch/);
});
