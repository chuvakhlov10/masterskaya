import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildDiagnosticReport,
  collectClientDiagnostics,
  readDiagnosticMetrics,
  readQueueBreakdown,
  recordSessionRenewal,
  recordStorageRequestResult,
} from '../src/diagnostics.js';

class MemoryStorage {
  constructor(initial = {}) { this.values = new Map(Object.entries(initial)); }
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}

const SESSION_TOKEN = 'header.payload.signature';

function storageFixture() {
  return new MemoryStorage({
    masterskaya_storage_session_v1: JSON.stringify({
      token: SESSION_TOKEN,
      expiresAt: 1_900_000_000_000,
      clientId: 'web-device-secret-12345678',
    }),
    masterskaya_device_name_v1: 'Ноутбук',
    pending_writes: JSON.stringify([{ key: 'records' }]),
    stock_ops_outbox_v1: JSON.stringify([{ opId: 'one' }, { opId: 'two' }]),
    last_successful_sync_v1: '1800000000000',
    unrelated_secret_v1: 'must_never_appear',
  });
}

test('queue breakdown separates data and stock operations', () => {
  const queues = readQueueBreakdown(storageFixture());
  assert.deepEqual(queues, {
    dataOperations: 1,
    stockOperations: 2,
    totalOperations: 3,
  });
});

test('storage metrics retain safe result codes and retry counters', () => {
  const storage = storageFixture();
  recordStorageRequestResult({
    ok: false,
    code: 'GATEWAY_REQUEST_FAILED',
    operation: 'PUT data/records.json',
    retries: 2,
    now: 1_800_000_000_100,
    storage,
  });
  recordStorageRequestResult({
    ok: true,
    operation: 'GET data/records.json',
    retries: 1,
    now: 1_800_000_000_200,
    storage,
  });
  recordSessionRenewal({ now: 1_800_000_000_300, storage });

  const metrics = readDiagnosticMetrics(storage);
  assert.equal(metrics.lastStorageSuccessAt, 1_800_000_000_200);
  assert.equal(metrics.lastStorageErrorCode, 'GATEWAY_REQUEST_FAILED');
  assert.equal(metrics.lastStorageRetries, 1);
  assert.equal(metrics.totalStorageRetries, 3);
  assert.equal(metrics.lastSessionRenewedAt, 1_800_000_000_300);
});

test('diagnostic snapshot reports PWA, queues and masked device id', async () => {
  const storage = storageFixture();
  const navigatorObj = {
    onLine: false,
    serviceWorker: {
      controller: {},
      async getRegistration() {
        return { active: { state: 'activated' }, waiting: null };
      },
    },
  };
  const documentObj = {
    querySelectorAll() {
      return [{ textContent: 'Офлайн · ожидает отправки: 3 операции' }];
    },
  };
  const cachesObj = { async keys() { return ['masterskaya-v5']; } };
  const health = {
    session: { clientId: 'web-device-secret-12345678', expiresAt: 1_900_000_000_000 },
    storage: { ok: true, version: '1.3.1', protocolVersion: 3 },
    ably: { ok: true, version: '1.3.1', protocolVersion: 3 },
  };
  const backup = {
    available: true,
    valid: true,
    backupAt: '2026-08-05T12:00:00Z',
    counts: { records: 100, stockOps: 200 },
    errors: [],
    warnings: [],
  };

  const snapshot = await collectClientDiagnostics({
    storage,
    navigatorObj,
    documentObj,
    cachesObj,
    health,
    backup,
    now: 1_800_000_000_500,
  });

  assert.equal(snapshot.online, false);
  assert.equal(snapshot.device.name, 'Ноутбук');
  assert.equal(snapshot.device.clientIdMasked, '…12345678');
  assert.equal(snapshot.sync.queues.totalOperations, 3);
  assert.equal(snapshot.pwa.controlled, true);
  assert.equal(snapshot.pwa.workerState, 'activated');
  assert.deepEqual(snapshot.pwa.cacheNames, ['masterskaya-v5']);
});

test('copied report contains no session, secrets or working data', async () => {
  const storage = storageFixture();
  const snapshot = await collectClientDiagnostics({
    storage,
    navigatorObj: { onLine: true },
    documentObj: { querySelectorAll: () => [{ textContent: 'Сохранено · Live' }] },
    cachesObj: { keys: async () => [] },
    health: {
      session: { clientId: 'web-device-secret-12345678', expiresAt: 1_900_000_000_000 },
      storage: { ok: true, version: '1.3.1', protocolVersion: 3 },
      ably: { ok: true, version: '1.3.1', protocolVersion: 3 },
    },
    backup: {
      available: true,
      valid: true,
      backupAt: '2026-08-05T12:00:00Z',
      counts: { records: 100, stockOps: 200 },
      errors: [],
      warnings: [],
    },
  });
  const report = buildDiagnosticReport(snapshot, '1.3.3');

  assert.match(report, /Мастерская — диагностика/);
  assert.match(report, /Ожидает отправки — данные: 1/);
  assert.match(report, /Ожидает отправки — склад: 2/);
  assert.doesNotMatch(report, new RegExp(SESSION_TOKEN.replaceAll('.', '\\.')));
  assert.doesNotMatch(report, /github_pat_must_never_appear/);
  assert.doesNotMatch(report, /web-device-secret-12345678/);
});
