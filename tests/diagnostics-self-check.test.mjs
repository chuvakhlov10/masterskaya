import test from 'node:test';
import assert from 'node:assert/strict';

import {
  readDiagnosticMetrics,
  recordStorageRequestResult,
} from '../src/diagnostics.js';

class MemoryStorage {
  constructor() { this.values = new Map(); }
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}

test('backup status self-check does not replace the last working operation', () => {
  const storage = new MemoryStorage();
  recordStorageRequestResult({
    ok: true,
    operation: 'PUT data/records.json',
    retries: 1,
    now: 1000,
    storage,
  });
  recordStorageRequestResult({
    ok: true,
    operation: 'GET status.json',
    retries: 0,
    now: 2000,
    storage,
  });

  const metrics = readDiagnosticMetrics(storage);
  assert.equal(metrics.lastStorageOperation, 'PUT data/records.json');
  assert.equal(metrics.lastStorageSuccessAt, 1000);
  assert.equal(metrics.lastStorageRetries, 1);
  assert.equal(metrics.totalStorageRetries, 1);
});
