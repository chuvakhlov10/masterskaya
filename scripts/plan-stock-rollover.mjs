// Offline only: validate a pinned repository snapshot and emit a candidate diff.
// This module deliberately has no network, Git write or deployment operations.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyStockCheckpoint, createStockArchivePlan, findRecordsMissingCreateEffect,
  normalizeStockJournal, replayStockOps, selectRecordEffectOps,
} from '../src/sync-core.js';
import { buildStockArchiveFiles } from './plan-stock-archive.mjs';

const CHECKPOINT = 'data/stock-checkpoint.json';
const JOURNAL = 'data/stock-ops.json';
const RECORDS = 'data/records.json';
const SHA = /^[a-f0-9]{40}$/;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const LOCATIONS = new Set(['main', 'ws:SMART', 'ws:Бегемот']);
const MIN_TS = Date.parse('2020-01-01T00:00:00Z');
const canonical = value => JSON.stringify(value, function (_, item) {
  return item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item;
});
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const jsonBytes = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const fingerprint = value => hash(canonical(value));
const byId = items => [...items].sort((a, b) => a.opId.localeCompare(b.opId));
const ids = items => items.map(item => item.opId).sort();
const monthOf = ts => new Date(ts).toISOString().slice(0, 7);
const text = value => typeof value === 'string' && value.trim().length > 0;
const timestamp = value => Number.isSafeInteger(value) && value >= MIN_TS && !Number.isNaN(new Date(value).getTime());
function requireThat(condition, error) { if (!condition) throw new Error(error); }
function equal(actual, expected, error) { requireThat(canonical(actual) === canonical(expected), error); }

export function describeBytes(relativePath, raw) {
  const bytes = Buffer.from(raw);
  return {
    path: relativePath, bytes: bytes.length, sha256: hash(bytes),
    gitBlobSha: crypto.createHash('sha1')
      .update(`blob ${bytes.length}\0`).update(bytes).digest('hex'),
  };
}

function validateOperations(ops) {
  requireThat(Array.isArray(ops), 'STOCK_OPS_MUST_BE_ARRAY');
  const seen = new Set();
  const mutations = new Set();
  const effect = value => value === null || (value && LOCATIONS.has(value.location)
    && text(value.marker) && Number.isFinite(value.qty) && value.qty > 0);
  for (const op of ops) {
    requireThat(op && text(op.opId), 'STOCK_OP_ID_MISSING');
    requireThat(!seen.has(op.opId), `STOCK_OP_ID_DUPLICATE:${op.opId}`);
    seen.add(op.opId);
    requireThat(timestamp(op.ts), `STOCK_OP_TS_INVALID:${op.opId}`);
    let valid = false;
    switch (op.type) {
      case 'init': case 'set':
        valid = LOCATIONS.has(op.location) && text(op.marker) && Number.isFinite(op.value); break;
      case 'delta':
        valid = LOCATIONS.has(op.location) && text(op.marker) && Number.isFinite(op.delta); break;
      case 'move':
        valid = LOCATIONS.has(op.from) && LOCATIONS.has(op.to) && op.from !== op.to
          && text(op.marker) && Number.isFinite(op.qty) && op.qty > 0; break;
      case 'rename':
        valid = text(op.oldMarker) && text(op.newMarker); break;
      case 'record-effect':
        valid = text(op.recordId) && text(op.mutationId) && !mutations.has(op.mutationId)
          && Number.isSafeInteger(op.baseRevision) && op.baseRevision >= 0
          && Number.isSafeInteger(op.revision) && op.revision > op.baseRevision
          && (op.baseMutationId === null || text(op.baseMutationId))
          && ['create', 'edit', 'delete'].includes(op.mutationKind)
          && effect(op.before) && effect(op.after) && !op.checkpointAnchor;
        mutations.add(op.mutationId); break;
    }
    requireThat(valid, `STOCK_OP_INVALID:${op.opId}`);
  }
}

function validateCheckpoint(checkpoint, archived) {
  const expected = createStockArchivePlan(archived, checkpoint.cutoffTs, {
    epoch: checkpoint.epoch, createdAt: checkpoint.createdAt,
  }).checkpoint;
  equal(checkpoint.stock, expected.stock, 'SOURCE_CHECKPOINT_STOCK_MISMATCH');
  equal(checkpoint.renameAliases, expected.renameAliases, 'SOURCE_CHECKPOINT_ALIASES_MISMATCH');
  requireThat(Array.isArray(checkpoint.recordEffectAnchors), 'SOURCE_CHECKPOINT_ANCHORS_INVALID');
  equal(byId(checkpoint.recordEffectAnchors), byId(expected.recordEffectAnchors), 'SOURCE_CHECKPOINT_ANCHORS_MISMATCH');
  for (const field of ['opCount', 'firstTs', 'lastTs']) {
    equal(checkpoint.archive[field], expected.archive[field], `SOURCE_ARCHIVE_${field}_MISMATCH`);
  }
  // stockFingerprint in v1 archives described the live stock at creation time,
  // not the checkpoint prefix; it cannot be compared with today's live balances.
  if (checkpoint.archive.checkpointFingerprint !== undefined) {
    equal(checkpoint.archive.checkpointFingerprint, fingerprint(checkpoint.stock), 'SOURCE_CHECKPOINT_HASH_MISMATCH');
  }
}

function validateReplay(checkpoint, hotOps, allOps) {
  const full = replayStockOps(allOps);
  const resumed = replayStockOps(hotOps, {
    baseStock: checkpoint.stock, renameAliases: checkpoint.renameAliases,
    recordEffectPrelude: checkpoint.recordEffectAnchors,
  });
  equal(resumed, full, 'STOCK_ROLLOVER_REPLAY_MISMATCH');
  // Equal balances alone could hide a changed mutation branch that cancels out.
  const hotIds = new Set(ids(hotOps));
  const archived = allOps.filter(op => !hotIds.has(op.opId));
  const selected = [
    ...selectRecordEffectOps(archived),
    ...selectRecordEffectOps([...checkpoint.recordEffectAnchors, ...hotOps])
      .filter(op => hotIds.has(op.opId)),
  ];
  equal(ids(selected), ids(selectRecordEffectOps(allOps)), 'STOCK_ROLLOVER_EFFECT_CHAIN_MISMATCH');
  return full;
}

export function buildStockRollover({ checkpoint, journal, archives, records, cutoffTs, createdAt }) {
  requireThat(checkpoint?.schemaVersion === 4 && Number.isSafeInteger(checkpoint.epoch)
    && checkpoint.epoch > 0 && Number.isSafeInteger(checkpoint.epoch + 1)
    && timestamp(checkpoint.cutoffTs), 'SOURCE_CHECKPOINT_INVALID');
  requireThat(timestamp(cutoffTs) && cutoffTs > checkpoint.cutoffTs
    && new Date(cutoffTs).toISOString().slice(8) === '01T00:00:00.000Z', 'ROLLOVER_CUTOFF_MUST_ADVANCE_TO_MONTH_START');
  requireThat(typeof createdAt === 'string' && Number.isFinite(Date.parse(createdAt))
    && Date.parse(createdAt) >= cutoffTs, 'ROLLOVER_CREATED_AT_INVALID');
  requireThat(journal?.schemaVersion === 4 && journal.epoch === checkpoint.epoch
    && Array.isArray(journal.ops), 'STOCK_ARCHIVE_EPOCH_MISMATCH');
  requireThat(Array.isArray(checkpoint.archive?.files) && Array.isArray(archives), 'SOURCE_ARCHIVES_INVALID');
  const archived = [];
  const seenPaths = new Set();
  for (const descriptor of checkpoint.archive.files) {
    requireThat(MONTH.test(descriptor?.month) && descriptor.path === `archives/stock-ops/${descriptor.month}.json`
      && !seenPaths.has(descriptor.path), 'SOURCE_ARCHIVE_DESCRIPTOR_INVALID');
    seenPaths.add(descriptor.path);
    const file = archives.find(item => item.path === descriptor.path);
    requireThat(file && Array.isArray(file.operations), `SOURCE_ARCHIVE_MISSING:${descriptor.path}`);
    requireThat(file.operations.length === descriptor.opCount, `SOURCE_ARCHIVE_COUNT_MISMATCH:${descriptor.path}`);
    for (const op of file.operations) {
      requireThat(timestamp(op?.ts) && op.ts < checkpoint.cutoffTs
        && monthOf(op.ts) === descriptor.month, `SOURCE_ARCHIVE_RANGE_MISMATCH:${descriptor.path}`);
    }
    archived.push(...file.operations);
  }
  equal(archives.map(file => file.path).sort(), [...seenPaths].sort(), 'SOURCE_ARCHIVE_INVENTORY_MISMATCH');
  const allOps = [...archived, ...journal.ops];
  validateOperations(allOps);
  normalizeStockJournal(journal, checkpoint);
  // A late operation for an already archived month needs a separate protocol
  // for immutable archive supplements. Never rewrite an existing monthly file.
  requireThat(!journal.ops.some(op => op.ts < checkpoint.cutoffTs), 'ROLLOVER_LATE_OPERATIONS_REQUIRE_REVIEW');
  validateCheckpoint(checkpoint, archived);
  const before = validateReplay(checkpoint, journal.ops, allOps);
  requireThat(Array.isArray(records), 'SOURCE_RECORDS_MUST_BE_ARRAY');
  requireThat(findRecordsMissingCreateEffect(records, journal.ops, checkpoint.recordEffectAnchors).length === 0,
    'SOURCE_RECORD_EFFECTS_MISSING');
  const result = buildStockArchiveFiles({ ops: allOps, cutoffTs, createdAt, epoch: checkpoint.epoch + 1 });
  requireThat(result.summary.archivedOps > archived.length, 'ROLLOVER_NOTHING_TO_ARCHIVE');
  for (const file of result.archiveFiles.filter(file => seenPaths.has(file.path))) {
    equal(byId(file.operations), byId(archives.find(old => old.path === file.path).operations),
      `IMMUTABLE_ARCHIVE_CHANGED:${file.path}`);
  }
  equal(validateReplay(result.checkpoint, result.hotOps, allOps), before, 'ROLLOVER_STATE_CHANGED');
  requireThat(findRecordsMissingCreateEffect(records, result.hotOps, result.checkpoint.recordEffectAnchors).length === 0,
    'ROLLOVER_RECORD_EFFECTS_MISSING');
  normalizeStockJournal(result.hotJournal, result.checkpoint);
  equal(applyStockCheckpoint(result.checkpoint, result.hotOps), before.stock, 'ROLLOVER_BALANCE_CHANGED');
  return {
    ...result,
    archiveFiles: result.archiveFiles.filter(file => !seenPaths.has(file.path)),
    summary: {
      ...result.summary, previousEpoch: checkpoint.epoch, previousHotOps: journal.ops.length,
      newlyArchivedOps: result.summary.archivedOps - archived.length,
      operationsFingerprint: fingerprint(byId(allOps)),
      checkpointFingerprint: fingerprint(result.checkpoint.stock),
      renameAliasesFingerprint: fingerprint(before.renameAliases),
      selectedRecordEffectsFingerprint: fingerprint(ids(selectRecordEffectOps(allOps))),
    },
  };
}

function readRegularFile(root, relative) {
  requireThat(!path.isAbsolute(relative) && !relative.split('/').some(part => ['..', '.', ''].includes(part)), 'SOURCE_PATH_INVALID');
  let target = root;
  for (const part of relative.split('/')) {
    target = path.join(target, part);
    requireThat(!fs.lstatSync(target).isSymbolicLink(), `SOURCE_SYMLINK:${relative}`);
  }
  requireThat(fs.statSync(target).isFile(), `SOURCE_NOT_FILE:${relative}`);
  return fs.readFileSync(target);
}

export function writeStockRolloverPlan({ sourceDir, outputDir, expectedHead, cutoff, createdAt }) {
  const source = fs.realpathSync(sourceDir);
  const output = path.resolve(outputDir);
  requireThat(SHA.test(expectedHead), 'SOURCE_HEAD_INVALID');
  requireThat(output !== source && !output.startsWith(`${source}${path.sep}`), 'OUTPUT_INSIDE_SOURCE');
  requireThat(!fs.existsSync(output), 'OUTPUT_ALREADY_EXISTS');
  const metadata = JSON.parse(readRegularFile(source, 'source-metadata.json'));
  requireThat(metadata.head === expectedHead && text(metadata.repository) && Array.isArray(metadata.files), 'SOURCE_HEAD_MISMATCH');
  const inputs = [];
  const read = relative => {
    const raw = readRegularFile(source, relative);
    const actual = describeBytes(relative, raw);
    const expected = metadata.files.filter(file => file.path === relative);
    requireThat(expected.length === 1 && expected[0].gitBlobSha === actual.gitBlobSha
      && expected[0].bytes === actual.bytes, `SOURCE_BLOB_MISMATCH:${relative}`);
    inputs.push(actual);
    return { raw, value: JSON.parse(raw) };
  };
  const checkpoint = read(CHECKPOINT).value;
  const journal = read(JOURNAL).value;
  const records = read(RECORDS).value;
  requireThat(Array.isArray(checkpoint.archive?.files), 'SOURCE_ARCHIVES_INVALID');
  const archives = checkpoint.archive.files.map(descriptor => {
    requireThat(MONTH.test(descriptor?.month) && descriptor.path === `archives/stock-ops/${descriptor.month}.json`, 'SOURCE_ARCHIVE_DESCRIPTOR_INVALID');
    const { value, raw } = read(descriptor.path);
    const digest = describeBytes(descriptor.path, raw);
    for (const field of ['sha256', 'gitBlobSha', 'bytes']) {
      if (descriptor[field] !== undefined) equal(descriptor[field], digest[field], `SOURCE_ARCHIVE_HASH_MISMATCH:${descriptor.path}`);
    }
    return { path: descriptor.path, operations: value };
  });
  const archiveRoot = path.join(source, 'archives/stock-ops');
  requireThat(!fs.lstatSync(archiveRoot).isSymbolicLink(), 'SOURCE_ARCHIVES_SYMLINK');
  const actualPaths = fs.readdirSync(archiveRoot, { recursive: true })
    .filter(file => file.endsWith('.json')).map(file => `archives/stock-ops/${file.split(path.sep).join('/')}`).sort();
  equal(actualPaths, archives.map(file => file.path).sort(), 'SOURCE_ARCHIVE_INVENTORY_MISMATCH');
  const result = buildStockRollover({ checkpoint, journal, archives, records, cutoffTs: Date.parse(cutoff), createdAt });
  const outputs = result.archiveFiles.map(file => ({ path: file.path, raw: jsonBytes(file.operations) }));
  result.checkpoint.archive.files = result.checkpoint.archive.files.map(descriptor => {
    const existing = inputs.find(input => input.path === descriptor.path);
    const added = outputs.find(file => file.path === descriptor.path);
    return { ...descriptor, ...(existing || describeBytes(descriptor.path, added.raw)) };
  });
  result.checkpoint.archive.checkpointFingerprint = result.summary.checkpointFingerprint;
  outputs.push({ path: CHECKPOINT, raw: jsonBytes(result.checkpoint) }, { path: JOURNAL, raw: jsonBytes(result.hotJournal) });
  // Match the gateway's actual base64 payload limit, without rounding MB.
  requireThat(outputs.find(file => file.path === JOURNAL).raw.toString('base64').length <= 2_900_000, 'ROLLOVER_HOT_JOURNAL_TOO_LARGE');
  const manifest = {
    mode: 'offline-dry-run', ...result.summary, createdAt,
    source: { repository: metadata.repository, expectedHead, files: inputs },
    changes: outputs.map(file => ({
      ...describeBytes(file.path, file.raw),
      action: inputs.some(input => input.path === file.path) ? 'update' : 'add',
      expectedBlobSha: inputs.find(input => input.path === file.path)?.gitBlobSha ?? null,
    })),
    preservedArchives: inputs.filter(input => input.path.startsWith('archives/')),
  };
  // Finish every semantic check before producing any candidate files. Stage the
  // complete output beside its destination so failed I/O leaves no partial plan.
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const staging = fs.mkdtempSync(path.join(path.dirname(output), '.stock-rollover-'));
  try {
    for (const file of [...outputs, { path: 'archive-manifest.json', raw: jsonBytes(manifest) }]) {
      const target = path.join(staging, file.path);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, file.raw, { flag: 'wx' });
    }
    requireThat(!fs.existsSync(output), 'OUTPUT_ALREADY_EXISTS');
    fs.renameSync(staging, output);
  } finally { fs.rmSync(staging, { recursive: true, force: true }); }
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = {};
  const allowed = new Set(['source', 'output', 'expected-head', 'cutoff', 'created-at']);
  for (let i = 2; i < process.argv.length; i += 2) {
    const key = process.argv[i].slice(2);
    requireThat(process.argv[i].startsWith('--') && allowed.has(key) && !(key in args)
      && process.argv[i + 1] !== undefined, 'USAGE_INVALID');
    args[key] = process.argv[i + 1];
  }
  requireThat([...allowed].every(key => args[key]),
    'USAGE: --source snapshot-dir --output new-dir --expected-head SHA --cutoff ISO --created-at ISO');
  console.log(JSON.stringify(writeStockRolloverPlan({ sourceDir: args.source, outputDir: args.output,
    expectedHead: args['expected-head'], cutoff: args.cutoff, createdAt: args['created-at'] }), null, 2));
}
