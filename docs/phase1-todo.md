# Phase 1 — Foundation: Todo & Progress

**Goal**: Config model, worktree provisioning, file assignment, workspace sync.

---

## Status Legend
- `[ ]` Not started
- `[~]` In progress
- `[x]` Complete
- `[!]` Blocked / difficulty — see notes

---

## 1.1 — Config Types (`src/configTypes.ts`)

- [x] `BranchStackEntry` interface (`name`, `color`, `order`, `base`)
- [x] `BranchConfig` root interface (`version`, `stack`, `assignments`)
- [x] `AssignmentMap` type alias (`Record<string, string>`)
- [x] `BranchStatus` interface (used by API and SCM layer)
- [x] `AssignmentChangeEvent` and `StackChangeEvent` event types
- [x] Schema version constant and migration helper stub

---

## 1.2 — Error Types (`src/errors.ts`)

- [x] `ConfigError` — malformed or unreadable config file
- [x] `SyncError` — file copy/sync failure between workspace and worktree
- [x] `BranchStackError` — invalid stack operations (circular base, unknown branch)

---

## 1.3 — ConfigService (`src/configService.ts`)

- [x] Read `.worktrees/local-config.json` (missing file = empty config, not error)
- [x] Write config atomically (write to temp file then rename)
- [x] Validate schema on load; log warning and return empty config if invalid
- [x] `onDidChange` EventEmitter — fires after every successful write
- [x] `getStack()` — returns ordered stack entries
- [x] `getAssignment(relativePath)` — returns branch name or `undefined`
- [x] `setAssignment(relativePath, branch)` — updates assignments map + writes
- [x] `removeAssignment(relativePath)` — removes from map + writes
- [x] `addBranch(entry)` — appends to stack, auto-assigns `order` if absent
- [x] `removeBranch(name)` — removes from stack, clears any assignments for that branch
- [x] On first write: ensure `.worktrees/` is in `.gitignore` (add silently)
- [x] Schema migration: version 1 → future versions

**Difficulties / Notes**:
- None blocking. Atomic write via temp file avoids corruption on crash.

---

## 1.4 — BranchStackService (`src/branchStackService.ts`)

- [x] `initStack()` — for each branch in config stack, create worktree if missing
- [x] `addBranchToStack(name, base, color?)` — creates git branch + worktree + updates config
- [x] `removeBranchFromStack(name)` — removes worktree + removes from config
- [x] `reorderStack(newOrder)` — updates `order` field on each entry + writes config
- [x] Prune orphaned worktrees (worktrees in `.worktrees/` with no config entry)
- [x] Guard against circular base references
- [x] Guard against creating a worktree for a branch that is currently checked out (git restriction)

**Difficulties / Notes**:
- `git worktree add` will fail if the branch is already checked out in another
  worktree. `BranchStackService` checks for this and surfaces a clear error.
- Worktree names under `.worktrees/` are derived from the branch name by
  replacing `/` with `-` to avoid directory nesting issues.

---

## 1.5 — WorkspaceSync (`src/workspaceSync.ts`)

- [x] File system watcher on the primary workspace folder (reuses existing watcher pattern)
- [x] On save of an assigned file: copy content to owning worktree path (create dirs if needed)
- [x] On save of a floating file: record URI in floating dirty set; do NOT sync
- [x] `getFloatingDirtyFiles()` — returns current set of floating dirty URIs
- [x] `clearFloatingDirty(uri)` — removes from set (called when file is assigned)
- [x] On assignment change event from ConfigService: immediately sync newly assigned file
- [x] On worktree external change (file watcher): sync back to primary workspace
- [x] Debounce rapid saves (200ms default, configurable via settings)
- [x] Handle file deletions: if assigned file deleted in primary, delete in worktree
- [x] Handle new file creation: if new file saved and assigned, create in worktree

**Difficulties / Notes**:
- Bidirectional sync risk: syncing from worktree back to primary could trigger
  another sync outward. Guard with a `_syncing` flag to break the cycle.
- External worktree changes are only relevant during `git rebase` or manual
  worktree operations. The sync-back is best-effort and logged.

---

## 1.6 — Bootstrap (`src/extension.ts`)

- [x] Instantiate `ConfigService` singleton at activation
- [x] Instantiate `BranchStackService`, call `initStack()` at activation
- [x] Instantiate `WorkspaceSync`, pass `ConfigService` reference
- [x] Auto-add `.worktrees` to `files.exclude` in workspace settings on first run
- [x] Ensure `.worktrees/` in `.gitignore` on activation (silent, no prompt)
- [x] Register `multi-branch-checkout.assignFile` command
- [x] Register `multi-branch-checkout.unassignFile` command
- [x] Register `multi-branch-checkout.addBranch` command (QuickInput for name + base)
- [x] Register `multi-branch-checkout.removeBranch` command
- [x] Dispose all new services in `context.subscriptions`

---

## 1.7 — Tests

### ConfigService tests (`test/configService.test.ts`)
- [x] Reads valid config correctly
- [x] Missing file returns empty config (no error)
- [x] Malformed JSON returns empty config + logs warning
- [x] `setAssignment` writes and fires `onDidChange`
- [x] `removeAssignment` cleans entry from map
- [x] `addBranch` appends to stack with correct order
- [x] `removeBranch` removes stack entry and clears associated assignments
- [x] `.gitignore` entry written on first write if absent
- [x] Schema migration stub executes without error for version 1

### BranchStackService tests (`test/branchStackService.test.ts`)
- [x] `initStack` creates worktrees for each config branch
- [x] `initStack` skips branches that already have a worktree
- [x] `addBranchToStack` creates branch + worktree + updates config
- [x] `removeBranchFromStack` removes worktree + config entry
- [x] Orphan worktree pruned on init
- [x] Circular base reference rejected with `BranchStackError`
- [x] Already-checked-out branch surfaces correct error

### WorkspaceSync tests (`test/workspaceSync.test.ts`)
- [x] Assigned file save → file appears modified in worktree
- [x] Floating file save → NOT synced, added to floating dirty set
- [x] Assignment change → file immediately synced to new worktree
- [x] File deletion in primary → deleted in worktree
- [x] Debounce: rapid saves only trigger one sync
- [x] Sync loop guard: external worktree change does not cause infinite loop

---

## Commit Plan

| Commit | Contents |
|--------|----------|
| `feat: add config types and extended error classes` | `configTypes.ts`, updated `errors.ts` |
| `feat: implement ConfigService with gitignore bootstrap` | `configService.ts` + tests |
| `feat: implement BranchStackService` | `branchStackService.ts` + tests |
| `feat: implement WorkspaceSync` | `workspaceSync.ts` + tests |
| `feat: wire Phase 1 services into extension activation` | updated `extension.ts`, new commands |

---

## Known Gaps / Future Work

- `WorkspaceSync` bidirectional sync (worktree → primary) is best-effort; a
  full conflict-detection pass is deferred to Phase 3 (chunk assignment).
- The `reorderStack` command has no UI yet — config can be edited manually.
  A drag-and-drop tree UI is Phase 2.
- `ConfigService` schema migration is stubbed but only handles version 1 today.
  Future versions add migration steps here.

---

## Delivered — Summary (2025-04)

All 5 planned commits landed on `main`. Below is what was actually shipped
versus what was planned.

### What was shipped

| File | Commit | Notes |
|------|--------|-------|
| `src/configTypes.ts` | `349d134` | All types, `emptyConfig()`, `isValidConfig()`, `migrateConfig()` |
| `src/errors.ts` | `349d134` | `ConfigError`, `SyncError`, `BranchStackError`; fixed `NotImplementedError` typo |
| `src/configService.ts` | `5ed735c` | Singleton, atomic writes, `.gitignore` bootstrap, full event system |
| `test/configService.test.ts` | `5ed735c` | 22 mocha tests |
| `src/branchStackService.ts` | `ad346b6` | Worktree lifecycle, orphan pruning, cycle detection, branch-name validation |
| `test/branchStackService.test.ts` | `ad346b6` | 12 tests covering all key paths |
| `src/workspaceSync.ts` | `dcd89da` | Copy-on-save routing, floating tracking, debounce, `_syncing` guard |
| `test/workspaceSync.test.ts` | `dcd89da` | 7 tests including sync, floating, debounce, exclusion |
| `src/extension.ts` | `77b6b09` | Services wired at activation; 4 new commands registered |
| `docs/PLAN.md` | `77b6b09` | Six-phase roadmap |
| `docs/phase1-todo.md` | `77b6b09` | This file |

### Deviations from plan

- `WorkspaceSync` sync-back from worktree to primary is guarded by `_syncing`
  flag (planned) but the *external-change watcher* path (watching `.worktrees/`
  for changes by git operations) was left as a stub — it logs but does not yet
  copy back. Full bidirectional sync deferred to Phase 3.
- No UI for `reorderStack` — command exists but there is no QuickPick flow;
  users must edit `local-config.json` manually. Tree UI deferred to Phase 2.
- `files.exclude` injection (auto-hide `.worktrees/` in Explorer) was wired
  in the helper call `filesExcludeWorktreesDir()` that already existed from the
  original extension — no new code needed.

### Test coverage

- **ConfigService**: 22 tests — read/write, atomic write, `.gitignore` creation,
  `onDidChange` firing, schema migration stub, missing-file → empty config.
- **BranchStackService**: 12 tests — `initStack`, add/remove, orphan pruning,
  cycle detection, already-checked-out guard.
- **WorkspaceSync**: 7 tests — assigned-file copy, nested dir creation, floating
  tracking, assignment-change triggers sync, debounce, `.worktrees/` exclusion.
