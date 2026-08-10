import test from "node:test";
import assert from "node:assert/strict";

import { applyStockCheckpoint } from "../src/sync-core.js";
import { buildStockInitRecoveryPlan } from "../scripts/plan-stock-init-recovery.mjs";

const checkpoint = {
  schemaVersion: 4,
  epoch: 1,
  cutoffTs: 1_800_000_000_100,
  stock: { main: { A: 10, B: 8 }, ws: { SMART: { A: 2 }, "Бегемот": { B: 4 } } },
  renameAliases: {},
  recordEffectAnchors: [],
  archive: {},
};

const journal = {
  schemaVersion: 4,
  epoch: 1,
  ops: [
    { type: "delta", location: "main", marker: "A", delta: -1, ts: 1_800_000_000_110, client: "sale", opId: "sale-before" },
    { type: "init", location: "main", marker: "A", value: 3, ts: 1_800_000_000_120, client: "migration", opId: "bad-main-a" },
    { type: "init", location: "ws:SMART", marker: "A", value: 20, ts: 1_800_000_000_120, client: "migration", opId: "bad-smart-a" },
    { type: "delta", location: "main", marker: "A", delta: -2, ts: 1_800_000_000_130, client: "sale", opId: "sale-after" },
    { type: "move", from: "main", to: "ws:Бегемот", marker: "B", qty: 2, ts: 1_800_000_000_140, client: "move", opId: "move-after" },
  ],
};

test("recovery neutralizes one repeated init batch while preserving later sales and moves", () => {
  const plan = buildStockInitRecoveryPlan({
    journal,
    checkpoint,
    sourceTs: 1_800_000_000_120,
    expectedSourceCount: 2,
    incidentId: "repeat-migration-2026-08-08",
    recoveryTs: 1_800_000_000_150,
  });
  assert.equal(plan.source.count, 2);
  assert.deepEqual(plan.rows, [
    { location: "main", marker: "A", actual: 1, desired: 7, delta: 6 },
    { location: "ws:SMART", marker: "A", actual: 20, desired: 2, delta: -18 },
  ]);
  const recovered = applyStockCheckpoint(checkpoint, [...journal.ops, ...plan.recoveryOps]);
  assert.deepEqual(recovered, plan.desiredStock);
  assert.equal(recovered.main.A, 7);
  assert.equal(recovered.main.B, 6);
  assert.equal(recovered.ws["Бегемот"].B, 6);
});

test("recovery is guarded by the exact batch size and a stable incident id", () => {
  assert.throws(() => buildStockInitRecoveryPlan({
    journal,
    checkpoint,
    sourceTs: 1_800_000_000_120,
    expectedSourceCount: 3,
    incidentId: "repeat-migration-2026-08-08",
    recoveryTs: 1_800_000_000_150,
  }), /STOCK_RECOVERY_SOURCE_COUNT_MISMATCH:2/);

  const first = buildStockInitRecoveryPlan({
    journal,
    checkpoint,
    sourceTs: 1_800_000_000_120,
    expectedSourceCount: 2,
    incidentId: "repeat-migration-2026-08-08",
    recoveryTs: 1_800_000_000_150,
  });
  const alreadyRecovered = { ...journal, ops: [...journal.ops, ...first.recoveryOps] };
  assert.throws(() => buildStockInitRecoveryPlan({
    journal: alreadyRecovered,
    checkpoint,
    sourceTs: 1_800_000_000_120,
    expectedSourceCount: 2,
    incidentId: "repeat-migration-2026-08-08",
    recoveryTs: 1_800_000_000_160,
  }), /STOCK_RECOVERY_ALREADY_APPLIED/);
});
