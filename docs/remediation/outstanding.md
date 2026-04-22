# Outstanding Remediation Work

Most of the 86 tasks (T1–T86) from the original remediation plan have been completed.
This file tracks what remains, grouped by theme. Each item references the original
task number so the original spec (in git history) can be consulted for acceptance
criteria.

---

## Security

### T18 — Complete `exec` → `spawn` migration in `gitFunctions.ts` and `hunkRouter.ts`

`ProcessGitRunner` (with `shell: false`) was introduced in `src/gitRunner.ts` and is
used by all *new* code (RebaseRecovery, StackCommands, PRAwareness). However the
original `gitFunctions.ts` still opens with:

```ts
const exec = util.promisify(child_process.exec)
```

and builds command strings via template literals (~7 call sites: branch listing,
fetch, push, status, log, etc.). `hunkRouter.ts` also imports `exec` for `git apply`.

**Fix:** Migrate each caller to `IGitRunner.run(args, {cwd})`. Once complete, delete
the `exec` import and the remaining `_sanitise`/`safe` helpers.

**Acceptance:** `grep -R "child_process.exec" src/` returns zero results.

---

## Correctness

### T8 — Hunk reconciler drift warnings

`_reconcileAssignments` in `hunkRouter.ts` matches assignments by bodyHash (exact)
then falls back to direct index. The "0.5–0.9 score" warning path from the original
spec (notify user when an assignment drifted but wasn't dropped) is not implemented.
Assignments that drift beyond the fuzzy threshold are silently dropped with a
`log.warn` that the user never sees.

**Fix:** When a reconciled assignment has no exact hash match, surface a notification:
*"N hunk assignments for `{file}` may have drifted — review before routing."* Include
an "Open file" action.

### T13 — Bidirectional sync (worktree → primary)

`gitbraid.bidirectionalSync` is read from settings and stored in `WorkspaceSync`, but
the worktree→primary copy path (watching `.worktrees/*/**` and reflecting changes back)
is not implemented. Changes that enter a worktree via rebase, terminal edits, or
external tools do not propagate to the primary workspace, breaking the cumulative-view
invariant.

**Fix:** Add a second watcher scoped to `.worktrees/*/**` through the FileChangeBus
`onDidChangeWorktree` event, gate it behind `bidirectionalSync`, and copy the file
back to the primary workspace when the worktree matches the assignment map.

### T21 — Config concurrent-write protection

Two VS Code windows open on the same repository both write
`.worktrees/local-config.json` without awareness of each other. The CHANGELOG notes
"mtime-based concurrent-write detection" but `ConfigService._writeToDisk` does not
currently re-stat before writing.

**Fix:** On each write, stat the file; if mtime differs from the last-read mtime,
reload + re-apply the in-memory delta before writing. Up to 3 retries, then surface
a `ConfigError`.

---

## UX

### T17 — Drag-and-drop file reassignment

`BranchStackTreeProvider` does not implement `vscode.TreeDragAndDropController`.
File reassignment requires right-click → QuickPick (3 clicks minimum).

**Fix:** Implement DnD on `BranchStackTreeProvider`. Accept `text/uri-list` drops
from the Explorer. Drop onto a `BranchNode` reassigns; drop onto the floating group
unassigns. Branch→Branch drag reorders.

### API gap — `pullBranch` / `syncBranch` missing from facade

`GitBraidExportedAPI` declares `pullBranch(branch)` and `syncBranch(branch)` but
`GitBraidApiFacade` does not delegate them, so callers receive a runtime error or
`undefined` (TypeScript allows it because both are on the interface). Add the two
delegating methods to `gitBraidApiFacade.ts`.

### `scratch` branch type undocumented

`BranchStackEntry.scratch` exists in `configTypes.ts` and the SCM provider has
special-casing for it, but no command creates scratch branches and the field is
absent from README and USAGE.md. Either expose it (via an opt-in flag in
`addStackBranch`) or remove it if it is not yet ready.

---

## Performance

### FileChangeBus does not honour `files.watcherExclude`

`FileChangeBus` creates a `**/*` watcher without consulting
`vscode.workspace.getConfiguration('files').get('watcherExclude')`. In repositories
with large `node_modules/`, `dist/`, or `.next/` directories this generates constant
spurious change events that fan out to every consumer (WorkspaceSync, SCM refresh,
decorations).

**Fix:** Read `files.watcherExclude` at construction and pass matching patterns to
`vscode.workspace.createFileSystemWatcher`'s `ignoreChangeEvents` / `ignoreCreateEvents`
where the API allows, or filter in `_dispatch`.

### T51 — `_floatingDirty` not pruned on file delete

`WorkspaceSync._floatingDirty` is a `Set<string>` that grows on every floating save
but is never pruned when a file is deleted. Subscribe to `FileChangeBus.onDidDeletePrimary`
and remove the entry.

---

## Testing

### T34 — Enable `@typescript-eslint/no-floating-promises`

`.eslintrc.json` does not include `@typescript-eslint/no-floating-promises`. Several
`void fn()` call sites in command handlers would be caught and converted to explicit
`await` or documented-`void`.

**Fix:** Add the rule, set `{ ignoreIIFE: true }`, fix violations. Gate in CI.

### T58 — Injection test suite

No `test/injection.test.ts` exists despite T18's partial migration. At minimum, add
tests that pass branch-name, path, and commit-message payloads with shell metacharacters
(`$(...)`, backtick, `;`, `|`) through the `ProcessGitRunner` path and assert no side
effect is executed.

### Coverage thresholds below the original target

CI enforces 55% lines / 45% branches. The T61 target was 70% / 60%. Coverage should
be raised as new tests are added for the items above.

---

## Architecture

### `extension.ts` still too large (1376 lines)

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
