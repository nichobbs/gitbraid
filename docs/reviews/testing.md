# Testing Review

## Current State

The test suite lives in `test/` and contains 15 files mirroring the 15 source modules.
Total test code is ~3,010 lines against ~5,938 lines of source — a healthy 1:2 ratio.
Tests use Mocha + Node.js `assert` with no additional assertion library.

### What Is Well-Tested

| Module | Test quality | Notes |
|---|---|---|
| `configService` | Good | Load/save cycle, schema migration, event firing, `.gitignore` management |
| `configTypes` | Good | Validation and migration logic |
| `diffEngine` | Good | Parser edge cases, pure deletions, multiple hunks, path sanitisation |
| `hunkRouter` | Good | Overlap detection, patch building, out-of-range indices |
| `errors` | Good | Error class hierarchy |
| `utils` | Good | Path and URI helpers |
| `channelLogger` | Adequate | Log level gating |

### What Is Poorly Tested

| Module | Problem |
|---|---|
| `workspaceSync` | The debounce and `_syncing` re-entrancy guard are untested; only basic assignment lookup is covered |
| `branchStackService` | Tests mock all git calls — no worktree is ever actually created |
| `rebaseSuggestionService` | Timer-based logic (`CHECK_INTERVAL_MS`) is hard to exercise with real time; tests fake the interval but miss edge cases |
| `stackResolver` | `getResolvedContent` path for floating files untested |
| `mbcApi` | Integration between API methods and underlying services is mostly smoke-tested |
| `phase45` | The test file name doesn't map to a source module — unclear what it covers |

### Not Tested at All

- `extension.ts` — activation, deactivation, command registration
- `branchStackTreeProvider.ts` — tree item rendering, label logic
- `branchScmProvider.ts` — SCM panel lifecycle
- `hunkCodeLensProvider.ts` — CodeLens generation
- `fileDecorationProvider.ts` — file colour decorations
- `worktreeView.ts` / `worktreeNodes.ts` — the secondary UI layer
- `commands.ts` — all command handlers

---

## Gaps and Recommendations

### 1. No Integration Tests

Every test mocks the git layer. That means a regression in the shell command
construction (wrong flags, wrong argument order) would pass all tests while breaking
the extension entirely.

Add an integration test fixture: a real temporary git repository created in `beforeEach`
using `git init` and `git commit`. Run `BranchStackService.addBranchToStack()` against
it and assert that the worktree directory exists and `git worktree list` reports it.

```typescript
// Sketch
let tmpDir: string
beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitbraid-'))
    execSync('git init', { cwd: tmpDir })
    execSync('git commit --allow-empty -m "init"', { cwd: tmpDir })
})
afterEach(() => fs.rmSync(tmpDir, { recursive: true }))
```

### 2. WorkspaceSync Debounce Is Untested

The 200 ms debounce and the `_syncing` re-entrancy guard are the two most likely
sources of subtle race-condition bugs. Both can be tested with fake timers:

```typescript
// Use sinon or @sinonjs/fake-timers
const clock = FakeTimers.install()
sync._onChanged(uri)
sync._onChanged(uri)         // second call should reset the timer
clock.tick(199)
assert.equal(syncCount, 0)  // not yet
clock.tick(1)
assert.equal(syncCount, 1)  // debounced to one call
clock.uninstall()
```

### 3. Error Path Coverage Is Thin

Most `catch` blocks in the source are untested. Inject failures:

- `vscode.workspace.fs.readFile` throws → `_syncFile` should swallow and return
- `git apply` exits non-zero → `HunkRouter.routeFile` should return `false` and show an error message
- Config file contains invalid JSON → `ConfigService.load` should fall back to `emptyConfig()`

### 4. `phase45.test.ts` Should Be Renamed or Split

The filename suggests a development phase rather than a module. Its tests should be
distributed into the appropriate per-module test files, or it should be renamed to
reflect what it actually tests (appears to cover `StackResolver` and
`RebaseSuggestionService` interaction).

### 5. Snapshot Tests for Config Migration

`configService.test.ts` tests migration logic procedurally. As the schema evolves, add
snapshot tests: store a JSON fixture for each historical version and assert that
`migrateConfig(v1Fixture)` produces a known-good v2 output. This makes it immediately
obvious when a migration changes its output unexpectedly.

### 6. VS Code API Mocking Is Inconsistent

Some tests import a hand-rolled `vscode` mock; others rely on the test runner providing
one. Centralise the mock in `test/helpers/vscode.ts` and import it everywhere. This
prevents subtle differences in mock behaviour from causing spurious test failures.

---

## Coverage Estimate

Based on code inspection (no coverage tooling was run):

| Layer | Estimated branch coverage |
|---|---|
| Config types and schema | ~85% |
| ConfigService | ~70% |
| DiffEngine / HunkRouter | ~75% |
| WorkspaceSync | ~30% |
| BranchStackService | ~40% (git calls all mocked) |
| UI components | ~5% |
| Extension activation | ~0% |

Running `c8` or `nyc` as part of the test script would make these estimates precise
and allow setting a coverage threshold in CI.
