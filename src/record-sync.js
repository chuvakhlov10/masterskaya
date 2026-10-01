import { mergeRecords, recordKey } from "./sync-core.js";

// The durable queue needs the changed records, not another copy of the history.
export function compactRecordWrite(before, next, pending = []) {
  const previous = new Map((Array.isArray(before) ? before : []).map(record => [recordKey(record), record]));
  const changes = (Array.isArray(next) ? next : []).filter(record => {
    const old = previous.get(recordKey(record));
    return !old || JSON.stringify(old) !== JSON.stringify(record);
  });
  return mergeRecords(pending, changes);
}

// A GET started before a PUT can complete after the PUT has cleared the queue.
// Known records still belong in the view until an explicit tombstone removes them.
export function mergeRecordRefresh(remote, current, pending = [], deletedIds = new Set()) {
  return mergeRecords(remote, mergeRecords(current, pending, deletedIds), deletedIds);
}

export function persistPendingWrites(storage, queue) {
  const encoded = JSON.stringify(queue);
  try {
    storage.setItem("pending_writes", encoded);
    return;
  } catch (firstError) {
    // Only disposable read caches are evicted. The stock journal, durable queues
    // and the legacy records recovery copy must survive a failed write.
    try {
      for (let i = storage.length - 1; i >= 0; i--) {
        const key = storage.key(i);
        if (key?.startsWith("offline_cache_")) storage.removeItem(key);
      }
      storage.setItem("pending_writes", encoded);
      return;
    } catch (cause) {
      const error = new Error("LOCAL_QUEUE_STORAGE_FAILED");
      error.cause = cause || firstError;
      throw error;
    }
  }
}

// Both local intents must survive before the form can report success. Persist
// the record first so a quota failure cannot leave an orphan stock deduction.
export function persistRecordMutation({ persistRecord, persistStockEffect, rollbackRecord, startDelivery }) {
  const queueId = persistRecord();
  let staged;
  try {
    staged = persistStockEffect();
  } catch (error) {
    rollbackRecord(queueId);
    throw error;
  }
  if (!staged?.ok) {
    rollbackRecord(queueId);
    return staged || { ok:false };
  }
  return { ok:true, savePromise:startDelivery(queueId) };
}
