# Implementation Plan: Branch-Overlay Workspace

## Vision

A single VS Code workspace where multiple branches coexist simultaneously.
Files can be edited in one place, but each file (or hunk within a file) is
committed to its own designated branch. Branches are stacked in a hierarchy
so the workspace always shows the cumulative top-of-stack state. Worktrees
remain an implementation detail — the user never navigates to a `.worktrees/`
directory directly.

---

## Core Concepts

### Branch Stack

Branches are ordered. Each branch has a base (the one below it, or `main` for
the first). The workspace reflects the cumulative view: base → layer 1 → layer 2.

```
main
  └── feature/docs      (layer 1)
        └── feature/impl  (layer 2)   ← workspace shows this state
```

### File Assignment

Every tracked file has one of three states:
- **Assigned** — explicitly mapped to a branch in the local config
- **Floating** — modified but not yet assigned; the user is warned at commit time
- **Committed** — previously committed to a branch; the assignment is no longer needed

### Local-Only Config

The branch stack and file assignment map are **personal working state**, not team
shared state. Different developers will have different layer structures — what
matters to a collaborator is the committed and pushed branch, not how it was
built. The config is therefore never committed to the repo.

Each developer starts from the current tips of whichever branches they pull and
builds their own local layer arrangement on top.

### Worktree Backing Stores

Each branch in the stack has a corresponding `git worktree` under `.worktrees/`.
These are hidden from the user via `files.exclude`. On file save, the
`WorkspaceSync` engine copies changed files to the owning worktree — making
those files appear as `modified` in that worktree's index.

---

## Configuration Schema

**`.worktrees/local-config.json`** — local only, never committed.

On first use the extension creates this file and automatically adds it (and the
entire `.worktrees/` directory) to `.gitignore`. It is human-readable and
editable, but it is personal scaffolding — equivalent in spirit to
`.vscode/settings.json` or a `.env` file.

Storing it as a file (rather than inside VS Code extension storage) means:
- It survives VS Code reinstalls and extension updates
- It can be inspected or manually edited when needed
- It can be backed up / stashed independently

```json
{
  "version": 1,
  "stack": [
    { "name": "feature/docs",  "color": "#4CAF50", "order": 1, "base": "main" },
    { "name": "feature/impl",  "color": "#2196F3", "order": 2, "base": "feature/docs" }
  ],
  "assignments": {
    "src/foo.ts":  "feature/docs",
    "README.md":   "feature/docs",
    "src/bar.ts":  "feature/impl"
  }
}
```

Properties:
- `stack[].color` — used for file decorations in the Explorer and SCM panels
- `stack[].base` — the branch this one sits on top of; drives rebase suggestions
- `assignments` — relative file paths keyed to branch names; floating files
  are absent from this map

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│  VS Code UI Layer                                       │
│                                                         │
│  Explorer (FileDecorations)   SCM Panel (per branch)   │
│  Branch Stack TreeView        Status Bar Item           │
│  Chunk Assignment Editor      Walkthrough               │
└───────────────────────┬─────────────────────────────────┘
                        │
┌───────────────────────▼─────────────────────────────────┐
│  Extension API  (exported, usable by AI/chat agents)    │
│                                                         │
│  assignFile(path, branch)     getAssignment(path)       │
│  createBranch(name, base)     getStack()                │
│  commitBranch(branch, msg)    getFloatingFiles()        │
│  assignHunk(path, hunk, br)   getBranchStatus(branch)   │
└───────────────────────┬─────────────────────────────────┘
                        │
┌───────────────────────▼─────────────────────────────────┐
│  Core Services                                          │
│                                                         │
│  ConfigService       WorkspaceSync     HunkRouter       │
│  BranchStackService  WorktreeManager   DiffEngine       │
└───────────────────────┬─────────────────────────────────┘
                        │
┌───────────────────────▼─────────────────────────────────┐
│  Git Layer  (existing gitFunctions.ts, extended)        │
│                                                         │
│  git worktree  git apply  git diff  git commit          │
└─────────────────────────────────────────────────────────┘
```

---

## Phase 1 — Foundation

Goal: Config model, worktree provisioning, file assignment, workspace sync.

### 1.1 — ConfigService (`src/configService.ts`)

- Read/write `.worktrees/local-config.json`
- On first write, ensure `.worktrees/` is in `.gitignore` (prompt user if not)
- Expose as a singleton with an `onDidChange` event so views can react
- Validate schema on load; migrate older versions gracefully
- Methods:
  - `getStack(): BranchStackEntry[]`
  - `getAssignment(relativePath: string): string | undefined`
  - `setAssignment(relativePath: string, branch: string): Promise<void>`
  - `removeAssignment(relativePath: string): Promise<void>`
  - `addBranch(entry: BranchStackEntry): Promise<void>`
  - `removeBranch(name: string): Promise<void>`

### 1.2 — BranchStackService (`src/branchStackService.ts`)

- Wraps `ConfigService` + git worktree operations
- On init, create a worktree for each branch in the stack that doesn't have one
- Delete orphaned worktrees (branches removed from the stack)
- Methods:
  - `initStack(): Promise<void>`
  - `addBranchToStack(name: string, base: string, color?: string): Promise<void>`
  - `removeBranchFromStack(name: string): Promise<void>`
  - `reorderStack(newOrder: string[]): Promise<void>`

### 1.3 — WorkspaceSync (`src/workspaceSync.ts`)

- File system watcher on the primary workspace folder
- On save of an assigned file: copy content to the corresponding worktree path
- On save of a floating file: do nothing (but record as "floating dirty")
- Bidirectional: if the worktree file changes externally, sync back to primary
- Handles new file creation and deletion across branches
- Methods:
  - `syncFileToWorktree(uri: vscode.Uri): Promise<void>`
  - `syncWorktreeToFile(uri: vscode.Uri, branch: string): Promise<void>`
  - `getFloatingDirtyFiles(): vscode.Uri[]`

### 1.4 — Bootstrap on Activation

- Auto-add `.worktrees` to `files.exclude` in workspace settings
- Ensure `.worktrees/` is in `.gitignore`; add it silently on first run
  (no prompt needed — it must never be committed)
- Display warning if workspace has uncommitted changes on main that should
  be moved to branches

### Tests (Phase 1)

- `ConfigService`: read/write/migrate, invalid schema handling, `onDidChange`
  firing; `.gitignore` entry created on first write; missing file treated as
  empty (not an error)
- `BranchStackService`: worktree creation on init, orphan cleanup, reorder
- `WorkspaceSync`: save in primary → file appears modified in worktree;
  external worktree change → syncs back; floating file save → no sync

---

## Phase 2 — SCM Integration & UI

Goal: Per-branch SCM providers, Explorer decorations, enhanced tree view,
status bar.

### 2.1 — Per-Branch SCM Providers (`src/branchScmProvider.ts`)

- For each branch in the stack, instantiate a `vscode.SourceControl`
- Each provider's resource groups show:
  - `Staged Changes` — files staged in that branch's worktree
  - `Changes` — unstaged modifications in that worktree
  - `Floating` — files modified in the primary workspace but unassigned
- Commit action on a provider commits that worktree and records the commit
  in `config.json`
- Before committing, if floating files exist: show a **warning** (not a block)
  listing the unassigned files; user can proceed or cancel

### 2.2 — File Decoration Provider (`src/fileDecorationProvider.ts`)

- Implements `vscode.FileDecorationProvider`
- Colours filenames in the Explorer using each branch's configured `color`
- Floating/unassigned dirty files get a distinct neutral badge (e.g. `?`)
- Tooltip shows the branch name and assignment status

### 2.3 — Branch Stack Tree View (rewrite of `WorktreeView`)

- Tree structure:
  ```
  ▼ feature/docs   🟢
    ▼ Staged Changes
        README.md
    ▼ Changes
        src/foo.ts
  ▼ feature/impl   🔵
    ▼ Changes
        src/bar.ts
  ▼ Floating (unassigned)
      src/config.ts  ⚠
  ```
- Right-click on a file node → "Assign to branch" QuickPick
- Right-click on a branch node → branch actions (lock, delete, open in new window)
- Drag-and-drop file between branch nodes to reassign

### 2.4 — Status Bar Item

- Shows count of floating dirty files: `$(warning) 3 unassigned`
- Click opens the tree view filtered to floating files

### 2.5 — "Assign File to Branch" Command

- Available from: Explorer context menu, TreeView context menu, Command Palette
- Opens a QuickPick listing branches in stack order
- Sets assignment in `config.json` and triggers `WorkspaceSync`

### Tests (Phase 2)

- `BranchScmProvider`: resource groups populated correctly; floating warning
  shown; commit flow end-to-end
- `FileDecorationProvider`: colour correct per assignment; floating files get
  badge; decorations update when config changes
- Tree view: structure matches stack config; right-click assign updates config;
  drag-drop reassigns
- Status bar: count reflects floating dirty files; updates on save

---

## Phase 3 — Chunk-Level Assignment

Goal: Assign individual diff hunks to different branches.

### 3.1 — DiffEngine (`src/diffEngine.ts`)

- Given a file URI, computes hunks against the merge-base for each branch
- Returns a structured list of `DiffHunk` objects:
  ```typescript
  interface DiffHunk {
    startLine: number
    endLine: number
    content: string
    currentBranch: string | undefined  // which branch owns this hunk if any
  }
  ```
- Uses `git diff --unified=0` against each worktree's merge-base

### 3.2 — HunkRouter (`src/hunkRouter.ts`)

- Accepts a file and a map of `hunkIndex → branchName`
- Generates a separate patch per branch using `git diff` output
- Applies each patch to the appropriate worktree via `git apply`
- Removes the hunk from the primary workspace content if all its hunks are
  assigned (the worktree becomes the source of truth for those lines)

### 3.3 — Chunk Assignment Editor

- **Preferred**: hook into VS Code's native diff editor via
  `vscode.commands.executeCommand('vscode.diff', ...)` and register a
  `CodeLensProvider` that adds "Assign to branch" lenses above each hunk
  in the diff view
- **Fallback**: custom webview panel showing the diff with per-hunk branch
  pickers if native diff editor hooks prove insufficient
- Command: `multi-branch-checkout.assignHunks` — opens the chunk editor for
  the current file

### 3.4 — Overlap Detection

- Warn (not block) when two branches are assigned overlapping line ranges
  of the same file
- Surface via a diagnostic in the Problems panel using
  `vscode.languages.createDiagnosticCollection`

### Tests (Phase 3)

- `DiffEngine`: hunk extraction for modified, deleted, added files; merge-base
  detection
- `HunkRouter`: correct patches generated per branch; patches applied cleanly;
  overlap detection triggers warning
- Chunk editor: CodeLens present on diff view; hunk assignment round-trip

---

## Phase 4 — Branch Hierarchy & Stacking

Goal: Branches that are layered can be rebased as the parent evolves.

### 4.1 — Cumulative Workspace View

- When the workspace opens a file, resolve its content through the stack:
  base → layer 1 → layer 2 → …
- Uses `git show <branch>:<file>` to get each layer's committed state, then
  applies uncommitted diffs on top
- This ensures the workspace always reflects the "if all branches were merged"
  state

### 4.2 — Rebase Suggestions

- When a parent branch receives new commits, detect child branches that need
  rebasing
- Show a notification: "feature/impl is 3 commits behind feature/docs — rebase?"
- Offer "Rebase now" which runs `git rebase` in the child worktree and then
  re-syncs

### 4.3 — PR Awareness (optional, feature-flagged)

- If `vscode.github-pullrequests` extension is available, surface the PR status
  (open/draft/merged) as a decoration on each branch node in the tree view
- No hard dependency — gracefully absent if not installed

### Tests (Phase 4)

- Cumulative view: content resolves through stack correctly; uncommitted diffs
  applied on top
- Rebase suggestion: triggered when parent branch has new commits; rebase runs
  cleanly in worktree; sync follows

---

## Phase 5 — AI / Chat Agent Integration

Goal: The extension's core operations are exposed in a way that AI agents
(GitHub Copilot chat, MCP tools, other automation) can drive the extension
programmatically.

### 5.1 — Rich Extension API (`src/@types/MultiBranchCheckoutAPI.d.ts`)

Expand the existing stub into a full exported API:

```typescript
export interface MultiBranchCheckoutAPI {
  // Stack management
  getStack(): BranchStackEntry[]
  addBranch(name: string, base: string, options?: BranchOptions): Promise<void>
  removeBranch(name: string): Promise<void>

  // File assignment
  getAssignment(relativePath: string): string | undefined
  assignFile(relativePath: string, branch: string): Promise<void>
  assignHunk(relativePath: string, startLine: number, endLine: number, branch: string): Promise<void>
  unassignFile(relativePath: string): Promise<void>
  getFloatingFiles(): string[]

  // Status
  getBranchStatus(branch: string): Promise<BranchStatus>
  getStackStatus(): Promise<StackStatus>

  // Actions
  commitBranch(branch: string, message: string, options?: CommitOptions): Promise<void>
  stageBranch(branch: string, files?: string[]): Promise<void>

  // Events
  onDidChangeAssignment: vscode.Event<AssignmentChangeEvent>
  onDidChangeStack: vscode.Event<StackChangeEvent>
}
```

### 5.2 — Language Model Tool Registration

Register the extension's operations as VS Code Language Model Tools
(`vscode.lm.registerTool`) so that Copilot chat (and any LM that supports
tool-use) can call them natively in chat:

| Tool name | Description |
|---|---|
| `mbc_getStack` | Returns the current branch stack and assignments |
| `mbc_assignFile` | Assigns a file to a branch |
| `mbc_assignHunk` | Assigns specific line range in a file to a branch |
| `mbc_getFloatingFiles` | Lists files with uncommitted changes but no branch |
| `mbc_commitBranch` | Commits all staged changes on a branch |
| `mbc_getBranchStatus` | Returns staged/unstaged/floating status for a branch |
| `mbc_addBranch` | Adds a new branch to the stack |

This enables natural language workflows like:

> "Assign all documentation changes to the docs branch and stage them"
> "What files are floating right now?"
> "Commit the impl branch with message 'add payment service'"

### 5.3 — MCP Server (stretch goal)

Expose the same operations via an MCP (Model Context Protocol) server
process embedded in the extension, making the extension drivable by any
MCP-compatible AI client outside VS Code.

### Tests (Phase 5)

- Extension API: all exported methods callable from test harness; events fire
  on state changes
- LM tool registration: tools registered at activation; tool calls invoke
  correct API methods; tool results are correctly serialised

---

## Phase 6 — Polish & Hardening

### 6.1 — Test Coverage

- Target: **>80% line coverage** across all source files
- All phases have test stubs written before implementation (TDD where practical)
- Test categories:
  - Unit tests: pure functions, services in isolation (mock git commands)
  - Integration tests: git operations against a real temp repo (extend `proj1.test.ts` pattern)
  - UI tests: TreeView structure, decoration colours, SCM provider resource groups
- CI enforces coverage threshold via `nyc`/`c8`

### 6.2 — Error Handling

- All git operations wrapped with typed errors (`GitError`, `WorktreeNotFoundError`)
- User-facing errors shown via `vscode.window.showErrorMessage` with an
  "Open Logs" action
- Graceful degradation: if a worktree is missing or corrupted, offer repair

### 6.3 — Performance

- Debounce `WorkspaceSync` on rapid saves (200ms)
- Lazy-load worktree status — only compute when the SCM panel is visible
- Cache `git status` results and invalidate on file watcher events

### 6.4 — Onboarding Walkthrough

- Fill in the existing `walkthroughs: []` in `package.json`
- Steps: add your first branch, assign a file, make a commit, add a layer

### 6.5 — Settings

```json
"multi-branch-checkout.syncDebounceMs": 200,
"multi-branch-checkout.showFloatingWarningOnCommit": true,
"multi-branch-checkout.prDecorationsEnabled": true,
"multi-branch-checkout.defaultBranchColor": "#888888"
```

---

## What Changes vs What Stays

| Existing | Disposition |
|---|---|
| `gitFunctions.ts` — `git worktree` commands | **Keep, extend** with `diffIndexWith`, `apply`, `show` |
| `worktreeNodes.ts` — `WorktreeRoot`, `WorktreeFile`, node map | **Keep, adapt** — nodes become per-branch-stack entries |
| `worktreeView.ts` — `TreeDataProvider` | **Rewrite** with new stack-oriented tree structure |
| `commands.ts` — `MultiBranchCheckoutAPI` | **Extend** — add assignment, hunk, LM tool methods |
| `extension.ts` — activation, file watchers | **Extend** — add `ConfigService`, `WorkspaceSync`, LM tools |
| `worktreeDecorator.ts` | **Rewrite** as `FileDecorationProvider` with per-branch colours |
| `channelLogger.ts`, `errors.ts`, `utils.ts` | **Keep as-is** |
| `test/proj1.test.ts` — integration test harness | **Keep, expand** significantly per phase |
| `@types/MultiBranchCheckoutAPI.d.ts` | **Rewrite** with full exported API surface |

---

## Open Questions

- Native diff editor CodeLens feasibility needs a spike before Phase 3
  implementation begins — fall back to webview if VS Code's diff editor API
  doesn't expose hunk positions to extensions
- MCP server (Phase 5.3) depends on whether VS Code's extension host can
  run an MCP listener process; investigate `node:net` / stdio options

---

## Delivery Order

```
Phase 1  →  Phase 2  →  Phase 3  →  Phase 5 (API + LM tools)
                  ↘                      ↗
                   Phase 4 (stacking) ──┘

Phase 6 runs in parallel with all phases (tests written alongside each feature)
```
