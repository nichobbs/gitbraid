# Performance Review

## Current Characteristics

GitBraid's performance profile is good for the common case (small-to-medium repos, 2–4
branches, files under a few MB). The debounced file sync (200 ms) and event-driven
updates prevent most gratuitous work. The following areas merit attention as usage
scales.

---

## P1 — Sequential Hunk Routing Across Branches

**File:** `src/hunkRouter.ts`, `routeFile()`

For each branch in `byBranch`, `_applyPatch` is awaited before the next branch starts:

```typescript
for (const [branchName, branchHunks] of byBranch) {
    ...
    const success = await this._applyPatch(patch, worktreeDir)
    ...
}
```

With N branches, routing is O(N) sequential `git apply` subprocesses. For 2–3 branches
this is imperceptible. For 8+ branches it adds latency proportional to N × (git startup
time ≈ 50–150 ms per call).

**Recommendation:** Run patch applications in parallel when there are no overlaps:

```typescript
const results = await Promise.all(
    [...byBranch.entries()].map(([branch, hunks]) =>
        this._applyPatch(this._buildPatch(hunks), worktreeDirs.get(branch)!)
    )
)
```

This is safe because each branch writes to a separate worktree directory; there is no
shared mutable state between the concurrent `git apply` calls.

---

## P2 — Entire File Read into Memory for Every Save

**File:** `src/workspaceSync.ts`, `_syncFile()`

```typescript
content = await vscode.workspace.fs.readFile(uri)
```

The entire file is read into a `Uint8Array` buffer before being written to the
worktree. For large generated files (minified JS, SQLite databases accidentally in the
workspace, video assets) this buffers the full content. The VS Code filesystem API does
not currently expose a streaming interface, so this cannot be eliminated entirely, but:

**Recommendation:**
- Add a configurable `gitbraid.maxSyncFileSizeKb` setting (default 10 MB). If the file
  exceeds this threshold, skip sync and show a one-time warning.
- Log file size at `debug` level so users can diagnose slow syncs.

---

## P3 — `getHunksForFile` Runs `git diff` on Every Hunk Routing Call

**File:** `src/diffEngine.ts`, `getHunksForFile()`

```typescript
const { stdout } = await exec(`git diff HEAD -- "${sanitised}"`, { cwd: wsRoot })
```

`HunkRouter.routeFile()` calls `getHunksForFile` once per routing operation. When the
user triggers routing for the same file repeatedly (e.g., during rapid iteration), this
spawns a new `git diff` subprocess each time with no caching.

**Recommendation:** Cache the diff output keyed by `(wsRoot, relativePath, mtime)`.
Invalidate on file change. Given the debounce in `WorkspaceSync`, the cache would
typically be warm for the duration of a single edit session.

---

## P4 — Config File Grows Unboundedly

**File:** `src/configService.ts`

`local-config.json` stores every file assignment and hunk assignment ever made. There
is no pruning when branches are removed. After months of use on an active codebase,
the file could contain thousands of stale assignment entries for deleted files.

**Recommendation:**
- When `removeBranch()` is called, remove all assignment entries pointing to that branch.
- Add a periodic reconciliation pass: on load, remove assignments for files that no
  longer exist in the workspace. This pass should be cheap (one `fs.existsSync` per
  entry) and run asynchronously after activation.

---

## P5 — `RebaseSuggestionService` Runs N Separate `git rev-list` Commands

**File:** `src/rebaseSuggestionService.ts`, `_checkAll()`

For a stack of N branches, `_checkAll()` runs one `git rev-list --count` subprocess
per branch pair. With a 5-branch stack, that is 4 subprocesses every 5 minutes.

This is currently fine. If stacks grow to 10+ branches, or if the check interval is
shortened, it will become noticeable.

**Recommendation:** No immediate action. If needed, batch the checks into a single
`git log --format=%D --all` call and parse the output, or use `git for-each-ref` to
compare branch tips.

---

## P6 — File System Watcher Pattern Is Overly Broad

**File:** `src/workspaceSync.ts`, `init()`

```typescript
vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(workspaceRoot, '**/*'), ...
)
```

`**/*` watches every file in the workspace including `node_modules`, build output,
test fixtures, and other high-churn directories. VS Code internally rate-limits watcher
events, but on large workspaces this still means more events hitting `_onChanged` than
necessary.

**Recommendation:** Honour VS Code's `files.watcherExclude` setting when constructing
the watcher, or at minimum exclude known high-churn directories (`node_modules`,
`dist`, `.next`, `__pycache__`). The exclusion list could mirror `files.exclude`.
