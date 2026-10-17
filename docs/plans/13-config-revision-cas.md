# Plan 13 - Config Revision Counter and Three-Way Merge

**Inspiration:** Scion's refs, which move by compare-and-swap on a single
row (https://www.anthropic.com/engineering/redesigning-source-control).

**Status:** **Implemented.** `src/configMerge.ts`, `src/configService.ts`. Tracking issue: #37.

## Goal

Replace mtime-based conflict detection in `ConfigService` with an
explicit revision counter, and replace the key-union merge with a
three-way merge so deletions are not resurrected.

## Rationale

`src/configService.ts` currently:

- detects conflicts with `stat.mtimeMs > lastSeen + 1`, which is a
  heuristic on coarse-resolution filesystems and forces needless merges
  on touches;
- calls `fs.statSync` inside an async write path;
- merges with `mergeConfigs`, a key union, so an unassign in one window
  is undone by another window's older copy;
- relies on a time-based stale-lock check.

## Design (as built)

### What differed from the original draft

- The schema was already **version 2** (hunk anchors), so `rev` makes it
  **version 3**, not 1 to 2.
- The old `mergeConfigs` also **dropped `hunkAnchors`** on every conflict merge.
  The new merge handles them.
- A conflict is detected by **revision or content**, not revision alone: if the
  file's `rev` equals what we last saw but its content differs (a hand edit, or
  an older GitBraid that does not bump `rev`), it is still merged.
- `migrateConfig` stamps the current version unconditionally, which would have
  silently downgraded a newer file. The version check now happens before it.

### Data model

`BranchConfig.rev?: number`, `CONFIG_SCHEMA_VERSION = 3`. Files without `rev`
read as 0. `ConfigService` remembers `_baseRev` and `_baseSnapshot`, the
revision and content it last read or wrote. No file modification times and no
synchronous filesystem calls remain in the write path.

### Write protocol

Inside the existing O_EXCL lock:

1. Read the file asynchronously.
2. **Newer schema:** refuse (see below).
3. **File equals our base** (same `rev`, same canonical content): write ours.
4. **File differs:** `mergeConfigs3(base, ours, theirs)`, adopt the result,
   fire `onDidResolveConflict` if anything conflicted, then write.
5. **File missing or unreadable:** write ours as is (this matches the old
   behaviour, and means deleting the file by hand cannot erase a live window's
   state).

The written revision is `max(disk rev, base rev) + 1`.

### Three-way merge (`src/configMerge.ts`, pure)

Per key of `assignments`, `hunkAssignments` and `hunkAnchors` (nested maps are
flattened so one routine covers them): a side that did not change defers to the
side that did, **including when the change is a deletion**. When both changed
differently, ours wins, except that a deletion never beats a modification, so
nothing the other window wrote is discarded.

Stack entries are merged by `name`, and when both sides modified the same
branch, **field by field**, so a colour change in one window and a cached PR
number in another both survive. Afterwards `order` is renumbered 1..n, which is
a no-op when it already was contiguous.

### Newer schema

A file whose `version` is greater than ours loads as an empty, **read-only**
config (`isReadOnly`), is never overwritten, and every mutation throws a
`ConfigError` saying so. Detected again at write time in case the file was
upgraded while we were running.

### Watching

`reload()` ignores the watcher event for our own write: if the file has our
base revision and content, nothing is applied and no events fire.

### User notice

`FolderContext` shows one warning (throttled to once per 10 s) when
`onDidResolveConflict` fires. Details go to the output channel.

### Known gaps

- A **malformed** file is still replaced by an empty config and overwritten on
  the next write (existing behaviour, not changed here).
- Conflict resolution is last-writer-wins on the same key; there is no
  interactive resolution.
- `ConfigService` keeps its own lock loop; moving it onto `withFileLock`
  (plan 14) is a separate small change.
- The notice in `FolderContext` is not unit tested.

## Sequencing

Landed as one change: the pure merge first (with its tests), then `rev` and the
write protocol, then removal of the mtime check and `statSync`. It is stacked on
the `reload()` race fix, since both rewrite the same part of `ConfigService`.
It does not depend on plan 14.

## Tests

- `test/configMerge.test.ts` (27): pure merge cases (delete vs untouched,
  delete vs modify, add vs add, nested hunk maps and anchors, field-level stack
  merge, reorder plus add) and a 200-seed property test that disjoint edits
  always combine to "apply both" with no conflicts. Mutation-checked: degrading
  the merge to the old union fails 9 of them.
- `test/configService.test.ts`: `rev` increments; a v2 file upgrades; a newer
  file is untouched and writes are refused; a deletion survives a stale window;
  a write is merged even when the mtime is unchanged; a hand edit without a
  `rev` bump is merged; conflicts are reported; our own write's watcher echo is
  ignored; and a two-window concurrent stress run converges. Mutation-checked:
  disabling the merge step fails five of them.

## Open questions

- Apply the same idea to `VirtualBranchStore` compaction? (Not needed once it
  is on `JsonlLog`, which locks every write.)
- Should conflicts be surfaced in the dashboard rather than a toast?
