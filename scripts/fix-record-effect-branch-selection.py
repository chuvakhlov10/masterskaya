from pathlib import Path
import re

sync_path = Path("src/sync-core.js")
test_path = Path("tests/sync-core.test.mjs")
sync = sync_path.read_text(encoding="utf-8")
tests = test_path.read_text(encoding="utf-8")

replacement = r'''function recordMutationPriority(op) {
  return op?.mutationKind === "delete" ? 1 : 0;
}

function compareRecordEffectTerminal(candidate, previous) {
  const deleteDiff = recordMutationPriority(candidate) - recordMutationPriority(previous);
  if (deleteDiff) return deleteDiff;
  const revisionDiff = Number(candidate.revision) - Number(previous.revision);
  if (revisionDiff) return revisionDiff;
  const timeDiff = Number(candidate.updatedAt ?? candidate.ts ?? 0) - Number(previous.updatedAt ?? previous.ts ?? 0);
  if (timeDiff) return timeDiff;
  return String(candidate.mutationId).localeCompare(String(previous.mutationId));
}

function traceRecordEffectChain(candidate, byMutationId) {
  const reversed = [];
  const visited = new Set();
  let current = candidate;
  while (current) {
    if (visited.has(current.mutationId)) return null;
    visited.add(current.mutationId);
    reversed.push(current);
    const parentId = typeof current.baseMutationId === "string" ? current.baseMutationId : "";
    if (!parentId) return reversed.reverse();
    const parent = byMutationId.get(parentId);
    if (!parent || Number(parent.revision) !== Number(current.baseRevision)) return null;
    current = parent;
  }
  return null;
}

export function selectRecordEffectOps(ops) {
  const groups = new Map();
  for (const op of Array.isArray(ops) ? ops : []) {
    if (!op || op.type !== "record-effect" || !op.recordId || !op.mutationId) continue;
    const baseRevision = Number(op.baseRevision);
    const revision = Number(op.revision);
    if (!Number.isInteger(baseRevision) || baseRevision < 0 ||
        !Number.isInteger(revision) || revision <= baseRevision) continue;
    if (!groups.has(op.recordId)) groups.set(op.recordId, []);
    groups.get(op.recordId).push(op);
  }

  const selected = [];
  for (const recordOps of groups.values()) {
    const byMutationId = new Map(recordOps.map(op => [op.mutationId, op]));
    const candidates = [...recordOps].sort((a, b) => compareRecordEffectTerminal(b, a));
    for (const candidate of candidates) {
      const chain = traceRecordEffectChain(candidate, byMutationId);
      if (!chain) continue;
      selected.push(...chain);
      break;
    }
  }

  const unique = new Map();
  for (const op of selected) {
    const identity = stockOpIdentity(op);
    if (identity && !unique.has(identity)) unique.set(identity, op);
  }
  return [...unique.values()].sort((a, b) =>
    Number(a?.ts || 0) - Number(b?.ts || 0) ||
    String(stockOpIdentity(a)).localeCompare(String(stockOpIdentity(b)))
  );
}

export function applyOpsToStock'''
updated, count = re.subn(
    r'function recordMutationPriority\(op\) \{.*?export function applyOpsToStock',
    replacement,
    sync,
    count=1,
    flags=re.S,
)
if count != 1:
    raise SystemExit(f"record effect selector replacement count={count}")
sync = updated

marker = "test('higher descendant revision selects its complete competing branch'"
if marker not in tests:
    tests += r'''

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
'''

sync_path.write_text(sync, encoding="utf-8")
test_path.write_text(tests, encoding="utf-8")
print("Fixed record effect branch selection")
