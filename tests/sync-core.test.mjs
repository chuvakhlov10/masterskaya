import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyObjectPatch,
  applyOpsToStock,
  createObjectPatch,
  mergeById,
  mergeObjectPatches,
  mergeRecords,
  mergeStockOps,
  stockOpIdentity,
} from '../src/sync-core.js';

const op = (overrides = {}) => ({
  type: 'delta',
  location: 'main',
  marker: 'TEST',
  delta: 1,
  ts: 1_800_000_000_000,
  client: 'client-a',
  opId: 'op-default',
  ...overrides,
});

test('mergeStockOps keeps operations from both devices during stale snapshot merge', () => {
  const remote = [op({ opId: 'server-1', delta: 5 })];
  const staleLocal = [op({ opId: 'local-1', delta: 3 })];
  const merged = mergeStockOps(remote, staleLocal);
  assert.deepEqual(merged.map(item => item.opId).sort(), ['local-1', 'server-1']);
  assert.equal(applyOpsToStock(merged).main.TEST, 8);
});

test('mergeStockOps treats an operation as immutable and keeps server copy for duplicate opId', () => {
  const remote = [op({ opId: 'same', delta: 5 })];
  const corruptedLocal = [op({ opId: 'same', delta: 500 })];
  const merged = mergeStockOps(remote, corruptedLocal);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].delta, 5);
});

test('legacy operation identity includes quantity fields and does not collapse real operations', () => {
  const first = op({ opId: undefined, delta: 1 });
  const second = op({ opId: undefined, delta: 2 });
  assert.notEqual(stockOpIdentity(first), stockOpIdentity(second));
  assert.equal(mergeStockOps([first], [second]).length, 2);
});

test('mergeStockOps ignores malformed null entries instead of crashing', () => {
  const merged = mergeStockOps([null, op({ opId: 'valid' })], [undefined, 4]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].opId, 'valid');
});

test('future device clock does not make a valid operation disappear', () => {
  const farFuture = Date.now() + 90 * 24 * 60 * 60 * 1000;
  const stock = applyOpsToStock([op({ opId: 'future', ts: farFuture, delta: 7 })]);
  assert.equal(stock.main.TEST, 7);
});

test('rename keeps later offline operation under the new marker name', () => {
  const operations = [
    op({ type: 'init', opId: 'init', marker: 'OLD', value: 10, delta: undefined, ts: 1_800_000_000_000 }),
    op({ type: 'rename', opId: 'rename', marker: undefined, oldMarker: 'OLD', newMarker: 'NEW', delta: undefined, ts: 1_800_000_000_001 }),
    op({ opId: 'offline-old-name', marker: 'OLD', delta: -2, ts: 1_800_000_000_002 }),
  ];
  const stock = applyOpsToStock(operations);
  assert.equal(stock.main.NEW, 8);
  assert.equal(stock.main.OLD, undefined);
});

test('invalid location is skipped and never interpreted as main warehouse', () => {
  const stock = applyOpsToStock([op({ opId: 'bad-location', location: 'SMART', delta: 9 })]);
  assert.deepEqual(stock.main, {});
  assert.deepEqual(stock.ws.SMART, {});
});

test('movement remains atomic in one event', () => {
  const stock = applyOpsToStock([
    op({ type: 'init', opId: 'init', location: 'main', value: 10, delta: undefined }),
    op({ type: 'move', opId: 'move', marker: 'TEST', from: 'main', to: 'ws:SMART', qty: 4, delta: undefined, ts: 1_800_000_000_001 }),
  ]);
  assert.equal(stock.main.TEST, 6);
  assert.equal(stock.ws.SMART.TEST, 4);
});

test('mergeRecords chooses newest edit and respects tombstones', () => {
  const remote = [{ id: 'r1', timestamp: 10, updatedAt: 20, amount: 100 }];
  const local = [
    { id: 'r1', timestamp: 10, updatedAt: 30, amount: 150 },
    { id: 'r2', timestamp: 40, updatedAt: 40, amount: 200 },
  ];
  const merged = mergeRecords(remote, local, new Set(['r2']));
  assert.equal(merged.length, 1);
  assert.equal(merged[0].amount, 150);
});

test('mergeById chooses newer tombstone instead of blindly preferring local order', () => {
  const remote = [{ id: 'r1', deletedAt: 50, client: 'remote' }];
  const local = [{ id: 'r1', deletedAt: 40, client: 'local' }];
  const merged = mergeById(remote, local);
  assert.equal(merged[0].client, 'remote');
});

test('object patches preserve unrelated remote changes and carry deletions', () => {
  const localBefore = { A: 1, B: 2 };
  const localAfter = { A: 3 };
  const patch = createObjectPatch(localBefore, localAfter);
  const remoteLatest = { A: 1, B: 2, C: 9 };
  assert.deepEqual(applyObjectPatch(remoteLatest, patch), { A: 3, C: 9 });
});

test('sequential object patches compact without reviving removed keys', () => {
  const first = { set: { A: 2, B: 3 }, remove: [] };
  const second = { set: { C: 4 }, remove: ['B'] };
  const merged = mergeObjectPatches(first, second);
  assert.deepEqual(merged, { set: { A: 2, C: 4 }, remove: ['B'] });
});
