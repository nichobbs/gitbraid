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

---

## Security

*(No open items)*

---

## Correctness

### T21 — Config concurrent-write protection

Two VS Code windows open on the same repository both write
`.worktrees/local-config.json` without awareness of each other. The mtime-based
conflict detection in `ConfigService._writeToDisk` has a narrow race: if two windows
both pass the pre-write mtime check before either renames its temp file, the second
rename silently overwrites the first.

**Status:** mtime detection and retry loop are in place and handle the common case.
The narrow TOCTOU window (between `statSync` and `rename`) requires a lock file or an
OS-level exclusive open (`O_EXCL`) for a fully correct solution. Low-priority given
the millisecond-scale window and the retry loop's merge-and-recover behaviour.

**Fix:** Implement a `.lock` file using `O_EXCL` to serialise writers across windows,
or use the Node.js `lockfile` pattern. Up to 3 retries, then surface a `ConfigError`.

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

### T58 — Injection test suite

Now that T18 is complete (full spawn migration), an injection test suite should
verify that branch-name, path, and commit-message payloads containing shell
metacharacters (`$(...)`, backtick, `;`, `|`) flow through `IGitRunner` as safe
arg arrays and do not cause side effects.

**Fix:** Add `test/injection.test.ts` using `FakeGitRunner`. Assert that the args
array passed to `runner.run()` contains the metacharacter as a literal string element,
not split across a shell-interpreted command.

### Coverage thresholds below the original target

CI enforces 55% lines / 45% branches. The T61 target was 70% / 60%. Coverage should
be raised as new tests are added.

**Fix:** Raise CI thresholds incrementally (60%/50%, then 65%/55%). Priority modules
for new tests: `workspaceSync.ts` (bidirectional path now partially covered),
`gitFunctions.ts` (needs unit tests via `FakeGitRunner` for the migrated methods),
`extension.ts` (command handlers once extracted to `src/commands/`).

---

## Architecture

### `extension.ts` still too large (~1376 lines)

Despite `FolderRegistry`/`FolderContext` extraction, the activation file still manages
command registration, SCM wiring, CodeLens, `.gitignore` stamping, and UI setup inline.
Splitting into focused activator modules (commands, scm, ui, watchers) would make the
file navigable.

This is low-urgency but has a real maintenance cost every time a new command or service
is added.

---

## Tracking

Tasks listed here remain open. When a task is completed, remove it from this file and
add a CHANGELOG entry. The full original task specs (acceptance criteria, effort
estimates) are available in git history under `docs/remediation/01-p0-blockers.md`
through `docs/remediation/10-sequencing.md` at commit `a2579e0` or earlier.
