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

// LEGACY_RECORD_DEDUP_V1
function fnv1a64(text) {
  const bytes = new TextEncoder().encode(String(text));
  let hash = 0xcbf29ce484222325n;
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, "0");
}

export function legacyRecordFingerprint(record) {
  if (!record || typeof record !== "object") return null;
  const value = {};
  for (const [key, item] of Object.entries(record)) {
    // Sync metadata is not part of the original sale identity. Ignoring it lets
    // an old no-id snapshot match the same migrated record after metadata was added.
    if (key === "id" || key === "legacyFingerprint" || key === "revision" ||
        key === "updatedAt" || key === "lastMutationId") continue;
    value[key] = item;
  }
  return fnv1a64(canonicalJson(value));
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

export function recordRevision(record) {
  if (!record || typeof record !== "object") return 0;
  const value = Number(record.revision);
  if (Number.isInteger(value) && value >= 0) return value;
  return record.id ? 1 : 0;
}

export function findRecordsMissingCreateEffect(records, stockOps, recordEffectAnchors = []) {
  const knownOpIds = new Set(
    [...(Array.isArray(stockOps) ? stockOps : []),
      ...(Array.isArray(recordEffectAnchors) ? recordEffectAnchors : [])]
      .map(op => typeof op?.opId === "string" ? op.opId : "")
      .filter(Boolean),
  );
  const seenRecordIds = new Set();
  const missing = [];

  for (const record of Array.isArray(records) ? records : []) {
    if (!record || typeof record !== "object" || typeof record.id !== "string" || !record.id) continue;
    if (seenRecordIds.has(record.id) || recordRevision(record) !== 1) continue;
    seenRecordIds.add(record.id);

    const mutationId = typeof record.lastMutationId === "string" ? record.lastMutationId.trim() : "";
    if (!mutationId || !mutationId.startsWith(`mut-${record.id}-`)) continue;
    if (knownOpIds.has(`record-effect:${mutationId}`)) continue;
    missing.push(record);
  }

  return missing;
}

export function sameRecordVersion(current, opened) {
  if (!current || !opened || typeof current !== "object" || typeof opened !== "object") return false;
  if (current.id || opened.id) {
    if (!current.id || current.id !== opened.id) return false;
  }
  return recordRevision(current) === recordRevision(opened)
    && String(current.lastMutationId || "") === String(opened.lastMutationId || "")
    && recordVersion(current) === recordVersion(opened);
}

function compareRecordState(candidate, previous) {
  const revisionDiff = recordRevision(candidate) - recordRevision(previous);
  if (revisionDiff) return revisionDiff;
  const versionDiff = recordVersion(candidate) - recordVersion(previous);
  if (versionDiff) return versionDiff;
  const mutationDiff = String(candidate?.lastMutationId || "").localeCompare(String(previous?.lastMutationId || ""));
  if (mutationDiff) return mutationDiff;
  return canonicalJson(candidate).localeCompare(canonicalJson(previous));
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
  const modern = new Map();
  const legacy = [];

  for (const record of [...remoteItems, ...localItems]) {
    if (!record || typeof record !== "object") continue;
    if (!record.id) {
      legacy.push(record);
      continue;
    }
    if (deleted.has(record.id)) continue;
    const key = `id:${record.id}`;
    const previous = modern.get(key);
    if (!previous || compareRecordState(record, previous) >= 0) modern.set(key, record);
  }

  const claimedFingerprints = new Set();
  const exactModernByFingerprint = new Map();
  for (const [key, record] of modern.entries()) {
    if (typeof record.legacyFingerprint === "string" && record.legacyFingerprint) {
      claimedFingerprints.add(record.legacyFingerprint);
    }

    // A migrated record may have lost legacyFingerprint in an old snapshot. Its
    // current canonical contents still claim an exactly matching no-id copy.
    const exactFingerprint = legacyRecordFingerprint(record);
    if (exactFingerprint) {
      claimedFingerprints.add(exactFingerprint);
      if (!exactModernByFingerprint.has(exactFingerprint)) exactModernByFingerprint.set(exactFingerprint, []);
      exactModernByFingerprint.get(exactFingerprint).push(key);
    }
  }

  const legacyMap = new Map();
  for (const record of legacy) {
    const fingerprint = legacyRecordFingerprint(record);
    if (fingerprint && claimedFingerprints.has(fingerprint)) {
      // Restore the durable original fingerprint when exactly one modern record
      // matches. Future edits can then reject this stale copy by the stored claim.
      const exactMatches = exactModernByFingerprint.get(fingerprint) || [];
      if (exactMatches.length === 1) {
        const key = exactMatches[0];
        const modernRecord = modern.get(key);
        if (modernRecord && !modernRecord.legacyFingerprint) {
          modern.set(key, { ...modernRecord, legacyFingerprint: fingerprint });
        }
      }
      continue;
    }
    const key = recordKey(record);
    if (!key) continue;
    const previous = legacyMap.get(key);
    if (!previous || compareRecordState(record, previous) >= 0) legacyMap.set(key, record);
  }

  return [...modern.values(), ...legacyMap.values()].sort((a, b) => {
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
    mutationId: op.mutationId,
    baseMutationId: op.baseMutationId,
    baseRevision: op.baseRevision,
    revision: op.revision,
    mutationKind: op.mutationKind,
    before: op.before,
    after: op.after,
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

function recordMutationPriority(op) {
  return op?.mutationKind === "delete" ? 1 : 0;
}

function compareRecordEffectTerminal(candidate, previous) {
  const deleteDiff = recordMutationPriority(candidate) - recordMutationPriority(previous);
  if (deleteDiff) return deleteDiff;
  const revisionDiff = Number(candidate.revision) - Number(previous.revision);
  if (revisionDiff) return revisionDiff;
  const timeDiff = Number(candidate.updatedAt ?? candidate.ts ?? 0) - Number(previous.updatedAt ?? previous.ts ?? 0);
  if (timeDiff) return timeDiff;
  return String(candidate.mutationId).localeCompare(String(previous.mutationId));
}

function cloneStockBucket(value) {
  const result = {};
  if (!isPlainObject(value)) return result;
  for (const [marker, raw] of Object.entries(value)) {
    const amount = Number(raw);
    if (typeof marker === "string" && marker.trim() && Number.isFinite(amount)) {
      result[marker] = amount;
    }
  }
  return result;
}

function initialStockState(baseStock, workshops) {
  const result = {
    main: cloneStockBucket(baseStock?.main),
    ws: {},
  };
  for (const workshop of workshops) {
    result.ws[workshop] = cloneStockBucket(baseStock?.ws?.[workshop]);
  }
  return result;
}

function normalizeRenameAliases(value) {
  const result = {};
  if (!isPlainObject(value)) return result;
  for (const [oldMarker, newMarker] of Object.entries(value)) {
    const oldName = typeof oldMarker === "string" ? oldMarker.trim() : "";
    const newName = typeof newMarker === "string" ? newMarker.trim() : "";
    if (oldName && newName && oldName !== newName) result[oldName] = newName;
  }
  return result;
}

function traceRecordEffectChain(candidate, byMutationId) {
  const reversed = [];
  const visited = new Set();
  let current = candidate;
  while (current) {
    if (visited.has(current.mutationId)) return null;
    visited.add(current.mutationId);
    reversed.push(current);
    const parentId = typeof current.baseMutationId === "string" ? current.baseMutationId : "";
    if (!parentId) return reversed.reverse();
    const parent = byMutationId.get(parentId);
    if (!parent || Number(parent.revision) !== Number(current.baseRevision)) return null;
    current = parent;
  }
  return null;
}

export function selectRecordEffectOps(ops) {
  const groups = new Map();
  for (const op of Array.isArray(ops) ? ops : []) {
    if (!op || op.type !== "record-effect" || !op.recordId || !op.mutationId) continue;
    const baseRevision = Number(op.baseRevision);
    const revision = Number(op.revision);
    if (!Number.isInteger(baseRevision) || baseRevision < 0 ||
        !Number.isInteger(revision) || revision <= baseRevision) continue;
    if (!groups.has(op.recordId)) groups.set(op.recordId, []);
    groups.get(op.recordId).push(op);
  }

  const selected = [];
  for (const recordOps of groups.values()) {
    const byMutationId = new Map(recordOps.map(op => [op.mutationId, op]));
    const candidates = [...recordOps].sort((a, b) => compareRecordEffectTerminal(b, a));
    for (const candidate of candidates) {
      const chain = traceRecordEffectChain(candidate, byMutationId);
      if (!chain) continue;
      selected.push(...chain);
      break;
    }
  }

  const unique = new Map();
  for (const op of selected) {
    const identity = stockOpIdentity(op);
    if (identity && !unique.has(identity)) unique.set(identity, op);
  }
  return [...unique.values()].sort((a, b) =>
    Number(a?.ts || 0) - Number(b?.ts || 0) ||
    String(stockOpIdentity(a)).localeCompare(String(stockOpIdentity(b)))
  );
}

export function replayStockOps(ops, options = {}) {
  const workshops = Array.isArray(options.workshops) && options.workshops.length
    ? options.workshops
    : DEFAULT_WORKSHOPS;
  const minTimestamp = Number.isFinite(options.minTimestamp)
    ? options.minTimestamp
    : new Date("2020-01-01T00:00:00Z").getTime();

  const result = initialStockState(options.baseStock, workshops);
  if (!Array.isArray(ops)) return { stock: result, renameAliases: normalizeRenameAliases(options.renameAliases) };

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
  const recordEffectPrelude = Array.isArray(options.recordEffectPrelude)
    ? options.recordEffectPrelude
    : [];
  const selectedRecordEffectIds = new Set(
    selectRecordEffectOps([...recordEffectPrelude, ...sortedOps])
      .map(op => stockOpIdentity(op))
      .filter(Boolean)
  );

  const renamedTo = new Map(Object.entries(normalizeRenameAliases(options.renameAliases)));
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
  const applyRecordEffect = (effect, multiplier) => {
    if (!effect || typeof effect !== "object") return;
    const bucket = getBucket(effect.location);
    const marker = resolveMarker(effect.marker);
    const qty = Number(effect.qty);
    if (!bucket || !marker || !Number.isFinite(qty) || qty <= 0) return;
    bucket[marker] = (Number(bucket[marker]) || 0) + multiplier * qty;
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

      if (op.type === "record-effect") {
        if (!selectedRecordEffectIds.has(stockOpIdentity(op))) continue;
        applyRecordEffect(op.before, 1);
        applyRecordEffect(op.after, -1);
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

  const renameAliases = {};
  for (const oldMarker of renamedTo.keys()) {
    const newMarker = resolveMarker(oldMarker);
    if (newMarker && oldMarker !== newMarker) renameAliases[oldMarker] = newMarker;
  }
  return { stock: result, renameAliases };
}

export function applyOpsToStock(ops, options = {}) {
  return replayStockOps(ops, options).stock;
}

export function normalizeStockCheckpoint(value, options = {}) {
  if (!isPlainObject(value) || Number(value.schemaVersion) !== 4) return null;
  const epoch = Number(value.epoch);
  const cutoffTs = Number(value.cutoffTs);
  if (!Number.isInteger(epoch) || epoch < 1 || !Number.isFinite(cutoffTs)) return null;
  const workshops = Array.isArray(options.workshops) && options.workshops.length
    ? options.workshops
    : DEFAULT_WORKSHOPS;
  return {
    schemaVersion: 4,
    epoch,
    cutoffTs,
    createdAt: typeof value.createdAt === "string" ? value.createdAt : null,
    stock: initialStockState(value.stock, workshops),
    renameAliases: normalizeRenameAliases(value.renameAliases),
    recordEffectAnchors: Array.isArray(value.recordEffectAnchors)
      ? value.recordEffectAnchors.filter(op => op && typeof op === "object")
      : [],
    archive: isPlainObject(value.archive) ? value.archive : {},
  };
}

export function applyStockCheckpoint(checkpoint, hotOps, options = {}) {
  const normalized = normalizeStockCheckpoint(checkpoint, options);
  if (!normalized) return applyOpsToStock(hotOps, options);
  return replayStockOps(hotOps, {
    ...options,
    baseStock: normalized.stock,
    renameAliases: normalized.renameAliases,
    recordEffectPrelude: normalized.recordEffectAnchors,
  }).stock;
}

export function normalizeStockJournal(value, checkpoint, options = {}) {
  const normalizedCheckpoint = normalizeStockCheckpoint(checkpoint, options);
  if (!normalizedCheckpoint) {
    if (value === null || value === undefined) return { schemaVersion: 3, epoch: 0, ops: [] };
    if (!Array.isArray(value)) throw new Error("STOCK_CHECKPOINT_REQUIRED");
    return { schemaVersion: 3, epoch: 0, ops: mergeStockOps([], value) };
  }
  if (!isPlainObject(value) || Number(value.schemaVersion) !== 4 ||
      Number(value.epoch) !== normalizedCheckpoint.epoch || !Array.isArray(value.ops)) {
    throw new Error("STOCK_ARCHIVE_EPOCH_MISMATCH");
  }
  const ops = mergeStockOps([], value.ops);
  for (const op of ops) {
    if (Number(op?.ts) < normalizedCheckpoint.cutoffTs &&
        Number(op?.archiveEpoch) !== normalizedCheckpoint.epoch) {
      throw new Error("STOCK_ARCHIVE_LATE_OPERATION_UNSTAMPED");
    }
  }
  return { schemaVersion: 4, epoch: normalizedCheckpoint.epoch, ops };
}

export function createStockJournal(ops, checkpoint, options = {}) {
  const normalizedCheckpoint = normalizeStockCheckpoint(checkpoint, options);
  const normalizedOps = mergeStockOps([], Array.isArray(ops) ? ops : []);
  if (!normalizedCheckpoint) return normalizedOps;
  return {
    schemaVersion: 4,
    epoch: normalizedCheckpoint.epoch,
    ops: normalizedOps,
  };
}

export function mergeStockJournals(remote, local, checkpoint, options = {}) {
  const remoteJournal = normalizeStockJournal(remote, checkpoint, options);
  const localJournal = normalizeStockJournal(local, checkpoint, options);
  return createStockJournal(mergeStockOps(remoteJournal.ops, localJournal.ops), checkpoint, options);
}

function terminalRecordEffectAnchors(ops) {
  const byRecord = new Map();
  for (const op of selectRecordEffectOps(ops)) {
    const previous = byRecord.get(op.recordId);
    if (!previous || compareRecordEffectTerminal(op, previous) >= 0) byRecord.set(op.recordId, op);
  }
  return [...byRecord.values()].map(op => ({
    ...op,
    baseMutationId: null,
    checkpointAnchor: true,
  }));
}

export function createStockArchivePlan(ops, cutoffTs, options = {}) {
  const cutoff = Number(cutoffTs);
  if (!Array.isArray(ops) || !Number.isFinite(cutoff)) throw new Error("STOCK_ARCHIVE_INPUT_INVALID");
  const archivedOps = mergeStockOps([], ops.filter(op => Number(op?.ts) < cutoff));
  const hotOps = mergeStockOps([], ops.filter(op => Number(op?.ts) >= cutoff));
  const prefix = replayStockOps(archivedOps, options);
  const checkpoint = {
    schemaVersion: 4,
    epoch: Number.isInteger(options.epoch) && options.epoch > 0 ? options.epoch : 1,
    cutoffTs: cutoff,
    createdAt: typeof options.createdAt === "string" ? options.createdAt : new Date().toISOString(),
    stock: prefix.stock,
    renameAliases: prefix.renameAliases,
    recordEffectAnchors: terminalRecordEffectAnchors(archivedOps),
    archive: {
      opCount: archivedOps.length,
      firstTs: archivedOps.length ? Number(archivedOps[0].ts) : null,
      lastTs: archivedOps.length ? Number(archivedOps.at(-1).ts) : null,
    },
  };
  return { checkpoint, archivedOps, hotOps };
}

export function classifyLateStockOps(checkpoint, hotOps, options = {}) {
  const normalized = normalizeStockCheckpoint(checkpoint, options);
  if (!normalized || !Array.isArray(hotOps)) return { safe: [], blocking: [] };
  const safeTypes = new Set(["delta", "move"]);
  const safe = [];
  const blocking = [];
  for (const op of hotOps) {
    if (!op || Number(op.ts) >= normalized.cutoffTs) continue;
    (safeTypes.has(op.type) ? safe : blocking).push(op);
  }
  return { safe, blocking };
}

function itemVersion(item) {
  if (!item || typeof item !== "object") return 0;
  for (const key of ["updatedAt", "deletedAt", "timestamp", "ts"]) {
    const value = Number(item[key]);
    if (Number.isFinite(value)) return value;
  }
  return 0;
}

function compareVersionedItems(candidate, previous) {
  const candidateRevision = Number.isInteger(Number(candidate?.revision)) ? Number(candidate.revision) : 0;
  const previousRevision = Number.isInteger(Number(previous?.revision)) ? Number(previous.revision) : 0;
  if (candidateRevision !== previousRevision) return candidateRevision - previousRevision;
  const timeDiff = itemVersion(candidate) - itemVersion(previous);
  if (timeDiff) return timeDiff;
  return String(candidate?.mutationId || candidate?.lastMutationId || "")
    .localeCompare(String(previous?.mutationId || previous?.lastMutationId || ""));
}

export function mergeById(remote, local) {
  const remoteItems = Array.isArray(remote) ? remote : [];
  const localItems = Array.isArray(local) ? local : [];
  const map = new Map();
  for (const item of [...remoteItems, ...localItems]) {
    if (!item || typeof item !== "object") continue;
    const id = item.id || `legacy:${canonicalJson(item)}`;
    const previous = map.get(id);
    if (!previous || compareVersionedItems(item, previous) >= 0) map.set(id, item);
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
