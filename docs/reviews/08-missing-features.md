# Missing Features and Roadmap Gaps

Items promised in `docs/PLAN.md` (or plainly implied by the extension's
purpose) that are absent or only stubbed in code.

## Promised but not implemented

### Drag-and-drop reassignment (PLAN §2.3)

> _"Drag-and-drop file between branch nodes to reassign"_

`BranchStackTreeProvider` does not implement
`vscode.TreeDragAndDropController`. Reassigning a file today requires
right-click → QuickPick. This is the biggest UX regression against the
plan.

### Bidirectional sync (PLAN §1.3)

> _"Bidirectional: if the worktree file changes externally, sync back
> to primary"_

`WorkspaceSync` only watches the primary workspace root. Changes made
inside a `.worktrees/<branch>/` directory (e.g. from a rebase, from a
commit hook, from another tool) are not propagated back to the primary
workspace. This breaks the "workspace always reflects the cumulative
top-of-stack state" invariant from the vision statement.

### Cumulative content resolution through the stack (PLAN §4.1)

> _"When the workspace opens a file, resolve its content through the
> stack"_

`StackResolver.getResolvedContent` exists but is **not wired up**: no
`TextDocumentContentProvider` is registered, no virtual scheme hooks
`vscode.workspace.openTextDocument`, and nothing calls
`getResolvedContent` in the activation path. The resolver is
dead code today.

### PR awareness (PLAN §4.3)

> _"If `vscode.github-pullrequests` extension is available, surface the
> PR status (open/draft/merged) as a decoration on each branch node"_

No code references `vscode.github-pullrequests`. The setting
`gitbraid.prDecorationsEnabled` is declared but unused.

### MCP server (PLAN §5.3)

Stretch goal, not started. Reasonable to defer but worth an ADR
documenting the decision.

### Drag-aware stack reordering

`ConfigService.reorderStack` exists and is tested, but no UI exposes
it. The tree view ignores `BranchNode` drag events. Without a way to
reorder, a user who adds branches in the wrong order has to remove and
re-add them.

### "Move commits to branches" guidance

`PLAN §1.4` says:

> _"Display warning if workspace has uncommitted changes on main that
> should be moved to branches"_

Not implemented. A helpful onboarding moment (a notification with a
"Show unassigned changes" action) is missing.

## Plausible features implied by the domain but missing

### Stack-wide commit summary

No way to see "what will happen if I finalise this stack": a combined
diff, a list of which file changes live on which branch, or a preview
commit graph. For a power user this is the primary value prop.

### Push-stack / sync-stack

After committing per-branch, the user still has to `git push` each
branch manually, which negates the "stay in one workspace" ergonomics.
Add:

- `gitbraid.pushStack` — push every branch in the stack, creating
  upstream tracking if missing.
- `gitbraid.syncStack` — fetch + rebase every child onto its new
  parent tip in order.

### Stack-wide conflict recovery

`rebaseBranch` shows an error message if rebase fails but gives the
user no way to resolve. Provide:

- A "Resolve rebase" SCM view for the branch.
- An "Abort rebase" command (`git rebase --abort`).
- A "Continue rebase" command (`git rebase --continue`).

### Assign all files on branch

No way to say "assign everything in this folder to feature/docs". A
batch operation via right-click on a folder → "Assign subtree to
branch…" would dramatically reduce click cost.

### Move a hunk to a new branch

The hunk router can assign a hunk to an existing branch. But a common
workflow is "this hunk is actually a different concern — make a new
branch and put this hunk there". Combine `assignHunk` with
`addBranchToStack` as a single command.

### Unassign hunk

`ConfigService.removeHunkAssignment` exists but there's no command or
UI that calls it. The CodeLens only opens the "assign" picker.

### Undo

No way to revert an assignment, a sync, or a per-branch commit. A
command history (in-memory, per session) with
`gitbraid.undoLastAssignment` would help.

### Export / import stack

For sharing a stack arrangement between machines (or committing a
suggested stack layout for a repo), `local-config.json` is personal by
design — but users will want to share. Consider a `.gitbraid/stack.yaml`
file **committed** to the repo that describes the default stack
layout; each developer then layers personal assignments on top.

### Handle `main` being renamed

`BranchStackService.addBranchToStack` defaults the base selector to
`['main', ...stack.map(...)]` (`extension.ts:263`). If the repo's
default branch is `master`, `trunk`, or `develop`, the first base
option will be wrong. Use `git symbolic-ref refs/remotes/origin/HEAD`
or the existing `git.defaultBranch()` helper.

### Handle worktree-inside-worktree edge cases

`initStack` will recreate `.worktrees/main` if a user adds `main` as a
stack branch — git will reject (cannot check out a branch in two
worktrees) and the error bubbles up. Detect this and warn up front.

## Language-model tools

The seven LM tools registered in `lmTools.ts` are not declared in
`package.json` under `contributes.languageModelTools`. VS Code's LM
tool registry requires:

```json
"contributes": {
    "languageModelTools": [
        {
            "name": "mbc_getStack",
            "displayName": "Get Branch Stack",
            "description": "Returns the current branch stack and assignments",
            "inputSchema": { … },
            "canBeReferencedInPrompt": true,
            "toolReferenceName": "getStack"
        },
        ...
    ]
}
```

Without these declarations, Copilot Chat cannot discover or call the
tools — the runtime `vscode.lm.registerTool(…)` call is not enough on
its own. This is likely the single biggest gap between "it exists"
and "users can actually use it".

Additional LM tools worth adding:

- `mbc_routeHunks` — apply pending hunk assignments for a file.
- `mbc_removeBranch`, `mbc_reorderStack`, `mbc_rebaseBranch`,
  `mbc_unassignFile`, `mbc_removeHunkAssignment` — symmetrical pairs
  for the existing read/write tools.
- `mbc_getStackStatus` — aggregate status across all branches.

## API surface gaps

`GitBraidExportedAPI` exposes most services but omits:

- `reorderStack(orderedNames: string[])`.
- `routeHunks(relativePath: string)`.
- `rebaseBranch(name: string)`.
- `getHunkAssignments(relativePath: string)`.
- `onDidSyncFile` / `onDidFloatFile` events (for observers that want to
  react to save-time events).

Without these, a downstream extension (or AI agent) cannot perform
full workflow automation.
