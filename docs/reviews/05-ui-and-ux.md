# UI / UX Review

## Two tree views with divergent models

The SCM view container hosts two trees:

- **GitBraid (Worktrees)** (`gitbraid.worktreeView`) — the legacy
  worktree tree built in `worktreeView.ts` / `worktreeNodes.ts`.
- **Branch Stack** (`gitbraid.stackView`) — the Phase 2 stack view.

The user sees both. They don't cross-reference each other, they don't
share expand/collapse state, and changes made in one don't update the
other reliably (the watchers in `extension.ts` fire on `**/*` and
refresh the worktree tree, but the stack tree subscribes to
`ConfigService` events only).

The `viewsWelcome` on the worktree view says:

```json
"contents": "This is welcome content! \n[Create worktree](command:gitbraid.createWorktree)"
```

This is clearly placeholder copy that should not ship.

## Command palette hygiene

### Missing `category` prefixes

VS Code convention: every command contributed to the palette gets a
stable category so users can filter. GitBraid uses `category: external`
and `category: other` for two commands and nothing for the rest. Every
command will appear under the generic root of the palette.

### Confusing titles

- `gitbraid.openFile` → title `"Multie Branch Checkout: Open file"`
  (typo "Multie" and the new branding is "GitBraid", not
  "Multi Branch Checkout").
- `gitbraid.compareTo` → title `"Compare with"`, category `"other"` —
  the user sees "Other: Compare with" in the palette.
- `gitbraid.refresh` vs `gitbraid.refreshView` vs `gitbraid.stackView.refresh`
  vs `gitbraid.scm.refreshAll` — four nearly-identical commands.

### Missing context menu support

The plan promises drag-and-drop assignment between branches. The stack
tree exposes no `canDragAndDrop` implementation (`BranchStackTreeProvider`
does not declare `onDidChangeSelection` nor implement
`vscode.TreeDragAndDropController`). Re-assigning a file today requires
right-click → "Assign File to Branch" → pick from QuickPick.

## QuickPick flow in `gitbraid.addStackBranch`

`extension.ts:196-267` constructs an elaborate `QuickPick` with a
300 ms debounce for remote-branch search and a "new branch" pseudo-entry.
Issues:

- The "new branch" entry appears at the **end** of the list — if the
  user types and presses Enter, VS Code selects the first match. There
  is no visual distinction (icon, trailing label) between "local",
  "remote", and "new".
- `qp.onDidAccept` disposes the QuickPick synchronously, but
  `qp.onDidHide` also disposes it. Double-dispose is safe in VS Code
  1.94 but warn-noisy in the Output log.
- The base-branch QuickPick defaults to `'main'` if the user presses
  Escape. Pressing Escape should cancel the whole command, not create
  a branch off `main`.
- If the user types a branch name that matches nothing locally or
  remotely, the "new branch" entry uses the raw value including spaces.
  `validateBranchName` will reject it downstream, but the error path
  dumps a raw `BranchStackError` — wrap in a friendly message.

## Walkthrough

The `Get Started` walkthrough references four images under
`resources/walkthrough-*.png` but only `icon.png` exists in
`resources/`:

```
resources/
  icon.png
  icon.svg
```

The walkthrough will render a broken-image placeholder for every step.
Either commit the images or drop the `media` fields.

The walkthrough title still reads **"Get Started with Multi-Branch
Checkout"**, not "GitBraid" — the rebranding is incomplete.

## File decorations

`fileDecorationProvider.ts` maps hex colours to VS Code's six named
`charts.*` palette entries via a naive HSL bucket. Consequences:

- Users can only visually distinguish ~6 branches at most; above that
  two branches will share a colour.
- The `defaultBranchColor` setting (`#4ec9b0`) maps to `green`, not
  teal — the user picks a colour and sees something noticeably
  different.
- VS Code actually supports `color: vscode.ThemeColor` with any theme
  token OR custom colours via `badge`. The `badge` field (1–2 chars)
  would let you distinguish branches by initials.

Also: decorations apply only to assigned files. A user who has assigned
half their files and is looking at a green `src/` folder doesn't see
any aggregate colour hint on the directory.

## SCM panel naming

`BranchScmEntry` registers itself as `MBC: ${branchName}` with id
`mbc-${name}`. "MBC" means "Multi Branch Checkout" — out-of-date brand.
Update to `GitBraid: ${branchName}` and id `gitbraid-${name}`.

The `Floating` SCM appears as **"MBC: Floating (unassigned)"** — same
issue.

## Hunk CodeLens UX

- The CodeLens title toggles between:
  `$(git-commit) Assign hunk to branch…` and
  `$(git-branch) Hunk → <branch>`.
  The second form is informational but has no click action — clicking
  still opens the QuickPick. Provide two lenses: one to **reassign**
  (open picker) and one to **unassign** (one-click remove).
- The lens fires even on the `.worktrees/**` paths when the scheme is
  `file`. The check `document.uri.fsPath.includes('.worktrees')` is a
  substring match and will also skip files in a directory called
  `'not.worktrees-backups/'`. Use path containment.

## Status bar

`FloatingStatusBarItem` is always visible, even with no stack and no
workspace. Hide it when `getStack().length === 0`, or at least when
`count === 0` so the status bar is less noisy.

## Error surfacing

Most errors are logged to the Output channel (`log.error(...)`) without
user-facing notifications — so a failed rebase, a failed sync, or a
failed worktree add often fails silently unless the user happens to be
looking at the Output panel. Combine this with the double-fire bug in
`log.notification` (`06-error-handling-and-logging.md`) and the end
result is "half the errors are silent, the rest are shown twice".

Recommendation: standardise on `vscode.window.showErrorMessage` for
user-actionable failures, and always include an "Open Output" button
that focuses the `gitbraid` channel.

## Accessibility

- Emoji is used in user-facing strings (`🔒`/`🔓` as lock state,
  `WorktreeRoot.setLocked`). Screen readers will announce "U+1F512"
  unless you wrap with `$(lock)` codicons.
- `WARNING` icons in the `FloatingGroupNode` (`ThemeIcon('warning')`)
  are correct, but the `count` description is
  `"${count} file(s)"`. A localised version would be
  `vscode.l10n.t('{0} files', count)`.

## Drag / drop between branches

Promised in `PLAN.md §2.3`, not implemented. This is the most natural
way to re-assign a file; it should be in the MVP.

## Multi-select

`WorktreeView` declares `canSelectMany: true` (`worktreeView.ts:94`) but
none of the registered commands accept an array; e.g.
`gitbraid.stageNode` takes a single `WorktreeNode`. Either disable
multi-select or update handlers to accept
`(node: WorktreeNode, nodes?: WorktreeNode[])`.
