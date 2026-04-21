# Error Handling and Logging Review

## Typed errors are defined but not used consistently

`errors.ts` declares `ConfigError`, `SyncError`, `BranchStackError`,
`GitError`, `WorktreeNotFoundError`, `NotImplementedError`,
`FileGroupError`, `WorktreeParentError`, `UpdateTreeError`.

Actual usage:

| Error type | Where thrown |
| --- | --- |
| `ConfigError` | `configService.ts` (3 places) ✅ |
| `BranchStackError` | `branchStackService.ts` (4 places) ✅ |
| `SyncError` | `workspaceSync.ts` (1 place) ✅ |
| `GitError` | `gitFunctions.ts:137` ✅ |
| `WorktreeNotFoundError` | `worktreeNodes.ts`, `commands.ts` ✅ |
| `NotImplementedError` | `commands.ts:437` ✅ |
| `FileGroupError` | **never thrown** |
| `WorktreeParentError` | **never thrown** |
| `UpdateTreeError` | **never thrown** |

Drop unused types. More importantly, **`MbcApi.commitBranch` throws a
plain `Error`**, not a typed `GitError`, so a consumer trying to branch
on `e instanceof GitError` has to fall back to message parsing:

```ts
// mbcApi.ts:144
throw new Error(`Commit to "${branch}" failed: ${msg}`)
```

Same issue in `rebaseSuggestionService.ts`, `stackResolver.ts`,
`hunkRouter.ts`.

## Catch-all `catch {}` swallows diagnostics

`branchStackService.ts:222`:

```ts
private async _isCheckedOut(branchName: string): Promise<boolean> {
    try {
        const worktrees = await git.worktree.list()
        return worktrees.some((wt) => wt.branch === 'refs/heads/' + branchName)
    } catch {
        return false
    }
}
```

If `git worktree list` fails for an unrelated reason (git not on PATH,
bad permissions) the method silently reports "not checked out" and the
caller then tries `git worktree add "$branch"`, which will fail with a
different error that doesn't point back at the original cause.

Similar patterns in:

- `branchStackService.ts:242-245` (readdirSync failure ignored)
- `branchStackService.ts:261-265` (worktree remove failure logged, but
  only as `warn`, no user message)
- `diffEngine.ts:184-187` (merge-base failure)
- `stackResolver.ts:117-120` (`getStackDiff` returns undefined)
- `rebaseSuggestionService.ts:186-188` (`_countRevsBehind` returns
  undefined)

Each of these is a place where the extension appears to work but
secretly isn't. Log at `warn` level with the specific error message.

## `gitExec` error handling is too eager

`gitFunctions.ts:127-132`:

```ts
if (r.stderr != '') {
    log.error('      stderr=' + r.stderr)
    void log.notificationWarn(r.stderr + '\n(command: ' + command + ')')
}
```

Git routinely writes to stderr on **successful** commands:

- `warning: LF will be replaced by CRLF…`
- `warning: in the working copy of 'x', LF will be replaced…`
- `M\tpath/to/file` (via some plumbing tools)

Every such message triggers a user-facing warning popup. This will be
extremely noisy. Only surface stderr on **non-zero** exit codes.

## Logger class issues

`channelLogger.ts`:

1. **Singleton via `getInstance` recreates every call**:

   ```ts
   public static getInstance () {
       Logger.instance = new Logger()
       Logger.instance.clearOutputChannel()
       return Logger.instance
   }
   ```

   Each invocation overwrites the instance and **clears the output
   channel**. Any caller holding an earlier `log` reference is now
   using the old channel. The module-level export `log = Logger.getInstance()`
   (`channelLogger.ts:229`) hides this because the module is evaluated
   once — but a second `getInstance()` call would lose every log line
   collected so far.

2. **`notification` fires twice** (`channelLogger.ts:92-96`) when
   `notificationsEnabled` is true (the call is made inside the `if`
   block **and** immediately after). Covered in
   `02-bugs-and-correctness.md`.

3. **`getCallerSourceLine` runs `new Error()` on every log call** to
   pull the call site from the V8 stack. Cost: ~20µs per log line.
   In a 10k-line refresh that's 200 ms. Guard with `this.logLevel <= Debug`.

4. **Internal filter list** of function names to skip:

   ```ts
   if (funcname == 'processTicksAndRejections' ||
       funcname == 'runNextTicks' || ...)
   ```

   This is brittle (V8 internals change) and misses arrow functions and
   minified bundles (esbuild mangles names). Replace with a stack-slice
   approach: take frame N+2 where N is the known frame count from
   within the logger.

5. **`consoleLogLevel` is hard-coded to `Info`** and
   `consoleTimestamp` to `true`. In tests this floods the CI log. Make
   them configurable via env vars (`GITBRAID_LOG_LEVEL`).

## Error flow in long-running operations

`RebaseSuggestionService._checkAll` iterates branches and runs a git
rev-list per branch. If one branch blows up, the loop continues — but
the message isn't shown to the user. Likewise `BranchScmProviderManager._refreshAll`
uses `Promise.all` so a single failure rejects the whole refresh.
Prefer `Promise.allSettled` + per-branch error reporting.

## Dialog handling

`rebaseSuggestionService.ts:129`:

```ts
await vscode.window.showInformationMessage(msg, 'Rebase now', 'Dismiss')
    .then(async (choice) => { … })
```

The `await` in front of a `.then` chain awaits only the outer message,
not the inner `_rebaseBranch`. If the caller awaits `_checkAll`, it
will return before the rebase completes. Restructure as
`const choice = await vscode.window.showInformationMessage(...); if (choice === 'Rebase now') { await this._rebaseBranch(...) }`.

## Absent error UX

- `BranchScmProviderManager.commitBranch` shows an error message on
  failure (good) but **clears the input box only on success**. Means
  the user's commit message is preserved across failures — good! But
  there's no logging of _why_ it failed beyond the raw stderr.
- `WorkspaceSync._syncFile` throws `SyncError` up into the watcher
  callback, which has no `.catch()`. Results in an unhandled rejection
  at the extension host level.

## Summary

- Replace `catch {}` with `catch (e) { log.warn(...) }` everywhere.
- Only surface stderr on non-zero exit codes.
- Standardise on typed errors in the API layer so consumers can
  branch on `instanceof`.
- Fix the double-fire bug in `log.notification`.
- Stop rebuilding the logger singleton.
- Guard `getCallerSourceLine` behind the log level.
- Use `Promise.allSettled` when refreshing N branches.
