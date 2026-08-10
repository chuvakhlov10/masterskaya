import fs from "node:fs";
import { pathToFileURL } from "node:url";

import {
  applyStockCheckpoint,
  normalizeStockCheckpoint,
  normalizeStockJournal,
} from "../src/sync-core.js";

const LOCATION_ORDER = ["main", "ws:SMART", "ws:Бегемот"];

function stockBucket(stock, location) {
  if (location === "main") return stock?.main || {};
  if (location.startsWith("ws:")) return stock?.ws?.[location.slice(3)] || {};
  throw new Error(`STOCK_RECOVERY_LOCATION_INVALID:${location}`);
}

function sameStock(left, right) {
  for (const location of LOCATION_ORDER) {
    const a = stockBucket(left, location);
    const b = stockBucket(right, location);
    const markers = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const marker of markers) {
      if ((Number(a[marker]) || 0) !== (Number(b[marker]) || 0)) return false;
    }
  }
  return true;
}

export function buildStockInitRecoveryPlan({
  journal,
  checkpoint,
  sourceClient = "migration",
  sourceTs,
  expectedSourceCount,
  incidentId,
  recoveryTs,
}) {
  const normalizedCheckpoint = normalizeStockCheckpoint(checkpoint);
  if (!normalizedCheckpoint) throw new Error("STOCK_RECOVERY_CHECKPOINT_REQUIRED");
  const normalizedJournal = normalizeStockJournal(journal, normalizedCheckpoint);
  const numericSourceTs = Number(sourceTs);
  if (!Number.isFinite(numericSourceTs)) throw new Error("STOCK_RECOVERY_SOURCE_TS_INVALID");
  const safeIncidentId = String(incidentId || "").trim();
  if (!/^[a-z0-9-]{8,80}$/i.test(safeIncidentId)) throw new Error("STOCK_RECOVERY_INCIDENT_ID_INVALID");

  const sourceOps = normalizedJournal.ops.filter(op =>
    op?.type === "init" &&
    op?.client === sourceClient &&
    Number(op?.ts) === numericSourceTs
  );
  if (Number.isInteger(expectedSourceCount) && sourceOps.length !== expectedSourceCount) {
    throw new Error(`STOCK_RECOVERY_SOURCE_COUNT_MISMATCH:${sourceOps.length}`);
  }
  if (sourceOps.length === 0) throw new Error("STOCK_RECOVERY_SOURCE_NOT_FOUND");

  const recoveryPrefix = `recovery:${safeIncidentId}:`;
  if (normalizedJournal.ops.some(op => String(op?.opId || "").startsWith(recoveryPrefix))) {
    throw new Error("STOCK_RECOVERY_ALREADY_APPLIED");
  }

  const sourceIds = new Set(sourceOps.map(op => op.opId));
  if (sourceIds.size !== sourceOps.length || sourceIds.has(undefined)) {
    throw new Error("STOCK_RECOVERY_SOURCE_ID_INVALID");
  }
  const withoutSource = normalizedJournal.ops.filter(op => !sourceIds.has(op?.opId));
  const actualStock = applyStockCheckpoint(normalizedCheckpoint, normalizedJournal.ops);
  const desiredStock = applyStockCheckpoint(normalizedCheckpoint, withoutSource);
  const rows = [];

  for (const location of LOCATION_ORDER) {
    const actual = stockBucket(actualStock, location);
    const desired = stockBucket(desiredStock, location);
    const markers = [...new Set([...Object.keys(actual), ...Object.keys(desired)])]
      .sort((a, b) => a.localeCompare(b, "ru"));
    for (const marker of markers) {
      const actualQty = Number(actual[marker]) || 0;
      const desiredQty = Number(desired[marker]) || 0;
      if (actualQty === desiredQty) continue;
      if (desiredQty < 0) throw new Error(`STOCK_RECOVERY_NEGATIVE_TARGET:${location}:${marker}`);
      rows.push({ location, marker, actual: actualQty, desired: desiredQty, delta: desiredQty - actualQty });
    }
  }

  const numericRecoveryTs = Number(recoveryTs);
  const latestTs = normalizedJournal.ops.reduce((max, op) => Math.max(max, Number(op?.ts) || 0), 0);
  if (!Number.isFinite(numericRecoveryTs) || numericRecoveryTs <= latestTs) {
    throw new Error("STOCK_RECOVERY_TS_NOT_LATEST");
  }
  const recoveryOps = rows.map((row, index) => ({
    type: "delta",
    location: row.location,
    marker: row.marker,
    delta: row.delta,
    ts: numericRecoveryTs,
    client: `recovery:${safeIncidentId}`,
    opId: `${recoveryPrefix}${String(index + 1).padStart(4, "0")}`,
    archiveEpoch: normalizedCheckpoint.epoch,
    recoveryFor: {
      client: sourceClient,
      ts: numericSourceTs,
    },
  }));

  const recoveredStock = applyStockCheckpoint(
    normalizedCheckpoint,
    [...normalizedJournal.ops, ...recoveryOps],
  );
  if (!sameStock(recoveredStock, desiredStock)) throw new Error("STOCK_RECOVERY_VERIFICATION_FAILED");

  return {
    incidentId: safeIncidentId,
    source: { client: sourceClient, ts: numericSourceTs, count: sourceOps.length },
    journal: { beforeCount: normalizedJournal.ops.length, afterCount: normalizedJournal.ops.length + recoveryOps.length },
    rows,
    recoveryOps,
    actualStock,
    desiredStock,
  };
}

function readJson(path) {
  return JSON.parse(fs.readFileSync(path, "utf8"));
}

function cliArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    if (!name?.startsWith("--") || argv[index + 1] === undefined) throw new Error("STOCK_RECOVERY_ARGUMENTS_INVALID");
    values[name.slice(2)] = argv[index + 1];
  }
  return values;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const args = cliArgs(process.argv.slice(2));
  const plan = buildStockInitRecoveryPlan({
    journal: readJson(args.journal),
    checkpoint: readJson(args.checkpoint),
    sourceClient: args["source-client"] || "migration",
    sourceTs: Number(args["source-ts"]),
    expectedSourceCount: Number(args["expected-source-count"]),
    incidentId: args["incident-id"],
    recoveryTs: Number(args["recovery-ts"]),
  });
  process.stdout.write(JSON.stringify({
    incidentId: plan.incidentId,
    source: plan.source,
    journal: plan.journal,
    rows: plan.rows,
    recoveryOps: plan.recoveryOps,
  }));
}
