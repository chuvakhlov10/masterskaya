import test from 'node:test';
import assert from 'node:assert/strict';

import {
  STOCK_OUTBOX_QUARANTINE_KEY,
  appendStockOutboxQuarantine,
  countQuarantinedStockOps,
  readStockOutboxQuarantine,
} from '../src/stock-outbox-quarantine.js';

class MemoryStorage {
  constructor(initial = {}) { this.values = new Map(Object.entries(initial)); }
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
  setItem(key, value) { this.values.set(key, String(value)); }
}

test('blocked operations are preserved in a versioned quarantine batch', () => {
  const storage = new MemoryStorage();
  const result = appendStockOutboxQuarantine({
    operations: [{ opId: 'legacy-1', type: 'init', ts: 10 }, { opId: 'legacy-2', type: 'delta', ts: 20 }],
    checkpoint: { epoch: 1, cutoffTs: 100 },
    storage,
    now: 200,
  });

  assert.equal(result.added.length, 2);
  assert.equal(result.totalOperations, 2);
  assert.equal(countQuarantinedStockOps(storage), 2);
  const stored = readStockOutboxQuarantine(storage);
  assert.equal(stored.batches[0].reason, 'PRE_CHECKPOINT_UNKNOWN');
  assert.equal(stored.batches[0].checkpointEpoch, 1);
  assert.equal(stored.batches[0].cutoffTs, 100);
  assert.deepEqual(stored.batches[0].operations.map(operation => operation.opId), ['legacy-1', 'legacy-2']);
});

test('repeated quarantine attempts deduplicate by operation id', () => {
  const storage = new MemoryStorage();
  appendStockOutboxQuarantine({
    operations: [{ opId: 'legacy-1', ts: 10 }],
    checkpoint: { epoch: 1, cutoffTs: 100 },
    storage,
    now: 200,
  });
  const second = appendStockOutboxQuarantine({
    operations: [{ opId: 'legacy-1', ts: 10 }, { opId: 'legacy-2', ts: 20 }],
    checkpoint: { epoch: 1, cutoffTs: 100 },
    storage,
    now: 300,
  });

  assert.deepEqual(second.added.map(operation => operation.opId), ['legacy-2']);
  assert.equal(second.totalOperations, 2);
  assert.equal(readStockOutboxQuarantine(storage).batches.length, 2);
});

test('failed quarantine persistence throws so the caller keeps the active outbox', () => {
  const storage = new MemoryStorage();
  storage.setItem = () => { throw new Error('QuotaExceededError'); };

  assert.throws(
    () => appendStockOutboxQuarantine({
      operations: [{ opId: 'legacy-1', ts: 10 }],
      checkpoint: { epoch: 1, cutoffTs: 100 },
      storage,
    }),
    /QuotaExceededError/,
  );
  assert.equal(storage.getItem(STOCK_OUTBOX_QUARANTINE_KEY), null);
});
