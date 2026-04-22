# P2 Remediation — Quality, Testing, Logging, Performance

**Target release:** 0.2.x dot releases
**Goal:** reduce incident rate; make the codebase maintainable.

Items in this tier can run in parallel with P1. Each is independently
mergeable.

---

## TEST-001: Test-harness isolation

**Source:** [04-testing.md](04-testing.md#2-tests-share-global-workspace-state)
**Severity:** Medium (flakiness)
**Effort:** M
**Blocks:** TEST-002, TEST-003
**Blocked by:** —

### Root cause
Every test file shares `test_projects/proj1/` on disk. Suite ordering
and cleanup discipline determine pass/fail.

### Proposed fix
1. Add `test/helpers/tmpWorkspace.ts`:

   ```ts
   export async function createTmpWorkspace(): Promise<vscode.Uri> {
       const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'gitbraid-'))
       await runGit(['init', '-b', 'main'], { cwd: dir })
       await runGit(['commit', '--allow-empty', '-m', 'init', '--no-gpg-sign'], { cwd: dir })
       return vscode.Uri.file(dir)
   }
   ```

2. Refactor every `suiteSetup/setup` to use the helper, returning a
   fresh URI per test. Teardown rm's the dir.

3. Alternatively, if changing `workspaceFolder` at runtime is not
   possible in `vscode-test`, split the CLI config to run each test
   file in a separate VS Code test instance with its own workspace.

### Acceptance criteria
- No two tests share state on disk.
- Randomising test order (`--sort` off) does not change pass/fail.

### Verification
CI runs tests with `mocha --sort off --shuffle`.

---

## TEST-002: Add missing unit tests

**Source:** [04-testing.md](04-testing.md#1-entire-modules-have-no-direct-tests)
**Severity:** Medium
**Effort:** L
**Blocks:** —
**Blocked by:** TEST-001

### Root cause
`commands.ts`, `worktreeNodes.ts` (or its stack equivalent post-ARCH-001),
`branchScmProvider.ts`, `hunkCodeLensProvider.ts`, `gitFunctions.ts`,
`extension.ts`, `lmTools.ts` all lack direct tests.

### Proposed fix
Write tests module by module. Priority order:
1. `branchScmProvider.ts` — stateful, easy to regress.
2. `hunkCodeLensProvider.ts` — stale-cache-prone.
3. `gitFunctions.ts` (or `gitRunner.ts` after SEC-001).
4. `lmTools.ts` — one test per tool.
5. `extension.ts` — activation smoke test.
6. `commands.ts` — covered via ARCH-001 rewrite.

Prefer an `IGitRunner` interface mock over child-process integration.

### Acceptance criteria
- Line coverage ≥ 70% for every module in `src/` excluding
  `channelLogger.ts` and `@types`.
- Every public method of `MbcApi` and each LM tool has a direct test.

### Verification
CI enforces coverage threshold.

---

## TEST-003: Shell-injection regression suite

**Source:** [04-testing.md](04-testing.md#3-no-tests-for-shell-injection-edge-cases) · [03-security.md](03-security.md)
**Severity:** Medium (permanent guard)
**Effort:** S
**Blocks:** —
**Blocked by:** TEST-001, SEC-001

### Root cause
No tests prove the injection surface stays closed.

### Proposed fix
Add `test/security/shellInjection.test.ts` with cases for:
- Branch name `feat$(touch FILE)` → `FILE` must not exist.
- Branch name `a\"$(touch FILE)\"` → same.
- Commit message with backticks, `$()`, newlines.
- Relative path `../../FILE`, `..\\..\\FILE`.
- Crafted ref `refs/heads/main; touch FILE`.

Each case invokes the `MbcApi` surface (not internal helpers) so the
test pins the contract at the boundary.

### Acceptance criteria
- Each case fails **loudly** if the injection runs (a sentinel file
  presence check).
- Suite passes only when SEC-001 has landed.

### Verification
CI runs this suite on every PR.

---

## TEST-004: CI pipeline

**Source:** [04-testing.md](04-testing.md#10-cicoverage-target)
**Severity:** Medium
**Effort:** S
**Blocks:** —
**Blocked by:** —

### Root cause
No CI. The `PLAN.md` >80% coverage promise is unenforced.

### Proposed fix
Add `.github/workflows/ci.yml`:

```yaml
name: CI
on: [push, pull_request]
jobs:
  test:
    strategy:
      matrix:
        os: [ubuntu-latest, macos-latest, windows-latest]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm ci
      - run: npm run lint
      - run: xvfb-run -a npm test
        if: runner.os == 'Linux'
      - run: npm test
        if: runner.os != 'Linux'
      - run: npx vsce package --no-dependencies
```

Add a coverage floor via `c8 --check-coverage --lines 70 --functions 70`
once TEST-002 lands.

### Acceptance criteria
- CI runs on PRs and blocks merge on failure.
- Matrix: Linux + macOS + Windows.

### Verification
Merge the workflow; observe it fail on a deliberately broken PR.

---

## ERR-001: Fix the logger

**Source:** [06-error-handling-and-logging.md](06-error-handling-and-logging.md#logger-class-issues)
**Severity:** Medium
**Effort:** S
**Blocks:** —
**Blocked by:** —

### Root cause
- `Logger.getInstance()` re-instantiates and clears the channel on
  each call.
- `notification()` double-fires info messages.
- `getCallerSourceLine()` runs on every log line.

### Proposed fix
```ts
class Logger {
    private static _instance: Logger | undefined
    static getInstance(): Logger {
        this._instance ??= new Logger()
        return this._instance
    }
    notification(message: string, type = NotificationType.Info) {
        if (!this.notificationsEnabled) return
        switch (type) {
            case NotificationType.Info:  void window.showInformationMessage(message); break
            case NotificationType.Warn:  void window.showWarningMessage(message);     break
            case NotificationType.Error: void window.showErrorMessage(message);       break
        }
    }
    private getCallerSourceLine(): string | undefined {
        if (this.logLevel > LogLevel.Debug) return undefined   // skip in release
        …
    }
}
```

### Acceptance criteria
- Test: two `Logger.getInstance()` calls return the same reference.
- Test: one `log.notification('hi')` call produces one
  `showInformationMessage` call.
- Log-level test: setting `logLevel = Info` means `getCallerSourceLine`
  is not called.

### Verification
`test/channelLogger.test.ts` extended.

---

## ERR-002: Promote typed errors at the API boundary

**Source:** [06-error-handling-and-logging.md](06-error-handling-and-logging.md#typed-errors-are-defined-but-not-used-consistently)
**Severity:** Medium
**Effort:** S
**Blocks:** —
**Blocked by:** SEC-001

### Root cause
`MbcApi.commitBranch`, `rebaseSuggestionService._rebaseBranch`, and
others throw `new Error(…)`. Consumers cannot pattern-match.

### Proposed fix
Use `GitError` (already in `errors.ts`) everywhere a git command fails.
Add specific subtypes where useful: `RebaseConflictError`,
`WorktreeExistsError`.

Drop unused types (`FileGroupError`, `WorktreeParentError`,
`UpdateTreeError`).

### Acceptance criteria
- `rg "throw new Error" src/` returns only paths that are not
  git-related (or documented as such).
- `MbcApi.commitBranch` rejects with a `GitError` in tests.

### Verification
Update API tests.

---

## ERR-003: Only surface stderr on non-zero exit

**Source:** [06-error-handling-and-logging.md](06-error-handling-and-logging.md#gitexec-error-handling-is-too-eager)
**Severity:** High on Windows (LF/CRLF popups)
**Effort:** S
**Blocks:** —
**Blocked by:** SEC-001

### Root cause
`gitExec` fires a user-visible warning on any non-empty stderr.

### Proposed fix
In `gitRunner.ts` (SEC-001), only resolve `stderr` for logs. Only
surface user notifications when `code !== 0`. Callers decide whether
to convert the failure into a toast.

### Acceptance criteria
- On Windows, editing a CRLF-normalised repo does not produce popups
  on save.

### Verification
Windows manual smoke; unit test of `runGit` return shape.

---

## ERR-004: `Promise.allSettled` for per-branch refresh

**Source:** [06-error-handling-and-logging.md](06-error-handling-and-logging.md#error-flow-in-long-running-operations)
**Severity:** Low
**Effort:** S
**Blocks:** —
**Blocked by:** —

### Root cause
`BranchScmProviderManager._refreshAll` and
`RebaseSuggestionService._checkAll` stop on first failure.

### Proposed fix
Swap `Promise.all` for `Promise.allSettled`; log per-branch failures;
aggregate into a single user notification only when it's useful.

### Acceptance criteria
- Test: one failing branch does not prevent the others from refreshing.

---

## PERF-001: Honour `syncDebounceMs` everywhere

**Source:** [07-performance.md](07-performance.md#1-file-system-watcher-storm)
**Severity:** Medium
**Effort:** S
**Blocks:** —
**Blocked by:** UX-004, ARCH-002

### Root cause
Only `WorkspaceSync` debounces; other watchers fire immediately.

### Proposed fix
The shared `FileChangeBus` (ARCH-002) debounces per-`(kind, path)`
using the configured value.

### Acceptance criteria
- A burst of 10 saves in 50ms produces one downstream event.
- Setting `syncDebounceMs = 0` disables debouncing.

### Verification
Timer-based test using a fake clock.

---

## PERF-002: Debounce CodeLens

**Source:** [07-performance.md](07-performance.md#2-gethunksforfile-runs-on-every-cursor-move)
**Severity:** Medium
**Effort:** S
**Blocks:** —
**Blocked by:** —

### Root cause
`HunkCodeLensProvider.provideCodeLenses` runs per document-version
increment.

### Proposed fix
Debounce 300ms per file URI in the provider. Cache the result by
`document.version` **and** text-hash to avoid recomputation when the
version bumps without text changes.

### Acceptance criteria
- Typing at 10 keys/sec produces at most 4 `runGit(['diff', …])` calls
  in a second.

### Verification
Instrumented test counting `runGit` invocations.

---

## PERF-003: Parallelise initial worktree creation

**Source:** [07-performance.md](07-performance.md#startup)
**Severity:** Low
**Effort:** S
**Blocks:** —
**Blocked by:** SEC-001

### Root cause
`BranchStackService.initStack` runs worktree adds sequentially.

### Proposed fix
Bounded parallel creation (concurrency = 3) with a helper:

```ts
async function pLimit<T>(items: T[], n: number, fn: (item: T) => Promise<void>) {
    const q = [...items]
    const workers = Array.from({ length: n }, async () => {
        while (q.length) await fn(q.shift()!)
    })
    await Promise.all(workers)
}
```

### Acceptance criteria
- 5-branch stack starts up in < 1s on a warm disk (down from ~2.5s).

### Verification
Benchmark in `test/perf/startup.bench.ts`.

---

## PERF-004: Per-branch status cache + invalidation

**Source:** [07-performance.md](07-performance.md#6-branchscmprovidermanager_refreshall-does-n-synchronous-forks)
**Severity:** Medium
**Effort:** M
**Blocks:** —
**Blocked by:** ARCH-002

### Root cause
Every save refreshes every branch's SCM panel via its own `git status`.

### Proposed fix
Cache the last-known status per branch keyed by
`(branch, worktreeHeadSha, dirtyFlag)`. Invalidate only when:
- `FileChangeBus` reports a save for a path assigned to that branch.
- A commit happens on that branch.
- The worktree's `.git/index` changes.

### Acceptance criteria
- One save on a 5-branch stack produces one `git status` call.

### Verification
Instrumented test.

---

## PERF-005: Bound in-memory caches

**Source:** [07-performance.md](07-performance.md#memory)
**Severity:** Low
**Effort:** S
**Blocks:** —
**Blocked by:** —

### Root cause
`HunkCodeLensProvider._cache` and `WorkspaceSync._floatingDirty` grow
without bound.

### Proposed fix
- Wrap `_cache` in an LRU (e.g. 128 entries).
- Clean `_floatingDirty` on `onDidDelete` (workspace) and on branch
  removal.

### Acceptance criteria
- Opening 500 files does not grow `_cache` beyond 128 entries.

### Verification
Unit test.

---

## QA-001: Lint rules as guard rails

**Source:** multiple
**Severity:** Low
**Effort:** S
**Blocks:** —
**Blocked by:** —

### Root cause
Several systemic issues (dynamic imports, `child_process.exec`, `any`
lambdas) could be prevented by lint.

### Proposed fix
Add the following ESLint rules:
- `no-restricted-imports`: forbid `child_process` in non-`gitRunner`
  modules.
- `no-restricted-syntax`: forbid `await import(` outside tests.
- `@typescript-eslint/no-explicit-any`: error, not warn, in `src/`.
- `no-console`: error in `src/`.

### Acceptance criteria
- `npm run lint` passes on `main` with zero warnings.

### Verification
CI.
