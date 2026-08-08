import test from 'node:test';
import assert from 'node:assert/strict';

import { readDiagnosticMetrics } from '../src/diagnostics.js';
import { dbSet } from '../src/github-storage.js';

class MemoryStorage {
  constructor(initial = {}) { this.values = new Map(Object.entries(initial)); }
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}

function response(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return payload; },
  };
}

test('dbSet promotes a retried 409 to an automatically resolved conflict', async () => {
  const originalFetch = globalThis.fetch;
  const originalStorage = globalThis.localStorage;
  const originalRandom = Math.random;
  const storage = new MemoryStorage({
    masterskaya_storage_session_v1: JSON.stringify({
      token: 'header.payload.signature',
      expiresAt: 1_900_000_000_000,
      clientId: 'web-device-12345678',
    }),
  });
  const calls = [];
  let putCount = 0;

  globalThis.localStorage = storage;
  Math.random = () => 0;
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    calls.push({ method: body.method, path: body.path });
    if (body.method === 'GET') {
      return response({ sha: `${calls.length}`.padStart(40, 'a'), content: 'W10=' });
    }
    putCount += 1;
    if (putCount === 1) return response({ error: 'GATEWAY_HTTP_409' }, 409);
    return response({ content: { sha: 'b'.repeat(40) } });
  };

  try {
    const result = await dbSet('stock-ops', [{ opId: 'local' }], (remote, local) => [...remote, ...local]);
    const metrics = readDiagnosticMetrics(storage);

    assert.equal(result.ok, true);
    assert.equal(putCount, 2);
    assert.deepEqual(calls.map(call => call.method), ['GET', 'PUT', 'GET', 'PUT']);
    assert.equal(metrics.lastStorageConflictState, 'resolved');
    assert.equal(metrics.lastStorageConflictOperation, 'PUT data/stock-ops.json');
    assert.equal(metrics.lastStorageConflictAttempts, 1);
    assert.equal(metrics.totalResolvedStorageConflicts, 1);
    assert.equal(metrics.activeStorageErrorCode, '');
    assert.equal(metrics.totalStorageRetries, 0);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.localStorage = originalStorage;
    Math.random = originalRandom;
  }
});
