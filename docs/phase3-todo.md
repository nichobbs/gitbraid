# Phase 3 — Chunk-Level Assignment: Todo & Progress

**Goal**: Assign individual diff hunks to different branches. CodeLens lenses
above each hunk let the user choose the target branch without leaving the editor.

---

## Status Legend
- `[ ]` Not started
- `[~]` In progress
- `[x]` Complete
- `[!]` Blocked / difficulty — see notes

---

## 3.1 — DiffEngine (`src/diffEngine.ts`)

- [x] `DiffHunk` interface: `index`, `startLine`, `endLine`, `header`, `patch`
- [x] `parseDiffHunks(unifiedDiff: string): DiffHunk[]` — parse `git diff` output
- [x] `DiffEngine.getHunksForFile(wsRoot, relativePath)` — `git diff HEAD -- <file>`, returns hunks
- [x] `DiffEngine.getMergeBase(wsRoot, branch1, branch2)` — `git merge-base`
- [x] `DiffEngine.getHunksAgainstBranch(wsRoot, relativePath, branch)` — diff vs merge-base
- [x] Handles added/deleted/modified files gracefully (no output = no hunks)

---

## 3.2 — HunkRouter (`src/hunkRouter.ts`)

- [x] `HunkAssignment`: map of `hunkIndex → branchName`
- [x] `HunkRouter.routeFile(wsRoot, relativePath, assignments)` — for each branch in
      assignments, build a patch from that branch's hunks and `git apply` it in the worktree
- [x] `HunkRouter.detectOverlaps(hunks, assignments)` — returns pairs of conflicting assignments
- [x] `git apply --index` in worktree so changes are staged automatically
- [ ] On success: remove hunk assignments from config for fully-routed hunks (handled in extension.ts command)
- [x] Error handling: if `git apply` fails, surface error with `showErrorMessage`

---

## 3.3 — Hunk CodeLens Provider (`src/hunkCodeLensProvider.ts`)

- [x] Implements `vscode.CodeLensProvider`
- [x] Registered for all language IDs on workspace files (excluding `.worktrees/`)
- [x] `provideCodeLenses`: run `DiffEngine.getHunksForFile` for the active document;
      return one `CodeLens` per hunk at the hunk's start line
- [x] CodeLens title: `$(git-commit) Assign hunk to branch…` (or branch name if already assigned)
- [x] `resolveCodeLens`: fills in the command (`multi-branch-checkout.assignHunk`)
- [x] Refreshes when config changes (`ConfigService.onDidChangeAssignment`) or file saves
- [x] Performance: cache last diff result per file, invalidate on save

---

## 3.4 — Overlap Diagnostics (`src/overlayDiagnostics.ts`)

- [x] Creates `vscode.languages.createDiagnosticCollection('multi-branch-checkout')` (in hunkCodeLensProvider.ts)
- [x] After every `HunkRouter.routeFile`, re-check overlaps; post as `Warning` diagnostics
- [x] Clears diagnostics for a file when all hunks are unassigned
- [x] Listens to `ConfigService.onDidChangeAssignment` to trigger refresh

---

## 3.5 — Bootstrap in `extension.ts`

- [x] Instantiate `DiffEngine` and pass to `HunkRouter` and `HunkCodeLensProvider`
- [x] Register `HunkCodeLensProvider` via `vscode.languages.registerCodeLensProvider`
- [x] Register `OverlayDiagnostics` and push to subscriptions
- [x] Register `multi-branch-checkout.assignHunk` command (opens the CodeLens flow)
- [x] Register `multi-branch-checkout.routeHunks` command (bulk-route all assigned hunks for current file)

---

## 3.6 — Tests

### DiffEngine tests (`test/diffEngine.test.ts`)
- [x] Parse unified diff with single hunk
- [x] Parse unified diff with multiple hunks
- [x] Empty diff (no changes) returns empty array
- [x] Added file (no context lines) parses correctly
- [x] `getHunksForFile` returns hunks after workspace file change

### HunkRouter tests (`test/hunkRouter.test.ts`)
- [x] Route single hunk to single branch: file appears modified in worktree
- [x] Route multiple hunks to different branches: each worktree gets correct changes
- [x] Overlap detection: two hunks on overlapping lines → returns overlap pairs
- [x] No overlap: adjacent hunks on different branches → no overlap reported

---

## Commit Plan

| Commit | Contents |
|--------|----------|
| `feat: add DiffEngine for hunk extraction` | `diffEngine.ts` + tests |
| `feat: add HunkRouter for patch routing to worktrees` | `hunkRouter.ts` + tests |
| `feat: add hunk CodeLens and overlap diagnostics` | `hunkCodeLensProvider.ts`, `overlayDiagnostics.ts` |
| `feat: wire Phase 3 chunk assignment into extension` | updated `extension.ts` |

---

## Known Gaps / Future Work

- `git apply` in the worktree requires the worktree to exist (BranchStackService
  must have initialised). Gracefully error if worktree missing.
- Hunk-level assignments are not persisted in `local-config.json` yet —
  they are applied immediately. Persistence deferred to a later pass.
- Interactive staging (partial file staging via git add -p equivalent) is
  deferred; current implementation routes entire hunks atomically.
