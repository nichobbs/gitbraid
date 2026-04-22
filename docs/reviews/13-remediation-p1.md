# P1 Remediation — Architecture & Feature Consolidation

**Target release:** 0.2.0
**Goal:** the extension behaves the way `PLAN.md` advertises it.

Everything here assumes the P0 release has landed. Work within this
tier can proceed in parallel except where noted.

---

## ARCH-001: Consolidate the two tree views

**Source:** [01-architecture.md](01-architecture.md#1-two-overlapping-viewcommand-hierarchies) · [05-ui-and-ux.md](05-ui-and-ux.md#two-tree-views-with-divergent-models)
**Severity:** High (UX confusion + state divergence)
**Effort:** L
**Blocks:** UX-002, ARCH-002
**Blocked by:** P0 release

### Root cause
Both `gitbraid.worktreeView` (legacy) and `gitbraid.stackView` (Phase 2)
activate and register overlapping commands. The user cannot tell which
is authoritative; state divergence between the two is possible.

### Proposed fix
1. Designate `gitbraid.stackView` as the authoritative view.
2. Delete `worktreeView.ts` and `WorktreeView`-specific code paths
   (legacy commands in `commands.ts`, `nodeMaps`, `WorktreeNode`,
   `WorktreeRoot`, `WorktreeFile`, `WorktreeFileGroup`, `EmptyFileGroup`).
3. Re-home the still-useful operations onto the stack tree:
   - "Open worktree in new window" → context menu on `BranchNode`.
   - "Lock / unlock worktree" → context menu on `BranchNode`.
   - Ignore `swapWorktrees` (never implemented, drop entirely).
   - Drop `copyToWorktree` / `moveToWorktree` (obsolete under the
     file-assignment model).
4. Update `package.json` `views`, `commands`, `menus`, `viewsWelcome`
   to reflect the single tree.

### Acceptance criteria
- Exactly one GitBraid tree is visible in the SCM view container.
- `rg "WorktreeView|nodeMaps|WorktreeRoot" src/` returns zero results
  outside the (now removed) files.
- All `gitbraid.*` commands remaining in `package.json` map to a
  `vscode.commands.registerCommand` in `extension.ts`.

### Verification
Regression tests for the moved commands.

---

## ARCH-002: Single file-change bus

**Source:** [01-architecture.md](01-architecture.md#4-file-watcher-storm) · [07-performance.md](07-performance.md#1-file-system-watcher-storm)
**Severity:** High (perf + correctness)
**Effort:** M
**Blocks:** PERF-001
**Blocked by:** ARCH-001

### Root cause
Three watchers over `**/*` fire on overlapping events. Every save
triggers `N × (git status)` invocations across branch worktrees.

### Proposed fix
Introduce `src/fileChangeBus.ts`:

```ts
export type FileChangeEvent =
    | { kind: 'saved';   uri: vscode.Uri; relativePath: string }
    | { kind: 'deleted'; uri: vscode.Uri; relativePath: string }
    | { kind: 'created'; uri: vscode.Uri; relativePath: string }
    | { kind: 'gitIndexChanged'; worktreePath: string }

export class FileChangeBus implements vscode.Disposable { … }
```

Consolidate the watchers into a single bus; services subscribe by
`kind`. Debouncing lives in the bus, keyed by `(kind, path)`. Skip
paths under `.worktrees/` centrally.

### Acceptance criteria
- Only two `createFileSystemWatcher` calls in `extension.ts` (one for
  workspace, one for `.git/index`), both owned by the bus.
- Typing and saving a single file triggers **one** downstream sync and
  **one** per-branch SCM refresh for its owning branch only.

### Verification
Add an instrumented test: count `runGit(['status', ...])` invocations
per save.

---

## ARCH-003: Wire `StackResolver` into a `TextDocumentContentProvider`

**Source:** [08-missing-features.md](08-missing-features.md#cumulative-content-resolution-through-the-stack-plan-41)
**Severity:** High (promised in PLAN §4.1, but currently dead code)
**Effort:** M
**Blocks:** FEAT-002
**Blocked by:** P0 release

### Root cause
`StackResolver` is constructed in `extension.ts:155` but its return
values are never read. No scheme is registered, no virtual documents
exist, and the workspace never displays "cumulative top-of-stack"
content.

### Proposed fix
1. Register a `TextDocumentContentProvider` for a new scheme
   `gitbraid-stack`:

   ```ts
   vscode.workspace.registerTextDocumentContentProvider('gitbraid-stack', {
       provideTextDocumentContent: async (uri) => {
           const rel = decodeURIComponent(uri.path).replace(/^\//, '')
           const bytes = await resolver.getResolvedContent(workspaceRoot, rel)
           return bytes ? Buffer.from(bytes).toString('utf8') : ''
       },
   })
   ```

2. Add `gitbraid.viewResolvedFile` command that opens
   `gitbraid-stack:/<relPath>` as a readonly diff against the primary.

3. Expose via stack-tree context menu: "Show cumulative content".

### Acceptance criteria
- Opening `gitbraid.viewResolvedFile` on an assigned file shows
  committed-branch content overlaid with the dirty worktree state.
- Test covers the resolver producing the expected merged content.

### Verification
`test/stackResolver.integration.test.ts`.

---

## ARCH-004: Bidirectional sync

**Source:** [08-missing-features.md](08-missing-features.md#bidirectional-sync-plan-13)
**Severity:** High (primary invariant drift)
**Effort:** M
**Blocks:** —
**Blocked by:** ARCH-002

### Root cause
`WorkspaceSync` only propagates primary → worktree. A `git rebase` or
external tool inside a worktree silently desyncs the primary.

### Proposed fix
1. `FileChangeBus` also watches `.worktrees/**` (excluding internal
   `.git` dirs).
2. On worktree-file change, look up which branch owns the path. If
   that branch matches the file's assignment, copy the worktree content
   back to the primary workspace.
3. Conflict policy: if both sides have diverged since the last sync
   (content hash comparison), raise a notification and leave both files
   untouched.

### Acceptance criteria
- Test: rebase inside `.worktrees/<branch>/` updates the primary file.
- Test: concurrent edit in primary + worktree leaves both unchanged and
  surfaces a conflict message.

### Verification
Integration test; manual verification of `git rebase` flow.

---

## ARCH-005: Eliminate `vscode.lm` dynamic import

**Source:** [01-architecture.md](01-architecture.md#5-circularad-hoc-module-dependencies)
**Severity:** Low
**Effort:** S
**Blocks:** —
**Blocked by:** —

### Root cause
`hunkCodeLensProvider.ts:172` uses a dynamic `await import('./hunkRouter')`.
No cycle exists — this was likely a workaround.

### Proposed fix
Replace with a static import at the top of the file. Construct the
`HunkRouter` once in the `OverlayDiagnostics` constructor rather than
per refresh.

### Acceptance criteria
- `rg "await import" src/` returns zero results.
- Tests pass.

### Verification
Lint rule: forbid top-level dynamic import in `src/`.

---

## FEAT-001: Drag-and-drop reassignment in the stack tree

**Source:** [05-ui-and-ux.md](05-ui-and-ux.md#missing-context-menu-support) · [08-missing-features.md](08-missing-features.md#drag-and-drop-reassignment-plan-23)
**Severity:** High (plan's primary interaction model)
**Effort:** M
**Blocks:** —
**Blocked by:** ARCH-001

### Root cause
`BranchStackTreeProvider` does not implement
`vscode.TreeDragAndDropController`.

### Proposed fix
Extend the provider:

```ts
class BranchStackTreeProvider implements
    vscode.TreeDataProvider<StackTreeNode>,
    vscode.TreeDragAndDropController<StackTreeNode> {

    dropMimeTypes = ['application/vnd.code.tree.gitbraid.stackview']
    dragMimeTypes = ['application/vnd.code.tree.gitbraid.stackview']

    handleDrag(source, dataTransfer) { … }
    handleDrop(target, dataTransfer) { … }
}
```

Support:
- Dragging a `FileNode` onto a `BranchNode` reassigns the file.
- Dragging a `FloatingFileNode` onto a `BranchNode` assigns it.
- Dragging a `BranchNode` onto another `BranchNode` reorders the stack.

### Acceptance criteria
- Test: simulate `handleDrop` with a file source and branch target,
  assert config change.
- Manual smoke: the file icon decoration updates immediately after
  drop.

### Verification
Integration test; UI smoke.

---

## FEAT-002: Stack-wide summary view

**Source:** [08-missing-features.md](08-missing-features.md#stack-wide-commit-summary)
**Severity:** Medium (killer-feature prospect)
**Effort:** L
**Blocks:** —
**Blocked by:** ARCH-003

### Root cause
Nothing aggregates the state of the whole stack.

### Proposed fix
Add a webview or quickpick-backed "Stack Overview" command that shows:
- Each branch, its file count, commits-ahead/behind of parent.
- Floating file count.
- Hunk assignments pending route.
- Buttons: Route all hunks, Rebase child branches, Push stack.

### Acceptance criteria
- Command `gitbraid.showStackSummary` opens the view.
- Values match `MbcApi.getStackStatus()` output.

### Verification
`test/stackSummary.test.ts`.

---

## FEAT-003: Stable hunk identifiers

**Source:** [02-bugs-and-correctness.md](02-bugs-and-correctness.md#hunk-indices-are-fragile-identifiers)
**Severity:** High
**Effort:** M
**Blocks:** —
**Blocked by:** BUG-004

### Root cause
Persistent assignments store hunk indices that drift on any edit.

### Proposed fix
Upgrade `HunkAssignmentMap` to schema v2 (`BUG-004` option 2):
`(header, startLine, endLine, bodyHash) → branch`. Migrate v1 data on
load by computing matching hunks at read time.

### Acceptance criteria
- Existing v1 configs still load.
- Assignments survive a subsequent edit provided the matching hunk is
  still present.
- If the matching hunk disappears, the assignment is dropped with a
  log entry.

### Verification
`test/hunkAssignment.migration.test.ts`.

---

## FEAT-004: Push / sync / rebase stack commands

**Source:** [08-missing-features.md](08-missing-features.md#push-stack--sync-stack)
**Severity:** Medium
**Effort:** M
**Blocks:** —
**Blocked by:** SEC-001

### Root cause
After per-branch commits, users must `git push` each branch manually.

### Proposed fix
Add three commands:
- `gitbraid.pushStack` — iterate stack, `git push --set-upstream origin <branch>`.
- `gitbraid.syncStack` — fetch and update parent tracking; signal
  `RebaseSuggestionService` to re-evaluate.
- `gitbraid.rebaseStack` — in stack order, rebase each child onto its
  parent.

Each command runs inside a progress notification. Failures abort the
remaining steps and surface the failed branch.

### Acceptance criteria
- `pushStack` pushes every branch when behind upstream; no-op when up
  to date.
- `rebaseStack` aborts on the first conflict and points the user at
  the branch to resolve.

### Verification
Integration tests against a disposable bare repo.

---

## FEAT-005: Expand exported API surface

**Source:** [08-missing-features.md](08-missing-features.md#api-surface-gaps)
**Severity:** Medium
**Effort:** S
**Blocks:** FEAT-006
**Blocked by:** —

### Root cause
Missing API methods: `reorderStack`, `routeHunks`, `rebaseBranch`,
`getHunkAssignments`, plus save-time events.

### Proposed fix
Add methods on `MbcApi` delegating to the services, and expose
`onDidSyncFile` / `onDidFloatFile` via the `MbcApi` getter pattern
used for the existing events.

Update `src/@types/GitBraidAPI.d.ts` accordingly; bump the type
`CONFIG_SCHEMA_VERSION` if the JSON shape moves.

### Acceptance criteria
- New `GitBraidExportedAPI` methods are callable from a test harness.
- Event registration/unregistration does not leak disposables
  (tracked via a disposable counter test).

### Verification
Extend `test/mbcApi.test.ts`.

---

## FEAT-006: Symmetrical LM tool set

**Source:** [08-missing-features.md](08-missing-features.md#language-model-tools)
**Severity:** Medium
**Effort:** M
**Blocks:** —
**Blocked by:** PKG-002, FEAT-005

### Root cause
Only the "create" half of each verb pair is exposed as an LM tool.

### Proposed fix
Add LM tools:
- `gitbraid_unassignFile`
- `gitbraid_removeHunkAssignment`
- `gitbraid_removeBranch`
- `gitbraid_reorderStack`
- `gitbraid_rebaseBranch`
- `gitbraid_routeHunks`
- `gitbraid_getStackStatus`

Declare each in `package.json` under `languageModelTools` (PKG-002
scaffolding) with explicit input schemas. Standardise tool names on
`gitbraid_` prefix; keep `mbc_` aliases one release for backwards
compatibility.

### Acceptance criteria
- Copilot Chat lists all 14 tools.
- Each tool has a matching test that calls it via the language-model
  test harness (`vscode.lm.invokeTool` in a unit test).

### Verification
`test/lmTools.test.ts`.

---

## FEAT-007: Dynamic default branch detection

**Source:** [08-missing-features.md](08-missing-features.md#handle-main-being-renamed)
**Severity:** Medium
**Effort:** S
**Blocks:** —
**Blocked by:** SEC-002

### Root cause
`extension.ts:263` hard-codes `'main'` as the default base in the
add-branch QuickPick.

### Proposed fix
Call `git symbolic-ref refs/remotes/origin/HEAD --short` to get the
remote default branch; fall back to `git config init.defaultBranch`;
fall back to `'main'`. Cache the result in `BranchStackService`.

### Acceptance criteria
- In a repo whose default is `master`, the QuickPick lists `master`
  first.

### Verification
Unit test with a mock `runGit`.

---

## UX-001: Finish the branding rollover

**Source:** [05-ui-and-ux.md](05-ui-and-ux.md#scm-panel-naming) · [09-packaging-and-branding.md](09-packaging-and-branding.md#branding-is-half-done)
**Severity:** Medium
**Effort:** S
**Blocks:** —
**Blocked by:** PKG-001

### Root cause
User-visible strings still reference "Multi-Branch Checkout" / "MBC".

### Proposed fix
Text replacements:
- Walkthrough title: "Get Started with GitBraid".
- Configuration section title: "GitBraid".
- Command title: fix "Multie" → "GitBraid: Open file".
- SCM ids/labels: `gitbraid-${branch}` / `GitBraid: ${branch}`.
- LM tool names: `gitbraid_*`.
- Category on every command: `"GitBraid"`.

### Acceptance criteria
- `rg -i "mbc|multi.?branch" src/ package.json README.md` returns only
  historical mentions (changelog, archived docs).

### Verification
Grep-based CI lint.

---

## UX-002: Activity-bar container

**Source:** [09-packaging-and-branding.md](09-packaging-and-branding.md#viewscontainer)
**Severity:** Low
**Effort:** S
**Blocks:** —
**Blocked by:** ARCH-001

### Root cause
Tree views live in the SCM container; discoverability is poor.

### Proposed fix
Add an Activity Bar entry:

```json
"viewsContainers": {
    "activitybar": [
        { "id": "gitbraid", "title": "GitBraid", "icon": "resources/icon.svg" }
    ]
}
```

Move the stack tree under the new container. Keep a proxy entry in the
SCM view for parity.

### Acceptance criteria
- A GitBraid icon appears in the Activity Bar.
- Clicking it focuses the stack tree.

### Verification
Manual.

---

## UX-003: Walkthrough assets

**Source:** [09-packaging-and-branding.md](09-packaging-and-branding.md#walkthrough-assets-missing)
**Severity:** Medium (broken UI on every new install)
**Effort:** S
**Blocks:** —
**Blocked by:** UX-001

### Root cause
`resources/walkthrough-*.png` do not exist.

### Proposed fix
Capture four screenshots (add-branch, assign-file, commit, rebase).
Commit them under `resources/`. Alternatively delete the `media`
fields if images are deferred.

### Acceptance criteria
- Walkthrough renders without broken-image placeholders.

### Verification
Manual smoke.

---

## UX-004: Settings are actually honoured

**Source:** [02-bugs-and-correctness.md](02-bugs-and-correctness.md) (multiple) · [05-ui-and-ux.md](05-ui-and-ux.md)
**Severity:** Medium (false advertising)
**Effort:** S
**Blocks:** —
**Blocked by:** —

### Root cause
`gitbraid.syncDebounceMs`, `gitbraid.showFloatingWarningOnCommit`,
`gitbraid.prDecorationsEnabled`, and `gitbraid.defaultBranchColor` are
declared but not read.

### Proposed fix
Add a thin `WorkspaceSettings` accessor (separate from `ConfigService`
— this is VS Code config, not project config):

```ts
export const workspaceSettings = {
    syncDebounceMs: () =>
        vscode.workspace.getConfiguration('gitbraid').get<number>('syncDebounceMs', 200),
    showFloatingWarningOnCommit: () =>
        vscode.workspace.getConfiguration('gitbraid').get<boolean>('showFloatingWarningOnCommit', true),
    prDecorationsEnabled: () =>
        vscode.workspace.getConfiguration('gitbraid').get<boolean>('prDecorationsEnabled', true),
    defaultBranchColor: () =>
        vscode.workspace.getConfiguration('gitbraid').get<string>('defaultBranchColor', '#4ec9b0'),
}
```

Wire into:
- `WorkspaceSync.DEBOUNCE_MS` → `workspaceSettings.syncDebounceMs()`.
- `BranchScmProviderManager.commitBranch` warning gate.
- `BranchFileDecorationProvider.provideFileDecoration` early-return if
  `prDecorationsEnabled` is false.
- `extension.ts addStackBranch` default color.

React to `onDidChangeConfiguration('gitbraid')` — refresh decorations
when `prDecorationsEnabled` flips.

### Acceptance criteria
- Toggling each setting in VS Code changes behaviour immediately
  without reload.
- Tests assert the setting is queried (stubbed mock) and the default
  preserved.

### Verification
`test/workspaceSettings.test.ts`.
