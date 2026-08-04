from pathlib import Path

sync_path = Path('src/sync-core.js')
test_path = Path('tests/sync-core.test.mjs')

sync = sync_path.read_text(encoding='utf-8')
if 'LEGACY_RECORD_DEDUP_V1' not in sync:
    anchor = '''function canonicalJson(value) {
  try { return JSON.stringify(canonicalize(value)); }
  catch { return String(value); }
}

'''
    addition = '''// LEGACY_RECORD_DEDUP_V1
function fnv1a64(text) {
  const bytes = new TextEncoder().encode(String(text));
  let hash = 0xcbf29ce484222325n;
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, "0");
}

export function legacyRecordFingerprint(record) {
  if (!record || typeof record !== "object") return null;
  const value = {};
  for (const [key, item] of Object.entries(record)) {
    if (key === "id" || key === "legacyFingerprint") continue;
    value[key] = item;
  }
  return fnv1a64(canonicalJson(value));
}

'''
    if anchor not in sync:
        raise SystemExit('canonicalJson anchor not found')
    sync = sync.replace(anchor, anchor + addition, 1)

    old_merge = '''export function mergeRecords(remote, local, deletedIds = new Set()) {
  const remoteItems = Array.isArray(remote) ? remote : [];
  const localItems = Array.isArray(local) ? local : [];
  const deleted = deletedIds instanceof Set ? deletedIds : new Set(deletedIds || []);
  const map = new Map();

  for (const record of [...remoteItems, ...localItems]) {
    const key = recordKey(record);
    if (!key) continue;
    if (record.id && deleted.has(record.id)) continue;
    const previous = map.get(key);
    if (!previous || compareRecordState(record, previous) >= 0) map.set(key, record);
  }

  return [...map.values()].sort((a, b) => {
    const ts = Number(a?.timestamp || 0) - Number(b?.timestamp || 0);
    return ts || String(recordKey(a)).localeCompare(String(recordKey(b)));
  });
}
'''
    new_merge = '''export function mergeRecords(remote, local, deletedIds = new Set()) {
  const remoteItems = Array.isArray(remote) ? remote : [];
  const localItems = Array.isArray(local) ? local : [];
  const deleted = deletedIds instanceof Set ? deletedIds : new Set(deletedIds || []);
  const modern = new Map();
  const legacy = [];

  for (const record of [...remoteItems, ...localItems]) {
    if (!record || typeof record !== "object") continue;
    if (!record.id) {
      legacy.push(record);
      continue;
    }
    if (deleted.has(record.id)) continue;
    const key = `id:${record.id}`;
    const previous = modern.get(key);
    if (!previous || compareRecordState(record, previous) >= 0) modern.set(key, record);
  }

  const claimedFingerprints = new Set();
  for (const record of modern.values()) {
    if (typeof record.legacyFingerprint === "string" && record.legacyFingerprint) {
      claimedFingerprints.add(record.legacyFingerprint);
    }
  }

  const legacyMap = new Map();
  for (const record of legacy) {
    const fingerprint = legacyRecordFingerprint(record);
    if (fingerprint && claimedFingerprints.has(fingerprint)) continue;
    const key = recordKey(record);
    if (!key) continue;
    const previous = legacyMap.get(key);
    if (!previous || compareRecordState(record, previous) >= 0) legacyMap.set(key, record);
  }

  return [...modern.values(), ...legacyMap.values()].sort((a, b) => {
    const ts = Number(a?.timestamp || 0) - Number(b?.timestamp || 0);
    return ts || String(recordKey(a)).localeCompare(String(recordKey(b)));
  });
}
'''
    if old_merge not in sync:
        raise SystemExit('mergeRecords block not found')
    sync = sync.replace(old_merge, new_merge, 1)
    sync_path.write_text(sync, encoding='utf-8')

tests = test_path.read_text(encoding='utf-8')
if 'legacyRecordFingerprint,' not in tests:
    tests = tests.replace('  findRecordIndex,\n', '  findRecordIndex,\n  legacyRecordFingerprint,\n', 1)

marker = "test('legacy fingerprint matches migrated source record'"
if marker not in tests:
    tests += '''\n\ntest('legacy fingerprint matches migrated source record', () => {
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
'''
    test_path.write_text(tests, encoding='utf-8')

print('Applied legacy record deduplication hotfix')
