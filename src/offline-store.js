import { mergeById, mergeRecords, mergeStockOps, normalizeStockCheckpoint, normalizeStockJournal } from './sync-core.js';

export const OFFLINE_DATA_KEYS = [
  'passwords', 'records', 'record-deletions', 'prices', 'stock-checkpoint', 'stock-ops',
  'stock:cfg', 'custom:markers', 'marker-aliases', 'marker-notes', 'subcategories', 'stock-moves',
];
const object = value => value && typeof value === 'object' && !Array.isArray(value);

// An incomplete download or two different archive epochs must never replace
// the last usable offline snapshot.
export function isCompleteOfflineData(data) {
  if (!object(data) || OFFLINE_DATA_KEYS.some(key => !Object.hasOwn(data, key))) return false;
  if (!object(data.passwords) || !Array.isArray(data.records) || !Array.isArray(data['record-deletions'])) return false;
  if(['prices','stock:cfg','custom:markers','marker-aliases','marker-notes','subcategories'].some(key => data[key] !== null && !object(data[key]))) return false;
  if(data['stock-moves'] !== null && !Array.isArray(data['stock-moves'])) return false;
  try {
    const checkpoint = normalizeStockCheckpoint(data['stock-checkpoint']);
    if (!checkpoint) return false;
    normalizeStockJournal(data['stock-ops'], checkpoint);
    return true;
  } catch { return false; }
}

export function readLegacyOfflineData(storage) {
  const data = {};
  for (const key of OFFLINE_DATA_KEYS) {
    try {
      const raw = storage?.getItem(key === 'stock-ops' ? 'stock_ops_local' : `offline_cache_${key}`);
      if (raw !== null && raw !== undefined) data[key] = JSON.parse(raw);
    } catch {}
  }
  return data;
}

function mergePatch(previous, patch) {
  const next = {...previous, ...patch};
  const oldJournal = previous?.['stock-ops'], journal = patch['stock-ops'];
  const oldEpoch = Math.max(Number(previous?.['stock-checkpoint']?.epoch)||0, Number(oldJournal?.epoch)||0);
  if(journal?.schemaVersion === 4 && oldJournal?.schemaVersion === 4) {
    if(journal.epoch < oldEpoch) next['stock-ops'] = oldJournal;
    else if(journal.epoch === oldJournal.epoch) next['stock-ops'] = {...journal,ops:mergeStockOps(oldJournal.ops,journal.ops)};
  }
  if(patch['stock-checkpoint']?.epoch < oldEpoch) next['stock-checkpoint'] = previous['stock-checkpoint'];
  if (Array.isArray(previous?.['record-deletions']) && Array.isArray(patch['record-deletions'])) {
    next['record-deletions'] = mergeById(previous['record-deletions'], patch['record-deletions']);
  }
  if (Array.isArray(patch.records)) {
    const deleted = new Set((next['record-deletions'] || []).map(item => item.id));
    next.records = mergeRecords(previous?.records || [], patch.records, deleted);
  }
  return next;
}

// One transaction stores the working set and, only when complete/consistent,
// advances the recovery snapshot. Separate tabs update keys rather than
// overwriting another tab's entire snapshot.
export function createOfflineStore({ indexedDB = globalThis.indexedDB, storage = globalThis.localStorage,
  name = 'masterskaya-offline-v1', now = Date.now } = {}) {
  let db, hydration, hydrated = false, values = {}, earlyPatches = [], tail = Promise.resolve();
  let persistenceRequested = false;
  let info = {ready:false, savedAt:null, error:''};
  const listeners = new Set();
  const notify = () => { for (const listener of listeners) listener({...info}); };
  function open() {
    return new Promise((resolve, reject) => {
      if (!indexedDB) { reject(new Error('OFFLINE_STORAGE_UNAVAILABLE')); return; }
      let settled = false;
      const request = indexedDB.open(name, 1);
      const timer = setTimeout(() => { settled = true; reject(new Error('OFFLINE_STORAGE_BLOCKED')); }, 3000);
      request.onupgradeneeded = () => request.result.createObjectStore('state');
      request.onerror = () => { clearTimeout(timer); reject(request.error); };
      request.onsuccess = () => {
        clearTimeout(timer);
        if (settled) { request.result.close(); return; }
        request.result.onversionchange = () => request.result.close();
        resolve(request.result);
      };
    });
  }
  function readSnapshot() {
    return new Promise((resolve, reject) => {
      const tx = db.transaction('state', 'readonly');
      const request = tx.objectStore('state').get('snapshot');
      tx.oncomplete = () => resolve(request.result);
      tx.onabort = () => reject(tx.error || new Error('OFFLINE_STORAGE_READ_FAILED'));
    });
  }
  function writePatch(patch) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction('state', 'readwrite');
      const state = tx.objectStore('state');
      const request = state.get('working');
      let snapshot;
      request.onsuccess = () => {
        const data = mergePatch(request.result || {}, patch);
        state.put(data, 'working');
        if (isCompleteOfflineData(data)) {
          snapshot = {version:1, savedAt:now(), data};
          state.put(snapshot, 'snapshot');
        }
      };
      tx.oncomplete = () => {
        if (snapshot) {
          info = {ready:true, savedAt:snapshot.savedAt, error:''};
          // These are duplicate read caches only. Recovery records and both
          // durable mutation queues are deliberately retained.
          for(const key of OFFLINE_DATA_KEYS) {
            try { storage?.removeItem(`offline_cache_${key}`); } catch {}
          }
          if(!persistenceRequested) {
            persistenceRequested = true;
            globalThis.navigator?.storage?.persist?.().catch(()=>{});
          }
          notify();
        }
        resolve(snapshot);
      };
      tx.onabort = () => reject(tx.error || new Error('OFFLINE_STORAGE_WRITE_FAILED'));
    });
  }
  async function hydrate() {
    if (hydration) return hydration;
    hydration = (async () => {
      values = readLegacyOfflineData(storage);
      try {
        db = await open();
        const snapshot = await readSnapshot();
        if (snapshot?.version === 1 && isCompleteOfflineData(snapshot.data)) {
          values = snapshot.data;
          info = {ready:true, savedAt:snapshot.savedAt, error:''};
        } else if (Object.keys(values).length) {
          await writePatch(values);
        }
      } catch (error) {
        info = {...info, error:error?.message || 'OFFLINE_STORAGE_UNAVAILABLE'};
      }
      for(const patch of earlyPatches) values = mergePatch(values, patch);
      earlyPatches = [];
      hydrated = true;
      notify();
      return {...info};
    })();
    return hydration;
  }
  function putBatch(patch) {
    const accepted = Object.fromEntries(Object.entries(patch).filter(([key]) => OFFLINE_DATA_KEYS.includes(key)));
    if(!hydrated) earlyPatches.push(accepted);
    // Do not turn a sparse record outbox into the cached history.
    values = mergePatch(values, accepted);
    const write = tail.catch(() => {}).then(async () => {
      await hydrate();
      if (!db) throw new Error('OFFLINE_STORAGE_UNAVAILABLE');
      return writePatch(accepted);
    });
    tail = write;
    write.catch(error => { info = {...info, error:error?.message || 'OFFLINE_STORAGE_WRITE_FAILED'}; notify(); });
    return write;
  }
  return {
    hydrate, putBatch, put:(key,value) => putBatch({[key]:value}),
    get:key => values[key], has:key => Object.hasOwn(values, key),
    hasComplete:() => isCompleteOfflineData(values), available:() => !!db,
    info:() => ({...info}), flush:() => tail,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    close() { db?.close(); },
  };
}

export const offlineStore = createOfflineStore();
