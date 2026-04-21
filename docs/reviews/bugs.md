# Bugs and Defects

## B1 — `_syncing` Flag Not Reset on `readFile` Failure

**File:** `src/workspaceSync.ts`, `_syncFile()`  
**Severity:** Medium

`_syncing` is set to `true` before writing to the worktree, and cleared in a `finally`
block. However, if `vscode.workspace.fs.readFile(uri)` throws (file deleted between
event and read), the method returns early *before* setting `_syncing = true`, which is
correct. But the subsequent `createDirectory` call is not inside the `try/finally`
block:

```typescript
this._syncing = true
try {
    await vscode.workspace.fs.writeFile(destUri, content)
    ...
} catch (e) {
    throw new SyncError(...)
} finally {
    this._syncing = false
}
```

If `writeFile` throws and `SyncError` is rethrown, `_syncing` is correctly reset via
`finally`. The bug is subtler: the thrown `SyncError` propagates up to `_handleSave`,
which has no `catch` block. The error is swallowed by the `void` call in the debounce
timer, but `_syncing` is correctly reset. On further inspection this is safe — however,
the `SyncError` is silently lost with no user notification. The user saves a file and
nothing happens with no explanation.

**Fix:** Catch the `SyncError` in `_handleSave` and show a VS Code error notification.

---

## B2 — File Watcher Triggers on `.worktrees/` Writes Despite Filter

**File:** `src/workspaceSync.ts`, `_onChanged()`  
**Severity:** Low

The watcher pattern is `**/*` over the entire workspace root. The `_onChanged` handler
filters out paths starting with `.worktrees/`:

```typescript
if (!rel || rel.startsWith('.worktrees/') || rel.startsWith('.git/')) {
    return
}
```

However, the `_syncing` guard is checked first:

```typescript
if (this._syncing) { return }
```

If a sync is not in progress but a background git operation writes to `.worktrees/`
(e.g., `git worktree prune` touching internal files), the path filter correctly ignores
it. The ordering is fine. The actual bug is that when `_syncing` is `true`, events from
*within the workspace* (not worktrees) are also suppressed — meaning a user saving a
file during a sync will have that save silently dropped, not debounced for later.

**Fix:** When `_syncing` is `true`, re-queue the event through the debounce mechanism
rather than discarding it:

```typescript
private _onChanged(uri: vscode.Uri): void {
    if (!this._workspaceRoot) { return }
    const rel = this._relativePath(uri)
    if (!rel || rel.startsWith('.worktrees/') || rel.startsWith('.git/')) { return }
    if (this._syncing) {
        // Re-queue: a sync is writing to the worktree right now, retry shortly
        setTimeout(() => this._onChanged(uri), DEBOUNCE_MS)
        return
    }
    ...
}
```

---

## B3 — `parseDiffHunks` Miscounts Lines for Zero-Line Hunks

**File:** `src/diffEngine.ts`, `parseDiffHunks()`  
**Severity:** Low

For a hunk with `+0,0` (a pure deletion that removes all lines and adds none):

```
@@ -5,3 +5,0 @@
```

`currentNewLineCount` is parsed as `0`. The `endLine` calculation is:

```typescript
const endLine = currentStart + Math.max(newCount - 1, 0)
```

With `currentStart = 5` and `newCount = 0`, `endLine = 5 + 0 = 5`. But the hunk adds
zero lines, so `startLine = 5` and `endLine = 5` implies a one-line span. The correct
representation for a zero-line hunk would be `startLine = 5, endLine = 4` (empty range)
or a dedicated `isEmpty` flag. This causes `detectOverlaps` to report false overlaps
between a deletion-only hunk and a hunk that starts on line 5.

**Fix:** Represent zero-line hunks explicitly:

```typescript
const endLine = newCount === 0 ? currentStart - 1 : currentStart + newCount - 1
```

And add a test case with a `+X,0` hunk header.

---

## B4 — `branchToWorktreeDirName` Can Produce Collisions

**File:** `src/branchStackService.ts`  
**Severity:** Low

```typescript
export function branchToWorktreeDirName(branchName: string): string {
    return branchName.replaceAll('/', '-').replaceAll(/[^a-zA-Z0-9._-]/g, '_')
}
```

The branch names `feature/my-branch` and `feature-my-branch` both map to the directory
name `feature-my-branch`. Adding both to the stack would silently reuse the same
worktree directory.

The upstream branch-name validator (`BRANCH_NAME_RE`) allows both `/` and `-`, so this
collision is reachable.

**Fix:** After computing the directory name, check whether `.worktrees/<name>` already
exists before creating the worktree. If there is a collision, append a numeric suffix
or throw `BranchStackError` with a descriptive message.

---

## B5 — `pathExists` in `utils.ts` Throws Instead of Returning False

**File:** `src/utils.ts`, `pathExists()`  
**Severity:** Low

```typescript
export function pathExists(uri: vscode.Uri) {
    const r = fs.statSync(uri.fsPath)
    return r !== undefined
}
```

`fs.statSync` throws `ENOENT` when the path does not exist — it does not return
`undefined`. The function therefore never returns `false`; it either returns `true` or
throws. All callers expecting a boolean will get an unhandled exception on a missing
path.

`fileExists` and `dirExists` in the same file correctly wrap `statSync` in `try/catch`.
`pathExists` was presumably written first and never corrected.

**Fix:**
```typescript
export function pathExists(uri: vscode.Uri): boolean {
    try {
        fs.statSync(uri.fsPath)
        return true
    } catch {
        return false
    }
}
```

---

## B6 — `toUri` Silently Accepts Relative Paths That Look Absolute on Windows

**File:** `src/utils.ts`, `toUri()`  
**Severity:** Low

```typescript
if (path.startsWith('/') || RegExp(/^[a-zA-Z]:\\/).exec(path)) {
    return vscode.Uri.file(path)
}
```

The regex `^[a-zA-Z]:\\` requires a backslash after the drive letter. Windows paths
using forward slashes (`C:/foo/bar`) are common when VS Code normalises paths and would
fall through to the relative-path branch, incorrectly joining them with the workspace
folder.

**Fix:** Also match `^[a-zA-Z]:/`:

```typescript
if (path.startsWith('/') || /^[a-zA-Z]:[/\\]/.test(path)) {
    return vscode.Uri.file(path)
}
```
