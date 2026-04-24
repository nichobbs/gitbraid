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

CI enforces coverage minimums (Linux only): **lines ≥55%, branches ≥45%, functions ≥55%** via `scripts/check-coverage.mjs`.

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

**`BranchStackService`** (`src/branchStackService.ts`) — Manages git worktrees under `.worktrees/`. Branch name → directory mapping uses a slug + SHA1 suffix (`feature-docs__a1b2c3d`) to avoid collisions. Wraps ConfigService and is the authoritative source for stack membership.

**`WorkspaceSync`** (`src/workspaceSync.ts`) — File system watcher that copies assigned files to their branch worktree on every save, with a configurable debounce (default 200 ms). Also tracks "floating" files (modified but unassigned). Bidirectional sync is present but experimental (disabled by default).

**`DiffEngine`** (`src/diffEngine.ts`) — Parses `git diff` unified output into `DiffHunk[]`. Has a 32-entry LRU cache with a 1.5 s TTL to avoid redundant diff runs.

**`HunkRouter`** (`src/hunkRouter.ts`) — Routes individual diff hunks to branches via `git apply --cached`. Uses anchor tracking for hunk stability across edits.

**`StackResolver` / `StackContentProvider`** — Provides the virtual `gitbraid-stack://` URI scheme. File content is resolved by walking the stack from bottom to top: worktree dirty state wins, then committed state via `git show`.

**`BranchScmProvider`** (`src/branchScmProvider.ts`) — Creates one `vscode.SourceControl` instance per branch so each branch gets its own SCM panel with independent staging and commit UI.

**`LmTools`** (`src/lmTools.ts`) — Registers 7 VS Code Language Model tools (`gitbraid_getStack`, `gitbraid_getFloatingFiles`, `gitbraid_getBranchStatus`, `gitbraid_addBranch`, `gitbraid_assignFile`, `gitbraid_assignHunk`, `gitbraid_commitBranch`) that allow AI chat to inspect and mutate the stack.

### Multi-Root Workspace Support

`FolderRegistry` creates one `FolderContext` per eligible workspace folder. Each context holds its own `ConfigService`, `BranchStackService`, `WorkspaceSync`, and SCM providers. Commands route to the active context via `activeContext()` (uses the active editor's URI) or `contextForUri()`. The tree view and status bar bind to the primary folder and follow the active editor.

### Local Config Schema

`.worktrees/gitbraid-config.json` is the only persistent state:
```json
{
  "version": 1,
  "stack": [{ "name": "feature/docs", "color": "#4CAF50", "order": 1, "base": "main" }],
  "assignments": { "src/foo.ts": "feature/docs" },
  "hunkAssignments": { "src/bar.ts": { "0": "feature/impl" } }
}
```
Never write this file directly — always go through `ConfigService`.

## Testing Conventions

- Test files live in `test/` and mirror `src/` filenames (`src/foo.ts` → `test/foo.test.ts`).
- `test/helpers/fakeGitRunner.ts` — mock git runner for unit tests; avoids real git subprocess overhead.
- `test/helpers/tmpRepo.ts` — creates a real temporary git repo for integration tests.
- `test/integration/` — integration tests that run real git commands.
- Unit tests should use `fakeGitRunner`; only reach for `tmpRepo` when git behavior itself is under test.

## Extension Activation

The extension activates when VS Code detects `.git` or `.worktrees/gitbraid-config.json` in the workspace. The `activate()` function in `src/extension.ts` runs six sequential phases: workspace trust check → folder service graph → SCM/UI → hunk CodeLens → command registration → LM tool registration. All disposables are pushed to `context.subscriptions`.
