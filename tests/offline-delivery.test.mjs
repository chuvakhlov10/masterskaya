import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { mergeRecords } from '../src/sync-core.js';

const source=readFileSync(new URL('../src/App.jsx',import.meta.url),'utf8');
const from=source.indexOf('    const flushQueue = async () => {');
const to=source.indexOf('    flushQueueRef.current = flushQueue;',from);
const flush=source.slice(from,to)+'\nglobalThis.flush = flushQueue;';
const record={id:'offline-sale',revision:1,amount:300};
function delivery({fail=false}={}) {
  const queue=[{key:'records',id:'write-original',val:[record]}], history=[];
  let allowCache; const persisted=new Promise(resolve=>{allowCache=resolve;});
  const context=vm.createContext({navigator:{onLine:true},console:{log(){},warn(){}},
    isFlushingRef:{current:false},getQueue:()=>queue,getStockOutbox:()=>[],
    setSyncStatus(){},setPendingCount(){},setLastSyncError(){},doPollRef:{current:()=>{}},
    scheduleStockSync(){},wsConnectedRef:{current:false},setTimeout(){},
    dbSet:async(key,val)=>{
      if(fail) throw new Error('GATEWAY_REQUEST_TIMEOUT');
      return {ok:true,value:mergeRecords(history,val)};
    },
    cacheSet:async()=>persisted,
    getMergeFn:()=>mergeRecords,applyObjectPatch(){},
    removeQueuedWrite:(key,id)=>{const index=queue.findIndex(x=>x.key===key&&x.id===id);if(index>=0)queue.splice(index,1);},
    applyRecordRefresh:rows=>{history.splice(0,history.length,...mergeRecords(history,rows));},
    stateSettersRef:{current:{}},publishCommittedChange(){},
  });
  vm.runInContext(flush,context);
  return {queue,history,flush:()=>context.flush(),allowCache};
}

test('server failure keeps the offline record queue until reconnection, then delivers it once',async()=>{
  const failed=delivery({fail:true});await failed.flush();
  assert.equal(failed.queue.length,1);
  const recovered=delivery();const sending=recovered.flush();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(recovered.queue.length,1,'a server acknowledgement alone cannot erase the recovery intent');
  recovered.allowCache();await sending;
  assert.equal(recovered.queue.length,0);
  assert.equal(recovered.history.length,1);
  await recovered.flush();
  assert.equal(recovered.history.length,1);
});

test('a newer queued record created during delivery is retained for the next flush',async()=>{
  const h=delivery();const sending=h.flush();
  await new Promise(resolve=>setImmediate(resolve));
  h.queue.splice(0,1,{key:'records',id:'write-newer',val:[record,{...record,id:'second-offline-sale'}]});
  h.allowCache();await sending;
  assert.equal(h.queue[0].id,'write-newer');
  await h.flush();
  assert.equal(h.queue.length,0);
  assert.equal(h.history.length,2);
});
