# Feature Suggestions

Ideas for improving GitBraid's user experience and extending its capabilities.
Each item includes the user problem it solves, the proposed approach, existing
hooks to build on, and rough effort / impact ratings.

Effort: **S** = < 1 day · **M** = 1–3 days · **L** = 1–2 weeks · **XL** = > 2 weeks  
Impact: **Low** · **Medium** · **High**

---

## 1. Conflict-free routing preview

**Problem:** Users are nervous about running "Route Hunks" because they can't see
what will change before it happens. When a routing fails midway, the worktrees can
be left in an inconsistent state.

**Proposal:** Add a `gitbraid.previewRouting` command that opens a diff editor showing
what each worktree *would* look like after routing — without writing anything. A
"Apply routing" button in the diff confirms.

**Existing hooks:** `StackResolver.getResolvedContent` already synthesises what a
file should look like at a given stack level. `HunkRouter._buildPatch` is pure (no
side effects) and can be called to generate the preview patch.

**Effort:** M · **Impact:** High

---

## 2. PR-ready cumulative diff view

**Problem:** When preparing a PR, developers want to see exactly what reviewers will
see — the cumulative diff of all commits on a branch relative to its base. Today
there is no way to get this view without switching branches.

**Proposal:** Add a `gitbraid.openStackDiff` command that opens VS Code's diff editor
with the cumulative changes from a branch's base to its tip. `StackResolver.getStackDiff`
already exists and is tested but is not exposed in the UI.

**Existing hooks:** `src/stackResolver.ts` (`getStackDiff`), `src/stackContentProvider.ts`
(already registers the `gitbraid-stack://` URI scheme).

**Effort:** S · **Impact:** High

---

## 3. Smart auto-assign on new file creation

**Problem:** When a developer creates a new file and saves it, it appears as floating.
They have to manually assign it. Files in `src/auth/` are almost certainly related to
the `feature/auth` branch but the user still has to make that explicit every time.

**Proposal:** When a new file is first saved floating, inspect the assignment map for
sibling files in the same directory. If all siblings belong to a single branch,
automatically suggest that branch (not assign — always ask, never do it silently).
Show a non-intrusive notification: *"New file `auth/token.ts` — assign to `feature/auth`?"*
with **Assign** / **Later** actions.

**Existing hooks:** `ConfigService.getAssignmentMap()` provides the full map.
`FileChangeBus.onDidSavePrimary` is the trigger. `WorkspaceSync` already checks for
floating status on each save.

**Effort:** M · **Impact:** High

---

## 4. Commit message templates per branch

**Problem:** Stacked-PR workflows often have commit conventions tied to branch names
(e.g., every commit on `fix/JIRA-123` should have `[JIRA-123]` in the message).
Users currently type this prefix manually every time.

**Proposal:** Allow a per-branch `commitTemplate` in the config (in
`.worktrees/local-config.json` and exposed via `addBranch` options). The SCM commit
input box pre-populates with the template. Template variables: `{branch}` (full
branch name), `{issue}` (first match of `[A-Z]+-\d+` in the branch name),
`{scope}` (last path segment after `/`).

**Existing hooks:** `BranchStackEntry` already has extensible fields.
`BranchScmProviderManager` controls the input-box state and could call
`inputBox.value = template` when a new commit message input is shown.

**Effort:** M · **Impact:** Medium

---

## 5. Worktree health dashboard

**Problem:** When managing a 5-branch stack, it's hard to get a quick answer to
"which branches are behind upstream, which have dirty worktrees, and which have
a rebase in progress?" The tree view shows per-file status but not branch health
at a glance.

**Proposal:** Add a summary row per branch in the stack view showing: ahead/behind
counts (e.g. `↑2 ↓1`), a dirty indicator (⦿), and a ⚠ badge if a rebase is
in-progress. This replaces the current "no status" blank space between branch names.

**Existing hooks:** `RebaseSuggestionService` already queries ahead/behind counts.
`RebaseRecovery.getState(worktreeDir)` returns `'in-progress'`. These can be surfaced
via `BranchStackTreeProvider` tree item descriptions and icon decorations.

**Effort:** M · **Impact:** High

---

## 6. Stack diagram export / clipboard

**Problem:** When raising a PR, it's helpful to include a diagram of the stack in the
description so reviewers understand which branches depend on which. Creating this
manually is tedious.

**Proposal:** Add a `gitbraid.copyStackDiagram` command that copies a Mermaid or
ASCII tree to the clipboard. Example:

```
main
  └── feature/auth        [↑3] PR #42 ✓
        └── feature/token [↑1] (no PR)
```

Include branch name, ahead-count, and PR status if `prDecorationsEnabled` is true.
Also add an LM tool `gitbraid_getStackDiagram` so AI assistants can include it in
generated PR descriptions automatically.

**Existing hooks:** `ConfigService.getStack()` provides the ordered list with base
relationships. `PRAwareness` provides PR numbers and status.

**Effort:** S · **Impact:** Medium

---

## 7. MCP server for AI tool access

**Problem:** The 7 existing VS Code LM tools work only inside Copilot Chat within VS
Code. Developers using Claude, Cursor Agent, or other AI tools outside the VS Code
LM context cannot manipulate the GitBraid stack programmatically.

**Proposal:** Implement the MCP server design already documented in
`docs/adr/0001-mcp-server.md`. Run as a sidecar process (stdio or TCP) that exposes
the same 7 core tools as MCP tool calls. The extension spawns the server on activation
and shuts it down on deactivate.

**Existing hooks:** `GitBraidExportedAPI` provides the full mutating surface.
`docs/adr/0001-mcp-server.md` has a detailed design with security model.

**Effort:** L · **Impact:** High (unlocks Claude, Cursor, and any other MCP client)

---

## 8. Named stack checkpoints

**Problem:** Before a risky rebase or large re-assignment, there is no way to save the
current stack state and restore it if things go wrong. The undo history only goes 100
steps deep and doesn't survive restarts.

**Proposal:** Add `gitbraid.saveCheckpoint` — writes a timestamped snapshot of
`local-config.json` to `.worktrees/checkpoints/<timestamp>.json`. Add
`gitbraid.restoreCheckpoint` — shows a QuickPick of available snapshots with
timestamps and a preview of the stack at that point, then merges the selected snapshot
into the current config.

**Existing hooks:** `StackShareService` already has import/export logic.
`ConfigService` write path handles the persistence. The checkpoint file format can
be identical to the existing `local-config.json` schema.

**Effort:** M · **Impact:** Medium

---

## 9. Floating file aging indicator

**Problem:** Files can sit in the "Floating (unassigned)" group for days while the
developer forgets to assign them. There is no visual signal that a file has been
floating for a long time, which leads to "floating file leakage" — changes that should
have been committed to a branch accumulate and eventually become hard to untangle.

**Proposal:** Track a `floatingSince: Date` for each floating file (stored in a
per-session in-memory map). In `BranchStackTreeProvider`, use the elapsed time to
choose the tree item icon colour: grey (< 1 hour), yellow (1–24 hours), orange
(1–7 days), red (> 7 days). Tooltip shows "Floating for 3 days".

**Existing hooks:** `WorkspaceSync.onDidFloatFile` fires the moment a file becomes
floating — ideal as the timestamp capture point. `BranchStackTreeProvider` already
has per-file tree items with configurable icons.

**Effort:** S · **Impact:** Medium

---

## 10. `assignGlob` command

**Problem:** Starting a new feature often means assigning 20+ files in a directory
to a branch. The current `assignFolder` command only works on an exact folder.
Developers also want to assign by file extension (`**/*.css`) or across directories
(`src/api/**`, `test/api/**` simultaneously).

**Proposal:** Add a `gitbraid.assignGlob` command and LM tool `gitbraid_assignGlob`
that takes a glob pattern and a branch name. Preview the matched files in a QuickPick
(with checkboxes) before applying. Useful as an AI-driven bulk action: *"Assign all
auth-related files to feature/auth."*

**Existing hooks:** `vscode.workspace.findFiles(pattern)` resolves globs.
`ConfigService.setAssignment` handles individual assignments.
`UndoStack.recordAssignFile` can batch them into a single undoable operation.

**Effort:** M · **Impact:** Medium

---

## 11. Integration with VS Code's merge editor for rebase conflicts

**Problem:** When `RebaseRecovery` detects a mid-rebase state and shows the conflict
dialog, the user clicks "Open conflicts" but ends up with a list of file paths in the
output channel rather than the files opening in VS Code's built-in three-pane merge
editor. The transition from "rebase paused" to "editing conflicts" is clunky.

**Proposal:** When the "Open conflicts" action is chosen in the rebase recovery dialog,
programmatically open each conflicted file in VS Code's merge editor via:
```ts
vscode.commands.executeCommand('merge-conflict.accept', uri, 'current')
// or the newer three-way merge API
```
After all conflicts are resolved, show the "Continue rebase" button directly.

**Existing hooks:** `RebaseRecovery.getInProgressRebase()` already returns
`conflictedFiles: string[]`. `vscode.commands.executeCommand('git.openMergeEditor', …)`
is available in VS Code 1.94+.

**Effort:** M · **Impact:** High

---

## 12. Team stack templates

**Problem:** When a new team member checks out a repository, they have no idea what
branch stack their colleagues are using for the current sprint. They start from
scratch while everyone else has a consistent branching structure.

**Proposal:** Extend `.gitbraid/stack.json` (already exported by `StackShareService`)
to include a `template: true` flag and an `instructions` field. When GitBraid detects
a new workspace with no `local-config.json` but a committed `.gitbraid/stack.json`,
offer to apply the template as a starting point. "Would you like to set up the
recommended sprint stack? (feature/auth → feature/token → main)"

**Existing hooks:** `StackShareService.importStack` already handles the merge.
The detection hook is available in `ConfigService._readFromDisk` when the config is
missing.

**Effort:** M · **Impact:** Medium

---

## Priority Matrix

| Idea | Impact | Effort | Recommended order |
|------|--------|--------|------------------|
| 2. PR-ready cumulative diff | High | S | 1 — existing code, tiny surface |
| 9. Floating file aging | Medium | S | 2 — pure UI, no new deps |
| 6. Stack diagram export | Medium | S | 3 — leverages existing data |
| 5. Worktree health dashboard | High | M | 4 — visible daily |
| 3. Smart auto-assign | High | M | 5 — big friction reducer |
| 1. Routing preview | High | M | 6 — safety win |
| 11. Merge editor integration | High | M | 7 — removes a rough edge |
| 10. assignGlob | Medium | M | 8 — power user + AI use |
| 8. Checkpoints | Medium | M | 9 — pre-rebase safety net |
| 4. Commit templates | Medium | M | 10 — workflow polish |
| 12. Team templates | Medium | M | 11 — onboarding win |
| 7. MCP server | High | L | 12 — high impact but large scope |
