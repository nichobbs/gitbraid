# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Project Is

GitBraid is a VS Code extension that lets developers work on multiple stacked git branches simultaneously in a single workspace. Files (or individual diff hunks) are assigned to branches; GitBraid routes changes to the correct git worktree on save. The workspace always reflects the cumulative state of the entire stack as if all branches were merged.

## Commands

```bash
npm ci                  # Install dependencies
npm run lint            # ESLint on src/**/*.ts
npm run compile         # Bundle with esbuild → dist/extension.js
npm run watch           # Watch mode
npm test                # Run all tests (with coverage)
npm run package         # Package as VSIX
```

Running tests requires a display server on Linux:
```bash
xvfb-run npm test       # Linux headless
npm test                # macOS / Windows
```

To run a single test file, pass `--grep` or a file path via the vscode-test CLI — see `@vscode/test-cli` docs. The pre-test script (`scripts/setup-test-fixture.js`) creates `test_projects/proj1/` automatically.

CI enforces coverage minimums (Linux only): **lines ≥60%, branches ≥50%, functions ≥60%** via `scripts/check-coverage.mjs`. These floors ratchet up as tests land; never lower them without a CHANGELOG note explaining why.

## Code Style

- **No semicolons** (`semi: never` in ESLint)
- Strict TypeScript: `noUnusedLocals`, `noImplicitReturns`, `noFallthroughCasesInSwitch`
- Use `===` / `!==` (eqeqeq smart — `== null` is allowed)
- Never `throw` literals; always throw `Error` instances
- ES2022 target, CommonJS output (esbuild bundles `src/` → `dist/extension.js`)

## Architecture

### Layers

```
VS Code UI (Explorer decorations, SCM panel, Branch Stack tree view, Status Bar)
    ↓
extension.ts  – orchestrates activation in 6 phases; registers all commands + LM tools
    ↓
FolderRegistry / FolderContext  – one independent service graph per workspace folder
    ↓
Core services: ConfigService · BranchStackService · WorkspaceSync · DiffEngine · HunkRouter
    ↓
Git layer: git worktrees under .worktrees/, git apply, git diff, git commit
```

### Key Services

**`ConfigService`** (`src/configService.ts`) — Persists the stack and file/hunk assignments to `.worktrees/gitbraid-config.json`. Uses atomic temp-file writes, mtime-based concurrent-write detection, a 50 ms debounce, and version migration. Fires `onDidChangeAssignment` / `onDidChangeStack` events consumed throughout the codebase.

**`BranchStackService`** (`src/branchStackService.ts`) — Manages git worktrees under `.worktrees/`. Branch name → directory mapping uses a slug + SHA1 suffix (`feature-docs__a1b2c3d`) to avoid collisions. Wraps ConfigService and is the authoritative source for stack membership. Also handles `virtual` branches — entries flagged `virtual: true` skip `git worktree add` and live only in `VirtualBranchStore`; `materialiseBranch()` promotes them to regular worktree branches.

**`VirtualBranchStore`** (`src/virtualBranchStore.ts`) — Append-only JSONL store under `.worktrees/virtual/<slug>.jsonl` that captures file snapshots for branches flagged `virtual: true` in the stack. Crash-safe by construction (append-only), with lazy compaction when the log grows >2× the live working set. See `docs/plans/08-virtual-branches.md`.

**`WorkspaceSync`** (`src/workspaceSync.ts`) — File system watcher that copies assigned files to their branch worktree on every save, with a configurable debounce (default 200 ms). Also tracks "floating" files (modified but unassigned). Saves for files assigned to a virtual branch go to `VirtualBranchStore` instead of a worktree. Bidirectional sync is present but experimental (disabled by default).

**`DiffEngine`** (`src/diffEngine.ts`) — Parses `git diff` unified output into `DiffHunk[]`. Has a 32-entry LRU cache with a 1.5 s TTL to avoid redundant diff runs.

**`HunkRouter`** (`src/hunkRouter.ts`) — Routes individual diff hunks to branches via `git apply --cached`. Uses anchor tracking for hunk stability across edits.

**`StackResolver` / `StackContentProvider`** — Provides the virtual `gitbraid-stack://` URI scheme. File content is resolved by walking the stack from bottom to top: worktree dirty state wins, then committed state via `git show`.

**`BranchScmProvider`** (`src/branchScmProvider.ts`) — Creates one `vscode.SourceControl` instance per branch so each branch gets its own SCM panel with independent staging and commit UI.

**`LmTools`** (`src/lmTools.ts`) — Registers 9 VS Code Language Model tools (`gitbraid_getStack`, `gitbraid_getFloatingFiles`, `gitbraid_getBranchStatus`, `gitbraid_addBranch`, `gitbraid_assignFile`, `gitbraid_assignHunk`, `gitbraid_commitBranch`, `gitbraid_getStackDiagram`, `gitbraid_assignGlob`) that allow AI chat to inspect and mutate the stack.

**`McpServer` / `McpTools`** (`src/mcpServer.ts`, `src/mcpTools.ts`) — Hosts a Model Context Protocol server over stdio so non-VS-Code clients can drive the same stack. Read-only by default; mutation tools appear only when `gitbraid.mcpWriteEnabled` is true. Toggled by `GitBraid: Start / Stop MCP Server`.

**`PrHostAdapter`** (`src/prHostAdapter.ts`) — Provider-agnostic interface with six built-in implementations: `GitHubVSCodeAdapter`, `GitHubOctokitAdapter`, `GitLabAdapter`, `BitbucketAdapter`, `AzureDevOpsAdapter`, `NullPRHostAdapter`. `pickAdapter()` detects the host from the `origin` remote; override via `gitbraid.prHost` (`auto`, `github`, `gitlab`, `bitbucket`, `azure`, `none`). Tokens live in `SecretStorage` under `gitbraid.githubToken` / `gitbraid.gitlabToken` / `gitbraid.bitbucketToken` / `gitbraid.azureDevOpsToken`.

**`SubmitStackService`** (`src/submitStackService.ts`) — Pushes every layer and calls the selected adapter's `createPR` / `updatePR` to keep the stack's PRs in sync, rewriting each body with the `renderStackBlock` sentinel.

**`MergeQueueService`** (`src/mergeQueueService.ts`) — Drives `gitbraid.mergeStack`. Enqueues the bottom-most unmerged PR, polls `queueStatus` until it lands, then proceeds up the stack. Polling interval comes from `gitbraid.mergeQueuePollSeconds`.

**`Absorb`** (`src/absorb.ts`) — Plans and applies `git commit --fixup + rebase --autosquash` for hunks that belong to an earlier commit. Guarded by `gitbraid.absorbRewritePushed` when the target commits have already been pushed.

**`PersistentUndoLog`** (`src/persistentUndoLog.ts`) — Append-only JSON-Lines log at `.worktrees/undo-log.jsonl` that survives VS Code restarts. Bounded by `gitbraid.undoLogMaxEntries`.

**`StackedPRToolImporter`** (`src/stackedPRToolImporter.ts`) — Detects Graphite / git-spr / git-stack / GitButler / plain-upstream metadata and seeds `gitbraid-config.json` with the inferred stack.

**`Telemetry`** (`src/telemetry.ts`) — Opt-in (`gitbraid.telemetry.enabled` + `vscode.env.isTelemetryEnabled`) event counter. Records command names and anonymous stack shape only; never file paths, branch names, or remote URLs. Ships with a no-op sink; a real reporter plugs in via `setTelemetrySink()`.

### Multi-Root Workspace Support

`FolderRegistry` creates one `FolderContext` per eligible workspace folder. Each context holds its own `ConfigService`, `BranchStackService`, `WorkspaceSync`, and SCM providers. Commands route to the active context via `activeContext()` (uses the active editor's URI) or `contextForUri()`. The tree view and status bar bind to the primary folder and follow the active editor.

### Local Config Schema

`.worktrees/gitbraid-config.json` is the primary persistent state:
```json
{
  "version": 1,
  "stack": [
    { "name": "feature/docs", "color": "#4CAF50", "order": 1, "base": "main" },
    { "name": "feature/idea", "color": "#6C8EBF", "order": 2, "base": "feature/docs", "virtual": true }
  ],
  "assignments": { "src/foo.ts": "feature/docs" },
  "hunkAssignments": { "src/bar.ts": { "0": "feature/impl" } }
}
```
Never write this file directly — always go through `ConfigService`.

Virtual branches (`virtual: true`) also persist their captured file
snapshots to `.worktrees/virtual/<slug>.jsonl`; these files are managed
exclusively by `VirtualBranchStore`.

## Testing Conventions

- Test files live in `test/` and mirror `src/` filenames (`src/foo.ts` → `test/foo.test.ts`).
- `test/helpers/fakeGitRunner.ts` — mock git runner for unit tests; avoids real git subprocess overhead.
- `test/helpers/tmpRepo.ts` — creates a real temporary git repo for integration tests.
- `test/integration/` — integration tests that run real git commands.
- Unit tests should use `fakeGitRunner`; only reach for `tmpRepo` when git behavior itself is under test.

## Extension Activation

The extension activates when VS Code detects `.git`, `.worktrees/gitbraid-config.json`, or the legacy `.worktrees/local-config.json` in the workspace (the legacy filename triggers an automatic one-time migration on load). The `activate()` function in `src/extension.ts` runs six sequential phases: workspace trust check → folder service graph → SCM/UI → hunk CodeLens → command registration → LM tool + MCP registration. All disposables are pushed to `context.subscriptions`.
