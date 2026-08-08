import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const appSource = fs.readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
const gatewaySource = fs.readFileSync(new URL('../src/storage-gateway.js', import.meta.url), 'utf8');

test('client loads checkpoint beside the hot stock journal and replays both', () => {
  assert.match(appSource, /sGet\("stock-checkpoint"/);
  assert.match(appSource, /applyStockCheckpoint\(stockCheckpointRef\.current, ops\)/);
  assert.match(appSource, /readConsistentStockPair\(\{allowCache:false\}\)/);
  assert.match(appSource, /applyServerStockOps\(stockPair\.rawJournal, stockPair\.checkpoint\)/);
});

test('archived stock cache keeps its epoch envelope for offline startup', () => {
  assert.match(
    appSource,
    /localStorage\.setItem\("stock_ops_local", JSON\.stringify\(encodeStockJournal\(ops\)\)\)/,
  );
  assert.match(appSource, /STOCK_ARCHIVE_EPOCH_MISMATCH/);
});

test('checkpoint disables the one-time legacy cache promotion', () => {
  assert.match(
    appSource,
    /!stockCheckpointRef\.current && localStorage\.getItem\(STOCK_OUTBOX_MIGRATED_KEY\) !== "1"/,
  );
});

test('every storage request advertises archive-aware protocol 4', () => {
  assert.match(gatewaySource, /storageProtocolVersion: 4/);
});

test('client repairs a missing create effect after startup, remote merge and record commit', () => {
  assert.match(appSource, /findRecordsMissingCreateEffect\(candidateRecords, knownOps, checkpointAnchors\)/);
  assert.match(appSource, /repairMissingCreateRecordEffects\(recordsRef\.current, "startup"\)/);
  assert.match(appSource, /repairMissingCreateRecordEffects\(merged, "remote-records"\)/);
  assert.match(appSource, /repairMissingCreateRecordEffects\(\[committed\], "record-commit"\)/);
});

test('client reconciles the durable stock outbox against every archive before sending', () => {
  assert.match(appSource, /normalized\.archive\?\.files/);
  assert.match(appSource, /await stockArchiveGet\(month\)/);
  assert.match(appSource, /reconcileStockOutboxAgainstHistory\(serverStockOps, stockPair\.checkpoint\)/);
  assert.match(appSource, /await reconcileStockOutboxAgainstHistory\(stockPair\.journal\.ops, stockPair\.checkpoint\)/);
  assert.match(appSource, /const opsToSave = mergeStockOps\(remote, outbox\)/);
});

test('unknown pre-checkpoint outbox operations are persisted to quarantine before removal', () => {
  assert.match(appSource, /stockOutboxHistoryEpochRef\.current !== checkpoint\.epoch\) return \[\]/);
  assert.match(appSource, /reconcileStockOutboxWithHistory\(outbox, \[\], checkpoint\)\.sendable/);
  assert.match(appSource, /appendStockOutboxQuarantine\(\{/);
  assert.match(appSource, /remaining = removeStockOutboxIds\(blockedIds\)/);
  assert.match(appSource, /Never remove an operation unless the quarantine was persisted/);
  assert.match(appSource, /STOCK_ARCHIVE_OUTBOX_REVIEW_REQUIRED/);
  assert.match(appSource, /автоматическая отправка заблокирована до проверки/);
});
