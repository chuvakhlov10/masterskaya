# Recurring stock archive planning

`npm run plan:stock-rollover` prepares the second and subsequent monthly stock
cutovers from an existing protocol-4 checkpoint. It is an **offline planner**:
it never writes to GitHub, changes Gateway settings, or sends client operations.
The original `plan:stock-archive` command remains available for legacy arrays.
No client or Gateway version change is required to run this tool.

## Snapshot input

Read a single `masterskaya-data` branch head, then read its Git tree and blobs
at that exact commit. Do not assemble files from successive reads of `main`.
Use Git blobs for large files, retaining the exact UTF-8 bytes, whitespace and
final-newline presence. Export only:

- `data/stock-checkpoint.json`;
- `data/stock-ops.json`;
- `data/records.json` (to check create-effect repair coverage);
- every `archives/stock-ops/YYYY-MM.json` declared by the checkpoint.

Place them at the same relative paths below a snapshot directory, together with
`source-metadata.json`:

```json
{
  "repository": "owner/data-repository",
  "head": "40-character commit SHA obtained from GitHub",
  "files": [
    {
      "path": "data/stock-checkpoint.json",
      "gitBlobSha": "40-character blob SHA from that commit's tree",
      "bytes": 41494
    }
  ]
}
```

The example file list is abbreviated: include all exported files. This metadata
is trusted provenance from the snapshot exporter, not proof of GitHub branch
state. The planner verifies every input's actual Git blob SHA and byte length
against it. A production executor must separately recheck the branch head.
Keep business data and generated candidates outside the application repository.

```sh
npm run plan:stock-rollover -- \
  --source /path/to/pinned-snapshot \
  --output /path/to/new-candidate-directory \
  --expected-head ACTUAL_COMMIT_SHA \
  --cutoff 2026-09-01T00:00:00Z \
  --created-at 2026-09-08T09:00:00Z
```

The cutoff must advance to the first instant of a closed **UTC** month. The
creation time is explicit for reproducible output; use the actual preparation
time. The epoch always advances by exactly one. The output directory must not
exist and must be outside the input snapshot. Failed semantic validation creates
no output; successful files are staged together before publishing the directory.

## Checks and output

The planner validates the archive inventory, month boundaries, counts, global
operation IDs, operation shapes, timestamps and source epoch. Replaying old
archives must reproduce the source checkpoint balances, aliases and terminal
record-effect anchors exactly. Both old and proposed checkpoint-plus-hot replays
must match the full history, including final rename aliases and the selected
record-effect branch IDs. Equal balances alone do not pass a changed effect chain.
Missing create effects and negative new checkpoint balances block the plan.

The emitted diff contains new monthly archive files and replacements for the
checkpoint and hot journal. Existing archives are retained by their exact bytes;
they are listed as preserved, never emitted for rewriting. Each archive descriptor
gets its byte size, SHA-256 and Git blob SHA. The new `checkpointFingerprint`
describes the prefix stock. The legacy `stockFingerprint` continues to describe
the full live stock at planning time and is not compared with later live balances.

`archive-manifest.json` contains the pinned source head, input hashes, output
hashes, expected old blob SHA for each replacement, operation counts and replay
fingerprints. It is evidence and input for a separately reviewed executor,
**not a production commit or a backup status**. Keep it outside `data/`.

Late hot operations before the old cutoff stop planning even if previously
stamped as additive. They may target an immutable archived month and need a
separate supplement protocol or case review. Divergent record-effect branches
that cannot be represented by terminal checkpoint anchors also stop planning.
Do not override these checks or rewrite history to make a plan pass.

## Production cutover procedure (separate operation)

1. Confirm compatible active clients and their current durable outboxes and
   quarantine counts. Do not infer that a stale device's old zero count is current.
   Agree on a short pause in sales, edits and stock changes on active devices.
2. Require a fresh valid backup and a successful isolated restore. Validate the
   full candidate layout using the data repository's current backup validator:
   overlay only manifest changes on a copy of the pinned source, keeping all
   existing archives. Compare both replay fingerprints and all operation IDs.
3. Keep minimum storage protocol 4; set Gateway's required stock epoch to the
   planned new epoch **before** committing the new data pair. Verify health and
   the epoch gate. During this short lock old-epoch stock writes must be rejected;
   explicit device outboxes retain pending changes. Do not clear local storage.
4. Read the data head again after the gate is active. If it differs from the
   manifest source head, export a new pinned snapshot and rebuild/revalidate the
   plan. Even a different-file commit makes the previous head precondition stale.
5. Build one Git tree on the exact source tree: add only new archive files and
   replace only checkpoint and hot journal with the verified output blobs. Retain
   all other paths and modes. Create one commit whose parent is the expected head,
   then advance `main` without force. A non-fast-forward or changed precondition
   means abort and rebuild; never retry by overwriting a newer data head.
6. Reload active devices; verify epoch agreement, identical balances, normal
   sync, zero queues and quarantine. Run a new backup and isolated restore before
   considering the cutover complete. Record final hashes and counts.

If the data commit has **not** happened and preparation is abandoned, restore
the previous Gateway epoch gate to resume writes. After a successful cutover,
do not simply lower the gate or restore the old hot file: newer operations may
already exist. Recovery then needs another verified snapshot and data-preserving
plan. This planner does not automate that production procedure.

## Size tradeoff

The hot file becomes much smaller, reducing every append-only write and conflict
retry. The checkpoint grows with terminal sale anchors needed for future edits
and startup repair. It is therefore not a constant-size summary, and archive
rollover alone does not solve long-term read volume. Monitor checkpoint and
records sizes separately; changing anchor storage is a future client/protocol
design, not part of this tool.
