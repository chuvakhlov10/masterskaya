# Stock rollover dry run — 2026-09-08

Offline planning is complete. Production data and Gateway settings were not changed.
This report describes one pinned snapshot; it is not authorization to apply an old
candidate after the production branch has advanced.

- Application source base: `55742d00cc5715037ea68d17d62523182b69a9fa`.
- Data repository: `chuvakhlov10/masterskaya-data`.
- Pinned data head: `a2ba111bf1acda2174039c3a692947be870bc0ae`.
- Prepared: `2026-09-08T06:34:00.051Z`.
- UTC cutoff: `2026-09-01T00:00:00Z`.
- Epoch: **1 → 2**.
- All operations: **7,959 → 7,959**, identical IDs and payloads.
- Archived operations: **3,510 → 7,446**.
- Newly archived August operations: **3,936**.
- Hot operations: **4,449 → 513**.
- Hot journal bytes: **1,224,682 → 270,409** (77.92% reduction).
- Checkpoint bytes: **41,494 → 742,201**; **1,109** terminal sale anchors.
- Combined checkpoint + hot JSON: **1,266,176 → 1,012,610** bytes (20.03% reduction).
- June and July archive bytes remain unchanged.

## Candidate diff (data repository, not part of this application PR)

| Path | Action | Bytes | Git blob SHA |
|---|---|---:|---|
| `archives/stock-ops/2026-08.json` | add | 1,311,016 | `68f66c46102b9c49e080a28f4ccc09e3e28f732b` |
| `data/stock-checkpoint.json` | update | 742,201 | `cf5aeb29eb68022cda286e4252a394e41ef099ca` |
| `data/stock-ops.json` | update | 270,409 | `48de485136bdb52a59d79692468a80f4fe1e0d67` |

Full-stock SHA-256 before and after:
`9ffc22fcde9fb3505b1202b05012aae90772172c435e70536a5456fdd702edc8`.

Full operation-set SHA-256 (canonical JSON, sorted by opId):
`f47e80b4d240ca17580d79e0155d779b60d02b8a65d02dd54e1a3378fe1b32ec`.

## Verification

- 209/209 Node tests pass, including 26 new rollover tests.
- Production Vite build passes; existing CJS and bundle-size warnings remain.
- Both Yandex Function bundles build and their handlers/metadata validate.
- Each downloaded input matches its GitHub tree blob SHA and byte count.
- The data repository backup validator at blob
  `b6280865b0a983c4256989f4d184d278a8f1d510` independently validates the source
  and an isolated overlay of the proposed files: checkpoint balances, aliases,
  mutation anchors, monthly archive inventory and complete stock replay pass.
- Restored operation payloads are identical, not just their counts.
- Tests cover another rollover to epoch 3, later edits/deletions, immutable
  archives, stale-epoch rejection, outbox reconciliation and fail-closed input
  corruption. A changed mutation branch is rejected even with equal balances.

The growing anchor checkpoint is the next scaling concern: this change mainly
reduces write payloads. It does not promise constant-size reads or permanent
elimination of storage limits.

## Next step

Review the offline planner, then follow [the cutover procedure](RECURRING_STOCK_ARCHIVE.md).
Before production mutation: confirm active devices, fresh backup/restore, a short
write pause, Gateway epoch gate, and a newly pinned/revalidated candidate. Apply
only one non-forced Git commit on its exact expected parent. A fresh post-cutover
backup and isolated restore are required to close the operation.
