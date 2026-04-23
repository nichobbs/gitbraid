# Outstanding Remediation Work

Most of the 86 tasks (T1–T86) from the original remediation plan have been completed.
This file tracks what remains, grouped by theme. Each item references the original
task number so the original spec (in git history) can be consulted for acceptance
criteria.

## Recently resolved (2026-04-22 wave)

- **T18 (Security)** — `exec` → `spawn` migration completed. `gitFunctions.ts` and
  `Worktree` now exclusively use `IGitRunner` / `child_process.spawn`. Shell-string
  injection surface eliminated. Worktree API redesigned with typed parameters
  (`add(path, branch)`, `addNew(branch, path, base)`); `branchStackService.ts` call
  sites updated.
- **T8 (Correctness)** — Fuzzy-match drift warning is implemented.
  `_reconcileAssignments` fires `showWarningMessage` when a hunk is fuzzy-relocated.
- **T13 (Correctness)** — Bidirectional sync reverse-copy path is implemented and
  now covered by tests (`test/workspaceSync.bidir.test.ts`).
- **T34 (Testing)** — `@typescript-eslint/no-floating-promises` enabled with
  `{ ignoreVoid: true }`.
- **API gap** — `pullBranch` and `syncBranch` are now delegated in `GitBraidApiFacade`.
- **`scratch` branch (UX)** — Documented in README.md, USAGE.md, and the command
  palette description.
- **FileChangeBus `files.watcherExclude` (Performance)** — `_dispatch` now filters
  against the user's `watcherExclude` globs before emitting.
- **T21 (Correctness)** — Lock file (`local-config.json.lock`, opened with `O_EXCL`)
  serialises writes across VS Code windows. Stale locks (>5 s old, e.g. from crashed
  windows) are removed automatically. Lock is released in a `finally` block so a write
  error never leaves the lock dangling. Tests in `configService.test.ts` verify the
  lock is absent after a write and that a stale lock is cleaned up.
- **T58 (Testing)** — Injection test suite added (`test/injection.test.ts`).
  40 parametric tests verify that shell metacharacters in paths, commit messages, and
  branch names flow through `IGitRunner.run()` as verbatim array elements. Fixed
  `Git._runner` to be a dynamic getter (calls `getDefaultGitRunner()` per-call) so
  `setDefaultGitRunnerForTest` works on the module-level singleton.
- **`extension.ts` size (Architecture)** — Reduced from ~1376 to 257 lines by
  extracting all 44 command registrations into `src/commands/` (viewCommands,
  fileCommands, hunkCommands, branchCommands, scmCommands) wired via `CommandDeps`.

---

## Security

*(No open items)*

---

## Correctness

*(No open items)*

---

## UX

### T17 — Drag-and-drop file reassignment

`BranchStackTreeProvider` does not implement `vscode.TreeDragAndDropController`.
File reassignment requires right-click → QuickPick (3 clicks minimum).

**Fix:** Implement DnD on `BranchStackTreeProvider`. Accept `text/uri-list` drops
from the Explorer. Drop onto a `BranchNode` reassigns; drop onto the floating group
unassigns. Branch→Branch drag reorders.

---

## Testing

### Coverage thresholds below the original target

CI enforces 55% lines / 45% branches. The T61 target was 70% / 60%. Coverage should
be raised as new tests are added.

**Fix:** Raise CI thresholds incrementally (60%/50%, then 65%/55%). Priority modules
for new tests: `workspaceSync.ts` (bidirectional path now partially covered),
`gitFunctions.ts` (needs unit tests via `FakeGitRunner` for the migrated methods),
`src/commands/` (command handlers now extracted; unit-testable via CommandDeps).

---

## Tracking

Tasks listed here remain open. When a task is completed, remove it from this file and
add a CHANGELOG entry. The full original task specs (acceptance criteria, effort
estimates) are available in git history under `docs/remediation/01-p0-blockers.md`
through `docs/remediation/10-sequencing.md` at commit `a2579e0` or earlier.
