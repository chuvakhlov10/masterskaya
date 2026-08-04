import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveSyncView, normalizeBackupStatus } from '../src/status-core.js';

test('pending operations never display as saved', () => {
  const view = deriveSyncView({ online: true, syncStatus: 'ws', pendingCount: 3, lastError: '', busy: false });
  assert.equal(view.kind, 'sending');
  assert.match(view.label, /3/);
});

test('offline status keeps the pending count visible', () => {
  const view = deriveSyncView({ online: false, syncStatus: 'offline', pendingCount: 2, lastError: '', busy: false });
  assert.equal(view.kind, 'offline');
  assert.match(view.label, /2/);
});

test('sync error has priority over an online connection', () => {
  const view = deriveSyncView({ online: true, syncStatus: 'ws', pendingCount: 0, lastError: 'network', busy: false });
  assert.equal(view.kind, 'error');
});

test('live status is shown only with no error and no pending work', () => {
  const view = deriveSyncView({ online: true, syncStatus: 'ws', pendingCount: 0, lastError: '', busy: false });
  assert.deepEqual(view, { kind: 'live', icon: '⚡', label: 'Сохранено · Live' });
});

test('valid backup report is normalized for the UI', () => {
  const result = normalizeBackupStatus({
    last_attempt: { valid: true, checked_at: '2026-08-04T13:52:49Z', errors: [], warnings: [] },
    latest_good: {
      created_at: '2026-08-04T13:52:49Z',
      daily_path: 'daily/2026-08-04',
      monthly_path: 'monthly/2026-08',
      counts: { records: 1084, stock_ops: 3703, record_deletions: 0, record_effect_ops: 4 },
    },
  });
  assert.equal(result.valid, true);
  assert.equal(result.counts.records, 1084);
  assert.equal(result.counts.stockOps, 3703);
  assert.equal(result.dailyPath, 'daily/2026-08-04');
});

test('failed backup attempt keeps errors and is not marked valid', () => {
  const result = normalizeBackupStatus({
    last_attempt: { valid: false, errors: ['duplicate id'], warnings: ['old file'] },
  });
  assert.equal(result.valid, false);
  assert.deepEqual(result.errors, ['duplicate id']);
  assert.deepEqual(result.warnings, ['old file']);
});

test('missing backup report is handled without throwing', () => {
  const result = normalizeBackupStatus(null);
  assert.equal(result.available, false);
  assert.equal(result.valid, false);
  assert.equal(result.counts.records, 0);
});
