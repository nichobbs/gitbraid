# Plan 14 - Shared JSONL Log Primitive

**Inspiration:** Scion's write-ahead changeset log with lazily derived
views (https://www.anthropic.com/engineering/redesigning-source-control).

**Status:** **Not started.** Tracking issue: #38.

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
  withLock<R>(fn: () => Promise<R>): Promise<R>
  stats(): { lines: number; bytes: number; skipped: number }
}
```

Rules:

- Append is a single `O_APPEND` write of one line; larger entries use
  `withLock`. If the file does not end in a newline, the next append
  first writes one (torn-write repair).
- `readAll` skips unparseable or rejected lines and counts them.
- Rewrite and compaction are tmp file, fsync, rename, under the lock.
- Compaction is scheduled on the in-process queue, never inline.

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
- Two child processes appending 500 lines each yield 1000 valid lines.
- Simulated crash between tmp write and rename leaves the original
  intact and cleans the stray tmp file.
- Undo log rewrite count over 1000 appends with `max = 100` is small.
- Existing undo and virtual-store tests pass unchanged.

## Open questions

- Is `fsync` acceptable on every platform CI runs on?
- Share the lockfile helper with `ConfigService`?
