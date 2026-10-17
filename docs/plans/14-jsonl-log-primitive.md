# Plan 14 - Shared JSONL Log Primitive

**Inspiration:** Scion's write-ahead changeset log with lazily derived
views (https://www.anthropic.com/engineering/redesigning-source-control).

**Status:** **Implemented.** `src/jsonlLog.ts`, `src/fileLock.ts`; `PersistentUndoLog` and `VirtualBranchStore` use it. Tracking issue: #38.

## Goal

One tested `JsonlLog<T>` used by `VirtualBranchStore` and
`PersistentUndoLog`, so crash safety, corrupt-line tolerance, locking and
compaction are implemented once.

## Rationale

Both stores are JSONL logs written independently.
`PersistentUndoLog` is weaker: it rewrites the whole file on truncation
and on `popLast`, non-atomically and without a lock, and once at capacity
it does that rewrite on every append.

## Design

New `src/jsonlLog.ts`:

```ts
interface JsonlLogOptions<T> {
  path: string
  parse: (raw: unknown) => T | undefined
  compact?: (entries: T[]) => T[]
  compactEvery?: number
  maxBytes?: number
}

class JsonlLog<T> {
  append(entry: T): Promise<void>
  readAll(): Promise<T[]>
  rewrite(entries: T[]): Promise<void>
  withLock<R>(fn: (locked: LockedJsonlLog<T>) => Promise<R>): Promise<R>
  stats(): { lines: number; bytes: number; skipped: number }
}
```

Rules (as built):

- **Every append takes the cross-process file lock**, however short the line.
  The first design let short lines skip the lock and rely on `O_APPEND`; a
  test showed that an unlocked append racing a locked read-modify-write
  (`popLast`, compaction) can land between the read and the rename and be
  silently overwritten. Cost is about 0.8 ms per append on Linux (0.3 ms
  without the lock), which is irrelevant at save/undo rates.
- If the file does not end in a newline, the first append from an instance
  writes one first (torn-write repair), so the new entry is not glued to a
  crash fragment.
- `readAll` skips unparseable or rejected lines and counts them. A final line
  without a newline is used if it is complete JSON.
- Rewrite and compaction are tmp file, `fsync`, rename, under the lock. A
  crash before the rename leaves the original untouched; the stray tmp file is
  overwritten by the next rewrite.
- Compaction runs inside the append that reaches `compactEvery`, only if
  `compact()` returns fewer entries, so it is amortised, not per-append.
- `withLock(fn)` gives `fn` a handle (`readAll`, `append`, `rewrite`) that
  bypasses the instance queue, because calling the instance's own methods from
  inside would wait on the queue `fn` already occupies.
- Lock staleness defaults to 30 s (a crashed holder), so a long rewrite is not
  mistaken for a dead one.

### Adapters

- `PersistentUndoLog`: truncation becomes `compact` with
  `compactEvery = max / 2`; `popLast` runs under the lock. Public API
  unchanged.
- `VirtualBranchStore`: keep its record schema and live-set compaction;
  move IO onto `JsonlLog`. `withBranchLock` must keep its atomicity
  guarantee with `WorkspaceSync` saves (see
  `BranchStackService.materialiseBranch`).

## Sequencing

Do first: pure refactor with parity tests, and later logs (for example
an agent audit log from plan 12) become cheap.

## Tests

- Torn final line ignored; next append starts on a fresh line.
- Corrupt middle line skipped and counted.
- Two instances appending 150 lines each concurrently (some 6 KB) yield 300 intact lines.
- An append racing a locked read-modify-write is never lost (mutation-checked).
- Simulated crash between tmp write and rename leaves the original
  intact and cleans the stray tmp file.
- Undo log rewrite count over 1000 appends with `max = 100` is small.
- Existing undo and virtual-store tests pass unchanged.

## Open questions

- `fsync` on rewrite is exercised by CI on all three platforms.
- `ConfigService` still has its own copy of the lock loop. Plan 13 rewrites its
  write path; switching it to `withFileLock` belongs there.
- The concurrency tests use separate `JsonlLog` instances in one process, not
  separate OS processes, so they cover the file lock and `O_APPEND` but not
  every cross-process filesystem behaviour.
