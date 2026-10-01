import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { compactRecordWrite, mergeRecordRefresh, persistPendingWrites, persistRecordMutation } from '../src/record-sync.js';

const record = (id, overrides = {}) => ({ id, marker:'Proxy', workshop:'SMART', qty:1,
  amount:250, timestamp:1_800_000_000_000, updatedAt:1_800_000_000_000, revision:1, ...overrides });

function storage(limit = Infinity, entries = {}) {
  const data = new Map(Object.entries(entries));
  return {
    get length() { return data.size; },
    key(i) { return [...data.keys()][i] ?? null; },
    getItem(key) { return data.get(key) ?? null; },
    removeItem(key) { data.delete(key); },
    setItem(key, value) {
      const next = new Map(data); next.set(key, String(value));
      const size = [...next].reduce((sum, [k, v]) => sum + k.length + v.length, 0);
      if(size > limit) throw new Error('QuotaExceededError');
      data.set(key, String(value));
    },
  };
}

test('record queue carries new and edited records without copying thousands of unchanged sales', () => {
  const history = Array.from({ length:3500 }, (_, i) => record(`old-${i}`));
  const queued = record('pending-from-other-tab');
  const changed = { ...history[10], revision:2, amount:300 };
  const next = history.map((r, i) => i === 10 ? changed : r).concat(record('new'));
  const payload = compactRecordWrite(history, next, [queued]);
  assert.deepEqual(new Set(payload.map(r => r.id)), new Set(['pending-from-other-tab', 'old-10', 'new']));
  assert.equal(payload.find(r => r.id === 'old-10').amount, 300);
  const disk = storage(JSON.stringify(history).length + 1000, { records_local:JSON.stringify(history) });
  assert.throws(() => persistPendingWrites(disk, [{ key:'records', val:next }]));
  persistPendingWrites(disk, [{ key:'records', val:payload }]);
  assert.equal(JSON.parse(disk.getItem('pending_writes'))[0].val.length, 3);
});

test('queue retry evicts only disposable caches and preserves both durable queues and recovery data', () => {
  const disk = storage(500, { offline_cache_records:'x'.repeat(400), records_local:'recovery', stock_ops_local:'journal', stock_ops_outbox_v1:'[]' });
  persistPendingWrites(disk, [{ key:'records', val:[record('new')] }]);
  assert.equal(disk.getItem('offline_cache_records'), null);
  assert.equal(disk.getItem('records_local'), 'recovery');
  assert.equal(disk.getItem('stock_ops_local'), 'journal');
  assert.equal(disk.getItem('stock_ops_outbox_v1'), '[]');
});

test('record storage failure cannot create a stock effect or start delivery', () => {
  let stock = 0, delivery = 0;
  assert.throws(() => persistRecordMutation({
    persistRecord: () => { throw new Error('LOCAL_QUEUE_STORAGE_FAILED'); },
    persistStockEffect: () => { stock++; return { ok:true }; },
    rollbackRecord: () => assert.fail('nothing was queued'),
    startDelivery: () => { delivery++; },
  }), /LOCAL_QUEUE_STORAGE_FAILED/);
  assert.equal(stock, 0);
  assert.equal(delivery, 0);
});

test('stock staging failure rolls back only the prepared record write', () => {
  const calls = [];
  const result = persistRecordMutation({
    persistRecord: () => { calls.push('record'); return 'prepared'; },
    persistStockEffect: () => { calls.push('stock'); return { ok:false }; },
    rollbackRecord: id => calls.push(`rollback:${id}`),
    startDelivery: () => assert.fail('must not deliver'),
  });
  assert.equal(result.ok, false);
  assert.deepEqual(calls, ['record', 'stock', 'rollback:prepared']);
});

test('old GET arriving after queue acknowledgement preserves the new record', () => {
  const old = record('old'), added = record('added');
  const currentAfterPut = [old, added];
  const clearedQueue = [];
  assert.deepEqual(mergeRecordRefresh([old], currentAfterPut, clearedQueue).map(r => r.id), ['added', 'old']);
  const remoteEdit = record('added', { revision:2, amount:500 });
  const refreshed = mergeRecordRefresh([old, remoteEdit], currentAfterPut);
  assert.equal(refreshed.find(r => r.id === 'added').amount, 500);
  assert.deepEqual(mergeRecordRefresh([old, added], currentAfterPut, [], new Set(['added'])).map(r => r.id), ['old']);
});

const app = fs.readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
const section = (start, end) => app.slice(app.indexOf(start), app.indexOf(end, app.indexOf(start)));

function appHarness(disk) {
  const history = [record('existing')], timers = [], effects = [], messages = [], delivered = [];
  let reset = 0;
  const context = vm.createContext({
    console, localStorage:disk, compactRecordWrite, persistPendingWrites, persistRecordMutation,
    PENDING_WRITES_KEY:'pending_writes', OBJECT_PATCH_KEYS:new Set(),
    ensureObj:v => v && typeof v === 'object' ? v : {},
    notifyDeviceDiagnosticsChanged:() => {}, cacheGet:() => null, cacheSet:() => {},
    currentValueForKey:() => context.recordsRef.current,
    applyLocalValue:(_key, value) => { context.recordsRef.current = value; },
    getStockOutbox:() => [], setPendingCount:() => {},
    saveQueueIdsRef:{ current:{} }, saveTimersRef:{ current:{} }, saveWaitersRef:{ current:{} },
    stateSettersRef:{ current:{} }, recordsRef:{ current:history },
    pricesRef:{ current:{} }, markersRef:{ current:{} }, aliasesRef:{ current:{} },
    notesRef:{ current:{} }, stockCfgRef:{ current:{} }, subcategoriesRef:{ current:{} },
    stockMovesRef:{ current:[] }, passwordsRef:{ current:{} },
    setTimeout:fn => { timers.push(fn); return timers.length; }, clearTimeout:() => {},
    sSet:async (_key, payload, { queueId }) => {
      delivered.push(payload); context.removeQueuedWrite('records', queueId);
      return { ok:true, queued:false, value:mergeRecordRefresh(history, payload) };
    },
    applyRecordRefresh:value => { context.recordsRef.current = mergeRecordRefresh(value, context.recordsRef.current); },
    publishCommittedChange:() => {},
    stageRecordEffect:effect => { effects.push(effect); return { ok:true }; },
    scheduleStockSync:() => {}, checkCommittedRecordMutation:() => {},
    recordStorageFailure:() => 'LOCAL_QUEUE_STORAGE_FAILED',
    marker:'Proxy', recordType:'sale', qty:1, defect:0, amount:250, comment:'',
    workshop:'SMART', category:'Домофонные', makeRecordMutationId:id => `mut-${id}`,
    setRecords:() => {}, setSubmitMsg:value => messages.push(value),
    setMarker:() => { reset++; }, setQty:() => {}, setDefect:() => {},
    setAmount:() => {}, setManualAmount:() => {}, setComment:() => {}, setRecordType:() => {},
  });
  vm.runInContext(section('function makeQueueId(){', 'async function sGet(')
    + section('  function saveAndSync(', '  // Старое имя')
    + section('  function saveRecordAndStock(', '  function recordStorageFailure(')
    + section('  async function submitRecord(){', '  // ── сохранение редактируемой записи'), context);
  return { context, timers, effects, messages, delivered, get reset() { return reset; } };
}

test('actual submit handler retains the form and creates no stock operation when browser storage is full', async () => {
  const h = appHarness(storage(0));
  await h.context.submitRecord();
  assert.equal(h.effects.length, 0);
  assert.equal(h.reset, 0);
  assert.equal(h.context.recordsRef.current.length, 1);
  assert.equal(h.messages.at(-1).ok, false);
});

test('actual submit and debounce send a compact record payload after durable staging', async () => {
  const disk = storage(), h = appHarness(disk);
  await h.context.submitRecord();
  const queued = JSON.parse(disk.getItem('pending_writes'));
  assert.equal(queued[0].val.length, 1);
  assert.equal(h.effects.length, 1);
  assert.equal(h.reset, 1);
  assert.equal(h.messages[0].ok, true);
  await h.timers[0]();
  assert.equal(h.delivered[0].length, 1);
  assert.equal(h.context.recordsRef.current.length, 2);
  assert.equal(JSON.parse(disk.getItem('pending_writes')).length, 0);
});

test('older save acknowledgement cannot overwrite a second newly queued record', async () => {
  const disk = storage(), h = appHarness(disk);
  await h.context.submitRecord();
  const firstSave = h.timers[0]();
  await h.context.submitRecord();
  await firstSave;
  assert.equal(h.context.recordsRef.current.length, 3);
  assert.equal(JSON.parse(disk.getItem('pending_writes'))[0].val.length, 1);
  await h.timers[2]();
  assert.equal(h.context.recordsRef.current.length, 3);
  assert.equal(JSON.parse(disk.getItem('pending_writes')).length, 0);
});

test('legacy recovery copy is removed only after missing records become durable', () => {
  const recovery = JSON.stringify([record('existing'), record('recovered')]);
  const init = section('      if(Array.isArray(r)){', '      if(p &&');
  const blocked = appHarness(storage(0, { records_local:recovery }));
  blocked.context.r = [record('existing')];
  blocked.context.mergeRecords = mergeRecordRefresh;
  assert.throws(() => vm.runInContext(init, blocked.context), /LOCAL_QUEUE_STORAGE_FAILED/);
  assert.equal(blocked.context.localStorage.getItem('records_local'), recovery);

  const h = appHarness(storage(Infinity, { records_local:recovery }));
  h.context.r = [record('existing')];
  h.context.mergeRecords = mergeRecordRefresh;
  vm.runInContext(init, h.context);
  assert.equal(h.context.localStorage.getItem('records_local'), null);
  const payload = JSON.parse(h.context.localStorage.getItem('pending_writes'))[0].val;
  assert.equal(payload.length, 1);
  assert.equal(payload[0].id, 'recovered');
});
