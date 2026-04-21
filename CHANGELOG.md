# GitBraid Changelog

## [Unreleased]

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
