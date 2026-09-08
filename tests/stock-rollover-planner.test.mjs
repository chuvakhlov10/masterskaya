import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildStockArchiveFiles } from '../scripts/plan-stock-archive.mjs';
import { buildStockRollover, describeBytes, writeStockRolloverPlan } from '../scripts/plan-stock-rollover.mjs';
import {
  applyOpsToStock, applyStockCheckpoint, normalizeStockJournal,
  reconcileStockOutboxWithHistory,
} from '../src/sync-core.js';

const august = Date.parse('2026-08-01T00:00:00Z');
const september = Date.parse('2026-09-01T00:00:00Z');
const october = Date.parse('2026-10-01T00:00:00Z');
const createdAt = '2026-09-08T09:00:00Z';
const head = 'a'.repeat(40);
const effect = qty => ({ location: 'main', marker: 'NEW', qty });
const operation = (opId, ts, values) => ({ opId, ts, client: 'test-device', ...values });
const recordEffect = (id, ts, revision, before, after, parent = null) => operation(`record-effect:${id}`, ts, {
  type: 'record-effect', recordId: 'sale', mutationId: id, baseMutationId: parent,
  baseRevision: revision - 1, revision, mutationKind: revision === 1 ? 'create' : after ? 'edit' : 'delete',
  before, after, updatedAt: ts,
});
function fixture() {
  const ops = [
    operation('init', august - 40, { type: 'init', location: 'main', marker: 'OLD', value: 20 }),
    operation('rename', august - 30, { type: 'rename', oldMarker: 'OLD', newMarker: 'NEW' }),
    recordEffect('sale-1', august - 20, 1, null, effect(2)),
    recordEffect('sale-2', august + 10, 2, effect(2), effect(5), 'sale-1'),
    operation('august-delta', august + 20, { type: 'delta', location: 'main', marker: 'OLD', delta: 4 }),
    recordEffect('sale-3', september + 10, 3, effect(5), effect(3), 'sale-2'),
    operation('boundary', september, { type: 'move', marker: 'OLD', from: 'main', to: 'ws:SMART', qty: 1 }),
  ];
  const first = buildStockArchiveFiles({ ops, cutoffTs: august, createdAt: '2026-08-08T00:00:00Z' });
  return { checkpoint: first.checkpoint, journal: first.hotJournal,
    archives: first.archiveFiles, records: [], cutoffTs: september, createdAt };
}

test('second and third rollover retain immutable history, aliases and cross-month sale edits', () => {
  const input = fixture();
  const original = structuredClone(input);
  const second = buildStockRollover(input);
  assert.deepEqual(input, original);
  assert.equal(second.checkpoint.epoch, 2);
  assert.deepEqual(second.archiveFiles.map(file => file.month), ['2026-08']);
  assert.equal(second.summary.newlyArchivedOps, 2);
  assert.equal(second.summary.totalOps, 7);
  assert.equal(second.hotOps.length, 2);
  assert.equal(second.checkpoint.renameAliases.OLD, 'NEW');
  assert.equal(second.checkpoint.recordEffectAnchors[0].mutationId, 'sale-2');
  assert.equal(second.checkpoint.recordEffectAnchors[0].baseMutationId, null);
  assert.deepEqual(applyStockCheckpoint(second.checkpoint, second.hotOps), {
    main: { NEW: 20 }, ws: { SMART: { NEW: 1 }, 'Бегемот': {} },
  });
  const third = buildStockRollover({ ...input, checkpoint: second.checkpoint,
    journal: second.hotJournal, archives: [...input.archives, ...second.archiveFiles],
    cutoffTs: october, createdAt: '2026-10-02T00:00:00Z' });
  assert.equal(third.checkpoint.epoch, 3);
  assert.equal(third.hotOps.length, 0);
  assert.deepEqual(third.archiveFiles.map(file => file.month), ['2026-09']);
  assert.equal(third.checkpoint.recordEffectAnchors[0].mutationId, 'sale-3');
  const deletion = recordEffect('sale-4', october + 1, 4, effect(3), null, 'sale-3');
  const all = [...input.archives.flatMap(file => file.operations), ...input.journal.ops, deletion];
  assert.deepEqual(applyStockCheckpoint(third.checkpoint, [deletion]), applyOpsToStock(all));
});

test('old journal and new checkpoint cannot mix; stale outbox IDs reconcile through the new archive', () => {
  const input = fixture();
  const result = buildStockRollover(input);
  assert.throws(() => normalizeStockJournal(input.journal, result.checkpoint), /EPOCH_MISMATCH/);
  assert.throws(() => normalizeStockJournal(result.hotJournal, input.checkpoint), /EPOCH_MISMATCH/);
  const unknown = operation('offline-unknown', august + 100, { type: 'delta', marker: 'NEW', location: 'main', delta: 1 });
  const confirmedHistory = [...input.archives, ...result.archiveFiles].flatMap(file => file.operations).concat(result.hotOps);
  const reconciled = reconcileStockOutboxWithHistory([...input.journal.ops, unknown], confirmedHistory, result.checkpoint);
  assert.equal(reconciled.confirmed.length, input.journal.ops.length);
  assert.deepEqual(reconciled.blocked, [unknown]);
  assert.deepEqual(reconciled.sendable, []);
});

const invalidCases = [
  ['epoch mismatch', input => input.journal.epoch++, /EPOCH_MISMATCH/],
  ['same cutoff', input => input.cutoffTs = august, /CUTOFF/],
  ['partial month', input => input.cutoffTs++, /CUTOFF/],
  ['future cutoff', input => input.createdAt = '2026-08-15T00:00:00Z', /CREATED_AT/],
  ['duplicate archive/hot ID', input => input.journal.ops.push(input.archives[0].operations[0]), /ID_DUPLICATE/],
  ['malformed op', input => input.journal.ops[0].ts = true, /TS_INVALID/],
  ['unknown op type', input => input.journal.ops[0].type = 'unknown', /OP_INVALID/],
  ['wrong month', input => input.archives[0].operations[0].ts = august + 1, /RANGE_MISMATCH/],
  ['missing archive', input => input.archives = [], /ARCHIVE_MISSING/],
  ['wrong archive count', input => input.checkpoint.archive.files[0].opCount++, /COUNT_MISMATCH/],
  ['changed checkpoint balances', input => input.checkpoint.stock.main.NEW++, /STOCK_MISMATCH/],
  ['lost aliases', input => input.checkpoint.renameAliases = {}, /ALIASES_MISMATCH/],
  ['lost anchors', input => input.checkpoint.recordEffectAnchors = [], /ANCHORS_MISMATCH/],
  ['missing create effect', input => input.records.push({ id: 'lost', revision: 1, lastMutationId: 'mut-lost-create' }), /RECORD_EFFECTS_MISSING/],
  ['late stamped delta', input => input.journal.ops.push(operation('late', august - 1,
    { type: 'delta', marker: 'NEW', location: 'main', delta: 1, archiveEpoch: 1 })), /LATE_OPERATIONS_REQUIRE_REVIEW/],
];
for (const [label, mutate, expected] of invalidCases) {
  test(`rollover rejects ${label}`, () => {
    const input = fixture(); mutate(input);
    assert.throws(() => buildStockRollover(input), expected);
  });
}

test('a hot fork cannot replace a frozen effect branch even if both have identical balances', () => {
  const input = fixture();
  // Two August edits have the same stock effect. September continues the older
  // branch, so the terminal anchor of the August-only replay would be wrong.
  input.journal.ops.find(op => op.mutationId === 'sale-3').after = effect(5);
  input.journal.ops.push(recordEffect('sale-other', august + 30, 2, effect(2), effect(5), 'sale-1'));
  assert.throws(() => buildStockRollover(input), /EFFECT_CHAIN_MISMATCH/);
});

test('an archived create effect remains visible to the missing-sale repair check', () => {
  const input = fixture();
  input.journal.ops.push({ ...recordEffect('mut-new-create', august + 50, 1, null, effect(1)), recordId: 'new' });
  input.records.push({ id: 'new', revision: 1, lastMutationId: 'mut-new-create' });
  const result = buildStockRollover(input);
  assert.equal(result.hotOps.some(op => op.mutationId === 'mut-new-create'), false);
  assert.equal(result.checkpoint.recordEffectAnchors.some(op => op.mutationId === 'mut-new-create'), true);
});

test('a negative cutoff balance blocks rollover even when later stock recovers', () => {
  const input = fixture();
  input.journal.ops.find(op => op.opId === 'august-delta').delta = -40;
  input.journal.ops.push(operation('recovery', september + 50, { type: 'delta', location: 'main', marker: 'NEW', delta: 100 }));
  assert.throws(() => buildStockRollover(input), /NEGATIVE_BALANCES/);
});

test('a month without newly closed operations produces no rollover', () => {
  const input = fixture();
  input.journal.ops.filter(op => op.ts < september).forEach(op => { op.ts += september - august; });
  assert.throws(() => buildStockRollover(input), /NOTHING_TO_ARCHIVE/);
});

function snapshot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stock-rollover-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourceDir = path.join(root, 'source');
  const outputDir = path.join(root, 'output');
  const input = fixture();
  const files = [
    ['data/stock-checkpoint.json', input.checkpoint], ['data/stock-ops.json', input.journal],
    ['data/records.json', input.records], ...input.archives.map(file => [file.path, file.operations]),
  ].map(([relative, value]) => {
    // Deliberately use formatting different from the planner's pretty JSON.
    const raw = JSON.stringify(value);
    const target = path.join(sourceDir, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, raw);
    return describeBytes(relative, raw);
  });
  fs.writeFileSync(path.join(sourceDir, 'source-metadata.json'), JSON.stringify({ repository: 'example/data', head, files }));
  return { sourceDir, outputDir, expectedHead: head, cutoff: '2026-09-01T00:00:00Z', createdAt };
}

test('offline output contains exactly three changes, source CAS preconditions and unchanged archive hashes', t => {
  const args = snapshot(t);
  const manifest = writeStockRolloverPlan(args);
  assert.equal(manifest.mode, 'offline-dry-run');
  assert.equal(manifest.source.expectedHead, head);
  assert.equal(manifest.changes.length, 3);
  assert.deepEqual(manifest.changes.map(file => file.action), ['add', 'update', 'update']);
  assert.equal(fs.existsSync(path.join(args.outputDir, 'archives/stock-ops/2026-07.json')), false);
  for (const file of manifest.changes) {
    const actual = describeBytes(file.path, fs.readFileSync(path.join(args.outputDir, file.path)));
    assert.equal(actual.gitBlobSha, file.gitBlobSha);
    assert.equal(actual.sha256, file.sha256);
  }
  const checkpoint = JSON.parse(fs.readFileSync(path.join(args.outputDir, 'data/stock-checkpoint.json')));
  assert.equal(checkpoint.archive.files[0].gitBlobSha, manifest.preservedArchives[0].gitBlobSha);
  assert.throws(() => writeStockRolloverPlan(args), /OUTPUT_ALREADY_EXISTS/);
  const again = writeStockRolloverPlan({ ...args, outputDir: `${args.outputDir}-again` });
  assert.deepEqual(again, manifest);
});

for (const [label, mutate, error] of [
  ['head moved', args => args.expectedHead = 'b'.repeat(40), /HEAD_MISMATCH/],
  ['source bytes changed', args => fs.appendFileSync(path.join(args.sourceDir, 'data/stock-ops.json'), '\n'), /BLOB_MISMATCH/],
  ['unlisted archive', args => fs.writeFileSync(path.join(args.sourceDir, 'archives/stock-ops/2026-08.json'), '[]'), /INVENTORY_MISMATCH/],
  ['symlink archive', args => {
    const target = path.join(args.sourceDir, 'archives/stock-ops/2026-07.json');
    fs.renameSync(target, `${target}.real`); fs.symlinkSync(`${target}.real`, target);
  }, /SYMLINK/],
]) {
  test(`file planner leaves no candidate when ${label}`, t => {
    const args = snapshot(t); mutate(args);
    assert.throws(() => writeStockRolloverPlan(args), error);
    assert.equal(fs.existsSync(args.outputDir), false);
  });
}
