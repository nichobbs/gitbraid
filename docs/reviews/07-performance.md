# Performance Review

## Hot paths

### 1. File-system watcher storm

`extension.ts:366-402` and `workspaceSync.ts:79-97` register watchers
with the pattern `**/*` on the workspace root. In a mono-repo with
5 000 files, every save triggers:

1. `extension.ts` `watcher.onDidCreate` (if new file) → `api.refreshUri`
   → `git check-ignore <path>` (shell out) → `git status --porcelain`
   for the containing worktree.
2. `extension.ts` `watcherChange.onDidChange` for `.git/index` when git
   writes it → another `api.refresh(repoNode)` → `git status --porcelain`.
3. `workspaceSync.ts` `watcher.onDidChange` → debounced `_handleSave`
   → read file, write to worktree, emit event.
4. `BranchScmProviderManager` listens to `onDidSyncFile` →
   `_refreshAll()` → `git status --porcelain=v1 -z` in **every** branch
   worktree.
5. `BranchStackTreeProvider` and `BranchFileDecorationProvider` listen
   to the same events and re-query `ConfigService`.

A single save of one file fans out to **O(branches × 2)** git status
invocations. On a stack of 5 branches that's 10 forks per save. The
`syncDebounceMs` setting mitigates the pump, but only the Sync path
honours it — the legacy refresh path does not.

Fixes:

- Honour `syncDebounceMs` everywhere.
- Introduce a shared debouncer keyed by worktree path.
- Drop the duplicate `**/*` watcher in `extension.ts`; subscribe to
  `WorkspaceSync`'s events instead.

### 2. `getHunksForFile` runs on every cursor move

`HunkCodeLensProvider.provideCodeLenses` is invoked by VS Code
aggressively (after any document version bump, including typing). The
internal cache checks `document.version`, which increments on every
keystroke — so every keystroke triggers a `git diff HEAD -- <file>`
exec. On a 100 KB file with 10 hunks the exec takes 30–80 ms; typing
quickly will queue several in flight.

Fix: debounce by 300 ms using the existing `_pending` pattern from
`WorkspaceSync`, keyed by `document.uri.fsPath`.

### 3. `nodeMaps.getAllNodes` is O(n³) with aggressive logging

`worktreeNodes.ts:28-45`:

```ts
for (const node of this.tree) {
    allNodes.push(node)
    log.info('node.id=' + node.id)
    for (const child of node.children) { … log.info … }
}
```

Every `getNode(uri)` call (and there are many) reruns the full walk
**and** writes one log line per node. With 10 worktrees × 500 files
that's 5 000 log lines per call, and `log.info` itself calls
`getCallerSourceLine` which throws a synthetic `Error` (see
`06-error-handling-and-logging.md`).

Fixes:

- Maintain a `Map<string, WorktreeNode>` keyed by URI; update on
  add/remove.
- Demote the inner logs to `trace` or delete them.

### 4. `RebaseSuggestionService` polls every 5 minutes

`rebaseSuggestionService.ts:11`: `CHECK_INTERVAL_MS = 5 * 60 * 1_000`.
A `setInterval` in an extension keeps the host process busy even when
no git event happened. Prefer event-driven triggers only
(`onDidChangeStack`, `onDidSyncFile`, and the existing startup check).

If you keep polling, back off during idle: reset the interval when the
user becomes active (`vscode.window.onDidChangeWindowState`).

### 5. Repeated `git.worktree.prune`

`BranchStackService._pruneOrphans` ends with `await git.worktree.prune()`.
On a stack with 5 branches, every `initStack` call runs prune once —
which itself scans every worktree's HEAD. With the `setInterval`-based
rebase check above, plus stack changes, plus manual refreshes, prune
runs frequently.

Fix: only prune when at least one orphan was detected.

### 6. `BranchScmProviderManager._refreshAll` does N synchronous forks

`await Promise.all([...this._entries.values()].map((e) => e.refresh()))`
forks N `git status --porcelain=v1 -z` processes concurrently. On macOS
this spikes CPU; on Windows each `fork` is slow. Cache the last status
per worktree, invalidate on `onDidSyncFile(branch)`, and run the status
only for the invalidated branch.

### 7. `gitStatusInDir` returns strings that are not interned

Each call builds a new `WorktreeFileStatus[]` including string slicing
of `stdout`. Nothing dramatic, but `BranchScmEntry.refresh` is called
on every save. Cache the status object and compare by content hash.

### 8. `ConfigService._writeToDisk` is sync

```ts
fs.writeFileSync(tmpPath, content, 'utf-8')
fs.renameSync(tmpPath, this._configPath)
```

Extension-host file operations block the event loop. For a 10 KB
config this takes <1 ms, but it runs on every `setAssignment`,
`setHunkAssignment`, `addBranch`, `removeBranch`, `reorderStack`. In
a workflow where an AI agent assigns 100 files in a batch, that's 100
synchronous writes. Switch to `fs.promises.writeFile` and batch-write
with `debounce(50ms)` so rapid mutations coalesce.

## Memory

- `HunkCodeLensProvider._cache` is never bounded. Opening many files
  with many hunks accumulates indefinitely.
- `WorkspaceSync._floatingDirty` is also unbounded and holds the full
  relative path for every file ever floated. Prune on
  `onDidChangeAssignment` with an explicit removal — today the code
  deletes only when the file is assigned or synced, not when it is
  deleted in the workspace.
- `nodeMaps.tree` leaks nodes on dispose in some paths
  (`WorktreeFileGroup.dispose` removes children but
  `WorktreeRoot.dispose` does not always clear `nodeMaps.tree` before
  re-adding in `initTreeview`).

## Startup

- `BranchStackService.initStack` runs `await git.worktree.add` for every
  missing branch sequentially. For a 5-branch stack from a cold start
  this is 5 × ~500 ms = 2.5 s. Run in parallel with
  `Promise.all(stack.map(e => this._ensureWorktree(e)))` — with a
  concurrency cap (e.g. 3) to avoid pack-file contention.
- `log.info` in activation logs ~15 lines before useful work happens.
  Move verbose startup logs to `trace`.
