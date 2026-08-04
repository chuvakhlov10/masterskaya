export const DEFAULT_WORKSHOPS = ["SMART", "Бегемот"];

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isPlainObject(value)) return value;
  const result = {};
  for (const key of Object.keys(value).sort()) result[key] = canonicalize(value[key]);
  return result;
}

function canonicalJson(value) {
  try { return JSON.stringify(canonicalize(value)); }
  catch { return String(value); }
}

export function recordKey(record) {
  if (!record || typeof record !== "object") return null;
  if (record.id) return `id:${record.id}`;
  return `legacy:${canonicalJson({
    ts: record.timestamp,
    workshop: record.workshop,
    marker: record.marker,
    qty: record.qty,
    defect: record.defect,
    amount: record.amount,
    recordType: record.recordType,
    category: record.category,
    comment: record.comment,
  })}`;
}

export function recordVersion(record) {
  if (!record || typeof record !== "object") return 0;
  const value = Number(record.updatedAt ?? record.timestamp ?? 0);
  return Number.isFinite(value) ? value : 0;
}


// Finds the exact record selected by the user. Modern records are resolved by
// immutable id. Legacy records without id may be resolved only when their
// canonical identity is unique; ambiguous duplicates are deliberately rejected.
export function findRecordIndex(records, target) {
  const items = Array.isArray(records) ? records : [];
  if (!target || typeof target !== "object") return -1;

  if (target.id) {
    return items.findIndex(item => item && item.id === target.id);
  }

  const sameReference = items.findIndex(item => item === target);
  if (sameReference >= 0) return sameReference;

  const key = recordKey(target);
  if (!key) return -1;
  const matches = [];
  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    if (!item || item.id) continue;
    if (recordKey(item) === key) matches.push(index);
  }
  return matches.length === 1 ? matches[0] : -1;
}

export function mergeRecords(remote, local, deletedIds = new Set()) {
  const remoteItems = Array.isArray(remote) ? remote : [];
  const localItems = Array.isArray(local) ? local : [];
  const deleted = deletedIds instanceof Set ? deletedIds : new Set(deletedIds || []);
  const map = new Map();

  for (const record of [...remoteItems, ...localItems]) {
    const key = recordKey(record);
    if (!key) continue;
    if (record.id && deleted.has(record.id)) continue;
    const previous = map.get(key);
    if (!previous || recordVersion(record) >= recordVersion(previous)) map.set(key, record);
  }

  return [...map.values()].sort((a, b) => {
    const ts = Number(a?.timestamp || 0) - Number(b?.timestamp || 0);
    return ts || String(recordKey(a)).localeCompare(String(recordKey(b)));
  });
}

export function stockOpIdentity(op) {
  if (!op || typeof op !== "object") return null;
  if (typeof op.opId === "string" && op.opId.trim()) return `id:${op.opId}`;
  // Старые операции без opId тоже должны дедуплицироваться, но ключ обязан
  // учитывать количество/значение/назначение. Иначе две реальные операции
  // с одинаковым временем могли ошибочно считаться одной.
  return `legacy:${canonicalJson({
    type: op.type,
    ts: op.ts,
    client: op.client,
    location: op.location,
    from: op.from,
    to: op.to,
    marker: op.marker,
    oldMarker: op.oldMarker,
    newMarker: op.newMarker,
    value: op.value,
    delta: op.delta,
    qty: op.qty,
    recordId: op.recordId,
    reason: op.reason,
  })}`;
}

export function mergeStockOps(remote, local) {
  const remoteItems = Array.isArray(remote) ? remote : [];
  const localItems = Array.isArray(local) ? local : [];
  const map = new Map();

  for (const op of [...remoteItems, ...localItems]) {
    const identity = stockOpIdentity(op);
    if (!identity) continue;
    // Операции immutable. При одинаковом opId оставляем первую серверную копию,
    // чтобы повреждённая локальная копия не могла изменить уже подтверждённую op.
    if (!map.has(identity)) map.set(identity, op);
  }

  return [...map.values()].sort((a, b) => {
    const tsA = Number.isFinite(Number(a?.ts)) ? Number(a.ts) : 0;
    const tsB = Number.isFinite(Number(b?.ts)) ? Number(b.ts) : 0;
    return (tsA - tsB) || String(stockOpIdentity(a)).localeCompare(String(stockOpIdentity(b)));
  });
}

function parseLocation(location, workshops) {
  if (location === "main") return { scope: "main", workshop: null };
  if (typeof location !== "string" || !location.startsWith("ws:")) return null;
  const workshop = location.slice(3);
  return workshops.includes(workshop) ? { scope: "ws", workshop } : null;
}

export function applyOpsToStock(ops, options = {}) {
  const workshops = Array.isArray(options.workshops) && options.workshops.length
    ? options.workshops
    : DEFAULT_WORKSHOPS;
  const minTimestamp = Number.isFinite(options.minTimestamp)
    ? options.minTimestamp
    : new Date("2020-01-01T00:00:00Z").getTime();

  const result = { main: {}, ws: {} };
  for (const workshop of workshops) result.ws[workshop] = {};
  if (!Array.isArray(ops)) return result;

  // Не отбрасываем операции только из-за часов, ушедших вперёд. Иначе остаток
  // сначала исчезает, а спустя дни внезапно появляется. Время используется лишь
  // для детерминированного порядка legacy set/rename операций.
  const validOps = ops.filter(op => {
    const ts = Number(op?.ts);
    return op && typeof op === "object" && typeof op.type === "string" &&
      Number.isFinite(ts) && ts >= minTimestamp;
  });
  const sortedOps = [...validOps].sort((a, b) => {
    const tsDiff = Number(a.ts) - Number(b.ts);
    return tsDiff || String(stockOpIdentity(a)).localeCompare(String(stockOpIdentity(b)));
  });

  const renamedTo = new Map();
  const resolveMarker = (marker) => {
    if (typeof marker !== "string" || !marker.trim()) return null;
    let current = marker.trim();
    const visited = new Set();
    while (renamedTo.has(current)) {
      if (visited.has(current)) return null;
      visited.add(current);
      current = renamedTo.get(current);
    }
    return current;
  };
  const getBucket = (location) => {
    const parsed = parseLocation(location, workshops);
    if (!parsed) return null;
    return parsed.scope === "main" ? result.main : result.ws[parsed.workshop];
  };

  for (const op of sortedOps) {
    try {
      if (op.type === "rename") {
        const oldMarker = resolveMarker(op.oldMarker);
        const newMarker = resolveMarker(op.newMarker);
        if (!oldMarker || !newMarker || oldMarker === newMarker) continue;
        renamedTo.set(oldMarker, newMarker);
        for (const bucket of [result.main, ...workshops.map(ws => result.ws[ws])]) {
          if (!Object.prototype.hasOwnProperty.call(bucket, oldMarker)) continue;
          bucket[newMarker] = (Number(bucket[newMarker]) || 0) + (Number(bucket[oldMarker]) || 0);
          delete bucket[oldMarker];
        }
        continue;
      }

      const marker = resolveMarker(op.marker);
      if (!marker) continue;

      if (op.type === "set" || op.type === "init") {
        const bucket = getBucket(op.location);
        const value = Number(op.value);
        if (!bucket || !Number.isFinite(value)) continue;
        bucket[marker] = value;
      } else if (op.type === "delta") {
        const bucket = getBucket(op.location);
        const delta = Number(op.delta);
        if (!bucket || !Number.isFinite(delta)) continue;
        bucket[marker] = (Number(bucket[marker]) || 0) + delta;
      } else if (op.type === "move") {
        const from = getBucket(op.from);
        const to = getBucket(op.to);
        const qty = Number(op.qty);
        if (!from || !to || from === to || !Number.isFinite(qty) || qty <= 0) continue;
        from[marker] = (Number(from[marker]) || 0) - qty;
        to[marker] = (Number(to[marker]) || 0) + qty;
      }
    } catch (error) {
      console.warn("[applyOpsToStock] skipping malformed op:", op, error?.message || error);
    }
  }

  return result;
}

function itemVersion(item) {
  if (!item || typeof item !== "object") return 0;
  for (const key of ["updatedAt", "deletedAt", "timestamp", "ts"]) {
    const value = Number(item[key]);
    if (Number.isFinite(value)) return value;
  }
  return 0;
}

export function mergeById(remote, local) {
  const remoteItems = Array.isArray(remote) ? remote : [];
  const localItems = Array.isArray(local) ? local : [];
  const map = new Map();
  for (const item of [...remoteItems, ...localItems]) {
    if (!item || typeof item !== "object") continue;
    const id = item.id || `legacy:${canonicalJson(item)}`;
    const previous = map.get(id);
    if (!previous || itemVersion(item) >= itemVersion(previous)) map.set(id, item);
  }
  return [...map.values()];
}

export function mergeObject(remote, local) {
  if (!isPlainObject(remote)) return isPlainObject(local) ? local : {};
  if (!isPlainObject(local)) return remote;
  return { ...remote, ...local };
}

export function createObjectPatch(before, after) {
  const oldValue = isPlainObject(before) ? before : {};
  const newValue = isPlainObject(after) ? after : {};
  const set = {};
  const remove = [];
  for (const [key, value] of Object.entries(newValue)) {
    if (!Object.prototype.hasOwnProperty.call(oldValue, key) || canonicalJson(oldValue[key]) !== canonicalJson(value)) {
      set[key] = value;
    }
  }
  for (const key of Object.keys(oldValue)) {
    if (!Object.prototype.hasOwnProperty.call(newValue, key)) remove.push(key);
  }
  return { set, remove };
}

export function mergeObjectPatches(first, second) {
  const result = {
    set: { ...(first?.set || {}) },
    remove: [...new Set(first?.remove || [])],
  };
  for (const key of second?.remove || []) {
    delete result.set[key];
    if (!result.remove.includes(key)) result.remove.push(key);
  }
  for (const [key, value] of Object.entries(second?.set || {})) {
    result.set[key] = value;
    result.remove = result.remove.filter(item => item !== key);
  }
  return result;
}

export function applyObjectPatch(remote, patch) {
  const result = isPlainObject(remote) ? { ...remote } : {};
  for (const key of patch?.remove || []) delete result[key];
  for (const [key, value] of Object.entries(patch?.set || {})) result[key] = value;
  return result;
}
