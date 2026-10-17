# Plan 15 - Content-Addressed Hunk Cache

**Inspiration:** Scion's derived data (blame, path history) computed
lazily from content-addressed inputs
(https://www.anthropic.com/engineering/redesigning-source-control).

**Status:** **Implemented.** `src/diffEngine.ts`; `absorb` uses the batch API. Tracking issue: #39.

## Goal

Key `DiffEngine`'s hunk cache on the actual diff inputs (the `HEAD` commit and
the file's content) instead of file mtime.

## Rationale

`src/diffEngine.ts` validates cache entries by `mtimeMs` only:

- touches with identical content force a needless `git diff HEAD`;
- `HEAD` moving (commit, rebase, reset) with an unchanged file can serve
  stale hunks. Callers must remember `invalidateCache`; the audit found none
  does;
- the 32-entry cap thrashes on stacks with many assigned files.

## Design (as built)

### What the audit found

- `invalidateCache` had **no callers** outside `diffEngine.ts`, so the cache was
  validated by mtime alone. Reproduced with real git, before any change:
  - a commit that moves `HEAD` with the file untouched served the old hunks;
  - rewriting identical content (new mtime) re-ran `git diff`;
  - **new finding:** different content with the same size and the same mtime was
    served stale.
- The cache held 32 files, so sweeping 200 changed files (absorb, a large
  change set) thrashed it: a second pass was as slow as the first.

### Cache identity

Each entry stores the `HEAD` commit and a SHA-1 of the file's bytes it was
computed from, and is used only if both still match. It is correct without
anyone invalidating it.

- **HEAD** is the commit id, not the blob id at `HEAD:path` the first draft
  proposed. One value serves every file in a root, and any commit simply makes
  entries re-diff lazily.
- **No time-based reuse of the HEAD id.** The draft suggested a 250 ms
  per-root cache; that would reintroduce a window where a commit is not seen.
  Instead `HEAD` is resolved by reading `.git/HEAD` and the ref it names
  (loose ref, then `packed-refs`; linked worktrees via `commondir`), a few small
  file reads. Anything it does not fully understand (unborn branch, reftable,
  `.git` not at the root) falls back to `git rev-parse HEAD`, shared between
  lookups already in flight. A differential test checks it against
  `git rev-parse HEAD` through commits, branch switches, detached HEAD,
  `pack-refs`, `reset --hard` and a linked worktree.
- **Content hash** is computed in Node, with no git process. Files up to 1 MiB
  are hashed on every lookup, so a hit never depends on mtime. Larger files
  reuse a hash while mtime and size are unchanged and the mtime is more than 2 s
  old (git's "racy" rule), so for those a same-size, same-mtime swap more than
  2 s old is the one case that can be missed.
- A result is not cached if the file's hash changed while git was reading it,
  since it could then reflect newer content than the hash it would be filed
  under.

### Batch API

`getHunksForFiles(root, paths)` serves cached files from the cache and diffs the
rest in one `git diff HEAD --no-renames -- <paths>`, splitting the output on
`diff --git a/<p> b/<p>` headers. If git fails, or prints a header it cannot match
to a requested path (for example a quoted non-ASCII name), it falls back to one
`git diff` per file, so the result is always the same as asking one at a time.
`absorb` now uses it.

### Limits

Default 256 files and 16 MB of patch text, both configurable through the
constructor; `gitbraid.diffCacheEntries` (32 to 2048, read when the window loads)
sets the count. A result larger than the byte cap is returned but not cached.

### Measured (Linux, 200 changed files of 80 lines)

| | before | after |
|---|---|---|
| cold, one file at a time | 1413 ms | 1746 ms |
| second pass, one at a time | 1380 ms (cache thrashed) | 150 ms |
| one file, 50 repeat lookups | 12 ms | 52 ms |
| all 200 in one batch, cold | n/a | 114 ms |

A single repeat lookup costs about 1 ms instead of 0.24 ms because it reads and
hashes the file instead of calling `stat`; that is the price of not trusting
mtime. Windows numbers were not measured.

### Known gaps

- Anything outside the file and `HEAD` that changes a diff (`.gitattributes`,
  `core.autocrlf`, diff algorithm settings) does not invalidate entries. The
  mtime scheme had the same gap.
- A change to the index alone (staging) does not affect `git diff HEAD`, so it
  is correctly ignored.

## Sequencing

Landed as one change, with the reproduction tests written first and shown
failing on the old code (three of them).

## Tests

- `test/diffEngine.cache.test.ts` (real git): the three reproduced bugs, cache
  hits, per-root isolation, deleted files, the file-changes-mid-diff race,
  large files (old mtime reuses the hash, recent mtime re-hashes), LRU by count
  and by bytes, an oversized result, unborn `HEAD`, shared concurrent
  `rev-parse`, the `HEAD` differential test, and the batch API (equals one at a
  time, one process, populates the cache, skips cached files, duplicates, quoted
  names, path escape).
- Mutation-checked: ignoring `HEAD` in the key, skipping the mid-diff re-hash,
  and ignoring `packed-refs` each fail the matching tests.
- `test/diffEngine.test.ts` now counts `git diff` calls specifically (the engine
  may also ask for `HEAD`); `test/absorb.test.ts` asserts one batched call.

## Open questions

- Windows timings for the single-file path were not measured.
- `HunkCodeLensProvider` could prefetch the whole change set with the batch API;
  it only ever needs the active file today, so it was left alone.
