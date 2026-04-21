# P1 — Correctness and Structural Fixes

These items block a real pilot. Each produces user-visible weirdness
("why is my hunk on the wrong branch?", "why did my save disappear?",
"why are there two branch trees?") even when the P0 items are clean.

---

## T8. Replace numeric hunk indices with stable positional identifiers

**Files:** `src/configService.ts` (assignment storage), `src/diffEngine.ts`
(hunk parsing), `src/hunkRouter.ts` (routing)
**Cross-ref:** `docs/reviews/02-bugs-and-correctness.md` ("Hunk
indices are fragile identifiers").

### Problem

`ConfigService.setHunkAssignment(rel, hunkIndex, branch)` persists
assignments keyed by **current** array index. Any subsequent edit —
even whitespace — reshuffles the hunks, so the persisted index now
points at a different range. The user sees their assignment silently
re-apply to the wrong lines after a save.

### Fix

Replace the numeric index with a positional tuple so reconciliation
can fuzz-match after edits:

```ts
type HunkAssignment = {
    id: string            // stable hash of header+body
    startLine: number     // new-file start line
    endLine: number
    contextHash: string   // sha1 of the 3 lines above + the hunk header
    branch: string
}
```

On `routeFile` the router re-parses the current file's hunks, matches
each assignment by `(id, startLine, endLine, contextHash)` using a
best-effort scorer, and:

- Matches with score ≥ 0.9 apply.
- Matches 0.5–0.9 are flagged in a notification: "3 hunk assignments
  no longer match; review before routing". Offer "Open review" which
  drops the user into a QuickPick.
- No-match: drop silently and log.

Persist a schema migration (`version: 2 → 3`) in `configTypes.ts`.

### Acceptance

- Unit tests for the matcher covering insert-line-above,
  insert-line-below, whitespace-only edit, rename.
- Integration test: assign hunk A to branch X, add a blank line above
  it, run `routeHunks`, assert the patch applied in X matches the
  original hunk content.
- Old configs (version 1/2) migrate cleanly.

### Effort

3 days.

---

## T9. Make `branchToWorktreeDirName` injective

**File:** `src/branchStackService.ts:19-21`
**Cross-ref:** `docs/reviews/02-bugs-and-correctness.md`
("branchToWorktreeDirName is not injective"),
`docs/reviews/bugs.md` B4.

### Problem

```ts
return branchName.replaceAll('/', '-').replaceAll(/[^a-zA-Z0-9._-]/g, '_')
```

`feature/a` and `feature-a` both map to `feature-a`. Two branches in
the stack can silently reuse the same worktree dir, and
`_pruneOrphans` can delete the "wrong" one.

### Fix

Encode a stable short hash suffix:

```ts
function branchToWorktreeDirName(branchName: string): string {
    const slug = branchName
        .replaceAll('/', '-')
        .replaceAll(/[^a-zA-Z0-9._-]/g, '_')
    const hash = crypto.createHash('sha1').update(branchName).digest('hex').slice(0, 7)
    return `${slug}__${hash}`
}
```

And keep a reverse index in `local-config.json`:

```json
"dirIndex": { "feature/a": "feature-a__1a2b3c4", "feature-a": "feature-a__9e8d7c6" }
```

Migrate pre-existing configs: load the legacy dir, detect whether it
matches the new hashed pattern, if not rename it and update the
index.

### Acceptance

- Unit test: two distinct branch names produce distinct dir names.
- Migration test: pre-existing `.worktrees/feature-a` is detected and
  re-keyed without losing its content.
- `_pruneOrphans` consults `dirIndex` before deciding a dir is an
  orphan.

### Effort

2 days.

---

## T10. Collapse the watcher storm into a single file-change bus

**Files:** `src/extension.ts:366-402`, `src/workspaceSync.ts:79-97`,
`src/branchScmProvider.ts:_refreshAll`, `src/worktreeView.ts`
**Cross-ref:** `docs/reviews/01-architecture.md` §4,
`docs/reviews/07-performance.md` §1, `docs/reviews/performance.md` P6.

### Problem

Three watchers with overlapping `**/*` patterns fire per save. Each
save fans out to N × 2 `git status` invocations. The legacy refresh
path does not honour `syncDebounceMs`. In a mono-repo this makes the
extension feel broken — every keystroke burns CPU for a second.

### Fix

1. Introduce `src/fileChangeBus.ts`: a singleton that owns **one**
   `vscode.workspace.createFileSystemWatcher('**/*', …)` and emits
   domain events:
   ```ts
   interface FileChangeBus {
     onDidSavePrimary: Event<vscode.Uri>
     onDidChangeWorktreeIndex: Event<{ worktreeDir: string }>
     onDidChangeWorkspaceTree: Event<void>
   }
   ```
2. Route all downstream consumers (`WorkspaceSync`, `BranchScmProviderManager`,
   `BranchStackTreeProvider`, legacy `WorktreeView`) through the bus.
3. Honour VS Code's `files.watcherExclude` when constructing the
   watcher so `node_modules` / `dist` / `.next` stop churning.
4. Honour `gitbraid.syncDebounceMs` in the bus (default 200 ms) so
   every consumer benefits from a single debounce key.
5. Delete the duplicate watchers in `extension.ts:366-402`.

### Acceptance

- Synthetic test that saves a file and asserts exactly one
  `git status` is spawned per worktree (use a fake git runner — see
  `07-testing.md#T1`).
- Save inside `node_modules/foo/index.js` triggers zero domain
  events.
- Changing `gitbraid.syncDebounceMs` in settings takes effect without
  reload (listen on `onDidChangeConfiguration`).

### Effort

3 days.

---

## T11. Reconcile the two tree views

**Files:** `src/extension.ts`, `src/worktreeView.ts`,
`src/worktreeNodes.ts`, `src/commands.ts`, `src/branchStackTreeProvider.ts`
**Cross-ref:** `docs/reviews/01-architecture.md` §1,
`docs/reviews/05-ui-and-ux.md`, `docs/reviews/architecture.md`
("parallel world").

### Problem

`GitBraid (Worktrees)` and `Branch Stack` both appear in the SCM
container. They have independent state, overlapping commands
(`createWorktree` vs `addStackBranch`), and the legacy one has
explicit `NotImplementedError` stubs (`swapWorktrees`). Users are
confused about which to use.

### Fix

Option A (preferred): **retire the legacy view**. The stack tree
becomes the single source of truth.

1. Delete `worktreeView.ts`, `worktreeNodes.ts`, and the matching
   commands that have no stack-tree equivalent (see dead-code list in
   `09-packaging.md#T42`).
2. Port the useful operations (`lockWorktree`, `launchWindowForWorktree`,
   `copyToWorktree`, `moveToWorktree`) to right-click context on
   `BranchNode` / `FileNode`.
3. Remove `gitbraid.worktreeView` contribution from `package.json`.
4. Remove the commented `patchToWorktree` block from `commands.ts`.

If the team decides to keep both for backward compatibility
(Option B), drive the legacy view from `ConfigService.getStack()`
rather than its own `nodeMaps`. Either way, a user sees exactly one
source of truth.

### Acceptance

- Exactly one tree view in the SCM container (or both views show
  identical branches after any mutation).
- Every command listed in `package.json:contributes.commands` is
  either wired or deleted — no more "Not yet implemented" modals
  reachable from the UI.

### Effort

4 days (Option A) or 2 days (Option B).

---

## T12. Wire `StackResolver.getResolvedContent` to a virtual file scheme

**Files:** `src/stackResolver.ts`, new `src/stackContentProvider.ts`,
`src/extension.ts` activation
**Cross-ref:** `docs/reviews/08-missing-features.md` ("Cumulative
content resolution through the stack"),
`docs/reviews/missing-features.md` F3.

### Problem

`PLAN §4.1` promises the workspace view reflects the cumulative
top-of-stack content. The code for that exists but is **unreferenced**.
Today what you see on disk is the primary worktree's content, which
is **not** the top-of-stack view.

### Fix

1. Register a `TextDocumentContentProvider` for a new scheme
   `gitbraid-stack:` that returns
   `StackResolver.getResolvedContent(relativePath)`.
2. Add a command `gitbraid.openResolvedAtTop` that opens
   `gitbraid-stack:<relativePath>?branch=<top>` in a diff-editor
   alongside the on-disk file, so the user can see what will appear
   on top of the stack.
3. Add a status-bar button "Top of stack view" that opens the current
   file's resolved content in a side-by-side view.

Also add a `gitbraid.compareBranchToBase` command
(`StackResolver.getStackDiff`, not currently exposed) — see
`missing-features.md` F3.

### Acceptance

- Opening `gitbraid-stack:src/foo.ts` returns merged content from all
  branches up to the specified branch.
- Round-trip test: assign hunk A to branch X → resolved content at
  top of stack equals primary + patch A.
- The dead-code review marker is removed from
  `docs/reviews/08-missing-features.md`.

### Effort

3 days.

---

## T13. Implement bidirectional sync (opt-in)

**File:** `src/workspaceSync.ts`
**Cross-ref:** `docs/reviews/08-missing-features.md` ("Bidirectional
sync"), `docs/reviews/missing-features.md` F2.

### Problem

Changes made inside `.worktrees/<branch>/` (e.g. from terminal
commands, rebases, external editors) are not propagated back to the
primary workspace. The "workspace always reflects top-of-stack"
invariant breaks as soon as the user touches a worktree directly.

### Fix

1. Add a second watcher scoped to `.worktrees/*/**` that fires
   `onDidChangeWorktreeFile(branch, relativePath)` through the file
   change bus.
2. On that event, if the file is assigned to `branch`, copy its
   content **back** to the primary workspace (honouring the same
   debounce + `_syncing` re-entrancy guard — see T14).
3. Add a setting `gitbraid.bidirectionalSync` (default `true` once the
   feature is stable; `false` in 0.1) with a doc note about loop
   safety.
4. Detect and break sync loops with a generation counter per file:
   every primary-originated write bumps generation, worktree-originated
   writes are accepted only if their generation ≤ current primary
   generation.

### Acceptance

- Edit `file.ts` inside a worktree (simulated via `fs.writeFile`) →
  after debounce, primary workspace has updated content.
- Edit primary file → only the worktree content changes (no bounce
  back).
- 100 rapid alternating edits do not loop.

### Effort

3 days.

---

## T14. Defer, don't drop, saves that arrive during a sync

**File:** `src/workspaceSync.ts:_onChanged`
**Cross-ref:** `docs/reviews/bugs.md` B1/B2.

### Problem

When `_syncing === true`, `_onChanged` returns early. The event is
lost; the save never reaches the debounce queue. Users who type fast
during a running sync see their latest change silently skipped.

### Fix

```ts
if (this._syncing) {
    // Defer to the next debounce window so the event isn't lost.
    setTimeout(() => this._onChanged(uri), DEBOUNCE_MS)
    return
}
```

Additionally, make `_syncFile`'s `catch (SyncError)` surface to the
user (notification with "Open Output") rather than dying silently
inside the debounce timer.

### Acceptance

- Test spins up a sync that takes 500 ms, fires a second save at 100
  ms, and asserts the second save is processed after the first
  finishes.
- `_syncFile` throw path is covered and shows a notification.

### Effort

½ day.

---

## T15. Declare the LM tools in `package.json`

**File:** `package.json` (add `contributes.languageModelTools`),
`src/lmTools.ts`
**Cross-ref:** `docs/reviews/08-missing-features.md` ("language-model
tools"), `docs/reviews/09-packaging-and-branding.md`.

### Problem

Seven `vscode.lm.registerTool(...)` calls exist, but the matching
`contributes.languageModelTools` entries are absent. Copilot Chat
discovers tools from the manifest, not from runtime registrations —
so the tools are effectively invisible today.

### Fix

Add entries for each tool in `package.json`:

```json
{
    "name": "mbc_getStack",
    "displayName": "Get Branch Stack",
    "description": "Returns the current branch stack and file assignments.",
    "canBeReferencedInPrompt": true,
    "toolReferenceName": "getStack",
    "inputSchema": { "type": "object", "properties": {}, "required": [] }
}
```

Cover the seven existing tools plus the gaps listed in
`docs/reviews/08-missing-features.md#language-model-tools`:
`mbc_routeHunks`, `mbc_removeBranch`, `mbc_reorderStack`,
`mbc_rebaseBranch`, `mbc_unassignFile`, `mbc_removeHunkAssignment`,
`mbc_getStackStatus`.

If we rename `mbc_` → `gitbraid_` as part of the branding sweep
(`09-packaging.md#T40`), do it in the same PR so there is never a
mid-state where Copilot has a mismatched id.

### Acceptance

- `vsce package` produces a manifest that lists all declared tools.
- Opening Copilot Chat and typing `@gitbraid` shows the tools.
- Each tool has an `inputSchema` with correct typing (string, enum,
  array, etc. — no `any` fallbacks).

### Effort

1 day.

---

## T16. Ship walkthrough assets and fix the branding copy

**Files:** `resources/walkthrough-add-branch.png`,
`resources/walkthrough-assign-file.png`,
`resources/walkthrough-commit.png`,
`resources/walkthrough-rebase.png`, `package.json:walkthroughs.title`
and step copy, `configuration.title`, SCM group names
**Cross-ref:** `docs/reviews/05-ui-and-ux.md`,
`docs/reviews/09-packaging-and-branding.md`.

### Problem

- Walkthrough references four PNGs that do not exist; each step shows
  a broken image.
- Walkthrough title: `"Get Started with Multi-Branch Checkout"`.
- `configuration.title: "Multi-Branch Checkout"`.
- Command: `"Multie Branch Checkout: Open file"` (typo + old brand).
- SCM groups: `"MBC: <branch>"`.
- `viewsWelcome` content on the legacy worktree tree:
  `"This is welcome content!"` placeholder.

### Fix

1. Capture the four walkthrough screenshots against a clean
   `test_projects/proj1` fixture and commit to `resources/`.
2. Global rename to **GitBraid** across walkthrough, configuration
   title, command titles, SCM group names and ids.
3. Fix `"Multie"` → `"GitBraid: Open file"`.
4. Replace `"This is welcome content!"` with real copy ("No branches
   in your stack yet. [Add branch](command:gitbraid.addStackBranch).").

### Acceptance

- Walkthrough renders without broken images on a clean VS Code
  profile.
- `git grep MBC` returns no code results; `git grep "Multi Branch"`
  returns no user-visible strings.
- SCM groups render `GitBraid: <branch>` after rebuild.

### Effort

1 day.

---

## T17. Implement drag-and-drop reassignment on the stack tree

**Files:** `src/branchStackTreeProvider.ts`, new
`src/stackTreeDnD.ts`
**Cross-ref:** `docs/reviews/05-ui-and-ux.md`, `docs/reviews/08-missing-features.md`,
`PLAN §2.3`.

### Problem

The primary interaction model promised by the plan is drag a file
between branch nodes. Today the only path is right-click → QuickPick
— usable but friction-heavy, and "three clicks to assign a file" is
cited by pilot users as a blocker.

### Fix

1. Implement `vscode.TreeDragAndDropController` on
   `BranchStackTreeProvider`:
   - `dropMimeTypes = ['application/vnd.code.tree.gitbraidStack']`
   - `dragMimeTypes = ['text/uri-list', 'application/vnd.code.tree.gitbraidStack']`
   - On drop onto a `BranchNode`: reassign each dragged `FileNode` to
     that branch via `ConfigService.setAssignment`.
   - On drop onto the `FloatingGroupNode`: unassign.
2. Accept drops from the Explorer (`text/uri-list`) so the user can
   drop a file from anywhere in VS Code.
3. Implement `BranchNode` → `BranchNode` drops as reorder via
   `ConfigService.reorderStack`.

### Acceptance

- Manual: drag a `FileNode` to another branch, assignment flips, SCM
  and decorations update.
- Unit test on the DnD controller using a fake `DataTransfer`.

### Effort

2 days.

---

## P1 exit criteria

- [ ] T8–T17 merged with tests.
- [ ] All dead-code removals (legacy view, commented blocks) land in
      T11.
- [ ] `docs/reviews/08-missing-features.md` has annotations showing
      F1 (overlap wiring), F2 (bidirectional), F3 (stack diff) closed.
- [ ] Pilot smoke test: open repo → add 3 branches → assign 10 files
      → make 20 edits → commit each branch → no unexpected popups, no
      wrong-branch hunks.
