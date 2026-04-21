# Testing Review

## Strengths

- 15 test files covering `ConfigService`, `BranchStackService`,
  `WorkspaceSync`, `DiffEngine`, `HunkRouter`, `BranchStackTreeProvider`,
  `RebaseSuggestionService`, `StackResolver`, `MbcApi`,
  `fileDecorationProvider`, `errors`, `utils`, `channelLogger`,
  `configTypes` and a cross-phase `phase45.test.ts`.
- Event-based assertions in `workspaceSync.test.ts` (waiting for
  `onDidSyncFile`) are the right pattern for async watchers.
- Coverage collection is wired up (`vscode-test --coverage`) and the
  mocha reporter is SonarQube-ready.

## Gaps

### 1. Entire modules have no direct tests

| Module | Has tests? |
| --- | --- |
| `commands.ts` (`GitBraidAPI`, 600 lines, the legacy command surface) | ❌ |
| `worktreeNodes.ts` (700 lines, `NodeMapper` + node classes) | ❌ |
| `worktreeView.ts` | ❌ |
| `branchScmProvider.ts` (`BranchScmProviderManager` + `BranchScmEntry`) | ❌ |
| `hunkCodeLensProvider.ts` (`HunkCodeLensProvider` + `OverlayDiagnostics`) | ❌ |
| `gitFunctions.ts` (`Git` + `Worktree` classes) | covered incidentally via other tests, no unit tests |
| `extension.ts` | ❌ |
| `lmTools.ts` | ❌ |

This is the bulk of the code. The coverage numbers (if you read the
`lcov.info` after a run) will show `mbcApi.ts`, `configService.ts`,
`diffEngine.ts`, and `hunkRouter.ts` at 80%+ and everything else at
0–20%.

### 2. Tests share global workspace state

Every test file does:

```ts
function wsRoot(): vscode.Uri {
    return vscode.workspace.workspaceFolders![0].uri
}
function cleanup() {
    try { fs.rmSync(path.join(wsRoot().fsPath, '.worktrees'), { recursive: true }) } catch {}
    try { fs.rmSync(path.join(wsRoot().fsPath, '.gitignore')) } catch {}
}
```

And writes real files/worktrees inside `test_projects/proj1/`. Because
`proj1/` is one physical folder, **suite ordering matters**: if
`workspaceSync.test.ts` runs before `branchStackService.test.ts` and
leaves an orphan directory behind, the later suite's `initStack` will
attempt to prune it. The tests work today because every suite calls
`cleanup()` in `setup`/`teardown`, but this is brittle and couples
suites temporally.

Recommendation: give each suite its own subdirectory
(`os.tmpdir()/gitbraid-<suiteName>-<random>`), set
`workspaceFolder` dynamically, or use `vscode-test`'s ability to run
each suite in a separate test instance.

### 3. No tests for shell-injection edge cases

Given the findings in `03-security.md`, the test suite should include:

- A test that calls `setAssignment(branch='feat$(touch /tmp/pwned)')`
  and verifies `/tmp/pwned` was not created.
- A test that calls `addBranch(name='..\\..\\foo', base='main')` and
  verifies the worktree is not created outside `.worktrees/`.
- Fuzz tests for `parseDiffHunks` (the current tests only cover the
  happy path).

### 4. Tests assert weak conditions

Several tests accept any outcome:

- `rebaseSuggestionService.test.ts:67`:
  `assert.ok(result === undefined || typeof result === 'number')`.
- `stackResolver.test.ts:109`:
  `assert.ok(result === undefined || typeof result === 'string')`.
- `hunkRouter.test.ts:219`:
  `assert.ok(typeof ok === 'boolean')`.

These tests cannot fail the assertion. They cover code paths but not
behaviour. Rework them with deterministic setup (create real branches,
check-in real commits) before asserting.

### 5. Mocks are type-unsafe

`test/hunkRouter.test.ts:10`:

```ts
engine.getHunksForFile = async (_wsRoot, _relativePath) => hunks
```

Replacing a class method with a function loses private-state
invariants. Introduce an interface (`IDiffEngine`) so tests can provide
a typed fake.

### 6. No tests for activation / deactivation

No test exercises `extension.activate(context)` end-to-end. The
ambient tests rely on the extension activating **from** the test host,
but none asserts that the commands were registered, or that the
`vscode.git` dependency exists, or that `filesExcludeWorktreesDir` is
idempotent. Given the bugs in activation (`isPrumary` typo,
`activationEvents` mis-key), this deserves a dedicated test.

### 7. No tests for the SCM provider

`BranchScmProviderManager` is ~280 lines of stateful code that creates
`vscode.SourceControl` instances and interprets `git status --porcelain`
output. None of that is exercised. At minimum:

- A test that adds two branches, triggers `_rebuild()`, asserts two
  entries exist, removes one, and asserts one entry is disposed.
- A test for `commitBranch` that stubs `exec` to simulate success and
  failure.

### 8. No tests for CodeLens / diagnostics

`HunkCodeLensProvider.provideCodeLenses` includes caching logic keyed by
`document.version`. A stale-cache bug in this path is likely and
difficult to reproduce manually.

### 9. Test harness has conflicting tooling

`.vscode-test.mjs` requires **both** `@swc-node/register` and
`tsconfig-paths/register`. The `package.json` devDependencies also
ship `ts-node`. Having two TS loaders active simultaneously is a
common cause of "cannot find module" errors on CI. Pick one.

Additionally:

```js
mochaOpts.reporterOptions = {
    reporterEnabled: [ 'json-stream', 'xunit', 'spec', 'mocha-reporter-sonarqube' ],
```

`mocha-reporter-sonarqube` is explicitly mentioned in a repo that
otherwise "removes legacy CI/Sonar infrastructure" (commit `4519ab4`).
Delete the reporter dependency or restore the Sonar pipeline — don't
leave it half-wired.

### 10. CI/coverage target

`docs/PLAN.md` promises **>80% line coverage** enforced by CI. There
is no CI workflow checked in and no coverage threshold in
`.vscode-test.mjs`. Add:

- `.github/workflows/ci.yml` running `npm test`, `npm run lint`, and
  `npx vsce package --no-dependencies` on pull requests.
- A coverage threshold check. With `c8` you'd add
  `--check-coverage --lines 80 --functions 80 --branches 70`.

### 11. Flaky test patterns

- `sleep(ms)` is used in `workspaceSync.test.ts` to wait for debounces.
  This depends on wall-clock timing; on slow machines the 600ms sleep
  might race the 200ms debounce. Prefer `fake timers` (sinon) or the
  event-based `waitForEvent` helpers already in the file.
- `waitForFilteredEvent` rejects with `'Filtered event timeout'` after
  3s — a timeout that's easy to hit on CI cold starts.

## Recommended test roadmap

1. Add a lightweight `IGitRunner` seam around `gitFunctions.ts`. Drive
   unit tests with a fake runner. Reserve real-git integration tests
   for a dedicated `test/integration/` folder that runs slowly but
   against a real repo created in `os.tmpdir()`.
2. Add tests for `commands.ts`. Start with `copyToWorktree`, `stage`,
   `discardChanges`.
3. Add tests for `BranchScmProviderManager` and `HunkCodeLensProvider`.
4. Add shell-injection negative tests per `03-security.md`.
5. Stand up CI and a coverage floor.
