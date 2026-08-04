import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyObjectPatch,
  applyOpsToStock,
  createObjectPatch,
  findRecordIndex,
  recordRevision,
  sameRecordVersion,
  selectRecordEffectOps,
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


test('two consecutive set operations keep the final zero value', () => {
  const stock = applyOpsToStock([
    op({ type: 'set', opId: 'set-three', marker: 'TEST', location: 'main', value: 3, delta: undefined, ts: 1_800_000_000_010 }),
    op({ type: 'set', opId: 'set-zero', marker: 'TEST', location: 'main', value: 0, delta: undefined, ts: 1_800_000_000_020 }),
  ]);
  assert.equal(stock.main.TEST, 0);
});


test('findRecordIndex resolves a reordered modern record by id', () => {
  const records = [
    { id: 'rec-b', timestamp: 2, marker: 'B' },
    { id: 'rec-a', timestamp: 1, marker: 'A' },
  ];
  assert.equal(findRecordIndex(records, { id: 'rec-a', timestamp: 1, marker: 'A' }), 1);
});

test('findRecordIndex resolves one unique legacy record without id', () => {
  const legacy = { timestamp: 10, workshop: 'SMART', category: 'Дверные', marker: 'ELB12D', qty: 1, defect: 0, amount: 400, recordType: 'sale', comment: '' };
  const records = [{ id: 'modern' }, { ...legacy }];
  assert.equal(findRecordIndex(records, { ...legacy }), 1);
});

test('findRecordIndex rejects ambiguous duplicate legacy records', () => {
  const legacy = { timestamp: 10, workshop: 'SMART', category: 'Дверные', marker: 'ELB12D', qty: 1, defect: 0, amount: 400, recordType: 'sale', comment: '' };
  assert.equal(findRecordIndex([{ ...legacy }, { ...legacy }], { ...legacy }), -1);
});


test('record-effect retry is idempotent by deterministic opId', () => {
  const effect = op({
    type: 'record-effect', opId: 'record-effect:create', recordId: 'rec-1',
    mutationId: 'create', baseMutationId: null, baseRevision: 0, revision: 1,
    mutationKind: 'create', before: null,
    after: { location: 'main', marker: 'TEST', qty: 2 },
    delta: undefined, ts: 1_800_000_000_010,
  });
  const merged = mergeStockOps([effect], [{ ...effect }]);
  assert.equal(merged.length, 1);
  assert.equal(applyOpsToStock(merged).main.TEST, -2);
});

test('one record edit atomically returns old effect and applies new effect', () => {
  const stock = applyOpsToStock([
    op({ type: 'init', opId: 'init-effect', value: 9, delta: undefined, ts: 1_800_000_000_001 }),
    op({
      type: 'record-effect', opId: 'record-effect:edit-1', recordId: 'rec-1',
      mutationId: 'edit-1', baseMutationId: null, baseRevision: 1, revision: 2,
      mutationKind: 'edit',
      before: { location: 'main', marker: 'TEST', qty: 1 },
      after: { location: 'main', marker: 'TEST', qty: 3 },
      delta: undefined, ts: 1_800_000_000_010,
    }),
  ]);
  assert.equal(stock.main.TEST, 7);
});

test('concurrent edits from one base revision apply only one winner', () => {
  const editA = op({
    type: 'record-effect', opId: 'record-effect:a', recordId: 'rec-1',
    mutationId: 'a', baseMutationId: null, baseRevision: 1, revision: 2,
    mutationKind: 'edit',
    before: { location: 'main', marker: 'TEST', qty: 1 },
    after: { location: 'main', marker: 'TEST', qty: 2 },
    delta: undefined, updatedAt: 20, ts: 1_800_000_000_020,
  });
  const editB = {
    ...editA, opId: 'record-effect:b', mutationId: 'b',
    after: { location: 'main', marker: 'TEST', qty: 3 },
    updatedAt: 30, ts: 1_800_000_000_030,
  };
  assert.deepEqual(selectRecordEffectOps([editA, editB]).map(item => item.mutationId), ['b']);
  const stock = applyOpsToStock([
    op({ type: 'init', opId: 'init-concurrent', value: 9, delta: undefined, ts: 1_800_000_000_001 }),
    editA, editB,
  ]);
  assert.equal(stock.main.TEST, 7);
});

test('delete wins over concurrent edit from the same revision', () => {
  const edit = op({
    type: 'record-effect', opId: 'record-effect:edit', recordId: 'rec-delete',
    mutationId: 'edit', baseMutationId: null, baseRevision: 1, revision: 2,
    mutationKind: 'edit',
    before: { location: 'main', marker: 'TEST', qty: 1 },
    after: { location: 'main', marker: 'TEST', qty: 2 },
    delta: undefined, updatedAt: 50, ts: 1_800_000_000_050,
  });
  const deletion = {
    ...edit, opId: 'record-effect:delete', mutationId: 'delete',
    mutationKind: 'delete', after: null, updatedAt: 40, ts: 1_800_000_000_040,
  };
  const stock = applyOpsToStock([
    op({ type: 'init', opId: 'init-delete', value: 9, delta: undefined, ts: 1_800_000_000_001 }),
    edit, deletion,
  ]);
  assert.equal(stock.main.TEST, 10);
});

test('record chain preserves a manual absolute set between edits', () => {
  const edit1 = op({
    type: 'record-effect', opId: 'record-effect:m1', recordId: 'rec-chain',
    mutationId: 'm1', baseMutationId: null, baseRevision: 1, revision: 2,
    mutationKind: 'edit',
    before: { location: 'main', marker: 'TEST', qty: 1 },
    after: { location: 'main', marker: 'TEST', qty: 2 },
    delta: undefined, ts: 1_800_000_000_020,
  });
  const edit2 = {
    ...edit1, opId: 'record-effect:m2', mutationId: 'm2',
    baseMutationId: 'm1', baseRevision: 2, revision: 3,
    before: { location: 'main', marker: 'TEST', qty: 2 },
    after: { location: 'main', marker: 'TEST', qty: 3 },
    ts: 1_800_000_000_040,
  };
  const stock = applyOpsToStock([
    op({ type: 'init', opId: 'init-chain', value: 9, delta: undefined, ts: 1_800_000_000_010 }),
    edit1,
    op({ type: 'set', opId: 'manual-set', value: 20, delta: undefined, ts: 1_800_000_000_030 }),
    edit2,
  ]);
  assert.equal(stock.main.TEST, 19);
});

test('mergeRecords prefers higher revision over a newer stale clock', () => {
  const remote = [{ id: 'rec-rev', revision: 3, updatedAt: 100, lastMutationId: 'm3', marker: 'SERVER' }];
  const stale = [{ id: 'rec-rev', revision: 2, updatedAt: 999999, lastMutationId: 'm2', marker: 'STALE' }];
  const merged = mergeRecords(remote, stale);
  assert.equal(merged[0].marker, 'SERVER');
  assert.equal(recordRevision(merged[0]), 3);
});

test('sameRecordVersion detects a stale opened record', () => {
  const opened = { id: 'rec-version', revision: 2, updatedAt: 20, lastMutationId: 'm2' };
  assert.equal(sameRecordVersion({ ...opened }, opened), true);
  assert.equal(sameRecordVersion({ ...opened, revision: 3, lastMutationId: 'm3' }, opened), false);
});


test('higher descendant revision selects its complete competing branch', () => {
  const editA = op({
    type: 'record-effect', opId: 'record-effect:branch-a', recordId: 'rec-branch',
    mutationId: 'branch-a', baseMutationId: null, baseRevision: 1, revision: 2,
    mutationKind: 'edit',
    before: { location: 'main', marker: 'TEST', qty: 1 },
    after: { location: 'main', marker: 'TEST', qty: 2 },
    delta: undefined, updatedAt: 20, ts: 1_800_000_000_020,
  });
  const editB = {
    ...editA, opId: 'record-effect:branch-b', mutationId: 'branch-b',
    after: { location: 'main', marker: 'TEST', qty: 3 },
    updatedAt: 30, ts: 1_800_000_000_030,
  };
  const editA2 = {
    ...editA, opId: 'record-effect:branch-a2', mutationId: 'branch-a2',
    baseMutationId: 'branch-a', baseRevision: 2, revision: 3,
    before: { location: 'main', marker: 'TEST', qty: 2 },
    after: { location: 'main', marker: 'TEST', qty: 4 },
    updatedAt: 40, ts: 1_800_000_000_040,
  };
  assert.deepEqual(
    selectRecordEffectOps([editA, editB, editA2]).map(item => item.mutationId),
    ['branch-a', 'branch-a2']
  );
  const stock = applyOpsToStock([
    op({ type: 'init', opId: 'init-branch', value: 9, delta: undefined, ts: 1_800_000_000_001 }),
    editA, editB, editA2,
  ]);
  assert.equal(stock.main.TEST, 6);
});

test('delete prevents a higher stale edit branch from resurrecting stock effect', () => {
  const staleEdit = op({
    type: 'record-effect', opId: 'record-effect:stale-edit', recordId: 'rec-permanent-delete',
    mutationId: 'stale-edit', baseMutationId: null, baseRevision: 1, revision: 2,
    mutationKind: 'edit',
    before: { location: 'main', marker: 'TEST', qty: 1 },
    after: { location: 'main', marker: 'TEST', qty: 2 },
    delta: undefined, updatedAt: 20, ts: 1_800_000_000_020,
  });
  const staleEdit2 = {
    ...staleEdit, opId: 'record-effect:stale-edit-2', mutationId: 'stale-edit-2',
    baseMutationId: 'stale-edit', baseRevision: 2, revision: 3,
    before: { location: 'main', marker: 'TEST', qty: 2 },
    after: { location: 'main', marker: 'TEST', qty: 4 },
    updatedAt: 40, ts: 1_800_000_000_040,
  };
  const deletion = {
    ...staleEdit, opId: 'record-effect:permanent-delete', mutationId: 'permanent-delete',
    mutationKind: 'delete', after: null, updatedAt: 30, ts: 1_800_000_000_030,
  };
  assert.deepEqual(
    selectRecordEffectOps([staleEdit, staleEdit2, deletion]).map(item => item.mutationId),
    ['permanent-delete']
  );
  const stock = applyOpsToStock([
    op({ type: 'init', opId: 'init-permanent-delete', value: 9, delta: undefined, ts: 1_800_000_000_001 }),
    staleEdit, staleEdit2, deletion,
  ]);
  assert.equal(stock.main.TEST, 10);
});
