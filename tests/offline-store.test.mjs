import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { createOfflineStore, isCompleteOfflineData, OFFLINE_DATA_KEYS } from '../src/offline-store.js';

function snapshot() {
  const data = Object.fromEntries(OFFLINE_DATA_KEYS.map(key=>[key,{}]));
  data.passwords = {SMART:'existing-hash',Бегемот:'existing-hash'};
  data.records = [{id:'sale',revision:1,timestamp:1800000000000,amount:250}];
  data['record-deletions'] = [];
  data['stock-moves'] = [];
  data['stock-checkpoint'] = {schemaVersion:4,epoch:1,cutoffTs:1700000000000,
    stock:{main:{},ws:{SMART:{Proxy:150},Бегемот:{}}},recordEffectAnchors:[],renameAliases:{}};
  data['stock-ops'] = {schemaVersion:4,epoch:1,ops:[]};
  return data;
}

test('complete data survives a new app instance with localStorage unavailable', async () => {
  const factory = new IDBFactory();
  const first = createOfflineStore({indexedDB:factory,storage:null});
  await first.hydrate();
  await first.putBatch(snapshot());
  first.close();
  const second = createOfflineStore({indexedDB:factory,storage:null});
  await second.hydrate();
  assert.equal(second.hasComplete(),true);
  assert.equal(second.get('records')[0].amount,250);
  assert.equal(second.get('stock-checkpoint').stock.ws.SMART.Proxy,150);
  second.close();
});

test('partial downloads and mixed checkpoint epochs cannot destroy the last usable copy', async () => {
  const factory = new IDBFactory();
  const writer = createOfflineStore({indexedDB:factory,storage:null});
  await writer.hydrate();
  await writer.putBatch(snapshot());
  await writer.put('stock-checkpoint',{...snapshot()['stock-checkpoint'],epoch:2});
  assert.equal(writer.hasComplete(),false);
  const reader = createOfflineStore({indexedDB:factory,storage:null});
  await reader.hydrate();
  assert.equal(reader.hasComplete(),true);
  assert.equal(reader.get('stock-checkpoint').epoch,1);
  await writer.put('stock-ops',{schemaVersion:4,epoch:2,ops:[]});
  const latest = createOfflineStore({indexedDB:factory,storage:null});
  await latest.hydrate();
  assert.equal(latest.get('stock-checkpoint').epoch,2);
  writer.close(); reader.close(); latest.close();
});

test('large history migrates out of quota limited caches without deleting recovery records or outboxes', async () => {
  const data=snapshot();
  data.records=Array.from({length:4000},(_,i)=>({id:'sale-'+i,comment:'comment '.repeat(150),amount:250}));
  const disk=new Map(OFFLINE_DATA_KEYS.map(key=>[key==='stock-ops'?'stock_ops_local':'offline_cache_'+key,JSON.stringify(data[key])]));
  disk.set('pending_writes','records-outbox'); disk.set('stock_ops_outbox_v1','stock-outbox'); disk.set('records_local','legacy-recovery');
  const storage={getItem:key=>disk.get(key)??null,removeItem:key=>disk.delete(key),setItem:()=>{throw new Error('QuotaExceededError');}};
  const store=createOfflineStore({indexedDB:new IDBFactory(),storage});
  await store.hydrate();
  assert.equal(store.info().ready,true);
  assert.equal(store.get('records').length,4000);
  assert.equal(disk.has('offline_cache_records'),false);
  assert.equal(disk.get('pending_writes'),'records-outbox');
  assert.equal(disk.get('stock_ops_outbox_v1'),'stock-outbox');
  assert.equal(disk.get('records_local'),'legacy-recovery');
  store.close();
});

test('late history writes and separate tabs preserve newer records, deletion tombstones and unrelated keys', async () => {
  const factory=new IDBFactory();
  const first=createOfflineStore({indexedDB:factory,storage:null}); await first.hydrate(); await first.putBatch(snapshot());
  const second=createOfflineStore({indexedDB:factory,storage:null}); await second.hydrate();
  await first.put('records',[{id:'new',revision:1,amount:300}]);
  await second.put('records',snapshot().records);
  await first.put('record-deletions',[{id:'sale',updatedAt:1800000000010}]);
  await second.put('marker-notes',{Proxy:'offline note'});
  const reader=createOfflineStore({indexedDB:factory,storage:null}); await reader.hydrate();
  assert.equal(reader.get('records').filter(row=>row.id==='new').length,1);
  assert.equal(reader.get('record-deletions')[0].id,'sale');
  assert.equal(reader.get('marker-notes').Proxy,'offline note');
  first.close();second.close();reader.close();
});

test('missing data does not report offline readiness and an unavailable database leaves existing data alone', async () => {
  const disk=new Map([['offline_cache_records','[]'],['pending_writes','unsent']]);
  const store=createOfflineStore({indexedDB:null,storage:{getItem:key=>disk.get(key)??null,removeItem:key=>disk.delete(key)}});
  await store.hydrate();
  assert.equal(store.hasComplete(),false);
  assert.equal(store.info().ready,false);
  await assert.rejects(store.put('records',[]),/OFFLINE_STORAGE_UNAVAILABLE/);
  assert.equal(disk.get('pending_writes'),'unsent');
  assert.equal(disk.get('offline_cache_records'),'[]');
});

test('writes arriving during hydration remain in memory and persist in order', async () => {
  const factory=new IDBFactory(); const store=createOfflineStore({indexedDB:factory,storage:null});
  const initial=store.putBatch(snapshot());
  const later=store.put('marker-notes',{Proxy:'newest'});
  await Promise.all([initial,later]);
  assert.equal(store.hasComplete(),true);
  assert.equal(store.get('marker-notes').Proxy,'newest');
  const reader=createOfflineStore({indexedDB:factory,storage:null}); await reader.hydrate();
  assert.equal(reader.get('marker-notes').Proxy,'newest');
  store.close();reader.close();
});

test('empty record lists are valid, but inconsistent archive pairs are not', () => {
  const data=snapshot(); data.records=[];
  assert.equal(isCompleteOfflineData(data),true);
  data['stock-ops'].epoch=2;
  assert.equal(isCompleteOfflineData(data),false);
});

test('stale tabs cannot discard append-only stock operations or roll the recovery copy back to an older archive epoch', async () => {
  const factory=new IDBFactory(), first=createOfflineStore({indexedDB:factory,storage:null});
  await first.hydrate();await first.putBatch(snapshot());
  const op={type:'delta',opId:'new-stock',ts:1800000000000,location:'ws:SMART',marker:'Proxy',delta:-1,archiveEpoch:1};
  await first.put('stock-ops',{schemaVersion:4,epoch:1,ops:[op]});
  await first.put('stock-ops',{schemaVersion:4,epoch:1,ops:[]});
  const reader=createOfflineStore({indexedDB:factory,storage:null});await reader.hydrate();
  assert.equal(reader.get('stock-ops').ops.length,1);
  await first.putBatch({'stock-checkpoint':{...snapshot()['stock-checkpoint'],epoch:2},'stock-ops':{schemaVersion:4,epoch:2,ops:[]}});
  await first.putBatch({'stock-checkpoint':snapshot()['stock-checkpoint'],'stock-ops':snapshot()['stock-ops']});
  const latest=createOfflineStore({indexedDB:factory,storage:null});await latest.hydrate();
  assert.equal(latest.get('stock-checkpoint').epoch,2);
  assert.equal(latest.get('stock-ops').epoch,2);
  first.close();reader.close();latest.close();
});
