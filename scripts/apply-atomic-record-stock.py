from pathlib import Path
import re

def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected 1 match, found {count}")
    return text.replace(old, new, 1)

def regex_once(text, pattern, replacement, label):
    updated, count = re.subn(pattern, replacement, text, count=1, flags=re.S)
    if count != 1:
        raise SystemExit(f"{label}: expected 1 match, found {count}")
    return updated

sync_path = Path("src/sync-core.js")
app_path = Path("src/App.jsx")
test_path = Path("tests/sync-core.test.mjs")
sync = sync_path.read_text(encoding="utf-8")
app = app_path.read_text(encoding="utf-8")
tests = test_path.read_text(encoding="utf-8")

sync = replace_once(sync,
'''export function recordVersion(record) {
  if (!record || typeof record !== "object") return 0;
  const value = Number(record.updatedAt ?? record.timestamp ?? 0);
  return Number.isFinite(value) ? value : 0;
}
''',
'''export function recordVersion(record) {
  if (!record || typeof record !== "object") return 0;
  const value = Number(record.updatedAt ?? record.timestamp ?? 0);
  return Number.isFinite(value) ? value : 0;
}

export function recordRevision(record) {
  if (!record || typeof record !== "object") return 0;
  const value = Number(record.revision);
  if (Number.isInteger(value) && value >= 0) return value;
  return record.id ? 1 : 0;
}

export function sameRecordVersion(current, opened) {
  if (!current || !opened || typeof current !== "object" || typeof opened !== "object") return false;
  if (current.id || opened.id) {
    if (!current.id || current.id !== opened.id) return false;
  }
  return recordRevision(current) === recordRevision(opened)
    && String(current.lastMutationId || "") === String(opened.lastMutationId || "")
    && recordVersion(current) === recordVersion(opened);
}

function compareRecordState(candidate, previous) {
  const revisionDiff = recordRevision(candidate) - recordRevision(previous);
  if (revisionDiff) return revisionDiff;
  const versionDiff = recordVersion(candidate) - recordVersion(previous);
  if (versionDiff) return versionDiff;
  const mutationDiff = String(candidate?.lastMutationId || "").localeCompare(String(previous?.lastMutationId || ""));
  if (mutationDiff) return mutationDiff;
  return canonicalJson(candidate).localeCompare(canonicalJson(previous));
}
''', "record version helpers")

sync = replace_once(sync,
'''    const previous = map.get(key);
    if (!previous || recordVersion(record) >= recordVersion(previous)) map.set(key, record);''',
'''    const previous = map.get(key);
    if (!previous || compareRecordState(record, previous) >= 0) map.set(key, record);''',
"record merge ordering")

sync = replace_once(sync,
'''    recordId: op.recordId,
    reason: op.reason,''',
'''    recordId: op.recordId,
    mutationId: op.mutationId,
    baseMutationId: op.baseMutationId,
    baseRevision: op.baseRevision,
    revision: op.revision,
    mutationKind: op.mutationKind,
    before: op.before,
    after: op.after,
    reason: op.reason,''',
"stock identity metadata")

sync = replace_once(sync,
'''export function applyOpsToStock(ops, options = {}) {''',
'''function recordMutationPriority(op) {
  if (op?.mutationKind === "delete") return 3;
  if (op?.mutationKind === "edit") return 2;
  if (op?.mutationKind === "create") return 1;
  return 0;
}

function chooseRecordEffectCandidate(candidates) {
  let winner = null;
  for (const candidate of candidates) {
    if (!winner) { winner = candidate; continue; }
    const revisionDiff = Number(candidate.revision) - Number(winner.revision);
    const priorityDiff = recordMutationPriority(candidate) - recordMutationPriority(winner);
    const timeDiff = Number(candidate.updatedAt ?? candidate.ts ?? 0) - Number(winner.updatedAt ?? winner.ts ?? 0);
    const mutationDiff = String(candidate.mutationId).localeCompare(String(winner.mutationId));
    if (revisionDiff > 0 || (!revisionDiff && (priorityDiff > 0 ||
        (!priorityDiff && (timeDiff > 0 || (!timeDiff && mutationDiff > 0)))))) winner = candidate;
  }
  return winner;
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
    const byParent = new Map();
    for (const op of recordOps) {
      const parent = typeof op.baseMutationId === "string" ? op.baseMutationId : "";
      if (!byParent.has(parent)) byParent.set(parent, []);
      byParent.get(parent).push(op);
    }
    const roots = byParent.get("") || [];
    if (!roots.length) continue;
    const minBase = Math.min(...roots.map(op => Number(op.baseRevision)));
    let winner = chooseRecordEffectCandidate(roots.filter(op => Number(op.baseRevision) === minBase));
    while (winner) {
      selected.push(winner);
      const children = (byParent.get(winner.mutationId) || [])
        .filter(op => Number(op.baseRevision) === Number(winner.revision));
      winner = chooseRecordEffectCandidate(children);
    }
  }
  return selected.sort((a, b) =>
    Number(a?.ts || 0) - Number(b?.ts || 0) ||
    String(stockOpIdentity(a)).localeCompare(String(stockOpIdentity(b)))
  );
}

export function applyOpsToStock(ops, options = {}) {''',
"record effect selection")

sync = replace_once(sync,
'''  const sortedOps = [...validOps].sort((a, b) => {
    const tsDiff = Number(a.ts) - Number(b.ts);
    return tsDiff || String(stockOpIdentity(a)).localeCompare(String(stockOpIdentity(b)));
  });

  const renamedTo = new Map();''',
'''  const sortedOps = [...validOps].sort((a, b) => {
    const tsDiff = Number(a.ts) - Number(b.ts);
    return tsDiff || String(stockOpIdentity(a)).localeCompare(String(stockOpIdentity(b)));
  });
  const selectedRecordEffectIds = new Set(
    selectRecordEffectOps(sortedOps).map(op => stockOpIdentity(op)).filter(Boolean)
  );

  const renamedTo = new Map();''',
"selected record effect ids")

sync = replace_once(sync,
'''  const getBucket = (location) => {
    const parsed = parseLocation(location, workshops);
    if (!parsed) return null;
    return parsed.scope === "main" ? result.main : result.ws[parsed.workshop];
  };''',
'''  const getBucket = (location) => {
    const parsed = parseLocation(location, workshops);
    if (!parsed) return null;
    return parsed.scope === "main" ? result.main : result.ws[parsed.workshop];
  };
  const applyRecordEffect = (effect, multiplier) => {
    if (!effect || typeof effect !== "object") return;
    const bucket = getBucket(effect.location);
    const marker = resolveMarker(effect.marker);
    const qty = Number(effect.qty);
    if (!bucket || !marker || !Number.isFinite(qty) || qty <= 0) return;
    bucket[marker] = (Number(bucket[marker]) || 0) + multiplier * qty;
  };''',
"record effect applier")

sync = replace_once(sync,
'''      const marker = resolveMarker(op.marker);
      if (!marker) continue;''',
'''      if (op.type === "record-effect") {
        if (!selectedRecordEffectIds.has(stockOpIdentity(op))) continue;
        applyRecordEffect(op.before, 1);
        applyRecordEffect(op.after, -1);
        continue;
      }

      const marker = resolveMarker(op.marker);
      if (!marker) continue;''',
"record effect replay")

sync = replace_once(sync,
'''export function mergeById(remote, local) {''',
'''function compareVersionedItems(candidate, previous) {
  const candidateRevision = Number.isInteger(Number(candidate?.revision)) ? Number(candidate.revision) : 0;
  const previousRevision = Number.isInteger(Number(previous?.revision)) ? Number(previous.revision) : 0;
  if (candidateRevision !== previousRevision) return candidateRevision - previousRevision;
  const timeDiff = itemVersion(candidate) - itemVersion(previous);
  if (timeDiff) return timeDiff;
  return String(candidate?.mutationId || candidate?.lastMutationId || "")
    .localeCompare(String(previous?.mutationId || previous?.lastMutationId || ""));
}

export function mergeById(remote, local) {''',
"versioned tombstones")

sync = replace_once(sync,
'''    const previous = map.get(id);
    if (!previous || itemVersion(item) >= itemVersion(previous)) map.set(id, item);''',
'''    const previous = map.get(id);
    if (!previous || compareVersionedItems(item, previous) >= 0) map.set(id, item);''',
"tombstone ordering")

app = replace_once(app,
'''  findRecordIndex,
  mergeById,''',
'''  findRecordIndex,
  recordRevision,
  sameRecordVersion,
  mergeById,''',
"App imports")

app = replace_once(app,
'''  //   { type: "rename", oldMarker, newMarker, ts, client, opId }
  // location: "main" | "ws:SMART" | "ws:Бегемот"''',
'''  //   { type: "rename", oldMarker, newMarker, ts, client, opId }
  //   { type: "record-effect", recordId, mutationId, baseMutationId,
  //     baseRevision, revision, mutationKind, before, after, ts, client, opId }
  // location: "main" | "ws:SMART" | "ws:Бегемот"''',
"stock event docs")

app = regex_once(app,
r'''  async function appendStockOp\(type, payload\) \{.*?\n  \}\n\n  // Доставка append-only outbox''',
'''  function stageStockOp(type, payload = {}) {
    const { opId: requestedOpId, ts: requestedTs, client: _client, type: _type, ...body } = payload || {};
    const numericTs = Number(requestedTs);
    const op = {
      ...body,
      type,
      ts: Number.isFinite(numericTs) ? numericTs : Date.now(),
      client: clientIdRef.current,
      opId: requestedOpId || makeOpId(),
    };

    try {
      addStockOutboxOp(op);
    } catch (error) {
      console.error('[stock-outbox] Не удалось сохранить операцию:', error.message);
      setSyncStatus("offline");
      alert("Изменение склада не сохранено: на устройстве закончилось место. Освободите место и повторите действие.");
      return { ok:false, queued:false, error:error.message };
    }
    unsyncedOpsRef.current.add(op.opId);
    syncRetriesRef.current = 0;

    const newOps = mergeStockOps(stockOpsRef.current, [op]);
    stockOpsRef.current = newOps;
    persistStockSnapshot(newOps);
    setStockOps(newOps);
    const newStock = applyOpsToStock(newOps);
    stockRef.current = newStock;
    setStock(newStock);
    return { ok:true, queued:true, op };
  }

  async function appendStockOp(type, payload) {
    const staged = stageStockOp(type, payload);
    if (!staged.ok) return staged;
    scheduleStockSync(700);
    return new Promise(resolve => stockSyncWaitersRef.current.push(resolve));
  }

  // Доставка append-only outbox''',
"stage stock operation")

record_block = '''  function makeRecordMutationId(recordId){
    return `mut-${recordId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function stockEffectForRecord(record){
    if(!record) return null;
    const used = stockDelta(record);
    if(!(used > 0)) return null;
    return { location: `ws:${record.workshop}`, marker: record.marker, qty: used };
  }

  function stageRecordEffect({kind, beforeRecord, afterRecord, mutationId, revision, now}){
    const source = afterRecord || beforeRecord;
    if(!source?.id) return {ok:false, error:"RECORD_ID_REQUIRED"};
    return stageStockOp("record-effect", {
      opId: `record-effect:${mutationId}`,
      recordId: source.id,
      mutationId,
      baseMutationId: beforeRecord?.lastMutationId || null,
      baseRevision: beforeRecord ? recordRevision(beforeRecord) : 0,
      revision,
      mutationKind: kind,
      before: stockEffectForRecord(beforeRecord),
      after: stockEffectForRecord(afterRecord),
      updatedAt: now,
      ts: now,
    });
  }

  function checkCommittedRecordMutation(result, recordId, mutationId){
    if(!result || result.queued || !Array.isArray(result.value)) return;
    const committed = result.value.find(record => record?.id === recordId);
    if(committed && committed.lastMutationId !== mutationId){
      alert("Эта запись одновременно менялась на другом устройстве. Применён более новый вариант; откройте запись заново.");
    }
  }

  // ── добавление записи ──
  async function submitRecord(){
    if(!marker.trim()){setSubmitMsg({ok:false,text:"Укажите маркировку"});return;}
    if(recordType==="sale" && qty===0 && defect===0){
      setSubmitMsg({ok:false,text:"Укажите количество или брак"});return;
    }
    if(amount<0){setSubmitMsg({ok:false,text:"Сумма не может быть отрицательной"});return;}

    const now = Date.now();
    const m = marker.trim();
    const recordId = `rec-${now}-${Math.random().toString(36).slice(2, 8)}`;
    const mutationId = makeRecordMutationId(recordId);
    const rec = {
      id: recordId, workshop, category, marker: m, qty, defect, amount, comment,
      recordType, timestamp: now, updatedAt: now, revision: 1, lastMutationId: mutationId,
    };
    const staged = stageRecordEffect({
      kind: "create", beforeRecord: null, afterRecord: rec, mutationId, revision: 1, now,
    });
    if(!staged.ok){
      setSubmitMsg({ok:false,text:"Не удалось надёжно сохранить операцию. Освободите место и повторите."});
      return;
    }

    const next = [...recordsRef.current, rec];
    recordsRef.current = next;
    const savePromise = saveAndSync("records", next, setRecords);
    scheduleStockSync(700);
    savePromise.then(result => checkCommittedRecordMutation(result, recordId, mutationId)).catch(()=>{});

    setMarker(""); setQty(0); setDefect(0); setAmount(0);
    setManualAmount(false); setComment(""); setRecordType("sale");
    setSubmitMsg({ok:true, text: rec.recordType==="refund" ? "Возврат оформлен" : (rec.qty===0&&rec.defect>0 ? `Брак оформлен (${rec.defect} шт)` : "Запись добавлена")});
    setTimeout(()=>setSubmitMsg(null), 2000);
  }

  // ── сохранение редактируемой записи ──
  async function handleEditSave(updated){
    const targetRecord = editRec?.record || updated;
    const oldIdx = findRecordIndex(recordsRef.current, targetRecord);
    if (oldIdx === -1) {
      alert('Не удалось однозначно найти запись. Обновите приложение и повторите действие.');
      setEditRec(null);
      return;
    }
    const old = recordsRef.current[oldIdx];
    if(!sameRecordVersion(old, targetRecord)){
      alert("Запись уже изменилась на другом устройстве. Откройте её заново.");
      setEditRec(null);
      return;
    }

    const now = Date.now();
    const recId = old.id || updated.id || `rec-${now}-${Math.random().toString(36).slice(2, 8)}`;
    const mutationId = makeRecordMutationId(recId);
    const revision = recordRevision(old) + 1;
    const nextRecord = {
      ...updated, id: recId, timestamp: old.timestamp, updatedAt: now,
      revision, lastMutationId: mutationId,
    };
    const staged = stageRecordEffect({
      kind: "edit", beforeRecord: old, afterRecord: nextRecord, mutationId, revision, now,
    });
    if(!staged.ok) return;

    const next = recordsRef.current.map((record, index) => index === oldIdx ? nextRecord : record);
    recordsRef.current = next;
    const savePromise = saveAndSync("records", next, setRecords);
    scheduleStockSync(700);
    savePromise.then(result => checkCommittedRecordMutation(result, recId, mutationId)).catch(()=>{});
    setEditRec(null);
  }

  async function handleEditDelete(recordOrId){
    if(!confirm("Удалить эту запись?")) return;
    const targetRecord = typeof recordOrId === "string" ? { id: recordOrId } : recordOrId;
    const oldIdx = findRecordIndex(recordsRef.current, targetRecord);
    if (oldIdx === -1) {
      alert('Не удалось однозначно найти запись. Обновите приложение и повторите действие.');
      setEditRec(null);
      return;
    }
    const old = recordsRef.current[oldIdx];
    if(!sameRecordVersion(old, targetRecord)){
      alert("Запись уже изменилась на другом устройстве. Откройте её заново перед удалением.");
      setEditRec(null);
      return;
    }

    const now = Date.now();
    const recId = old.id || targetRecord?.id || `rec-${now}-${Math.random().toString(36).slice(2, 8)}`;
    const mutationId = makeRecordMutationId(recId);
    const revision = recordRevision(old) + 1;
    const staged = stageRecordEffect({
      kind: "delete", beforeRecord: old, afterRecord: null, mutationId, revision, now,
    });
    if(!staged.ok) return;

    const tombstone = {
      id: recId, deletedAt: now, updatedAt: now, revision, mutationId,
      baseMutationId: old.lastMutationId || null, client: clientIdRef.current,
    };
    const nextDeletions = mergeById(recordDeletionsRef.current, [tombstone]);
    recordDeletionsRef.current = nextDeletions;
    setRecordDeletionIds(nextDeletions);
    commitImmediate("record-deletions", nextDeletions).catch(()=>{});

    const next = recordsRef.current.filter((_, index) => index !== oldIdx);
    recordsRef.current = next;
    saveAndSync("records", next, setRecords);
    scheduleStockSync(700);
    setEditRec(null);
  }

'''

app = regex_once(app,
r'''  // ── добавление записи ──.*?(?=  // ── склад: перемещение ──)''',
record_block,
"record mutation UI block")

tests = replace_once(tests,
'''  findRecordIndex,
  mergeById,''',
'''  findRecordIndex,
  recordRevision,
  sameRecordVersion,
  selectRecordEffectOps,
  mergeById,''',
"test imports")

tests += r'''

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
'''

sync_path.write_text(sync, encoding="utf-8")
app_path.write_text(app, encoding="utf-8")
test_path.write_text(tests, encoding="utf-8")
print("Applied atomic record/stock mutation patch")
