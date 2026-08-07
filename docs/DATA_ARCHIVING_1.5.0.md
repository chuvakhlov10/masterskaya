# Data archiving 1.5.0

## Scope

Version 1.5.0 introduces an archive-aware stock format without deleting history.
The recovery flow and the records format remain unchanged. Production data must
not be migrated until every active device runs the compatible client and its
outboxes are empty.

## Audit on 2026-08-05

- `data/stock-ops.json`: 3,791 operations, 609,755 compact JSON bytes.
- Operation range: 2026-06-24 through 2026-08-05.
- Types: 1,308 `init`, 2,263 `delta`, 70 `move`, 57 `set`, 15
  `rename`, and 78 `record-effect`.
- Every operation has `opId` and `ts`; there are no duplicate `opId` values and
  the server journal is ordered.
- `data/records.json`: 1,149 records, all from 2026. There is no closed record
  year to archive yet.
- The gateway accepts at most 2.9 million base64 characters in a GitHub write,
  or roughly 2.17 MB of raw JSON. At the observed growth rate the stock journal
  would approach that hard limit around the end of November 2026.
- Four non-revoked devices were registered and recently active.

The last displayed backup was valid schema 3, but it predated the successful
recovery-code rotation. A new backup that includes `auth/recovery.json` is a
hard prerequisite for the cutover.

## Target format

`data/stock-checkpoint.json` is an immutable checkpoint created only by the
atomic migration process. Connected browser clients may read it but cannot
write it through the gateway.

```json
{
  "schemaVersion": 4,
  "epoch": 1,
  "cutoffTs": 1785542400000,
  "createdAt": "2026-08-05T00:00:00.000Z",
  "stock": { "main": {}, "ws": { "SMART": {}, "Бегемот": {} } },
  "renameAliases": {},
  "recordEffectAnchors": [],
  "archive": {
    "opCount": 3510,
    "firstTs": 1782326917466,
    "lastTs": 1785541900000
  }
}
```

`data/stock-ops.json` becomes an epoch envelope containing the append-only `ops`
array committed after the checkpoint. The matching epoch prevents a browser from
combining an old full journal with a new checkpoint during cutover. Closed monthly files are stored as read-only
`archives/stock-ops/YYYY-MM.json` files. The checkpoint holds resolved balances,
permanent rename aliases, and record-effect anchors needed by future edits.

For the simulated 2026-08-01 cutoff:

- 3,510 operations (92.6%) move to June and July archives;
- 281 operations remain hot;
- the checkpoint is about 23.5 KB and contains 1,399 marker/location balances;
- all 1,399 balances produced by `checkpoint + hot` exactly match a full replay;
- there are no negative checkpoint balances;
- archived record-effect chains do not cross this cutoff in the current data.

The exact counts and hashes must be recalculated from a fresh server read during
the real cutover. The figures above are evidence for the design, not migration
inputs.

## Safety rules

1. Old clients must never be allowed to write after cutover. They still keep the
   full journal in local storage and could otherwise repopulate the hot file.
2. Archive-aware clients send `storageProtocolVersion: 4`. The Storage Gateway
   initially accepts older versions, then switches
   `MASTERSKAYA_MIN_STORAGE_PROTOCOL` to `4` and
   `MASTERSKAYA_STOCK_EPOCH` to `1` immediately before cutover. During this
   short lock, stock writes stay in the durable device outbox until the matching
   checkpoint and journal exist.
3. A local cache is never treated as an outbox once a checkpoint exists. Only
   the explicit durable stock outbox may be merged into the hot journal.
4. Late `delta` and `move` operations are additive and can be applied after a
   checkpoint using saved rename aliases. Every other late operation, including
   `set`, `init`, `rename`, and `record-effect`, is quarantined for review because
   replaying it after the checkpoint can change historical order. Record effects
   retain mutation-chain anchors in the checkpoint for normal post-cutoff edits.
5. Checkpoint and archive files are read-only through the normal device gateway.
6. A cutover is one Git commit that adds archives and the checkpoint and replaces
   the hot journal. If the data branch head or `stock-ops.json` blob changes
   during preparation, the commit is aborted and rebuilt from the new head.
7. History is never deleted from Git. Archives plus checkpoint plus hot journal
   must remain sufficient for audit and full reconstruction.

## Release and cutover order

1. Publish the compatible client and Storage Gateway with minimum protocol `1`.
2. Confirm all four active devices use the compatible client and report zero
   pending data and stock operations.
3. Produce a fresh valid backup that includes recovery state, checkpoint support,
   and future archive paths; test restoration in isolation.
4. Set Storage Gateway's minimum storage protocol to `4` and required stock
   epoch to `1`. Reads continue to work; old stock writers receive HTTP 426 and
   protocol-4 writes without the epoch envelope receive HTTP 428.
5. Re-read the current data branch, build monthly archives and checkpoint, and
   verify operation counts, unique IDs, hashes, and full-replay equality.
6. Apply the archive files, checkpoint, and hot journal in one compare-and-swap
   Git commit.
7. Reload each device and verify identical balances, `Saved · Live`, empty
   queues, protocol 4, and a valid post-cutover backup.
8. Only after a restore drill succeeds may the cutover be considered complete.

## Records policy

No records are moved in the first cutover because all 1,149 records belong to the
current year. After a year closes, records may move to
`archives/records/YYYY.json`; archive search must be an explicit action, and
archived records must be read-only or deliberately rehydrated before editing.
