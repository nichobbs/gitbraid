# Error Handling and Logging

Close the gap where the extension appears to work but quietly isn't,
and where successful operations produce duplicate popups.

---

## T25. Shared command-handler error wrapper

**Files:** new `src/commandWrapper.ts`, `src/extension.ts`,
`src/commands.ts`
**Cross-ref:** `docs/reviews/code-quality.md` Q1,
`docs/reviews/10-priorities.md` #2.

### Fix

```ts
export function cmd<Args extends unknown[]>(
    id: string,
    fn: (...args: Args) => Promise<void> | void,
): (...args: Args) => Promise<void> {
    return async (...args) => {
        try {
            await fn(...args)
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e)
            log.error(`${id} failed: ${msg}`)
            const pick = await vscode.window.showErrorMessage(
                `GitBraid: ${msg}`,
                'Open Output',
            )
            if (pick === 'Open Output') log.show()
        }
    }
}
```

Rewrite every `vscode.commands.registerCommand('gitbraid.*', () =>
void fn(...))` to `registerCommand(id, cmd(id, () => fn(...)))`.

### Acceptance

- A failing command surfaces a single notification with an "Open
  Output" button, and the output channel contains the stack trace.
- ESLint `@typescript-eslint/no-floating-promises` is enabled
  (see T34) with zero violations.

### Effort

½ day + migration time.

---

## T26. Replace `catch {}` with logged `catch (e) { log.warn(...) }`

**Files:** `src/branchStackService.ts:222`, `:242-245`, `:261-265`,
`src/diffEngine.ts:184-187`, `src/stackResolver.ts:117-120`,
`src/rebaseSuggestionService.ts:186-188`, `src/workspaceSync.ts`
(directory-exists and file-not-present handlers),
`src/utils.ts:pathExists` (see T27 for the specific fix)
**Cross-ref:** `docs/reviews/06-error-handling-and-logging.md`
("Catch-all catch {} swallows diagnostics"),
`docs/reviews/code-quality.md` Q4.

### Fix

- Catch only the specific error codes that are expected (`EEXIST`,
  `ENOENT`) and rethrow unexpected ones.
- Where "expected failure" is a semantic (e.g. git path not in tree),
  check the exit code or error message specifically.
- At minimum, log `e.message` at `warn` level before returning the
  fallback.

### Acceptance

- `grep -nE "catch \{\}" src/` returns zero results (lint rule
  optional: `@typescript-eslint/no-useless-catch` + custom rule).
- Tests that simulate unexpected failures (EACCES, EIO) now see the
  error surfaced instead of swallowed.

### Effort

1 day.

---

## T27. Fix `pathExists`, harden `toUri`

**Files:** `src/utils.ts:pathExists`, `src/utils.ts:toUri`
**Cross-ref:** `docs/reviews/bugs.md` B5, B6.

### Fix

```ts
export function pathExists (uri: vscode.Uri): boolean {
    try { fs.statSync(uri.fsPath); return true } catch { return false }
}

export function toUri (p: string): vscode.Uri {
    if (p.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(p)) {
        return vscode.Uri.file(p)
    }
    // relative path → join with workspace root
    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri
    if (!wsRoot) throw new ConfigError('toUri called without a workspace')
    return vscode.Uri.joinPath(wsRoot, p)
}
```

### Acceptance

- `pathExists` returns `false` on ENOENT, `true` otherwise, never
  throws on missing paths.
- `toUri('C:/foo/bar')` on Windows returns an absolute file URI.
- `toUri` with no workspace throws a typed error rather than
  returning `undefined`.

### Effort

¼ day.

---

## T28. Fix the double-fire in `log.notification*`

**File:** `src/channelLogger.ts:92-96`, around `notificationWarn`,
`notificationInfo`
**Cross-ref:** `docs/reviews/02-bugs-and-correctness.md`
("log.notification double-fires info messages"),
`docs/reviews/06-error-handling-and-logging.md`.

### Fix

```ts
public notification (message: string): void {
    if (!this.notificationsEnabled) return
    void window.showInformationMessage(message)
}
```

(the unconditional second call goes away). Same pattern for
`notificationWarn` / `notificationError`.

### Acceptance

- Test: stub `window.showInformationMessage`, call `log.notification`
  with notifications enabled → exactly one invocation.

### Effort

¼ day.

---

## T29. Stop recreating the Logger singleton

**File:** `src/channelLogger.ts:getInstance`
**Cross-ref:** `docs/reviews/06-error-handling-and-logging.md`
("Logger class issues" #1).

### Fix

```ts
public static getInstance (): Logger {
    if (!Logger.instance) {
        Logger.instance = new Logger()
    }
    return Logger.instance
}
```

Move the `clearOutputChannel()` call into an explicit `resetForTest()`
or trigger on `workspaceFolders` change.

### Acceptance

- Calling `getInstance()` twice returns the same object; the output
  channel keeps its history.

### Effort

¼ day.

---

## T30. Guard `getCallerSourceLine` by log level

**File:** `src/channelLogger.ts`
**Cross-ref:** `docs/reviews/06-error-handling-and-logging.md`
("getCallerSourceLine runs new Error() on every log call").

### Fix

Only compute the caller line when the configured level is `Debug` or
lower. For `Info`/`Warn`/`Error` skip the stack capture entirely.

### Acceptance

- Microbench: 10_000 `log.info` calls complete in < 20 ms on a
  reference machine.

### Effort

¼ day.

---

## T31. Standardise on typed errors in the API layer

**Files:** `src/mbcApi.ts`, `src/rebaseSuggestionService.ts`,
`src/stackResolver.ts`, `src/hunkRouter.ts`, `src/errors.ts`
**Cross-ref:** `docs/reviews/06-error-handling-and-logging.md`
("Typed errors are defined but not used consistently").

### Fix

- Remove unused error types (`FileGroupError`, `WorktreeParentError`,
  `UpdateTreeError`).
- Replace `throw new Error(...)` with the existing typed errors in
  `mbcApi.commitBranch`, `rebaseSuggestionService._rebaseBranch`,
  `stackResolver.getResolvedContent`, `hunkRouter.routeFile`.
- Export a union `GitBraidError = ConfigError | SyncError |
  BranchStackError | GitError | WorktreeNotFoundError |
  NotImplementedError` for downstream consumers.

### Acceptance

- `grep -n "throw new Error" src/` returns zero results.
- Lint rule in place forbidding it going forward.

### Effort

1 day.

---

## T32. `Promise.allSettled` for per-branch refreshes

**Files:** `src/branchScmProvider.ts:_refreshAll`,
`src/rebaseSuggestionService.ts:_checkAll`
**Cross-ref:** `docs/reviews/06-error-handling-and-logging.md`
("Error flow in long-running operations"),
`docs/reviews/07-performance.md`.

### Fix

Switch from `Promise.all` to `Promise.allSettled`, iterate results,
log each failure once with the branch name, and continue. Never let
a single failing branch poison the whole refresh.

### Acceptance

- Test: simulate one branch throwing; assert the other branches
  still refreshed and a single warning logged.

### Effort

½ day.

---

## T33. Restructure the rebase dialog await chain

**File:** `src/rebaseSuggestionService.ts:129`
**Cross-ref:** `docs/reviews/06-error-handling-and-logging.md`
("Dialog handling").

### Fix

```ts
const choice = await vscode.window.showInformationMessage(msg, 'Rebase now', 'Dismiss')
if (choice === 'Rebase now') {
    await this._rebaseBranch(entry)
}
```

### Acceptance

- Caller's `await` actually waits for the rebase to finish.
- Unit test with sinon-timers verifies ordering.

### Effort

¼ day.

---

## T34. Enable `@typescript-eslint/no-floating-promises`

**Files:** `.eslintrc*`, `package.json` (lint script)
**Cross-ref:** `docs/reviews/code-quality.md` Q10.

### Fix

Enable the rule, set `{ ignoreIIFE: true }`, fix the few remaining
offenders after T25 lands. Run lint in CI on every PR (see T46).

### Acceptance

- `npm run lint` exits zero; `void`-prefixed promises exist only
  where justified.

### Effort

½ day.

---

## Error/logging exit criteria

- [ ] No double-fire notifications.
- [ ] No `catch {}` blocks remaining.
- [ ] All API failures propagate as typed errors.
- [ ] Output channel survives multiple `getInstance()` calls.
- [ ] Log level changes take effect without reload.
