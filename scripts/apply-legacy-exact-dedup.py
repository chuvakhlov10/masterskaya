from pathlib import Path

sync_path = Path('src/sync-core.js')
test_path = Path('tests/sync-core.test.mjs')

sync = sync_path.read_text(encoding='utf-8')

a = '''  for (const [key, item] of Object.entries(record)) {
    if (key === "id" || key === "legacyFingerprint") continue;
    value[key] = item;
  }
'''
b = '''  for (const [key, item] of Object.entries(record)) {
    // Sync metadata is not part of the original sale identity. Ignoring it lets
    // an old no-id snapshot match the same migrated record after metadata was added.
    if (key === "id" || key === "legacyFingerprint" || key === "revision" ||
        key === "updatedAt" || key === "lastMutationId") continue;
    value[key] = item;
  }
'''
if a not in sync:
    raise SystemExit('legacyRecordFingerprint block not found')
sync = sync.replace(a, b, 1)

old = '''  const claimedFingerprints = new Set();
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
'''
new = '''  const claimedFingerprints = new Set();
  const exactModernByFingerprint = new Map();
  for (const [key, record] of modern.entries()) {
    if (typeof record.legacyFingerprint === "string" && record.legacyFingerprint) {
      claimedFingerprints.add(record.legacyFingerprint);
    }

    // A migrated record may have lost legacyFingerprint in an old snapshot. Its
    // current canonical contents still claim an exactly matching no-id copy.
    const exactFingerprint = legacyRecordFingerprint(record);
    if (exactFingerprint) {
      claimedFingerprints.add(exactFingerprint);
      if (!exactModernByFingerprint.has(exactFingerprint)) exactModernByFingerprint.set(exactFingerprint, []);
      exactModernByFingerprint.get(exactFingerprint).push(key);
    }
  }

  const legacyMap = new Map();
  for (const record of legacy) {
    const fingerprint = legacyRecordFingerprint(record);
    if (fingerprint && claimedFingerprints.has(fingerprint)) {
      // Restore the durable original fingerprint when exactly one modern record
      // matches. Future edits can then reject this stale copy by the stored claim.
      const exactMatches = exactModernByFingerprint.get(fingerprint) || [];
      if (exactMatches.length === 1) {
        const key = exactMatches[0];
        const modernRecord = modern.get(key);
        if (modernRecord && !modernRecord.legacyFingerprint) {
          modern.set(key, { ...modernRecord, legacyFingerprint: fingerprint });
        }
      }
      continue;
    }
    const key = recordKey(record);
'''
if old not in sync:
    raise SystemExit('mergeRecords fingerprint block not found')
sync = sync.replace(old, new, 1)
sync_path.write_text(sync, encoding='utf-8')

tests = test_path.read_text(encoding='utf-8')
anchor = '''test('mergeRecords preserves an unmatched legitimate legacy record', () => {
'''
addition = '''test('mergeRecords drops an exact no-id copy even when legacyFingerprint was lost', () => {
  const legacy = {
    workshop: 'SMART', category: 'Домофонные', marker: 'Proxy', qty: 1,
    defect: 0, amount: 250, comment: '', recordType: 'sale', timestamp: 1782110055316,
  };
  const modern = {
    ...legacy, id: 'legacy-4e22f164920235cf8c00c334', revision: 1,
    updatedAt: 1782110055316, lastMutationId: '',
  };
  const merged = mergeRecords([modern], [legacy]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, modern.id);
  assert.equal(merged[0].legacyFingerprint, legacyRecordFingerprint(legacy));
});

test('restored fingerprint blocks the old copy after a later edit', () => {
  const legacy = {
    workshop: 'SMART', category: 'Домофонные', marker: 'Proxy', qty: 1,
    defect: 0, amount: 250, comment: '', recordType: 'sale', timestamp: 1782110055316,
  };
  const firstMerge = mergeRecords([{ ...legacy, id: 'legacy-record' }], [legacy]);
  const edited = {
    ...firstMerge[0], marker: 'Proxy edited', amount: 300,
    revision: 2, updatedAt: 1783000000000, lastMutationId: 'edit-2',
  };
  const secondMerge = mergeRecords([edited], [legacy]);
  assert.equal(secondMerge.length, 1);
  assert.equal(secondMerge[0].marker, 'Proxy edited');
  assert.equal(secondMerge[0].amount, 300);
});

'''
if anchor not in tests:
    raise SystemExit('test insertion anchor not found')
tests = tests.replace(anchor, addition + anchor, 1)
test_path.write_text(tests, encoding='utf-8')
