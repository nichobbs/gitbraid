# GitBraid Changelog

## [Unreleased]

### Added
- **GitBraid Doctor** (`gitbraid.runDoctor`) — a one-shot health check for
  circular base references, orphaned worktrees, orphaned virtual-branch
  store files, missing worktrees, and out-of-workspace assignments, each
  with a one-click fix where one exists. New modules: `src/doctorService.ts`,
  `src/commands/doctorCommand.ts`.
- **Inline PR review comments** (GitHub) — line-level review comments on
  a PR now show up as native VS Code comment threads directly on the file
  they were left on. Read-only, GitHub-only for now. Toggle with
  `gitbraid.showPrReviewComments`; refresh via
  `gitbraid.refreshPrReviewComments`. New modules: `src/prReviewComments.ts`,
  `src/prReviewCommentsProvider.ts`.
- **Rebase / sync conflict prediction** — before `gitbraid.rebaseBranch` or
  `gitbraid.syncStack` runs, GitBraid predicts whether the rebase will
  conflict using `git merge-tree --write-tree` (no working-tree or index
  changes) and warns up front with the affected files, instead of leaving
  the user to discover a conflict mid-rebase.
  `RebaseSuggestionService.predictConflict`.
- **First-run interactive walkthrough** — a new "Route Hunks to Branches"
  step, plus an accompanying SVG, between the file-assignment and
  commit steps.
- **Reviews & checks panel** in the stack dashboard — populated from each
  PR's review-state rollup and per-check-run detail
  (`fetchGithubReviewAndChecks`, `summariseGithubReviews`).

### Fixed
- **Path traversal (security)** — `WorkspaceSync.syncAllAssigned()` /
  `_syncFile()` built read/write file URIs directly from config-stored
  assignment keys with no containment check. A crafted assignment key
  (reachable via the MCP write tool, the LM chat tool, or a hand-edited
  `gitbraid-config.json`) could read/write files outside the workspace.
  Now guarded with `pathGuard.requireInside()`.
- **Hunk-routing partial-failure data loss** — `HunkRouter.routeFile()`
  returned a single boolean, so a partial failure (one branch's hunks
  apply, another's fail) left the caller either clearing *all*
  assignments (losing the failure) or *none* (leaving a successfully
  applied branch's hunks both on disk and still marked assigned — a retry
  would then permanently fail re-applying an already-applied patch). Now
  returns `{ok, appliedIndices, failedIndices}`.
- **`GitHubVSCodeAdapter.updatePR` silent no-op** — the extension exposes
  no programmatic edit API, so `updatePR` opened the PR description panel
  and returned the *unchanged* PR while callers reported success. Now
  delegates to a real REST PATCH via `GitHubOctokitAdapter` when a token
  is stored, and throws an actionable error otherwise.
- **Circular base references on stack import** — `StackShareService`
  wrote branches through `ConfigService.addBranch` directly, bypassing
  the cycle check that only ran on the `addBranchToStack` path. Extracted
  `detectStackCycle()` and added a batch-aware check for the whole
  incoming set together.
- **Dead commands** — `gitbraid.openStackDiff` and `gitbraid.previewRouting`
  were declared in `package.json` with menu bindings but had no
  registered handler.
- **Diff-cache staleness + virtual-branch materialise race** —
  `DiffEngine`'s hunk cache skipped its mtime check for ~1.5s after a
  fresh fill, serving stale hunks to a save landing in that window.
  `BranchStackService.materialiseBranch` could silently drop an edit
  landing between its virtual-store snapshot and the store removal;
  `VirtualBranchStore.withBranchLock`/`flushAndRemoveLocked` now make the
  flush and the config flag flip atomic.
- **PR host adapters hardcoded `workspaceFolders[0]`** instead of the
  resolved repo root, breaking PR operations in any multi-root workspace
  where the relevant repo wasn't the first folder. `repoRoot` is now
  threaded through each adapter's constructor.
- **`VirtualBranchStore.flushAndRemoveLocked`** now guards the
  materialise-time write with `pathGuard.requireInside()`, matching
  `DiffEngine`/`WorkspaceSync`.
- **MCP server endpoint file and Unix socket** are now `chmod 0600`
  after creation, so another local user on a shared host can't read the
  plaintext auth token or connect to the socket.
- `gitbraid.unassignFolder`, `gitbraid.defaultBranchColor`, and
  `gitbraid.suggestImportOnActivate` were either missing their
  `contributes.commands` entry or never actually read — the command is
  now declared, the default branch colour is honoured by
  `gitbraid.addStackBranch`, and activation offers to import detected
  stacked-tool metadata when the setting is on and the stack is empty.

### Changed
- **Rate-limit-aware GitHub API error handling** — `fetchJson` retries
  once on a secondary rate limit with a short `Retry-After`, and fails
  fast with a "resets at HH:MM" message (instead of a generic 403) when
  the primary rate limit is exhausted.
- **Fast-fail on a stuck or deleted PR** in the merge queue — after 3
  consecutive "PR not found" polls, `MergeQueueService` stops waiting
  and reports the likely cause (deleted / renamed / force-pushed) instead
  of waiting out the full timeout.
- GitLab, Bitbucket, and Azure DevOps `PRHostAdapter` implementations
  now have `createPR`/`updatePR`/`queueStatus`/error-path test coverage
  matching GitHub's, closing a coverage gap where a regression in any of
  the three wouldn't have been caught by CI.

### Tests / CI
- Test coverage raised significantly — overall lines from ~62% to ~74%,
  branches from ~77% to ~77%, functions from ~63% to ~77%.  CI floors
  ratcheted from `lines ≥60%, branches ≥50%, functions ≥60%` to
  `lines ≥72%, branches ≥75%, functions ≥75%`.  New / expanded test
  files cover `absorb`, `checkpointService`, `gitIndex`, `lmTools`
  invocation paths, `mcpTools` write-gate + success paths,
  `stackContentProvider`, `hunkCodeLensProvider`, `OverlayDiagnostics`,
  `prHostAdapter` REST adapters with mocked `fetch`, `worktreeHealthService`,
  `undoStack` record-helpers, `undoReplay.runShowUndoLogCommand`, and
  `telemetry` (with `vscode.env.isTelemetryEnabled` forced on so the gate
  doesn't short-circuit).  Previously-skipped suites for `absorb`,
  `commitListService`, `mergeQueueService`, `persistentUndoLog`, and
  `submitStackService` are now part of the run.
- Pure command-helper logic factored out of `src/commands/branchCommands.ts`
  and `src/commands/fileCommands.ts` into `src/commands/_helpers.ts`
  (`reorderForMove`, `buildBaseList`, `buildAssignBranchPickItems`,
  `buildAddBranchPickItems`, `globToCandidates`, `filesAssignedTo`,
  `pluralise`, `toolDisplayName`) and unit-tested directly.  The residual
  command shells stay VS Code-bound and are best covered by integration
  tests.
- `src/extension.ts` (~404 lines of activation wiring already exercised
  end-to-end by `test/extension.test.ts`) and the thin
  `src/commands/index.ts` dispatcher are now excluded from the c8
  coverage report — they were dragging the denominator without
  surfacing a real testing gap.  Note: c8/test-exclude requires the
  `**/extension.ts` pattern shape; the more specific
  `**/src/extension.ts` triggers a known instrumentation bug that
  produces spurious 100% coverage across all files.

### Added
- **Virtual branches (Plan 08)** — a new kind of stack entry that exists only
  as an in-memory set of file snapshots until the user commits.  Commands:
  `GitBraid: Add Virtual Branch`, `GitBraid: Materialise Virtual Branch`,
  `GitBraid: Discard Virtual Branch`.  Virtual entries skip `git worktree
  add` and appear in the Branch Stack view under a `$(cloud)` badge.  Saves
  on assigned files are routed to an append-only JSONL store under
  `.worktrees/virtual/<slug>.jsonl` so VS Code restarts don't lose work.
  Materialisation creates the worktree, applies every stored file, and
  flips the branch back to the regular commit path.  Exposed via the
  public API (`addBranch(..., { virtual: true })`, `materialiseBranch`,
  `getVirtualBranches`).  Store implementation: `src/virtualBranchStore.ts`;
  commands: `src/commands/virtualBranchCommands.ts`; plan:
  `docs/plans/08-virtual-branches.md`.
- **Multi-host PR support** — `prHostAdapter.ts` now ships `GitLabAdapter`
  (REST v4, including Merge Train enqueue), `BitbucketAdapter` (Cloud REST
  v2), and `AzureDevOpsAdapter` (REST v7.1 for dev.azure.com and the
  legacy `*.visualstudio.com` tenants, including the SSH v3 remote
  shape). `pickAdapter()` detects the host from the `origin` remote, and
  the `gitbraid.prHost` setting accepts `gitlab` / `bitbucket` / `azure`
  in addition to `github` / `none` / `auto`. Tokens are stored in
  `SecretStorage` under `gitbraid.gitlabToken` / `gitbraid.bitbucketToken`
  / `gitbraid.azureDevOpsToken` via the renamed `GitBraid: Set PR Host
  Token…` command (now asks which host).
- **Submit Stack + Merge Stack across hosts** — `SubmitStackService` and
  `MergeQueueService` route through whichever adapter `pickAdapter` returns,
  so the user flow is identical on GitHub, GitLab, and Bitbucket. Bitbucket
  surfaces a clear "no native merge queue" error instead of silently
  succeeding.
- **Opt-in telemetry** (`gitbraid.telemetry.enabled`, default `false`) — a
  lightweight, anonymous event counter gated behind both the GitBraid setting
  and `vscode.env.isTelemetryEnabled`. Records command names and anonymous
  stack shape only; never file paths, branch names, or remote URLs. Ships
  with a no-op sink (`src/telemetry.ts`); downstream reporters plug in via
  `setTelemetrySink()`.
- **Plans 01–06 + 09 landed** — from `docs/plans/00-index.md`:
  - `01` PR creation (`submitStackService.ts`, `gitbraid.submitStack`).
  - `02` Stack visualisation (`stackDashboardView.ts` webview).
  - `03` Single-commit-per-PR mode (`gitbraid.toggleSingleCommitMode`).
  - `04` Absorb-equivalent (`absorb.ts`, `gitbraid.absorbHunks`).
  - `05` Merge-queue-aware push (`mergeQueueService.ts`,
    `gitbraid.mergeStack`).
  - `06` Richer stack graph (dashboard renders PR state + checks + queue pos).
  - `09` Persistent undo log (`persistentUndoLog.ts`, bounded by
    `gitbraid.undoLogMaxEntries`).
- **MCP server** (ADR 0001) — `gitbraid.startMcpServer` launches a stdio MCP
  server so external agents and CLIs can drive GitBraid without VS Code.
  Read-only by default; mutation tools appear only when
  `gitbraid.mcpWriteEnabled` is set. Modules: `src/mcpServer.ts`,
  `src/mcpTools.ts`.
- **Cross-tool stack importer** (`gitbraid.importStackedTool`, RM-012) — detect
  Graphite / git-stack / git-spr / GitButler / plain-upstream metadata in the
  active repository, preview the inferred stack, and seed GitBraid's
  `.worktrees/gitbraid-config.json` so users migrating from another tool don't
  have to rebuild their stack by hand. New module:
  `src/stackedPRToolImporter.ts`. Plan: `docs/plans/07-import-from-tools.md`.
- **Config migration** — `.worktrees/local-config.json` is now called
  `.worktrees/gitbraid-config.json`. Existing files are migrated once on load
  (commit `52b576f`).
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

### Notes
- Coverage floor: adding the new `src/commands/virtualBranchCommands.ts`
  (which follows the same register-command pattern as other command modules
  and is therefore dominated by VS Code-host-only code paths) pulls lines
  coverage by ~0.3 pp.  The core service (`virtualBranchStore.ts`) is at
  ~97% lines / ~95% functions, so the drop is strictly proportional to the
  new command-registration surface.  No threshold reduction.

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
  path segment after `/`). Template is stored in `gitbraid-config.json` and
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
