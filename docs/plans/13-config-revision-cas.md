# Plan 13 - Config Revision Counter and Three-Way Merge

**Inspiration:** Scion's refs, which move by compare-and-swap on a single
row (https://www.anthropic.com/engineering/redesigning-source-control).

**Status:** **Not started.** Tracking issue: #37.

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

## Design

### Data model

Config version 2 adds `rev: number`.

```json
{ "version": 2, "rev": 17, "stack": [], "assignments": {}, "hunkAssignments": {} }
```

`migrateConfig` maps version 1 to version 2 with `rev = 0`. A file with
a version above the supported one throws `ConfigError` and is left
untouched (it must never fall through to `emptyConfig()`).

### Write protocol

Inside the existing O_EXCL lock:

1. Async read of the file; missing means `rev = 0`.
2. `disk.rev === baseRev`: write `rev = baseRev + 1` via tmp and rename.
3. Otherwise run `mergeConfigs3(base, ours, theirs)` and write
   `rev = disk.rev + 1`.

`ConfigService` keeps `_baseRev` and `_baseSnapshot` (last read or
written document).

### Three-way merge

For each map entry, compare `ours` and `theirs` to `base`:

- one side changed: take it, including deletion;
- both changed identically: take it;
- both changed differently: ours wins and a conflict is recorded.

Stack entries merge by `name`; `order` is recomputed from base order
plus additions. Conflicts fire `onDidResolveConflict` and log to the
output channel; the UI shows a one-time notice.

### Watching

The file watcher compares `rev` so our own writes do not reload.

## Sequencing

1. Land `mergeConfigs3` and its tests (pure).
2. Add `rev` and migration, keep mtime as a secondary check.
3. Remove mtime detection and `statSync`.

Do after plan 14 only if the lock helper is shared; otherwise independent.

## Tests

- Pure table tests for `mergeConfigs3` (delete vs untouched, delete vs
  modify, add vs add, nested hunk maps, reorder on both sides).
- Two `ConfigService` instances, 200 random interleaved mutations each,
  final state equals a sequential replay.
- Stubbed second-resolution mtimes: no lost update.
- Newer-version file untouched and surfaces `ConfigError`.

## Open questions

- Apply the same idea to `VirtualBranchStore` compaction?
- Should conflicts be surfaced in the dashboard rather than a toast?
