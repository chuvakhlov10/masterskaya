import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

export const FUNCTION_ID = 'd4ep5fmjtp6t09f06tvt';
const API = 'https://serverless-functions.api.cloud.yandex.net';
const OPERATIONS = 'https://operation.api.cloud.yandex.net';
const HEALTH = `https://functions.yandexcloud.net/${FUNCTION_ID}`;
const CONFIG = ['runtime','entrypoint','resources','executionTimeout','serviceAccountId',
  'environment','namedServiceAccounts','concurrency','connectivity','secrets','logOptions',
  'storageMounts','asyncInvocationConfig','tmpfsSize','mounts','metadataOptions'];
const METADATA = ['id','functionId','description','createdAt','imageSize','status','tags'];

export function versionRequest(current, archive, commit) {
  assert.match(commit, /^[a-f0-9]{40}$/, 'INVALID_COMMIT');
  assert.equal(current.functionId, FUNCTION_ID, 'WRONG_FUNCTION');
  assert.equal(current.status, 'ACTIVE', 'CURRENT_VERSION_NOT_ACTIVE');
  assert.equal(current.runtime, 'nodejs22', 'UNEXPECTED_RUNTIME');
  assert.equal(current.entrypoint, 'index.handler', 'UNEXPECTED_ENTRYPOINT');
  assert.ok(current.id && current.resources && current.executionTimeout, 'INCOMPLETE_CURRENT_VERSION');
  // Stop if the API adds configuration we do not yet know how to preserve.
  assert.ok(Object.keys(current).every(key=>CONFIG.includes(key)||METADATA.includes(key)), 'UNKNOWN_VERSION_FIELD');
  const request={functionId:FUNCTION_ID,description:`Storage deployment ${commit}`,content:archive.toString('base64')};
  for(const key of CONFIG) if(Object.hasOwn(current,key)) request[key]=structuredClone(current[key]);
  return request;
}

export function validateArtifact(bundle, manifest, commit) {
  assert.match(commit, /^[a-f0-9]{40}$/, 'INVALID_COMMIT');
  assert.equal(manifest.buildId,commit,'ARTIFACT_COMMIT_MISMATCH');
  assert.equal(manifest.targets?.storage?.sha256,createHash('sha256').update(bundle).digest('hex'),'ARTIFACT_CHECKSUM_MISMATCH');
}

async function jsonRequest(url, options={}) {
  let response;
  try { response=await fetch(url,{...options,signal:AbortSignal.timeout(30000)}); }
  catch { throw new Error('DEPLOY_NETWORK_REQUEST_FAILED'); }
  if(!response.ok) throw new Error(`DEPLOY_HTTP_${response.status}`);
  try { return await response.json(); } catch { throw new Error('DEPLOY_INVALID_JSON'); }
}

export function apiClient(token) {
  assert.ok(token,'YC_IAM_TOKEN_REQUIRED');
  return async(method,path,body)=>{
    const base=path.startsWith('/operations/')?OPERATIONS:API;
    return jsonRequest(base+path,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
      ...(body===undefined?{}:{body:JSON.stringify(body)})});
  };
}

async function publicHealth() {
  return jsonRequest(HEALTH,{method:'POST',headers:{Origin:'https://chuvakhlov10.github.io','Content-Type':'application/json'},body:'{"action":"health"}'});
}

export async function deploy({api,health=publicHealth,archive,commit,expectedVersion,expectedProtocol,
  pause=()=>delay(2000),report=console.log}) {
  const byTag=`/functions/v1/versions:byTag?functionId=${FUNCTION_ID}&tag=%24latest`;
  const current=await api('GET',byTag);
  const request=versionRequest(current,archive,commit);
  const before=await health();
  assert.equal(before.ok,true,'HEALTH_PREFLIGHT_FAILED');
  assert.equal(before.service,'masterskaya-storage-gateway','HEALTH_WRONG_SERVICE');
  assert.equal(before.checks?.sessionAuth,'configured','SESSION_CONFIGURATION_MISSING');
  assert.equal(before.checks?.githubAppConfig,'configured','GITHUB_CONFIGURATION_MISSING');
  if(before.buildId===commit && before.version===expectedVersion) {
    return {status:'unchanged',versionId:current.id,commit};
  }
  // Never print the active version, the create request, or API error bodies:
  // they can contain application credentials and secret bindings.
  report(`Previous version: ${current.id}`);
  const rechecked=await api('GET',byTag);
  assert.deepEqual(rechecked,current,'CURRENT_VERSION_CHANGED');
  let operation=await api('POST','/functions/v1/versions',request);
  assert.match(operation.id||'',/^[a-zA-Z0-9_-]+$/,'INVALID_OPERATION_ID');
  for(let attempt=0;!operation.done && attempt<150;attempt++) {
    await pause();
    operation=await api('GET',`/operations/${operation.id}`);
  }
  assert.equal(operation.done,true,'DEPLOY_OPERATION_TIMEOUT');
  assert.ok(!operation.error,'DEPLOY_OPERATION_FAILED');
  const versionId=operation.response?.id;
  assert.ok(versionId,'DEPLOY_VERSION_ID_MISSING');
  const deployed=await api('GET',byTag);
  assert.equal(deployed.id,versionId,'LATEST_VERSION_CHANGED');
  assert.equal(deployed.functionId,FUNCTION_ID,'WRONG_DEPLOYED_FUNCTION');
  assert.equal(deployed.status,'ACTIVE','DEPLOYED_VERSION_NOT_ACTIVE');
  for(const key of CONFIG) assert.deepEqual(deployed[key],current[key],`DEPLOYED_CONFIG_CHANGED_${key}`);
  let after;
  for(let attempt=0;attempt<30;attempt++) {
    try { after=await health(); } catch { after=null; }
    if(after?.buildId===commit) break;
    await pause();
  }
  assert.equal(after?.ok,true,'DEPLOY_HEALTH_FAILED');
  assert.equal(after.service,before.service,'DEPLOY_HEALTH_SERVICE_MISMATCH');
  assert.equal(after.buildId,commit,'DEPLOY_BUILD_MISMATCH');
  assert.equal(after.version,expectedVersion,'DEPLOY_VERSION_MISMATCH');
  assert.equal(after.protocolVersion,expectedProtocol,'DEPLOY_PROTOCOL_MISMATCH');
  for(const key of ['minimumStorageProtocol','requiredStockEpoch']) assert.equal(after[key],before[key],`DEPLOY_HEALTH_CHANGED_${key}`);
  for(const key of ['sessionAuth','githubAppConfig']) assert.equal(after.checks?.[key],'configured',`DEPLOY_CONFIG_MISSING_${key}`);
  return {status:'deployed',previousVersionId:current.id,versionId,commit};
}

async function main() {
  const commit=process.env.EXPECTED_COMMIT;
  const bundle=readFileSync('dist/yandex/storage/index.js');
  const manifest=JSON.parse(readFileSync('dist/yandex/manifest.json','utf8'));
  validateArtifact(bundle,manifest,commit);
  const require=createRequire(import.meta.url);
  const loaded=require(resolve('dist/yandex/storage/index.js'));
  const result=await deploy({api:apiClient(process.env.YC_IAM_TOKEN),archive:readFileSync('dist/yandex/storage.zip'),
    commit,expectedVersion:loaded.FUNCTION_VERSION,expectedProtocol:loaded.PROTOCOL_VERSION});
  console.log(JSON.stringify(result));
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  main().catch(()=>{console.error('DEPLOY_FAILED: inspect safe step status; active version ID was printed before any change. No API payload is logged.');process.exitCode=1;});
}
