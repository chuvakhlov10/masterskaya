import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { applyStockCheckpoint, mergeRecords, mergeStockOps, normalizeStockCheckpoint, normalizeStockJournal } from '../src/sync-core.js';

const source = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
function section(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from);
  return source.slice(from, to);
}
const checkpoint = {
  schemaVersion:4, epoch:1, cutoffTs:1700000000000,
  stock:{main:{}, ws:{SMART:{Proxy:145}, Бегемот:{}}},
  recordEffectAnchors:[], renameAliases:{},
};
const sale = { id:'sale-confirmed', workshop:'SMART', timestamp:1791443822201, amount:1000, marker:'Proxy', qty:4, revision:1 };
const complete = {
  passwords:{SMART:'existing-password-hash'}, records:[sale], 'record-deletions':[],
  'stock-checkpoint':checkpoint, 'stock-ops':{schemaVersion:4,epoch:1,ops:[]},
};

function harness({cache = {}, online = true, remote = null} = {}) {
  const disk = new Map([['pending_writes', '[{"key":"records","val":[{"id":"unsent"}]}]'],
    ['stock_ops_outbox','[{"opId":"pending-stock"}]']]);
  const originalDisk = JSON.stringify([...disk]);
  const state = {loading:true, error:'', records:[], pwdLoaded:false, selected:null};
  let writes = 0, repairs = 0;
  const context = vm.createContext({
    navigator:{onLine:online}, console:{warn(){}, error(){}, log(){}},
    dbGet:async key => {
      if(remote) return remote[key] ?? null;
      throw Object.assign(new Error('GATEWAY_REQUEST_TIMEOUT'), {code:'GATEWAY_REQUEST_TIMEOUT'});
    },
    cacheGet:key => cache[key] ?? null, cacheSet(){},
    sSet:async () => { writes++; },
    localStorage:{getItem:key => disk.get(key) ?? null, removeItem:key => disk.delete(key)},
    useEffect:fn => fn(), startupAttempt:0,
    setLoading:value => {state.loading=value;}, setStartupError:value => {state.error=value;},
    stockReadyRef:{current:false}, setPasswords(){}, setPwdLoaded:value => {state.pwdLoaded=value;},
    recordDeletionsRef:{current:[]}, setRecordDeletionIds(){},
    activateStockCheckpoint:value => {context.stockCheckpointRef.current=value;},
    normalizeStockCheckpoint, normalizeStockJournal, mergeRecords, mergeStockOps,
    stockCheckpointRef:{current:null}, recordsRef:{current:[]},
    reconcileStockOutboxAgainstHistory:async () => {},
    getQueue:() => [], enqueueWrite:() => {writes++;}, setPendingCount(){},
    setRecords:value => {state.records=value;}, pricesRef:{current:{}}, setPrices(){},
    getStockOutbox:() => [], prepareStockOutbox:value => value, removeStockOutboxIds(){},
    stockOpsRef:{current:[]}, stockOutboxBlockedCountRef:{current:0}, persistStockSnapshot(){},
    calculateStock:ops => applyStockCheckpoint(context.stockCheckpointRef.current, ops),
    stockRef:{current:null}, setStockOps(){}, setStock(){}, unsyncedOpsRef:{current:new Set()},
    scheduleStockSync(){}, repairMissingCreateRecordEffects:() => {repairs++;},
    setStockMoves(){}, setStockCfg(){}, setMarkers(){}, setAliases(){}, setNotes(){}, setSubcategories(){},
    LOCAL_AUTH_KEY:'auth', LOCAL_WS_KEY:'workshop', WORKSHOPS:['SMART','Бегемот'],
    selectWorkshop:value => {state.selected=value;},
  });
  vm.runInContext(section('async function sGet(', '// Удаления записей'), context);
  vm.runInContext(section('  async function readConsistentStockPair(', '  async function loadStockArchiveHistory('), context);
  async function boot() {
    vm.runInContext(section('  // ── загрузка при старте', '  // ── авто-расчёт суммы')
      .replace('(async()=>{', 'globalThis.startupPromise = (async()=>{'), context);
    await context.startupPromise;
  }
  return {context, state, disk, originalDisk, boot, get writes(){return writes;}, get repairs(){return repairs;}};
}

test('timeout without cached passwords blocks startup and cannot initialize or overwrite passwords', async () => {
  const h = harness();
  await h.boot();
  assert.equal(h.state.error, 'GATEWAY_REQUEST_TIMEOUT');
  assert.equal(h.state.loading, false);
  assert.equal(h.state.pwdLoaded, false);
  assert.equal(h.context.stockReadyRef.current, false);
  assert.equal(h.writes, 0);
  assert.equal(h.repairs, 0);
  assert.equal(JSON.stringify([...h.disk]), h.originalDisk);
});

for(const missing of ['records','record-deletions','stock-checkpoint','stock-ops']) {
  test(`timeout without cached ${missing} cannot open an empty workshop`, async () => {
    const cache = {...complete}; delete cache[missing];
    const h = harness({cache});
    await h.boot();
    assert.equal(h.state.error, 'GATEWAY_REQUEST_TIMEOUT');
    assert.equal(h.context.stockReadyRef.current, false);
    assert.equal(h.state.selected, null);
    assert.equal(h.writes, 0);
    assert.equal(h.repairs, 0);
    assert.equal(JSON.stringify([...h.disk]), h.originalDisk);
  });
}

test('a complete cached snapshot remains usable offline with its actual records and stock', async () => {
  const h = harness({cache:complete, online:false});
  await h.boot();
  assert.equal(h.state.error, '');
  assert.equal(h.state.records[0].id, sale.id);
  assert.equal(h.context.stockRef.current.ws.SMART.Proxy, 145);
  assert.equal(h.context.stockReadyRef.current, true);
  assert.equal(JSON.stringify([...h.disk]), h.originalDisk);
});

test('server timeouts use a complete local snapshot instead of showing zero records', async () => {
  const h = harness({cache:complete});
  await h.boot();
  assert.equal(h.state.error, '');
  assert.equal(h.state.records[0].amount, 1000);
  assert.equal(h.context.stockRef.current.ws.SMART.Proxy, 145);
  assert.equal(h.context.stockReadyRef.current, true);
});

test('retry after server recovery clears the startup failure and loads the confirmed snapshot', async () => {
  const h = harness();
  await h.boot();
  assert.equal(h.state.error, 'GATEWAY_REQUEST_TIMEOUT');
  h.context.dbGet = async key => complete[key] ?? null;
  await h.boot();
  assert.equal(h.state.error, '');
  assert.equal(h.state.records[0].id, sale.id);
  assert.equal(h.context.stockRef.current.ws.SMART.Proxy, 145);
  assert.equal(h.context.stockReadyRef.current, true);
  assert.equal(h.writes, 0);
});

test('a genuinely empty server record list is accepted, but a missing file cannot revive cache', async () => {
  const h = harness({cache:complete, remote:{...complete,records:[]}});
  await h.boot();
  assert.equal(h.state.error, '');
  assert.equal(h.state.records.length, 0);
  const missing = harness({cache:complete, remote:{...complete,records:null}});
  await missing.boot();
  assert.equal(missing.state.error, 'SERVER_DATA_MISSING');
  assert.equal(missing.context.stockReadyRef.current, false);
});
