# Missing Features

These are capabilities that users of a multi-branch workflow tool would reasonably
expect, but that are absent or incomplete in the current implementation.

---

## F1 — No Conflict Detection When Routing Hunks

`HunkRouter.detectOverlaps()` identifies hunks assigned to different branches whose
line ranges intersect, but this check is not wired into the routing workflow. A user
can assign overlapping hunks to different branches and then call `routeFile()` — the
overlaps are silently ignored and `git apply` will likely fail in one of the worktrees
with a cryptic patch error.

**Recommendation:** Call `detectOverlaps()` before `routeFile()` and surface a clear
error (or warning with confirmation) when overlaps exist. The infrastructure is already
there; it just needs to be connected.

---

## F2 — No Bi-directional File Sync

`WorkspaceSync` only copies files from the primary workspace into worktrees. If a
user edits a file directly in a worktree (e.g., via a terminal, or from a second VS
Code window), those changes are not reflected back into the primary workspace.

This creates a confusing situation: the primary workspace appears stale, and there is
no mechanism to pull worktree changes back.

**Recommendation:** Add a "pull from worktree" command: read the file from a specific
branch's worktree and write it into the primary workspace. For automatic bi-directional
sync, watch the worktree directories as well — but make the direction configurable to
avoid sync loops.

---

## F3 — No Visual Diff Between Branch Layers

There is no way to view what a specific branch contributes on top of its parent. The
`StackResolver.getStackDiff()` method exists but is not exposed in the UI.

**Recommendation:** Add a "Show branch diff" command that opens a VS Code diff editor
comparing the branch to its base. This would be the primary way to review what each
layer in the stack is doing before committing.

---

## F4 — Committing a Branch Does Not Propagate to Child Branches

When a branch in the stack is committed, its child branches are now one commit behind.
The `RebaseSuggestionService` detects this and prompts for a rebase, but the rebase
operation is manual and the suggestion only appears after a 5-minute delay (or extension
restart).

More critically, after committing branch A and rebasing branch B onto it, the file
assignments in `local-config.json` still reference old content. There is no mechanism
to verify that the assignments are still meaningful after a rebase.

**Recommendation:** After a commit or rebase, trigger a reconciliation pass that
re-diffs assigned files and highlights any assignments that no longer match a live hunk.

---

## F5 — No Support for Stacked Pull Requests

The natural output of a branch stack is a set of stacked PRs (PR for branch 1 targets
`main`; PR for branch 2 targets branch 1; etc.). There is no tooling to create, update,
or visualise this PR chain.

**Recommendation:** Add a "Create stacked PRs" command using the VS Code GitHub
extension API (or `gh` CLI) that creates one PR per branch in the stack with the correct
base branch. Display PR status (open, merged, CI state) in the branch stack tree view.

---

## F6 — No Assignment Import/Export

Branch assignments are stored in `.worktrees/local-config.json` which is gitignored.
Team members working on the same feature branch stack cannot share assignments.

**Recommendation:** Add an export command that writes assignments to a
`.gitbraid-assignments.json` file (not gitignored) and an import command that reads
it. Teams can then commit a suggested assignment layout that collaborators opt into.

---

## F7 — No Undo for Assignment Changes

Assigning a file to the wrong branch, or accidentally clearing an assignment, has no
undo. The user must remember the previous assignment and manually reassign.

**Recommendation:** Maintain an in-memory undo stack for assignment operations (not
persisted to disk — session only). Wire it to VS Code's `vscode.commands.registerCommand`
for `undo` so `Ctrl+Z` in a quick-pick context reverses the last assignment action.

---

## F8 — Rebase Conflict Resolution Is Unguided

When `RebaseSuggestionService.rebaseBranch()` encounters a conflict, it shows the
`stderr` output from `git rebase` in a notification and stops. The user is left in a
mid-rebase state with no guidance on how to proceed.

**Recommendation:** On rebase conflict:
1. Open the VS Code Git panel for the affected worktree.
2. Show a notification with options: "Open conflicted files", "Abort rebase", "View
   instructions".
3. Monitor for rebase completion (watch `.git/rebase-merge/` directory) and fire a
   `onDidCompleteRebase` event to refresh the branch stack UI.

---

## F9 — No Workspace Trust Integration

VS Code 1.57+ exposes a workspace trust API. GitBraid spawns git subprocesses
unconditionally, even in untrusted workspaces where the user has indicated they do not
trust the repository's content.

**Recommendation:** Check `vscode.workspace.isTrusted` at activation. In untrusted
workspaces, disable commands that spawn subprocesses and show a banner explaining why.
Register a `vscode.workspace.onDidGrantWorkspaceTrust` handler to re-activate when
trust is granted.

---

## F10 — No Status Bar Summary

There is no at-a-glance indicator of GitBraid's state. Users must open the branch stack
tree view to see which branch has floating files or is behind its parent.

**Recommendation:** Add a status bar item (bottom of window) showing:
- Number of floating files (red badge if non-zero)
- Name of the active branch for the currently open file
- A warning icon if the current branch is behind its parent

This mirrors how the built-in Git extension shows the current branch and sync status.
