import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  applyOpsToStock,
  applyStockCheckpoint,
  createStockArchivePlan,
} from '../src/sync-core.js';

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  const result = {};
  for (const key of Object.keys(value).sort()) result[key] = canonicalize(value[key]);
  return result;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function prettyJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function monthOf(ts) {
  return new Date(Number(ts)).toISOString().slice(0, 7);
}

function assertValidOperations(ops) {
  if (!Array.isArray(ops)) throw new Error('STOCK_OPS_MUST_BE_ARRAY');
  const ids = new Set();
  for (const [index, op] of ops.entries()) {
    if (!op || typeof op !== 'object') throw new Error(`STOCK_OP_INVALID:${index}`);
    if (typeof op.opId !== 'string' || !op.opId.trim()) throw new Error(`STOCK_OP_ID_MISSING:${index}`);
    if (ids.has(op.opId)) throw new Error(`STOCK_OP_ID_DUPLICATE:${op.opId}`);
    if (!Number.isFinite(Number(op.ts))) throw new Error(`STOCK_OP_TS_INVALID:${op.opId}`);
    ids.add(op.opId);
  }
}

function negativeBalances(stock) {
  const result = [];
  const buckets = [
    ['main', stock?.main],
    ...Object.entries(stock?.ws || {}).map(([workshop, values]) => [`ws:${workshop}`, values]),
  ];
  for (const [location, values] of buckets) {
    for (const [marker, raw] of Object.entries(values || {})) {
      if (Number(raw) < 0) result.push({ location, marker, value: Number(raw) });
    }
  }
  return result;
}

function groupByMonth(ops) {
  const groups = new Map();
  for (const op of ops) {
    const month = monthOf(op.ts);
    if (!groups.has(month)) groups.set(month, []);
    groups.get(month).push(op);
  }
  return groups;
}

function writeNewFile(root, relativePath, value) {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (fs.existsSync(target)) throw new Error(`OUTPUT_ALREADY_EXISTS:${relativePath}`);
  fs.writeFileSync(target, prettyJson(value), { encoding: 'utf8', flag: 'wx' });
  return {
    path: relativePath.split(path.sep).join('/'),
    bytes: Buffer.byteLength(prettyJson(value)),
    sha256: sha256(prettyJson(value)),
  };
}

export function buildStockArchiveFiles({ ops, cutoffTs, createdAt, epoch = 1 }) {
  assertValidOperations(ops);
  const cutoff = Number(cutoffTs);
  if (!Number.isFinite(cutoff)) throw new Error('STOCK_ARCHIVE_CUTOFF_INVALID');
  const plan = createStockArchivePlan(ops, cutoff, { epoch, createdAt });
  const fullStock = applyOpsToStock(ops);
  const resumedStock = applyStockCheckpoint(plan.checkpoint, plan.hotOps);
  const fullFingerprint = sha256(canonicalJson(fullStock));
  const resumedFingerprint = sha256(canonicalJson(resumedStock));
  if (fullFingerprint !== resumedFingerprint) throw new Error('STOCK_ARCHIVE_BALANCE_MISMATCH');
  const negatives = negativeBalances(plan.checkpoint.stock);
  if (negatives.length > 0) throw new Error(`STOCK_ARCHIVE_NEGATIVE_BALANCES:${negatives.length}`);

  const archives = groupByMonth(plan.archivedOps);
  const archiveFiles = [...archives.entries()].map(([month, monthOps]) => ({
    month,
    path: `archives/stock-ops/${month}.json`,
    operations: monthOps,
  }));
  const checkpoint = {
    ...plan.checkpoint,
    archive: {
      ...plan.checkpoint.archive,
      files: archiveFiles.map(file => ({ month: file.month, path: file.path, opCount: file.operations.length })),
      stockFingerprint: fullFingerprint,
    },
  };
  const hotJournal = {
    schemaVersion: 4,
    epoch: checkpoint.epoch,
    ops: plan.hotOps,
  };
  return {
    checkpoint,
    hotOps: plan.hotOps,
    hotJournal,
    archiveFiles,
    summary: {
      schemaVersion: 4,
      epoch: checkpoint.epoch,
      cutoffTs: cutoff,
      totalOps: ops.length,
      archivedOps: plan.archivedOps.length,
      hotOps: plan.hotOps.length,
      archiveMonths: archiveFiles.map(file => file.month),
      stockFingerprint: fullFingerprint,
    },
  };
}

export function writeStockArchivePlan({ inputPath, outputDir, cutoff, createdAt, epoch = 1 }) {
  const ops = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  const cutoffTs = Date.parse(cutoff);
  if (!Number.isFinite(cutoffTs)) throw new Error('STOCK_ARCHIVE_CUTOFF_INVALID');
  if (!createdAt || !Number.isFinite(Date.parse(createdAt))) throw new Error('STOCK_ARCHIVE_CREATED_AT_INVALID');
  fs.mkdirSync(outputDir, { recursive: true });
  if (fs.readdirSync(outputDir).length > 0) throw new Error('OUTPUT_DIRECTORY_NOT_EMPTY');

  const result = buildStockArchiveFiles({ ops, cutoffTs, createdAt, epoch });
  const writtenArchives = result.archiveFiles.map(file =>
    writeNewFile(outputDir, file.path, file.operations)
  );
  const checkpointFile = writeNewFile(outputDir, 'data/stock-checkpoint.json', result.checkpoint);
  const hotFile = writeNewFile(outputDir, 'data/stock-ops.json', result.hotJournal);
  const manifest = {
    ...result.summary,
    files: {
      checkpoint: checkpointFile,
      hot: hotFile,
      archives: writtenArchives,
    },
  };
  writeNewFile(outputDir, 'archive-manifest.json', manifest);
  return manifest;
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined) throw new Error('USAGE_INVALID');
    result[key.slice(2)] = value;
  }
  return result;
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.input || !args.output || !args.cutoff || !args['created-at']) {
    throw new Error('USAGE: --input stock-ops.json --output directory --cutoff ISO --created-at ISO [--epoch N]');
  }
  const manifest = writeStockArchivePlan({
    inputPath: path.resolve(args.input),
    outputDir: path.resolve(args.output),
    cutoff: args.cutoff,
    createdAt: args['created-at'],
    epoch: args.epoch ? Number(args.epoch) : 1,
  });
  console.log(JSON.stringify(manifest, null, 2));
}
