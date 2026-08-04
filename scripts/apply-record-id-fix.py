from pathlib import Path
import re

app_path = Path('src/App.jsx')
core_path = Path('src/sync-core.js')
test_path = Path('tests/sync-core.test.mjs')

app = app_path.read_text(encoding='utf-8')
core = core_path.read_text(encoding='utf-8')
tests = test_path.read_text(encoding='utf-8')


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected one match, found {count}')
    return text.replace(old, new, 1)

# Pure resolver used by edit/delete code and covered by tests.
resolver_marker = 'export function findRecordIndex(records, target)'
if resolver_marker not in core:
    anchor = '''export function recordVersion(record) {
  if (!record || typeof record !== "object") return 0;
  const value = Number(record.updatedAt ?? record.timestamp ?? 0);
  return Number.isFinite(value) ? value : 0;
}
'''
    resolver = anchor + '''

// Finds the exact record selected by the user. Modern records are resolved by
// immutable id. Legacy records without id may be resolved only when their
// canonical identity is unique; ambiguous duplicates are deliberately rejected.
export function findRecordIndex(records, target) {
  const items = Array.isArray(records) ? records : [];
  if (!target || typeof target !== "object") return -1;

  if (target.id) {
    return items.findIndex(item => item && item.id === target.id);
  }

  const sameReference = items.findIndex(item => item === target);
  if (sameReference >= 0) return sameReference;

  const key = recordKey(target);
  if (!key) return -1;
  const matches = [];
  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    if (!item || item.id) continue;
    if (recordKey(item) === key) matches.push(index);
  }
  return matches.length === 1 ? matches[0] : -1;
}
'''
    core = replace_once(core, anchor, resolver, 'record resolver insertion')

# Import the resolver into App.jsx.
if '  findRecordIndex,\n' not in app:
    app = replace_once(
        app,
        '  createObjectPatch,\n',
        '  createObjectPatch,\n  findRecordIndex,\n',
        'findRecordIndex import',
    )

# Pass the actual selected record to deletion, not only an optional legacy id.
app = replace_once(
    app,
    '<button onClick={()=>onDelete(id)} style={{...s.btn("danger"),padding:"10px 14px"}}>Удалить</button>',
    '<button onClick={()=>onDelete(record)} style={{...s.btn("danger"),padding:"10px 14px"}}>Удалить</button>',
    'EditModal delete target',
)

edit_pattern = re.compile(
    r'''  // ── сохранение редактируемой записи ──\n'''
    r'''  // Поиск по ID записи \(не по индексу — индекс может измениться при синхронизации\)\n'''
    r'''  async function handleEditSave\(updated\)\{.*?\n'''
    r'''  \}\n\n'''
    r'''  async function handleEditDelete\(recId\)\{.*?\n'''
    r'''  \}\n\n'''
    r'''  // ── склад: перемещение ──''',
    re.S,
)

replacement = '''  // ── сохранение редактируемой записи ──
  // Современные записи ищем по постоянному id. Для старой записи без id
  // допускаем только однозначное совпадение; при дубле ничего не меняем.
  async function handleEditSave(updated){
    const targetRecord = editRec?.record || updated;
    const oldIdx = findRecordIndex(recordsRef.current, targetRecord);
    if (oldIdx === -1) {
      console.warn('[handleEditSave] запись не найдена или legacy-совпадение неоднозначно');
      alert('Не удалось однозначно найти запись. Обновите приложение и повторите действие.');
      setEditRec(null);
      return;
    }
    const old = recordsRef.current[oldIdx];
    const recId = old.id || updated.id || `rec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const nextRecord = { ...updated, id: recId, updatedAt: Date.now() };

    // 1) Возвращаем старое списание (через stockDelta)
    const oldDelta = stockDelta(old);
    if(oldDelta > 0){
      appendStockOp("delta", {
        location: `ws:${old.workshop}`,
        marker: old.marker,
        delta: oldDelta,
      });
    }
    // 2) Применяем новое списание (через stockDelta)
    const newDelta = stockDelta(nextRecord);
    if(newDelta > 0){
      appendStockOp("delta", {
        location: `ws:${nextRecord.workshop}`,
        marker: nextRecord.marker,
        delta: -newDelta,
      });
    }

    const next = recordsRef.current.map((record, index) => index === oldIdx ? nextRecord : record);
    recordsRef.current = next;
    saveAndSync("records", next, setRecords);
    setEditRec(null);
  }

  async function handleEditDelete(recordOrId){
    if(!confirm("Удалить эту запись?")) return;
    const targetRecord = typeof recordOrId === "string" ? { id: recordOrId } : recordOrId;
    const oldIdx = findRecordIndex(recordsRef.current, targetRecord);
    if (oldIdx === -1) {
      console.warn('[handleEditDelete] запись не найдена или legacy-совпадение неоднозначно');
      alert('Не удалось однозначно найти запись. Обновите приложение и повторите действие.');
      setEditRec(null);
      return;
    }
    const old = recordsRef.current[oldIdx];
    const recId = old.id || targetRecord?.id || `rec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // Возвращаем списание через stockDelta
    const oldDelta = stockDelta(old);
    if(oldDelta > 0){
      appendStockOp("delta", {
        location: `ws:${old.workshop}`,
        marker: old.marker,
        delta: oldDelta,
      });
    }
    const tombstone = { id: recId, deletedAt: Date.now(), client: clientIdRef.current };
    const nextDeletions = mergeById(recordDeletionsRef.current, [tombstone]);
    recordDeletionsRef.current = nextDeletions;
    setRecordDeletionIds(nextDeletions);
    commitImmediate("record-deletions", nextDeletions).catch(()=>{});

    // Удаляем именно найденный элемент по индексу. Это безопасно и для legacy
    // записи, которой id присваивается только в момент удаления.
    const next = recordsRef.current.filter((_, index) => index !== oldIdx);
    recordsRef.current = next;
    saveAndSync("records", next, setRecords);
    setEditRec(null);
  }

  // ── склад: перемещение ──'''

app, count = edit_pattern.subn(replacement, app, count=1)
if count != 1:
    raise SystemExit(f'edit/delete handler replacement: expected one match, found {count}')

# Add resolver to test imports.
if '  findRecordIndex,\n' not in tests:
    tests = replace_once(
        tests,
        '  createObjectPatch,\n',
        '  createObjectPatch,\n  findRecordIndex,\n',
        'test resolver import',
    )

if "findRecordIndex resolves a reordered modern record by id" not in tests:
    tests += '''

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
'''

app_path.write_text(app, encoding='utf-8')
core_path.write_text(core, encoding='utf-8')
test_path.write_text(tests, encoding='utf-8')
Path('.record-id-fix-trigger').unlink(missing_ok=True)
