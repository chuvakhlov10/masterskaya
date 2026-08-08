import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyObjectPatch,
  applyOpsToStock,
  applyStockCheckpoint,
  classifyLateStockOps,
  createStockJournal,
  createObjectPatch,
  createStockArchivePlan,
  findRecordsMissingCreateEffect,
  findRecordIndex,
  legacyRecordFingerprint,
  recordRevision,
  reconcileStockOutboxWithHistory,
  sameRecordVersion,
  selectRecordEffectOps,
  mergeById,
  mergeObjectPatches,
  mergeRecords,
  mergeStockJournals,
  mergeStockOps,
  normalizeStockJournal,
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

test('checkpoint plus hot journal reproduces the full stock and keeps rename aliases', () => {
  const cutoff = 1_800_000_000_100;
  const operations = [
    op({ type: 'init', opId: 'init-old', marker: 'OLD', value: 10, delta: undefined, ts: cutoff - 30 }),
    op({ type: 'rename', opId: 'rename-old', marker: undefined, oldMarker: 'OLD', newMarker: 'NEW', delta: undefined, ts: cutoff - 20 }),
    op({ opId: 'before-cutoff', marker: 'OLD', delta: -2, ts: cutoff - 10 }),
    op({ opId: 'after-cutoff', marker: 'NEW', delta: 4, ts: cutoff + 10 }),
  ];
  const plan = createStockArchivePlan(operations, cutoff, {
    epoch: 1,
    createdAt: '2026-08-05T18:00:00Z',
  });

  assert.equal(plan.archivedOps.length, 3);
  assert.equal(plan.hotOps.length, 1);
  assert.equal(plan.checkpoint.renameAliases.OLD, 'NEW');
  assert.deepEqual(
    applyStockCheckpoint(plan.checkpoint, plan.hotOps),
    applyOpsToStock(operations),
  );
  assert.equal(applyStockCheckpoint(plan.checkpoint, plan.hotOps).main.NEW, 12);
});

test('late additive operation is applied after checkpoint under the canonical marker', () => {
  const cutoff = 1_800_000_000_100;
  const plan = createStockArchivePlan([
    op({ type: 'init', opId: 'init-old', marker: 'OLD', value: 10, delta: undefined, ts: cutoff - 30 }),
    op({ type: 'rename', opId: 'rename-old', marker: undefined, oldMarker: 'OLD', newMarker: 'NEW', delta: undefined, ts: cutoff - 20 }),
  ], cutoff);
  const late = op({ opId: 'late-offline', marker: 'OLD', delta: -3, ts: cutoff - 10 });

  const stock = applyStockCheckpoint(plan.checkpoint, [late]);
  const classification = classifyLateStockOps(plan.checkpoint, [late]);
  assert.equal(stock.main.NEW, 7);
  assert.equal(stock.main.OLD, undefined);
  assert.deepEqual(classification.safe.map(item => item.opId), ['late-offline']);
  assert.deepEqual(classification.blocking, []);
});

test('late set is quarantined because applying it after a checkpoint changes history order', () => {
  const cutoff = 1_800_000_000_100;
  const plan = createStockArchivePlan([
    op({ type: 'init', opId: 'init', value: 10, delta: undefined, ts: cutoff - 20 }),
  ], cutoff);
  const lateSet = op({ type: 'set', opId: 'late-set', value: 4, delta: undefined, ts: cutoff - 10 });
  const classification = classifyLateStockOps(plan.checkpoint, [lateSet]);
  assert.deepEqual(classification.safe, []);
  assert.deepEqual(classification.blocking.map(item => item.opId), ['late-set']);
});

test('outbox reconciliation removes only ids confirmed by hot or archived history', () => {
  const cutoff = 1_800_000_000_100;
  const checkpoint = createStockArchivePlan([
    op({ opId: 'archived', ts: cutoff - 20 }),
    op({ opId: 'hot', ts: cutoff + 20 }),
  ], cutoff).checkpoint;
  const outbox = [
    op({ opId: 'archived', ts: cutoff - 20 }),
    op({ opId: 'hot', ts: cutoff + 20 }),
    op({ opId: 'new-local', ts: cutoff + 30 }),
  ];

  const result = reconcileStockOutboxWithHistory(outbox, [
    op({ opId: 'hot', ts: cutoff + 20 }),
    op({ opId: 'archived', ts: cutoff - 20 }),
  ], checkpoint);

  assert.deepEqual(result.confirmed.map(item => item.opId), ['archived', 'hot']);
  assert.deepEqual(result.remaining.map(item => item.opId), ['new-local']);
  assert.deepEqual(result.sendable.map(item => item.opId), ['new-local']);
  assert.deepEqual(result.blocked, []);
});

test('unknown pre-checkpoint outbox operations stay blocked regardless of type or epoch stamp', () => {
  const cutoff = 1_800_000_000_100;
  const checkpoint = createStockArchivePlan([], cutoff, { epoch: 2 }).checkpoint;
  const lateDelta = op({ opId: 'late-delta', ts: cutoff - 30, archiveEpoch: 2 });
  const lateMove = op({
    type: 'move', opId: 'late-move', ts: cutoff - 20, archiveEpoch: 2,
    from: 'main', to: 'ws:SMART', qty: 1, delta: undefined,
  });
  const invalidTimestamp = op({ opId: 'invalid-ts', ts: undefined });
  const current = op({ opId: 'current', ts: cutoff + 10 });

  const result = reconcileStockOutboxWithHistory(
    [lateDelta, lateMove, invalidTimestamp, current],
    [],
    checkpoint,
  );

  assert.deepEqual(result.blocked.map(item => item.opId).sort(), ['invalid-ts', 'late-delta', 'late-move']);
  assert.deepEqual(result.sendable.map(item => item.opId), ['current']);
  assert.deepEqual(result.remaining.map(item => item.opId).sort(), ['current', 'invalid-ts', 'late-delta', 'late-move']);
});

test('record-effect anchor lets a post-cutoff edit continue an archived mutation chain', () => {
  const cutoff = 1_800_000_000_100;
  const created = op({
    type: 'record-effect', opId: 'record-effect:create', recordId: 'record-1',
    mutationId: 'create', baseMutationId: null, baseRevision: 0, revision: 1,
    mutationKind: 'create', before: null,
    after: { location: 'main', marker: 'TEST', qty: 2 },
    delta: undefined, ts: cutoff - 10,
  });
  const edited = op({
    type: 'record-effect', opId: 'record-effect:edit', recordId: 'record-1',
    mutationId: 'edit', baseMutationId: 'create', baseRevision: 1, revision: 2,
    mutationKind: 'edit',
    before: { location: 'main', marker: 'TEST', qty: 2 },
    after: { location: 'main', marker: 'TEST', qty: 4 },
    delta: undefined, ts: cutoff + 10,
  });
  const plan = createStockArchivePlan([created, edited], cutoff);

  assert.equal(plan.checkpoint.recordEffectAnchors.length, 1);
  assert.equal(plan.checkpoint.recordEffectAnchors[0].mutationId, 'create');
  assert.deepEqual(
    applyStockCheckpoint(plan.checkpoint, plan.hotOps),
    applyOpsToStock([created, edited]),
  );
  assert.equal(applyStockCheckpoint(plan.checkpoint, plan.hotOps).main.TEST, -4);
});

test('checkpoint and hot journal must have the same archive epoch', () => {
  const cutoff = 1_800_000_000_100;
  const plan = createStockArchivePlan([
    op({ type: 'init', opId: 'init', value: 10, delta: undefined, ts: cutoff - 10 }),
    op({ opId: 'hot', ts: cutoff + 10 }),
  ], cutoff);
  const journal = createStockJournal(plan.hotOps, plan.checkpoint);
  assert.equal(journal.schemaVersion, 4);
  assert.equal(journal.epoch, plan.checkpoint.epoch);
  assert.deepEqual(normalizeStockJournal(journal, plan.checkpoint).ops.map(item => item.opId), ['hot']);
  assert.throws(() => normalizeStockJournal(plan.hotOps, plan.checkpoint), /STOCK_ARCHIVE_EPOCH_MISMATCH/);
  assert.throws(() => normalizeStockJournal(journal, null), /STOCK_CHECKPOINT_REQUIRED/);
});

test('journal merge keeps archive envelope and rejects unstamped late operations', () => {
  const cutoff = 1_800_000_000_100;
  const plan = createStockArchivePlan([
    op({ type: 'init', opId: 'init', value: 10, delta: undefined, ts: cutoff - 10 }),
  ], cutoff);
  const remote = createStockJournal([op({ opId: 'remote', ts: cutoff + 10 })], plan.checkpoint);
  const local = createStockJournal([op({ opId: 'local', ts: cutoff + 20 })], plan.checkpoint);
  const merged = mergeStockJournals(remote, local, plan.checkpoint);
  assert.equal(merged.epoch, 1);
  assert.deepEqual(merged.ops.map(item => item.opId), ['remote', 'local']);

  const unstampedLate = createStockJournal([op({ opId: 'late', ts: cutoff - 1 })], plan.checkpoint);
  assert.throws(() => normalizeStockJournal(unstampedLate, plan.checkpoint), /STOCK_ARCHIVE_LATE_OPERATION_UNSTAMPED/);
  const stampedLate = createStockJournal([op({ opId: 'late', ts: cutoff - 1, archiveEpoch: 1 })], plan.checkpoint);
  assert.equal(normalizeStockJournal(stampedLate, plan.checkpoint).ops[0].archiveEpoch, 1);
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

test('missing first-revision record effect is detected for automatic recovery', () => {
  const record = {
    id: 'rec-1786174483531-awbq6o', workshop: 'Бегемот', category: 'Вертикальные',
    marker: 'Apex-02', qty: 2, defect: 0, amount: 700, recordType: 'sale',
    timestamp: 1786174483531, updatedAt: 1786174483531, revision: 1,
    lastMutationId: 'mut-rec-1786174483531-awbq6o-1786174483531-c4vatk',
  };

  assert.deepEqual(findRecordsMissingCreateEffect([record], [], []), [record]);
});

test('existing hot operation or checkpoint anchor prevents create-effect repair', () => {
  const record = {
    id: 'rec-1', revision: 1, timestamp: 10, updatedAt: 10,
    lastMutationId: 'mut-rec-1-10-abc123',
  };
  const effect = op({
    type: 'record-effect', opId: 'record-effect:mut-rec-1-10-abc123',
    recordId: 'rec-1', mutationId: 'mut-rec-1-10-abc123',
  });

  assert.deepEqual(findRecordsMissingCreateEffect([record], [effect], []), []);
  assert.deepEqual(findRecordsMissingCreateEffect([record], [], [effect]), []);
});

test('automatic repair ignores edits and records with untrusted mutation ids', () => {
  const edit = { id: 'rec-edit', revision: 2, lastMutationId: 'mut-rec-edit-20-edit' };
  const malformed = { id: 'rec-bad', revision: 1, lastMutationId: 'some-other-record' };
  assert.deepEqual(findRecordsMissingCreateEffect([edit, malformed], [], []), []);
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


test('legacy fingerprint matches migrated source record', () => {
  const record = {
    workshop: 'SMART', category: 'Домофонные', marker: 'Proxy', qty: 1,
    defect: 0, amount: 250, comment: '', recordType: 'sale', timestamp: 1782110055316,
  };
  assert.equal(legacyRecordFingerprint(record), '8258805b32fcc15f');
});

test('mergeRecords drops a stale no-id copy claimed by migrated record fingerprint', () => {
  const legacy = {
    workshop: 'SMART', category: 'Домофонные', marker: 'Proxy', qty: 1,
    defect: 0, amount: 250, comment: '', recordType: 'sale', timestamp: 1782110055316,
  };
  const modern = {
    ...legacy, id: 'legacy-4e22f164920235cf8c00c334', marker: 'Proxy edited',
    legacyFingerprint: legacyRecordFingerprint(legacy), revision: 2,
    updatedAt: 1783000000000, lastMutationId: 'm2',
  };
  const merged = mergeRecords([modern], [legacy]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, modern.id);
  assert.equal(merged[0].marker, 'Proxy edited');
});

test('mergeRecords drops an exact no-id copy even when legacyFingerprint was lost', () => {
  const legacy = {
    workshop: 'SMART', category: 'Домофонные', marker: 'Proxy', qty: 1,
    defect: 0, amount: 250, comment: '', recordType: 'sale', timestamp: 1782110055316,
  };
  const modern = {
    ...legacy, id: 'legacy-4e22f164920235cf8c00c334', revision: 1,
    updatedAt: 1782110055316, lastMutationId: '',
  };
  const merged = mergeRecords([modern], [legacy]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, modern.id);
  assert.equal(merged[0].legacyFingerprint, legacyRecordFingerprint(legacy));
});

test('restored fingerprint blocks the old copy after a later edit', () => {
  const legacy = {
    workshop: 'SMART', category: 'Домофонные', marker: 'Proxy', qty: 1,
    defect: 0, amount: 250, comment: '', recordType: 'sale', timestamp: 1782110055316,
  };
  const firstMerge = mergeRecords([{ ...legacy, id: 'legacy-record' }], [legacy]);
  const edited = {
    ...firstMerge[0], marker: 'Proxy edited', amount: 300,
    revision: 2, updatedAt: 1783000000000, lastMutationId: 'edit-2',
  };
  const secondMerge = mergeRecords([edited], [legacy]);
  assert.equal(secondMerge.length, 1);
  assert.equal(secondMerge[0].marker, 'Proxy edited');
  assert.equal(secondMerge[0].amount, 300);
});

test('mergeRecords preserves an unmatched legitimate legacy record', () => {
  const modern = {
    id: 'rec-modern', timestamp: 1, workshop: 'SMART', marker: 'A', qty: 1,
    defect: 0, amount: 100, comment: '', recordType: 'sale', category: 'Дверные',
  };
  const legacy = {
    timestamp: 2, workshop: 'SMART', marker: 'B', qty: 1,
    defect: 0, amount: 200, comment: '', recordType: 'sale', category: 'Дверные',
  };
  const merged = mergeRecords([modern], [legacy]);
  assert.equal(merged.length, 2);
});
