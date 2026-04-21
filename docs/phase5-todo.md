# Phase 5 — Exported API & LM Tools: Todo & Progress

**Goal**: Expose a typed public API for other extensions; register VS Code language
model tools so AI chat agents can interact with the branch stack programmatically.

---

## Status Legend
- `[ ]` Not started
- `[~]` In progress
- `[x]` Complete

---

## 5.1 — API type definitions (`src/@types/MultiBranchCheckoutAPI.d.ts`)

- [x] `MultiBranchCheckoutExportedAPI` interface — full public surface:
  - Stack: `getStack()`, `addBranch()`, `removeBranch()`
  - Assignment: `getAssignment()`, `assignFile()`, `assignHunk()`, `unassignFile()`,
    `getFloatingFiles()`
  - Status: `getBranchStatus()`, `getStackStatus()`
  - Actions: `commitBranch()`, `stageBranch()`
  - Events: `onDidChangeAssignment`, `onDidChangeStack`
- [x] `BranchOptions` interface: `color?: string`
- [x] `CommitOptions` interface: `noGpgSign?: boolean`, `stageAll?: boolean`
- [x] Replaced old 3-method stub (which had typo `MultiBrnachCheckoutAPI`)

---

## 5.2 — MbcApi implementation (`src/mbcApi.ts`)

- [x] `MbcApi implements MultiBranchCheckoutExportedAPI`
- [x] Constructor receives `configService`, `branchStack`, `workspaceSync`, `workspaceRoot`
- [x] `getStack()` → `configService.getStack()`
- [x] `addBranch(name, base, opts)` → `branchStack.addBranchToStack(name, base, opts?.color)`
- [x] `removeBranch(name, force)` → `branchStack.removeBranchFromStack(name, force)`
- [x] `getAssignment(rel)` → `configService.getAssignment(rel)`
- [x] `assignFile(rel, branch)` → `configService.setAssignment(rel, branch)`
- [x] `assignHunk(rel, idx, branch)` → `configService.setHunkAssignment(rel, idx, branch)`
- [x] `unassignFile(rel)` → `configService.removeAssignment(rel)`
- [x] `getFloatingFiles()` → `[...workspaceSync.getFloatingDirty()]`
- [x] `getBranchStatus(branch)` → runs `git status --porcelain=v1 -z` in the branch's worktree
- [x] `getStackStatus()` → aggregates `getBranchStatus` for every stack entry
- [x] `commitBranch(branch, message, opts)` — optional `stageAll` and `noGpgSign` flags
- [x] `stageBranch(branch, files?)` — stages specified files or all tracked changes
- [x] `onDidChangeAssignment` / `onDidChangeStack` — proxied from `configService`

---

## 5.3 — LM tools registration (`src/lmTools.ts`)

- [x] `registerLmTools(api): vscode.Disposable[]` — returns disposables
- [x] 7 tools registered via `vscode.lm.registerTool()`:
  - `mbc_getStack` — returns JSON array of `BranchStackEntry`
  - `mbc_assignFile` — assigns a file to a named branch (with confirmation message)
  - `mbc_assignHunk` — assigns a hunk by index (with confirmation message)
  - `mbc_getFloatingFiles` — returns list of unassigned modified files
  - `mbc_commitBranch` — stages all and commits to named branch (with confirmation)
  - `mbc_getBranchStatus` — returns `BranchStatus` JSON for a branch
  - `mbc_addBranch` — creates and stacks a new branch (with confirmation)
- [x] Each tool implements `prepareInvocation` with human-readable `invocationMessage`
- [x] Graceful degradation: catches registration errors for older VS Code versions

---

## 5.4 — Extension wiring (`src/extension.ts`)

- [x] Imports added for `StackResolver`, `RebaseSuggestionService`, `MbcApi`, `registerLmTools`
- [x] `MbcApi` instantiated after Phase 4 block
- [x] LM tool disposables pushed to `context.subscriptions`
- [x] `activate()` now returns `mbcExportedApi` instead of legacy `api`

---

## 5.5 — Tests (`test/phase45.test.ts`)

- [x] `rs.1` – `rs.3` — rebase service git primitives
- [x] `mt.1` — `activate()` exports object with correct method signatures
- [x] `mt.2` — `getStack()` returns an array
- [x] `mt.3` — `getFloatingFiles()` returns an array

---

## Commit

- [x] Committed as `feat(phase5): exported API and LM tools registration` (beeb00f)
