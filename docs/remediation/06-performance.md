# Performance Remediation

After correctness, the biggest user-visible complaint in both reviews
is "feels slow on every save". Most of this is fixed by the file-change
bus (T10); the remaining items are targeted caches and debounces.

---

## T45. Debounce `HunkCodeLensProvider.provideCodeLenses`

**File:** `src/hunkCodeLensProvider.ts`
**Cross-ref:** `docs/reviews/07-performance.md` §2,
`docs/reviews/performance.md` P3.

### Fix

- 300 ms debounce keyed by `document.uri.fsPath`.
- Cache `{ versionAtDiff, lenses }`. Invalidate on
  `onDidChangeTextDocument` for the same URI.
- Cap the cache at 50 entries (LRU) to avoid unbounded growth.
- Cache the underlying `getHunksForFile` result keyed by
  `(wsRoot, relativePath, mtime)`.

### Effort

½ day.

---

## T46. Parallelise `initStack` worktree creation (bounded)

**File:** `src/branchStackService.ts:initStack`
**Cross-ref:** `docs/reviews/07-performance.md` §Startup.

### Fix

```ts
const CONCURRENCY = 3
await pLimit(CONCURRENCY, stack.map(e => () => this._ensureWorktree(e)))
```

(inline a tiny `pLimit` — no new dependency).

### Effort

¼ day.

---

## T47. Invalidate SCM status per branch on `onDidSyncFile(branch)`

**File:** `src/branchScmProvider.ts`
**Cross-ref:** `docs/reviews/07-performance.md` §6,
`docs/reviews/performance.md` P6.

### Fix

- Move from "refresh all on any event" to "refresh only the entry
  whose branch received the event".
- Cache the last `git status --porcelain=v1 -z` output per branch
  with a short TTL (e.g. 2 s) to coalesce rapid fires.
- Use content hash comparison to avoid re-emitting unchanged groups.

### Effort

1 day.

---

## T48. Config writes: async + debounced

**File:** `src/configService.ts:_writeToDisk`
**Cross-ref:** `docs/reviews/07-performance.md` §8,
`docs/reviews/architecture.md`.

### Fix

- Replace `fs.writeFileSync` / `renameSync` with their promise
  counterparts.
- Add 50 ms write coalescing: rapid `setAssignment` / `setHunkAssignment`
  calls share a single flush.
- Still use `tmp + rename` for crash-safety.

### Acceptance

- Microbench: 100 sequential `setAssignment` calls complete one
  flush, not 100.

### Effort

1 day.

---

## T49. Demote noisy `log.info` and tighten `getAllNodes`

**File:** `src/worktreeNodes.ts:28-45` and throughout
**Cross-ref:** `docs/reviews/07-performance.md` §3,
`docs/reviews/10-priorities.md` quick wins.

### Fix

- Replace the walk with a cached `Map<string, WorktreeNode>` updated
  on add/remove.
- Delete or demote the per-node `log.info` lines to `debug`/`trace`.
- Same sweep across `extension.ts:activate` — move verbose startup
  logs to `trace`, keep one headline info line.

### Effort

½ day.

---

## T50. Turn the 5-minute rebase poll into an event-driven check

**File:** `src/rebaseSuggestionService.ts`
**Cross-ref:** `docs/reviews/07-performance.md` §4,
`docs/reviews/performance.md` P5.

### Fix

- Default trigger set: `onDidChangeStack`, `onDidSyncFile`,
  `vscode.window.onDidChangeWindowState` (focus gained).
- Keep a configurable interval fallback (user setting from T39) but
  default to `0` (disabled).
- Wrap `_checkAll` in `try/catch` so interval errors don't become
  unhandled rejections (the named review also notes this
  — `bugs.md` B1 style).

### Effort

½ day.

---

## T51. Prune `WorkspaceSync._floatingDirty` on file delete

**File:** `src/workspaceSync.ts`
**Cross-ref:** `docs/reviews/07-performance.md` §Memory.

### Fix

Listen for the file-change bus's delete event; remove the entry.
Cap the set size at e.g. 10k entries with an LRU eviction when
hitting the cap.

### Effort

¼ day.

---

## T52. File-size guard on sync

**File:** `src/workspaceSync.ts:_syncFile`
**Cross-ref:** `docs/reviews/performance.md` P2.

### Fix

- Add setting `gitbraid.maxSyncFileSizeKb` (default 10_240 — 10 MB).
- Before `vscode.workspace.fs.readFile`, call `fs.promises.stat`; if
  above the threshold, skip and show a one-time notification per
  path with "Always sync / Skip / Configure".

### Effort

½ day.

---

## T53. Cache `getHunksForFile` diff output

**File:** `src/diffEngine.ts`
**Cross-ref:** `docs/reviews/performance.md` P3.

### Fix

LRU keyed by `(wsRoot, relativePath, mtime, HEAD-sha)`. Invalidate
on `onDidSavePrimary` for the same path and on
`onDidChangeStack` (HEAD may move).

### Effort

½ day.

---

## Performance exit criteria

- [ ] One `git status` per sync event per branch, not two.
- [ ] CodeLens does not spawn a `git diff` on every keystroke.
- [ ] Startup on a 5-branch stack takes < 1.5 s on a reference
      machine.
- [ ] Config writes do not block the event loop on batch mutations.
