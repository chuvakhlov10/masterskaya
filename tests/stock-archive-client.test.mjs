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
