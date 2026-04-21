# Architecture Review

## Overview

GitBraid is a VS Code extension for multi-branch development in a single workspace. The
core idea — assign files (or individual diff hunks) to git branches backed by worktrees,
then sync changes automatically — is novel and well-executed. The architecture reflects
careful layered thinking.

## Layered Design

```
VS Code UI  (TreeView, SCM panels, CodeLens, decorations)
     ↓
Commands / Extension entry point  (extension.ts, commands.ts)
     ↓
Public API  (mbcApi.ts, lmTools.ts)
     ↓
Core services  (ConfigService, BranchStackService, WorkspaceSync,
                DiffEngine, HunkRouter, StackResolver,
                RebaseSuggestionService)
     ↓
Git primitives  (gitFunctions.ts — wraps `git` CLI via child_process)
```

Each layer has a clear responsibility and the seams between them are well-defined. This
makes the codebase easy to navigate and extend.

## What Works Well

**Singleton services with explicit reset hooks.** `ConfigService`, `BranchStackService`,
and `WorkspaceSync` all expose `resetInstance()` for tests. This is the right pattern
for VS Code extensions where DI containers are overkill.

**Event-driven decoupling.** `onDidChangeAssignment`, `onDidChangeStack`, `onDidSyncFile`,
and `onDidFloatFile` allow UI components to react to state changes without polling or
tight coupling. The EventEmitter pattern is used consistently throughout.

**Atomic config writes.** `ConfigService._writeToDisk()` writes to a `.tmp` file then
renames, preventing corruption on crash. Small but important detail.

**Self-contained hunk patches.** Every `DiffHunk.patch` includes the file header so it
can be applied in isolation via `git apply`. This design decision unlocks the routing
feature cleanly.

**Path normalisation at the boundary.** Forward-slash normalisation happens once in
`normalisePath()` before anything touches the config, keeping the rest of the codebase
free of OS-specific path logic.

## Concerns

### Singleton proliferation

Three services use the singleton pattern. While this works, it means any code can call
`ConfigService.getInstance()` and mutate global state. As the codebase grows, tracing
data flow becomes harder. Consider passing service instances through constructors
everywhere (which `BranchStackService` and `WorkspaceSync` already do when a `config`
argument is supplied) and reserving `getInstance()` for the extension entry point only.

### `extension.ts` is too large

At ~460 lines, `extension.ts` handles activation phases, command registration, file
excludes, `.gitignore` management, SCM panel setup, and watcher wiring. Each of those
five concerns deserves its own module. Suggested split:

| New module | Responsibility |
|---|---|
| `activation/gitignore.ts` | Ensure `.worktrees/` is excluded from git and VS Code |
| `activation/scm.ts` | Create and tear down per-branch SCM providers |
| `activation/commands.ts` | Register all `vscode.commands.registerCommand` calls |
| `activation/watchers.ts` | Set up file-system and git-index watchers |

`extension.ts` would then be a thin orchestrator: init services, call each activator,
collect disposables.

### `WORKTREES_DIR` constant is duplicated

The string `'.worktrees'` is defined as a `const` in both `configService.ts` and
`branchStackService.ts`. One canonical location (e.g., `constants.ts`) would prevent
the two from drifting.

### The worktree-view subsystem is a parallel world

`worktreeNodes.ts`, `worktreeView.ts`, and `commands.ts` contain a substantial secondary
UI and command set that appears to predate the branch-stack approach (lots of commented-
out code, `NotImplementedError` throws, `TODO` comments). It is unclear which parts are
live and which are vestigial. Dead code should be removed; live code should be
integrated into the same data model as the branch stack.

### No graceful degradation when git is missing

`gitFunctions.ts` throws immediately at module load time if the `vscode.git` extension
is absent:

```typescript
if (!gitExtension) {
    throw new Error('Git extension not found')
}
```

A module-level throw terminates the entire extension with no user-visible error. This
should be caught during activation and surfaced as an informative message.

## Missing Architectural Pieces

**No undo/redo support.** Assigning a file to a branch or routing a hunk is
irreversible from the UI. A simple command stack (last N actions with their inverse)
would significantly reduce accidental-action anxiety.

**No cross-window awareness.** Two VS Code windows open on the same repository will
both write `.worktrees/local-config.json` without awareness of each other. A file-lock
or optimistic-concurrency scheme (read version, compare before write) is needed before
multi-window use is safe.

**No offline/degraded mode.** If git operations fail (no network for a remote ref,
locked index, corrupted worktree) the extension largely fails silently. A status
indicator showing the health of each worktree would help users diagnose problems.
