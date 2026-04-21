# Code Quality Review

## Overall Assessment

The codebase is clean, consistently formatted, and easy to read. TypeScript strict mode
is enabled and respected. The layered architecture is reflected in the file structure.
The issues below are improvements rather than indictments.

---

## Q1 — Unhandled Promise Rejections in Command Handlers

Throughout `extension.ts` and `commands.ts`, async command handlers are called with
`void`:

```typescript
context.subscriptions.push(
    vscode.commands.registerCommand('gitbraid.addStackBranch', () => {
        void addStackBranch(config, branchStack, wsRoot)
    })
)
```

`void` silences the TypeScript "floating promise" warning but means any rejection from
`addStackBranch` is silently swallowed. The user gets no feedback when a command fails.

**Recommendation:** Wrap each command in a shared error handler:

```typescript
function cmd(fn: (...args: unknown[]) => Promise<void>) {
    return (...args: unknown[]) => fn(...args).catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e)
        vscode.window.showErrorMessage(`GitBraid: ${msg}`)
        log.error(msg)
    })
}

vscode.commands.registerCommand('gitbraid.addStackBranch', cmd(() =>
    addStackBranch(config, branchStack, wsRoot)
))
```

This is a one-time investment that makes every command self-diagnosing.

---

## Q2 — `WORKTREES_DIR` Constant Is Duplicated

The string `'.worktrees'` is defined as a module-level constant in both
`configService.ts` and `branchStackService.ts`. If the directory name ever changes
(unlikely, but possible for a rename/rebrand), it must be updated in two places.

**Recommendation:** Extract to `src/constants.ts`:

```typescript
export const WORKTREES_DIR = '.worktrees'
export const CONFIG_FILENAME = 'local-config.json'
```

---

## Q3 — Large Volume of Commented-Out Code in `commands.ts`

`commands.ts` contains approximately 80 lines of commented-out code for a
`patchToWorktree` command that was never completed. This dead code:

- Adds noise when reading the file
- Gives the impression the file is larger and more complex than it is
- May confuse future contributors who don't know if this is intentional or forgotten

**Recommendation:** Delete it. The git history preserves it if it ever needs to be
revived. If the feature is planned, open a GitHub issue instead of leaving code
comments.

---

## Q4 — Broad `catch {}` Blocks Hide Errors

Several places catch all errors and log at `info` level, obscuring the real problem:

```typescript
// workspaceSync.ts
} catch {
    // Directory may already exist
}
```

```typescript
// workspaceSync.ts
} catch {
    // File may not exist in worktree — not an error
}
```

The intent is clear, but using bare `catch {}` means unexpected errors (permissions
denied, disk full) are silently swallowed alongside the expected ones.

**Recommendation:** Catch specific error codes:

```typescript
} catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw e
    }
}
```

Or at minimum log unexpected errors at `warn` level to make them visible in the
Output panel without blocking the operation.

---

## Q5 — `gitFunctions.ts` Mixes Two Unrelated Concerns

`gitFunctions.ts` contains:
1. A `git` object wrapping all git CLI operations (worktrees, staging, diff, etc.)
2. A `WorktreeView`-level helper (`cleanMessage`, `getStateFromChar`) used only by the
   SCM provider UI

These have different abstraction levels and different change rates. The git CLI wrapper
is stable core infrastructure; the UI helpers change with the UI.

**Recommendation:** Move `cleanMessage`, `getStateFromChar`, and the worktree-status
parsing logic into `branchScmProvider.ts` or a dedicated `scmHelpers.ts`, leaving
`gitFunctions.ts` as a pure git-operations module.

---

## Q6 — `exec` vs `spawn` Inconsistency

The codebase uses `util.promisify(child_process.exec)` in most places and
`child_process.spawn` only in `HunkRouter._applyPatch` (to stream stdin for large
patches). This is a reasonable split, but the inconsistency makes it hard to audit
subprocess calls at a glance.

**Recommendation:** Add a comment at the top of each file that spawns processes
explaining the choice:

```typescript
// Uses spawn (not exec) to stream patch content via stdin, avoiding arg-length limits.
```

And enforce `maxBuffer` on all `exec` calls — the default 1 MB buffer will truncate
diffs for large files:

```typescript
await exec(`git diff HEAD -- "${sanitised}"`, { cwd: wsRoot, maxBuffer: 100 * 1024 * 1024 })
```

---

## Q7 — `configTypes.ts` Schema Validation Is Incomplete

`isValidConfig()` checks for the presence of top-level keys but does not validate the
shape of individual entries:

```typescript
export function isValidConfig(obj: unknown): obj is BranchConfig {
    return (
        typeof obj === 'object' && obj !== null &&
        'version' in obj && 'stack' in obj && 'assignments' in obj
    )
}
```

A config with `stack: "not-an-array"` would pass this check and cause a runtime crash
when the stack is iterated.

**Recommendation:** Use a schema validation library (e.g., `zod`, which adds ~12 KB to
the bundle) or write explicit type guards for each nested shape. This is especially
important for the migration path where old configs may have unexpected shapes.

---

## Q8 — Magic Numbers in `rebaseSuggestionService.ts`

```typescript
const CHECK_INTERVAL_MS = 5 * 60 * 1_000  // 5 minutes
```

This constant is not exposed as a VS Code setting, so users cannot adjust the polling
frequency. A busy developer who wants real-time rebase suggestions, or a developer on
a slow machine who wants to reduce background work, has no way to tune this.

**Recommendation:** Add `gitbraid.rebaseCheckIntervalMinutes` to `package.json`
`contributes.configuration` with a default of 5 and wire it up in the service.

---

## Q9 — `phase45.test.ts` Is a Test Organisation Smell

A test file named after a development phase rather than the feature it tests will rot:
the phase label becomes meaningless once the feature ships. Rename it to reflect what
it actually tests (e.g., `stackResolver.integration.test.ts`).

---

## Q10 — No ESLint Rule for Floating Promises

TypeScript's `strict` mode does not catch `void somePromise()` as a problem. The
`@typescript-eslint/no-floating-promises` rule does, but it does not appear to be
enabled in `.eslintrc`.

**Recommendation:** Enable `@typescript-eslint/no-floating-promises` with
`{ "ignoreIIFE": true }`. This will surface the Q1 issues as lint errors and prevent
new ones from being introduced.
