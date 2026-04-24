# GitBraid Changelog

## [Unreleased]

### Added
- **Cross-tool stack importer** (`gitbraid.importStackedTool`, RM-012) — detect
  Graphite / git-stack / git-spr / GitButler / plain-upstream metadata in the
  active repository, preview the inferred stack, and seed GitBraid's
  `.worktrees/local-config.json` so users migrating from another tool don't
  have to rebuild their stack by hand. New module:
  `src/stackedPRToolImporter.ts`. Plan: `docs/plans/07-import-from-tools.md`.
- **Expanded default keybindings** (RM-009) — adds bindings for
  `gitbraid.unassignFile` (Ctrl/Cmd+Alt+U), `gitbraid.assignHunk`
  (Ctrl/Cmd+Alt+H), `gitbraid.focusStackView` (Ctrl/Cmd+Alt+S),
  `gitbraid.pushStack` (Ctrl/Cmd+Alt+Shift+P), and `gitbraid.rebaseBranch`
  (Ctrl/Cmd+Alt+Shift+R).
- **Competitive analysis + feature roadmap** — `docs/competitive-analysis.md`
  compares GitBraid against Graphite, git-spr, git-stack, Sapling, GitButler,
  ghstack, and Stacked Git; `docs/plans/` captures implementation plans for
  the gaps (PR creation, stack visualisation, absorb, merge queue, virtual
  branches, persistent undo).
- **Layered workspace population** (`StackPopulator`) — when a branch is added to the
  stack, GitBraid now automatically copies its committed files (those that differ from
  the branch's base via `git diff --name-only`) into the primary workspace and assigns
  them to that branch. On extension activation, any committed files in existing stack
  branches that have no assignment yet are seeded into the workspace. The highest layer
  in the stack wins when two branches introduce the same file; overlapping files surface
  a warning notification.
- **Stack-ordered Branch Stack view** — branches in the **Branch Stack** tree view are
  now shown in descending stack order (topmost layer first) instead of alphabetically.
  Scratch branches continue to appear at the bottom.
- **Move Branch Up / Move Branch Down** commands (`gitbraid.moveBranchUp` /
  `gitbraid.moveBranchDown`) — reorder the stack without the mouse. Bound to
  `Alt+Up` / `Alt+Down` when a branch node is focused in the Branch Stack view.
  Also available via right-click context menu on any branch node.

### Fixed
- Activity bar icon now renders correctly in all VS Code themes. The SVG was
  converted from `<circle>` elements to `<path>` arc equivalents; VS Code's
  CSS mask renderer only reliably handles `<path>` elements.

### Security
- Reject shell metacharacters in paths, branch names, and commit messages
  before they reach `child_process.exec` (hardens DiffEngine, StackResolver,
  RebaseSuggestionService, and MbcApi). Full `spawn`-with-argv migration is
  tracked in `docs/remediation/03-security-hardening.md#T18`.
- Replace the no-op `String.raw\`"\`` quote escape in `DiffEngine._sanitisePath`
  with a strict reject (was a confirmed command-injection surface).
- `gitExec` no longer surfaces successful-command stderr as a user-facing
  warning popup (LF/CRLF hints made the extension unusable on Windows).
- Redact `user:token@` URLs, `Authorization:` headers, and GitHub PATs from
  logged git output.
- Declare `capabilities.virtualWorkspaces=false` and
  `capabilities.untrustedWorkspaces=limited`; add
  `extensionKind: ["workspace"]` to the manifest.

### Fixed
- `git.branch()` and `git.revList()` now return real values instead of
  `undefined` (the `(r: any) => r.stdout` accesses were reading `.stdout`
  off an already-trimmed string).
- Zero-line hunk (`@@ -X,Y +Z,0 @@`) now reports `endLine < startLine`
  instead of colliding with the next line during overlap detection
  (reviews/bugs.md B3).
- `Logger.getInstance()` is idempotent — no more "output channel keeps
  resetting" regressions.
- `log.notification()` fires one notification, not two.
- `getCallerSourceLine()` is skipped unless the log level is Debug or
  lower (was running `new Error()` on every info/warn/error call).
- `discardChanges` restores tracked files via `git checkout HEAD --` and
  only deletes untracked files via `git clean -f --` (previously ran
  `clean -f` on everything, so tracked edits survived and untracked
  files were deleted without a clear signal).
- `toUri()` correctly accepts Windows paths with forward slashes
  (`C:/foo/bar`) — previously treated as relative.
- `activationEvents` replaced with `workspaceContains:.git` +
  `workspaceContains:.worktrees/local-config.json`. Activation no longer
  throws on windows with no workspace folder.
- Remote branch listing preserves `upstream/...` prefixes instead of
  munging everything to `second-segment/rest`.
- Hunk CodeLens no longer fires in directories whose name merely
  contains the substring `.worktrees`.
- Multi-remote branch listing + already-checked-out detection surface
  friendly errors before git fails.
- `_pruneOrphans` logs the failing orphan path instead of silently
  carrying on; `_isCheckedOut` and `_worktreeIsDirty` log the underlying
  error instead of returning `false`.
- `BranchScmProviderManager._refreshAll` uses `Promise.allSettled` so one
  failing branch can't poison the whole refresh.
- Rebase suggestion prompt awaits the rebase operation itself, not just
  the dialog; interval errors are caught rather than leaked as
  unhandled rejections.
- `WorkspaceSync._handleSave` shows a user-facing error when sync fails
  (previously the `SyncError` was lost inside the debounce callback).
- Saves that arrive while a sync is running are now re-queued instead of
  dropped.

### Changed
- Brand sweep: every `Multi[- ]Branch Checkout` / `MBC` / `MBC:` /
  `mbc-*` surfaces rebranded to **GitBraid**. SCM group ids now use
  `gitbraid-*`. Walkthrough title updated. Command title "Multie Branch
  Checkout: Open file" → "GitBraid: Open File".
- Every palette-visible command now carries `category: "GitBraid"`
  instead of the miscellaneous `other` / `external` labels.
- QuickPick in `gitbraid.addStackBranch` surfaces "Create a new branch"
  at the top of the list with a `$(plus)` icon and groups
  local / remote branches with separators. Pressing Escape cancels the
  command instead of silently defaulting to `main`.
- Base-branch picker no longer hard-codes `main` — detects the
  repository's default branch via `refs/remotes/origin/HEAD`,
  `init.defaultBranch`, or the current branch.
- Status-bar indicator hides when the stack is empty or no files are
  floating (was always visible).
- `_createWorktree` refuses up front if a branch is already checked
  out elsewhere, instead of letting git fail with a cryptic
  "is already checked out at X".
- Honour user settings that were previously ignored:
  `gitbraid.syncDebounceMs`, `gitbraid.prDecorationsEnabled`,
  `gitbraid.showFloatingWarningOnCommit`. New setting
  `gitbraid.maxSyncFileSizeKb` (default 10 MB) skips sync for large
  files.
- File decorations add a 1–2 character badge so branches that map to
  the same chart colour can still be visually distinguished.

### Added
- **Assign by glob** (`gitbraid.assignGlob`): enter a glob pattern, pick a
  branch, preview matched files in a checkbox QuickPick, and assign them all
  in one undoable operation. Also exposed as `gitbraid_assignGlob` LM tool so
  AI assistants can bulk-assign related files.
- **Named stack checkpoints** (`gitbraid.saveCheckpoint` /
  `gitbraid.restoreCheckpoint`): snapshot the current stack and assignments to
  `.worktrees/checkpoints/<timestamp>.json`; restore via a QuickPick that
  previews branch count and assignment count per checkpoint.
- **Commit message templates** (`gitbraid.setCommitTemplate`): set a per-branch
  template that pre-populates the SCM input box. Variables: `{branch}` (full
  name), `{issue}` (first JIRA-style token e.g. `PROJ-123`), `{scope}` (last
  path segment after `/`). Template is stored in `local-config.json` and
  survives rebuilds.
- **Team stack templates** (`gitbraid.exportStackTemplate`): export the stack
  with `template: true` and optional `instructions` to `.gitbraid/stack.json`.
  New teammates who open the repo with no local config are offered a one-click
  "Apply Template" prompt. Detection runs once at activation via
  `StackShareService.detectAndOfferTemplate()`.
- **Worktree health dashboard** (`WorktreeHealthService`): ahead/behind
  commit counts, dirty-worktree indicator (⦿), and mid-rebase warning icon
  are now shown live in the Branch Stack tree view for every branch.
- **Floating-file aging**: unassigned files in the Branch Stack tree view
  are now colour-coded by how long they have been floating — grey (<1 h),
  yellow (1–24 h), orange (1–7 days), red (>7 days).
- **Stack diagram copy** (`gitbraid.copyStackDiagram`): copies an ASCII tree
  of the full stack (branch names, bases, assigned-file counts) to the
  clipboard. Also exposed as `gitbraid_getStackDiagram` LM tool.
- **PR-ready diff** (`gitbraid.openStackDiff`): opens a VS Code diff editor
  comparing the current working tree to the base of the stack using the
  `gitbraid-base:` virtual scheme.
- **Smart auto-assign**: when a new file is saved in a directory where all
  other assigned files belong to a single branch, a toast offers to auto-
  assign the new file to that branch.
- **Routing preview / dry-run** (`gitbraid.previewRouting`): validates all
  current hunk assignments with `git apply --check` (no worktree changes)
  and reports per-branch pass/fail in the Output panel.
- **Merge editor integration**: `openConflicts` now opens conflicted files
  in VS Code's built-in three-way merge editor (`git.openMergeEditor`) with
  a plain-editor fallback for older VS Code versions.
- `gitbraid.unassignHunk` command + a second CodeLens entry per assigned
  hunk so users can remove an assignment in one click.
- `MbcApi.reorderStack`, `getHunkAssignments`, `removeHunkAssignment`,
  `onDidSyncFile`, and `onDidFloatFile` are now part of the exported
  `GitBraidExportedAPI` so downstream tools (including LM tools) can
  observe save-time events and full read/write parity.
- `GitBraidError` union type exported for consumers that want to
  `instanceof`-narrow on the public API.

### Removed
- Unused error types `FileGroupError`, `WorktreeParentError`,
  `UpdateTreeError`.
- ~80 lines of commented-out `patchToWorktree` scaffolding from
  `commands.ts`.
- `viewsWelcome` "This is welcome content!" placeholder string.

### Documentation
- Full remediation plan committed under `docs/remediation/` (11 files,
  sequenced P0 → P3, with acceptance criteria). Tracks the outstanding
  work from `docs/reviews/`.

## [0.1.0] - 2026-04-21

### Added
- Phase 1: ConfigService, BranchStackService, WorkspaceSync — foundation layer
- Phase 2: BranchFileDecorationProvider, per-branch SCM providers, Branch Stack tree view, floating-file status bar
- Phase 3: DiffEngine, HunkRouter, HunkCodeLensProvider, OverlayDiagnostics — chunk-level hunk assignment
- Phase 4: StackResolver, RebaseSuggestionService — cumulative content resolution and automatic rebase suggestions
- Phase 5: Full exported API (`MultiBranchCheckoutExportedAPI`) and 7 VS Code LM tools for AI integration
- Phase 6: Complete `package.json` manifest — all commands declared, configuration schema, Getting Started walkthrough
