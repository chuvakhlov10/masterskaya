import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildStockArchiveFiles,
  writeStockArchivePlan,
} from '../scripts/plan-stock-archive.mjs';

const cutoff = Date.parse('2026-08-01T00:00:00Z');
const operations = [
  { type: 'init', location: 'main', marker: 'OLD', value: 10, ts: cutoff - 30, client: 'migration', opId: 'init' },
  { type: 'rename', oldMarker: 'OLD', newMarker: 'NEW', ts: cutoff - 20, client: 'device', opId: 'rename' },
  { type: 'delta', location: 'main', marker: 'NEW', delta: -2, ts: cutoff - 10, client: 'device', opId: 'july-delta' },
  { type: 'delta', location: 'main', marker: 'NEW', delta: 3, ts: cutoff + 10, client: 'device', opId: 'august-delta' },
];

test('planner creates monthly archives, checkpoint and a matching hot replay', () => {
  const result = buildStockArchiveFiles({
    ops: operations,
    cutoffTs: cutoff,
    createdAt: '2026-08-05T18:00:00Z',
  });
  assert.equal(result.summary.totalOps, 4);
  assert.equal(result.summary.archivedOps, 3);
  assert.equal(result.summary.hotOps, 1);
  assert.deepEqual(result.summary.archiveMonths, ['2026-07']);
  assert.equal(result.checkpoint.stock.main.NEW, 8);
  assert.equal(result.checkpoint.renameAliases.OLD, 'NEW');
  assert.equal(result.hotJournal.epoch, result.checkpoint.epoch);
  assert.deepEqual(result.hotJournal.ops.map(item => item.opId), ['august-delta']);
  assert.match(result.summary.stockFingerprint, /^[a-f0-9]{64}$/);
});

test('planner writes new files without overwriting an existing output', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'masterskaya-archive-'));
  const inputPath = path.join(root, 'stock-ops.json');
  const outputDir = path.join(root, 'output');
  fs.writeFileSync(inputPath, JSON.stringify(operations));
  const manifest = writeStockArchivePlan({
    inputPath,
    outputDir,
    cutoff: '2026-08-01T00:00:00Z',
    createdAt: '2026-08-05T18:00:00Z',
  });
  assert.equal(manifest.archivedOps, 3);
  assert.equal(fs.existsSync(path.join(outputDir, 'data/stock-checkpoint.json')), true);
  assert.equal(fs.existsSync(path.join(outputDir, 'archives/stock-ops/2026-07.json')), true);
  assert.throws(
    () => writeStockArchivePlan({ inputPath, outputDir, cutoff: '2026-08-01T00:00:00Z', createdAt: '2026-08-05T18:00:00Z' }),
    /OUTPUT_DIRECTORY_NOT_EMPTY/,
  );
});

test('planner rejects duplicate operation IDs', () => {
  assert.throws(
    () => buildStockArchiveFiles({ ops: [...operations, { ...operations[0] }], cutoffTs: cutoff, createdAt: '2026-08-05T18:00:00Z' }),
    /STOCK_OP_ID_DUPLICATE/,
  );
});
