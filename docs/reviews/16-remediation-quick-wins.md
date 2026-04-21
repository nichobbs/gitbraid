# Remediation — Quick Wins

Items completable in **≤ 1 day each**, parallelisable, low risk. Pick
them off opportunistically between larger P0/P1 items.

Each row includes: ID, title, source, effort in hours, proposed fix in
one or two lines.

---

## QW-001: Remove `viewsWelcome` placeholder

- **Source:** [05-ui-and-ux.md](05-ui-and-ux.md#two-tree-views-with-divergent-models)
- **Effort:** 0.25 h
- **Fix:** Replace `"This is welcome content!"` with real copy in
  `package.json`, or remove the `viewsWelcome` block entirely (the
  view only shows when empty anyway). Consider linking to the
  walkthrough via `command:gitbraid.getStarted`.

---

## QW-002: Fix "Multie Branch Checkout" typo

- **Source:** [02-bugs-and-correctness.md](02-bugs-and-correctness.md#command-id-typos) · [09-packaging-and-branding.md](09-packaging-and-branding.md#branding-is-half-done)
- **Effort:** 0.25 h
- **Fix:** `package.json:175` — `"Multie Branch Checkout: Open file"` →
  `"GitBraid: Open file"`. Part of UX-001 but trivial as a standalone
  fix.

---

## QW-003: Fix `isPrumary` typo in `when` clause

- **Source:** [02-bugs-and-correctness.md](02-bugs-and-correctness.md#command-id-typos)
- **Effort:** 0.25 h
- **Fix:** `package.json:295` — `isPrumary=true` → `primary=true` (note:
  matching the actual context value in `worktreeNodes.ts:497`).
  Obsoleted by ARCH-001 once the legacy view is removed, but worth
  landing before then so the action is usable.

---

## QW-004: Delete dead `patchToWorktree` registration

- **Source:** [01-architecture.md](01-architecture.md#3-extensionts-is-a-460-line-activate-function)
- **Effort:** 0.5 h
- **Fix:** Remove the `gitbraid.patchToWorktree` command declaration
  and its menu entry in `package.json`; delete the commented
  `command_patchToWorktree` block at `commands.ts:10-107`.

---

## QW-005: Hide `FloatingStatusBarItem` when stack is empty

- **Source:** [05-ui-and-ux.md](05-ui-and-ux.md#status-bar)
- **Effort:** 0.5 h
- **Fix:** In `FloatingStatusBarItem._update`, call `this._item.hide()`
  when `config.getStack().length === 0`.

---

## QW-006: Remove unused error classes

- **Source:** [06-error-handling-and-logging.md](06-error-handling-and-logging.md#typed-errors-are-defined-but-not-used-consistently)
- **Effort:** 0.5 h
- **Fix:** Delete `FileGroupError`, `WorktreeParentError`,
  `UpdateTreeError` from `errors.ts`. Drop their tests if any.

---

## QW-007: Swap `fs.readFileSync` → `fs.promises.readFile`

- **Source:** [07-performance.md](07-performance.md#8-configservice_writetodisk-is-sync)
- **Effort:** 0.5 h
- **Fix:** `ConfigService._readFromDisk` uses `fs.readFileSync`;
  switch to the async variant. Similar in `_writeToDisk` → batch with
  a 50ms debounce if there's appetite.

---

## QW-008: Drop the duplicate `mocha-reporter-sonarqube` dep

- **Source:** [09-packaging-and-branding.md](09-packaging-and-branding.md#devdependencies-audit)
- **Effort:** 0.25 h
- **Fix:** Commit `4519ab4` already removed the Sonar infra. Remove
  `mocha-reporter-sonarqube`, `mocha-multi-reporters` from
  `package.json` and the related `mochaOpts.reporter` block from
  `.vscode-test.mjs`.

---

## QW-009: Pick one TS loader

- **Source:** [09-packaging-and-branding.md](09-packaging-and-branding.md#devdependencies-audit)
- **Effort:** 0.5 h
- **Fix:** `devDependencies` ships both `@swc-node/register` and
  `ts-node`. The test harness only uses `@swc-node/register`; remove
  `ts-node` and `tsconfig-paths` (latter has no `paths` to resolve).

---

## QW-010: Fix `git.show` temp path

- **Source:** [03-security.md](03-security.md#temporary-file-writes-without-sanitisation)
- **Effort:** 0.5 h
- **Fix:** `gitFunctions.ts:295` — replace `.replace('/', '_')` (single-
  occurrence replace) with `.replaceAll('/', '_')` so nested paths
  don't create arbitrary subdirs in the temp dir.

---

## QW-011: Single `.gitignore` writer

- **Source:** [03-security.md](03-security.md#gitignore-injection) · [02-bugs-and-correctness.md](02-bugs-and-correctness.md#extension-ts458-writes-a-utf-8-encoded-bom-less-gitignore)
- **Effort:** 1 h
- **Fix:** Delete `extension.ts:442-459` `ignoreWorktreesDir`. Let
  `ConfigService._ensureGitignore` own the write. Update tests.

---

## QW-012: Drop `nodeMaps.tree.pop()` special case

- **Source:** [02-bugs-and-correctness.md](02-bugs-and-correctness.md#nodemapstreepop-removes-the-only-root-when-exactly-one-worktree-exists)
- **Effort:** 0.25 h
- **Fix:** Remove the `if (nodeMaps.tree.length == 1) { nodeMaps.tree.pop() }`
  block in `worktreeView.ts`. Obsoleted by ARCH-001; land it sooner
  so subsequent code doesn't crash while waiting for the rewrite.

---

## QW-013: Guard `getAllNodes` logging

- **Source:** [07-performance.md](07-performance.md#3-nodemapsgetallnodes-is-on-with-aggressive-logging)
- **Effort:** 0.25 h
- **Fix:** Demote the three `log.info('node.id=' + …)` calls in
  `worktreeNodes.ts:28-45` to `log.trace`, or delete outright if
  debugging hasn't needed them.

---

## QW-014: Strip leading `197 ` / `200 ` debug numbers

- **Source:** [01-architecture.md](01-architecture.md#3-extensionts-is-a-460-line-activate-function)
- **Effort:** 0.25 h
- **Fix:** `extension.ts` has artefacts like `log.info('197 ' + …)` and
  `log.info('200.1')` — scratch numbers from a debugging session.
  Remove.

---

## QW-015: Replace `vscode.workspace.workspaceFolders![0].uri` repeats

- **Source:** [02-bugs-and-correctness.md](02-bugs-and-correctness.md#workspace-root-assumptions-scattered-throughout)
- **Effort:** 1 h
- **Fix:** Add a helper `getWorkspaceRoot(): vscode.Uri`
  in `utils.ts` and replace the ~20 inline usages. Keeps the
  non-null-assertion in one place and makes multi-root refactor
  (RM-005) easier later.

---

## QW-016: `FloatingGroupNode` identity stability

- **Source:** [02-bugs-and-correctness.md](02-bugs-and-correctness.md#tree-view-floatinggroupnode-is-always-re-created)
- **Effort:** 0.5 h
- **Fix:** In `BranchStackTreeProvider.getChildren(undefined)`, cache
  the `FloatingGroupNode` instance on the provider and mutate its
  `description` instead of recreating. Prevents expand/collapse
  flicker.

---

## QW-017: Shorten `remoteDebounce` for branch search

- **Source:** [05-ui-and-ux.md](05-ui-and-ux.md#quickpick-flow-in-gitbraidaddstackbranch)
- **Effort:** 0.5 h
- **Fix:** Reduce `300ms` → `150ms` and guard against double-dispose in
  `onDidHide`/`onDidAccept`. Trivial ergonomic improvement.

---

## QW-018: Distinguish "local", "remote", "new" in add-branch QuickPick

- **Source:** [05-ui-and-ux.md](05-ui-and-ux.md#quickpick-flow-in-gitbraidaddstackbranch)
- **Effort:** 1 h
- **Fix:** Swap `description` strings for `iconPath` + a leading label
  badge (e.g. a `$(git-branch)` icon for local, `$(cloud)` for remote,
  `$(add)` for new). Reuse VS Code's themable icons.

---

## QW-019: Narrow `.worktrees` path check

- **Source:** [05-ui-and-ux.md](05-ui-and-ux.md#hunk-codelens-ux)
- **Effort:** 0.25 h
- **Fix:** `hunkCodeLensProvider.ts:58` uses `fsPath.includes('.worktrees')`
  — substring match. Replace with a path-boundary check, e.g.
  `uri.path.split('/').includes('.worktrees')`.

---

## QW-020: Rename `listBranches` remote stripping

- **Source:** [02-bugs-and-correctness.md](02-bugs-and-correctness.md#git-branch-listing-parses-remote-names-wrongly)
- **Effort:** 0.5 h
- **Fix:** `gitFunctions.ts:252` — replace `/^[^/]+\//` with
  `/^origin\//` (or make it configurable). Document that multiple
  remotes with overlapping names are not yet supported and file
  RM-012 for follow-up.

---

## QW-021: Demote verbose activation logs

- **Source:** [07-performance.md](07-performance.md#startup) · [06-error-handling-and-logging.md](06-error-handling-and-logging.md)
- **Effort:** 0.25 h
- **Fix:** `log.info('subscribe')`, `log.info('register worktreeView')`,
  `log.info('register filewatcher')` etc. → `log.trace`.

---

## QW-022: `npm run build` / `npm run compile` alias

- **Source:** [09-packaging-and-branding.md](09-packaging-and-branding.md#scripts)
- **Effort:** 0.25 h
- **Fix:** Collapse both to the same script or alias one:
  `"compile": "npm run build"`.

---

## QW-023: Add `gitbraid.getStarted` command

- **Source:** Inferred — the walkthrough links to individual commands
  but there's no top-level "Show walkthrough" command.
- **Effort:** 0.5 h
- **Fix:** Register `gitbraid.getStarted` that invokes
  `workbench.action.openWalkthrough` with the walkthrough id.

---

## QW-024: Remove the 2s timeout in `waitForDidChangeTreeData`

- **Source:** [02-bugs-and-correctness.md](02-bugs-and-correctness.md#worktreeviewts-has-a-2-second-hard-timeout)
- **Effort:** 0.25 h
- **Fix:** Drop or extend to 10s. Obsoleted by ARCH-001 — touch only
  if ARCH-001 is not landed soon.

---

## QW-025: `--no-gpg-sign` for commit tests

- **Source:** Inferred (test files show `--no-gpg-sign` passed as
  second arg to `git.commit`).
- **Effort:** 0.5 h
- **Fix:** `git.commit(message, args, repoRoot)` signature is awkward
  — `args` is a string appended to the command. In SEC-001 migration,
  change to `git.commit({ message, opts: { noGpgSign: true } })` and
  update tests.

---

## Table view

| ID | Title | Hours |
| --- | --- | --- |
| QW-001 | Welcome placeholder | 0.25 |
| QW-002 | "Multie" typo | 0.25 |
| QW-003 | `isPrumary` typo | 0.25 |
| QW-004 | Dead `patchToWorktree` | 0.5 |
| QW-005 | Hide status-bar when empty | 0.5 |
| QW-006 | Unused errors | 0.5 |
| QW-007 | `readFileSync` → async | 0.5 |
| QW-008 | Drop Sonar deps | 0.25 |
| QW-009 | Pick one TS loader | 0.5 |
| QW-010 | `git.show` path slash | 0.5 |
| QW-011 | Single `.gitignore` writer | 1.0 |
| QW-012 | `nodeMaps.tree.pop()` | 0.25 |
| QW-013 | Log spam in `getAllNodes` | 0.25 |
| QW-014 | Strip debug numbers | 0.25 |
| QW-015 | `getWorkspaceRoot()` helper | 1.0 |
| QW-016 | `FloatingGroupNode` identity | 0.5 |
| QW-017 | Shorten remote debounce | 0.5 |
| QW-018 | QuickPick icons | 1.0 |
| QW-019 | Narrow `.worktrees` check | 0.25 |
| QW-020 | Remote branch stripping | 0.5 |
| QW-021 | Demote activation logs | 0.25 |
| QW-022 | Build/compile alias | 0.25 |
| QW-023 | `getStarted` command | 0.5 |
| QW-024 | 2s tree timeout | 0.25 |
| QW-025 | Commit signature cleanup | 0.5 |
| **Total** | | **~11 h** |

Roughly a day and a half of focused effort delivers 25 observable
improvements. Good candidates for an intern sprint or a "janitor week"
between P0 and P1.
