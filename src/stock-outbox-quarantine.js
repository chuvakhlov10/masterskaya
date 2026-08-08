export const STOCK_OUTBOX_QUARANTINE_KEY = "stock_ops_quarantine_v1";

function safeJson(value, fallback) {
  try { return JSON.parse(String(value || "")); }
  catch { return fallback; }
}

function validOperation(value) {
  return value && typeof value === "object" && typeof value.opId === "string" && value.opId.trim();
}

function normalizeBatch(value) {
  if (!value || typeof value !== "object") return null;
  const operations = Array.isArray(value.operations) ? value.operations.filter(validOperation) : [];
  if (operations.length === 0) return null;
  return {
    id: String(value.id || `legacy-${Number(value.quarantinedAt) || 0}`),
    quarantinedAt: Number(value.quarantinedAt) || 0,
    reason: String(value.reason || "PRE_CHECKPOINT_UNKNOWN").slice(0, 80),
    checkpointEpoch: Math.max(0, Number(value.checkpointEpoch) || 0),
    cutoffTs: Number(value.cutoffTs) || null,
    operations,
  };
}

export function normalizeStockOutboxQuarantine(value) {
  const batches = (Array.isArray(value?.batches) ? value.batches : [])
    .map(normalizeBatch)
    .filter(Boolean);
  return {
    version: 1,
    updatedAt: Number(value?.updatedAt) || 0,
    batches,
  };
}

export function readStockOutboxQuarantine(storage = globalThis.localStorage) {
  try {
    return normalizeStockOutboxQuarantine(safeJson(storage?.getItem?.(STOCK_OUTBOX_QUARANTINE_KEY), null));
  } catch {
    return normalizeStockOutboxQuarantine(null);
  }
}

export function countQuarantinedStockOps(storage = globalThis.localStorage) {
  const ids = new Set();
  for (const batch of readStockOutboxQuarantine(storage).batches) {
    for (const operation of batch.operations) ids.add(operation.opId);
  }
  return ids.size;
}

// The quarantine is written and verified before callers remove anything from
// the active outbox. If localStorage is full or damaged, this throws and the
// original active queue remains untouched.
export function appendStockOutboxQuarantine({
  operations,
  checkpoint,
  storage = globalThis.localStorage,
  now = Date.now(),
} = {}) {
  const candidates = (Array.isArray(operations) ? operations : []).filter(validOperation);
  const current = readStockOutboxQuarantine(storage);
  const existingIds = new Set(
    current.batches.flatMap(batch => batch.operations.map(operation => operation.opId)),
  );
  const added = [];
  for (const operation of candidates) {
    if (existingIds.has(operation.opId)) continue;
    existingIds.add(operation.opId);
    added.push(operation);
  }

  if (added.length === 0) {
    return { quarantine: current, added: [], totalOperations: existingIds.size };
  }

  const epoch = Math.max(0, Number(checkpoint?.epoch) || 0);
  const batch = {
    id: `archive-${epoch}-${now}`,
    quarantinedAt: now,
    reason: "PRE_CHECKPOINT_UNKNOWN",
    checkpointEpoch: epoch,
    cutoffTs: Number(checkpoint?.cutoffTs) || null,
    operations: added,
  };
  const next = normalizeStockOutboxQuarantine({
    version: 1,
    updatedAt: now,
    batches: [...current.batches, batch],
  });

  storage.setItem(STOCK_OUTBOX_QUARANTINE_KEY, JSON.stringify(next));
  const verified = readStockOutboxQuarantine(storage);
  const verifiedIds = new Set(
    verified.batches.flatMap(item => item.operations.map(operation => operation.opId)),
  );
  if (added.some(operation => !verifiedIds.has(operation.opId))) {
    throw new Error("STOCK_OUTBOX_QUARANTINE_VERIFY_FAILED");
  }
  return { quarantine: verified, added, totalOperations: verifiedIds.size };
}
