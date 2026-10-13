# Plan 15 - Content-Addressed Hunk Cache

**Inspiration:** Scion's derived data (blame, path history) computed
lazily from content-addressed inputs
(https://www.anthropic.com/engineering/redesigning-source-control).

**Status:** **Not started.** Tracking issue: #39.

## Goal

Key `DiffEngine`'s hunk cache on the actual diff inputs (HEAD blob and
working blob) instead of file mtime.

## Rationale

`src/diffEngine.ts` validates cache entries by `mtimeMs` only:

- touches with identical content force a needless `git diff HEAD`;
- `HEAD` moving (commit, rebase, reset) with an unchanged file can serve
  stale hunks. Callers must remember `invalidateCache`; this plan's first
  task is to audit that every commit and rebase path does;
- the 32-entry cap thrashes on stacks with many assigned files.

## Design

```
key = `${wsRoot}::${path}::${headBlobOid}::${workingBlobOid}`
```

- `headBlobOid`: blob oid of the path at `HEAD`, `none` for new files.
  The `HEAD` commit oid per root is cached for a short TTL (about 250 ms)
  to coalesce bursts.
- `workingBlobOid`: `git hash-object -- <path>`. A per-path stamp of
  `(mtimeMs, size, blobOid)` is a fast path: same mtime and size reuses
  the oid. Apply git's "racy" rule: rehash when the mtime is within 2 s
  of now.

A hit requires both oids to match, so touches hit and `HEAD` movement
misses.

### Batching

`getHunksForFiles(wsRoot, paths[])` runs one `git diff HEAD -- p1 p2 ...`,
splits on `diff --git`, and primes the cache per file. Adopt in
`HunkCodeLensProvider` refreshes and optionally `absorb`.

### Limits

`HUNK_CACHE_MAX` rises from 32 to 256, configurable through
`gitbraid.diffCacheEntries` (32 to 2048), with a 16 MB total patch cap.
`invalidateCache` stays for explicit callers but is no longer needed for
correctness.

## Sequencing

1. Audit existing invalidation call sites; add a failing test for the
   HEAD-moves case if it reproduces.
2. Content key and stamps.
3. Batch API and adoption.

## Tests

- Touch without change: no second `git diff`.
- Size change with equal mtime invalidates; document the racy window.
- Commit via `tmpRepo` with unchanged file returns `[]`, not stale hunks.
- Batch equals N single calls.
- LRU respects count and byte caps.

## Open questions

- Measure CodeLens refresh latency on a repo with about 200 changed files
  before and after.
- Is the extra `rev-parse` per cold path acceptable on Windows?
