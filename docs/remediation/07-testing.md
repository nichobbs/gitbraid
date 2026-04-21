# Testing Remediation

---

## T54. Introduce `IGitRunner` seam

**Files:** new `src/gitRunner.ts` (interface + real impl), refactor of
`src/gitFunctions.ts`, `src/diffEngine.ts`, etc. to accept the
interface
**Cross-ref:** `docs/reviews/04-testing.md` §Recommended roadmap,
`docs/reviews/testing.md` §1.

### Fix

```ts
export interface IGitRunner {
    run(args: string[], opts: { cwd: string, input?: string }): Promise<{ stdout: string, stderr: string, exitCode: number }>
}
```

Pass the runner through the services that currently import
`gitFunctions` directly. Default impl wraps `spawn` (from T18).
Tests use a fake impl that records calls and returns canned output.

### Effort

2 days.

---

## T55. Per-suite isolated workspaces

**Files:** every `test/*.test.ts`
**Cross-ref:** `docs/reviews/04-testing.md` §2,
`docs/reviews/testing.md` §6.

### Fix

- Each suite gets its own `os.tmpdir()/gitbraid-<suite>-<random>` dir,
  `git init`-ed in `before()`.
- The existing `wsRoot()` helper returns the per-suite root.
- Remove `test_projects/proj1` dependency; that folder becomes just a
  fixture that tests copy from, never mutate in place.
- Centralise cleanup in a shared `test/helpers/tmpRepo.ts`.

### Effort

2 days.

---

## T56. Integration test folder

**Files:** new `test/integration/*.test.ts`
**Cross-ref:** `docs/reviews/04-testing.md` §1,
`docs/reviews/testing.md` §1.

### Fix

Integration tests use the real `spawn` runner against tmp repos:

- `addBranchToStack.integration.test.ts` — adds a branch, asserts
  `.worktrees/<dir>` exists, `git worktree list` reports it.
- `routeFile.integration.test.ts` — with overlaps, asserts routing
  fails with a user-facing error; without overlaps, asserts each
  branch has the expected hunks.
- `rebaseBranch.integration.test.ts` — rebase succeeds and conflict
  paths both covered.
- `prune.integration.test.ts` — covers T4 (dirty orphan guard).

### Effort

3 days.

---

## T57. Fake-timer tests for `WorkspaceSync` and `RebaseSuggestion*`

**Files:** `test/workspaceSync.debounce.test.ts` (new),
`test/rebaseSuggestion.test.ts` extension
**Cross-ref:** `docs/reviews/04-testing.md` §Flaky,
`docs/reviews/testing.md` §2.

### Fix

Use `@sinonjs/fake-timers` to drive the debounce / interval without
wall-clock sleep.

### Effort

1 day.

---

## T58. Fuzz / negative tests for shell injection

**Files:** new `test/injection.test.ts`
**Cross-ref:** `docs/reviews/04-testing.md` §3,
`docs/reviews/03-security.md`.

### Fix

Covered alongside T18 — list of payloads (`$(...)`, backtick,
semicolon, newline) × every argument surface (branch name, path,
commit message, base ref) asserting no side effect executed and no
silent acceptance.

### Effort

1 day.

---

## T59. Tests for previously uncovered modules

**Files:** `test/commands.*.test.ts`,
`test/branchScmProvider.test.ts`, `test/hunkCodeLensProvider.test.ts`,
`test/extension.activation.test.ts`
**Cross-ref:** `docs/reviews/04-testing.md` §1,
`docs/reviews/testing.md` §"Not Tested at All".

### Fix

Focus on behaviour seams rather than "assert any shape":

- `commands.copyToWorktree`: copy a file, assert target path has
  expected content.
- `commands.stageNode` / `unstageNode`: integration with SCM runner.
- `commands.discardChanges`: see T3 acceptance.
- `branchScmProvider._refreshAll`: add two branches, trigger
  refresh, assert both source controls exist; remove one, assert
  disposed.
- `hunkCodeLensProvider.provideCodeLenses`: document with two
  hunks, one assigned; assert two lenses with the correct commands.
- `extension.activate`: commands registered, no throw on
  empty-folder window.

Remove the three "assert any value is any type" tests flagged in the
numbered review.

### Effort

3 days (parallelisable).

---

## T60. Snapshot tests for config migrations

**Files:** new `test/fixtures/configV1.json`, `configV2.json`, etc.;
`test/configMigration.test.ts`
**Cross-ref:** `docs/reviews/testing.md` §5.

### Fix

Freeze a fixture per historical version; assert `migrateConfig(vN)`
produces a stable known-good `vN+1`.

### Effort

½ day.

---

## T61. Coverage floor and CI workflow

**Files:** `.vscode-test.mjs`, new `.github/workflows/ci.yml`
**Cross-ref:** `docs/reviews/04-testing.md` §10,
`docs/reviews/testing.md` §Coverage Estimate.

### Fix

- Add `--check-coverage --lines 70 --functions 70 --branches 60` to
  the test runner (via `c8` or `nyc`).
- GitHub Actions workflow on push + PR, running on Linux, macOS,
  Windows:
  - `npm ci`
  - `npm run lint`
  - `npm test`
  - `npx vsce package --no-dependencies`
  - Upload coverage as artefact.
- Block merge on coverage regression.

### Effort

1 day.

---

## T62. Tooling housekeeping

**Files:** `.vscode-test.mjs`, `package.json:devDependencies`
**Cross-ref:** `docs/reviews/04-testing.md` §9,
`docs/reviews/09-packaging-and-branding.md`.

### Fix

- Pick one TS loader (`@swc-node/register`) and remove `ts-node`,
  `tsconfig-paths`.
- Remove `mocha-reporter-sonarqube` and `mocha-multi-reporters` (the
  Sonar pipeline was removed — see commit `4519ab4`).
- Collapse reporter list to `['spec']` (plus `json` in CI).

### Effort

¼ day.

---

## Testing exit criteria

- [ ] `npm test` runs green, deterministic, on Linux + macOS +
      Windows.
- [ ] Coverage ≥ 70% lines, 60% branches, enforced in CI.
- [ ] `test/integration/` covers the critical paths.
- [ ] Injection suite is green.
- [ ] No `ok === 'boolean' || undefined` tautological asserts.
