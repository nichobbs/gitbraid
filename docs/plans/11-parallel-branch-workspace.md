# Plan 11 — Parallel-Branch Workspace

**Inspiration:** GitButler's virtual branches view; the user need to see and
edit multiple independent branches simultaneously without losing track of
which changes belong where.

**Status:** Design / pre-implementation.

---

## Problem

The current GitBraid model routes file saves to per-branch worktrees based on
explicit file (or hunk) assignments. This causes two concrete pain points:

1. **Opaque workspace state.** When multiple branches are active, the
   workspace file content is determined by whichever branch was last applied
   via `WorkspaceSync`. Lines that "belong to" another branch may appear as
   local modifications (or missing), making `git diff` output confusing
   and the workspace state mentally hard to track.

2. **Late conflict detection.** Conflicts between branches are only discovered
   at rebase time, after the user has already invested time in both branches.
   There is no signal at the point when a second branch starts touching the
   same file/region as a first.

---

## Proposed Model

### Core idea

Each branch in the stack is independently branched off a common **root
branch** (e.g. `main`). The workspace is a *synthetic integrated view*:

```
root ──┬── branch A   diff_A = git diff root..A
       ├── branch B   diff_B = git diff root..B
       └── branch C   diff_C = git diff root..C
```

Workspace file content = root file content + all diffs applied simultaneously.
Each hunk is attributed to its source branch and rendered with that branch's
colour as a gutter decoration. The workspace itself is never committed;
it is purely an integrated view for editing convenience.

### What "stacking" means in this model

Branches are **parallel**, not sequential. There is no ordering dependency
between A, B, and C — each is independently rebased onto root when submitted.
The word "stack" continues to refer to the *set* of branches managed by
GitBraid in a given workspace; it does not imply a linear chain.

(Linear/stacked PRs where B targets A are still supported as a separate
workflow — plan 01 — but are not the primary mental model for parallel
editing.)

---

## Root Branch

### Configuration

A new top-level field `"root"` in `gitbraid-config.json`:

```jsonc
{
  "version": 1,
  "root": "main",          // ← new
  "stack": [ … ],
  "assignments": { … }
}
```

Default resolution order when `root` is absent:
1. Prompt user on first `addBranch` call.
2. Suggest the upstream tracking branch of the current HEAD, or `main` /
   `master` / `develop` (first that exists locally).

### Changing the root later

A `GitBraid: Change Root Branch` command. Changing root:
1. Recomputes `git diff newRoot..branch` for every branch.
2. Re-evaluates all hunk attributions against the new diffs.
3. Warns if any previously-resolved overlaps need re-resolution.
4. Rebuilds the workspace worktree (see below).

---

## Workspace Worktree

The workspace (the folder the user has open in VS Code) becomes a dedicated
git worktree checked out at `root`. It is *never* committed. All edits are
applied to this worktree only for viewing/editing purposes and are routed to
the correct per-branch worktree via the existing `WorkspaceSync` / `HunkRouter`
machinery on save.

This is a change from the current model where the workspace is whatever was
checked out by the user. The migration path:

1. On first activation after upgrade, if the workspace is not already on
   `root`, GitBraid offers: *"Switch workspace to root branch for integrated
   view? Your current HEAD will be preserved."*
2. The user can opt out; in that case GitBraid falls back to the current
   overlay behaviour with a persistent status-bar warning.

---

## Hunk Attribution

### Auto-attribution on add-branch

When a branch is added:
1. Run `git diff root..branch --unified=0` to get the branch's hunk list.
2. For each hunk in the diff:
   - If the hunk's line range does not overlap with any existing attributed
     hunk → auto-attribute to the new branch. No user action needed.
   - If the hunk overlaps with an existing attributed hunk → surface a
     conflict (see below).
3. Apply the hunk to the workspace worktree file.
4. Fire the gutter decoration refresh.

### Auto-attribution on remove-branch

1. Revert the branch's attributed hunks from the workspace worktree file.
2. Release those line ranges from the attribution map.

### Whole-file attribution

If a file has hunks attributed to only one branch (or is a new file on only
one branch), the entire file is attributed to that branch. No hunk
granularity is stored. This matches current behaviour for new files.

### New edits in the workspace

An edit to an already-attributed line range → remains attributed to that
branch; the edit is routed to that branch's worktree on save (existing
`HunkRouter` behaviour).

An edit to an unattributed line range (base code, not changed by any branch)
→ treated as a floating change; a CodeLens or gutter action prompts
assignment to a branch.

---

## Overlap / Conflict Resolution

When two branches modify overlapping line ranges in the same file, GitBraid
surfaces a conflict dialog *at add-branch time*, not at rebase time:

```
Branch "feature/B" modifies lines 14–22 of src/api.ts,
which are also modified by "feature/A".

How should the workspace show this?
  [A wins]  [B wins]  [Show both — I'll edit manually]
```

- **A wins / B wins:** The winning branch's hunk is displayed; the other
  branch's hunk is recorded as "suppressed" in the attribution map but still
  routed to that branch's worktree for commit purposes. On PR submission, both
  PRs carry their own independent diffs relative to root — the suppression is
  a *display* decision only.
- **Show both:** GitBraid applies both hunks (A's version above B's, or the
  user can reorder). The merged result is displayed with both branch colours.
  The boundary between the two regions is stored explicitly.

Resolution choices are persisted in `gitbraid-config.json` under
`"overlapResolutions"` so they survive restarts:

```jsonc
"overlapResolutions": [
  {
    "file": "src/api.ts",
    "range": [14, 22],
    "branches": ["feature/A", "feature/B"],
    "resolution": "A-wins"   // | "B-wins" | "manual"
  }
]
```

---

## Root Advancing (e.g. new commits land on main)

1. A `git fetch` + ref-change watcher detects that `root` has new commits.
2. GitBraid recomputes `git diff newRoot..branch` for each branch.
3. Diffs that have shrunk (branch already contained those changes) → remove
   those decorated ranges from the workspace; they are now base.
4. Diffs that have grown (merge conflict with new root content) → surface as
   new overlaps for resolution.
5. Workspace worktree is updated to the new root via `git pull --ff-only` (or
   `git reset --hard newRoot` if the worktree has no local commits by
   construction).

---

## Decoration Rendering

A new `HunkDecorationProvider` (`src/hunkDecorationProvider.ts`):

- Registers `vscode.window.createTextEditorDecorationType` per branch (colour
  sourced from `entry.color` in the stack config).
- Decorates: a coloured left-gutter bar + very subtle background tint (same
  alpha as VS Code's Git diff gutter).
- Re-renders on: attribution map change, active editor change, workspace file
  save.
- Tooltip on hover: branch name + first line of the branch's most recent
  commit message.

The decoration data is derived from the in-memory attribution map (already
tracked by `HunkRouter`); no additional git calls are needed at render time.

---

## Committing

Committing branch A from the SCM panel or `gitbraid.commitBranch` works
identically to today: changes are staged in A's worktree and committed there.
After commit, `git diff root..A` shrinks. GitBraid:
1. Recomputes the diff.
2. Removes the now-committed lines from the workspace decoration (they are
   base code now).
3. Does *not* modify the workspace file content (the lines are still there,
   just no longer decorated).

---

## Migration from Current Model

Existing configs with `"assignments"` / `"hunkAssignments"` continue to work.
On first load under the new code:
1. If `root` is absent, GitBraid infers it from the `base` field of the
   bottom-most stack entry (current model uses `base` to mean the parent
   branch, which is root in the parallel model).
2. Existing file assignments are treated as whole-file attributions and
   converted to diff-derived hunk attributions on next `refreshDiffs` call.
3. A one-time migration note is shown in the GitBraid output channel.

---

## Data Model Changes

### `gitbraid-config.json`

```jsonc
{
  "version": 2,                // bump to trigger migration
  "root": "main",              // NEW
  "stack": [
    { "name": "feature/A", "color": "#4CAF50", "order": 1 },
    { "name": "feature/B", "color": "#6C8EBF", "order": 2 }
  ],
  "assignments": {},           // retained for whole-file attributions
  "hunkAssignments": {},       // retained; semantics unchanged
  "overlapResolutions": []     // NEW
}
```

### In-memory (`ConfigService`)

New methods:
- `getRoot(): string`
- `setRoot(branch: string): Promise<void>`
- `getOverlapResolutions(): OverlapResolution[]`
- `setOverlapResolution(r: OverlapResolution): Promise<void>`

### New service: `ParallelWorkspaceService`

Owns:
- The workspace worktree (creation, teardown, reset-to-root).
- The per-branch diff cache (keyed by `branchName + rootSha`).
- Conflict detection and resolution workflow.
- Triggers `HunkDecorationProvider` refresh.

---

## Implementation Phases

### Phase 1 — Root config + prompt (low risk, no behaviour change)
- Add `root` field to config schema and `ConfigService`.
- Prompt for root on first `addBranch` if absent.
- `GitBraid: Change Root Branch` command.

### Phase 2 — Diff-derived attribution (read-only, no workspace changes)
- `ParallelWorkspaceService` computes per-branch diffs.
- Feeds `HunkDecorationProvider` for gutter decoration.
- Existing save routing unchanged.

### Phase 3 — Conflict detection at add-branch time
- Overlap detection + resolution dialog.
- `overlapResolutions` persisted to config.

### Phase 4 — Workspace worktree on root
- Migrate workspace checkout to root worktree.
- Adjust `WorkspaceSync` to not treat workspace as a branch worktree.

### Phase 5 — Root-advances refresh
- Watcher on root ref; recompute diffs; refresh decorations; surface new
  conflicts.

---

## Decisions on Former Open Questions

1. **Workspace worktree location.** Use whichever is simpler to implement.
   Preference is `.worktrees/_workspace` (alongside branch worktrees) so all
   GitBraid-managed trees are in one place and the repo root stays clean, but
   if keeping the workspace in-place proves simpler during Phase 4 that is
   acceptable. Users will adapt.

2. **Suppressed-hunk display.** Controlled by a VS Code setting:
   `gitbraid.showSuppressedHunks` (default `true`). When enabled, the losing
   branch's version is rendered as a dimmed "ghost block" below the winning
   hunk, with the branch colour at reduced opacity. When disabled, suppressed
   hunks are hidden entirely. The setting can be toggled live; the decoration
   provider re-renders on change.

3. **Uncommitted changes on branch worktrees.** Yes — decorate and attribute
   them. Each branch has two diff sources:
   - **Committed:** `git diff root..branch` (the branch's full diff vs root).
   - **Uncommitted:** `git diff HEAD` inside the branch's worktree (dirty
     working-tree changes not yet staged/committed).
   Both are attributed to that branch and decorated with its colour; the
   uncommitted source uses a slightly different decoration style (e.g. dashed
   gutter bar vs solid) so the user can distinguish "committed to this branch"
   from "just edited, not yet committed". The uncommitted diff is the only
   source of changes the user is making right now — committed diff is stable
   between saves; uncommitted diff refreshes on every `WorkspaceSync` tick.

4. **Performance on large diffs.** Root advances are rare in practice; a
   notification during recompute is sufficient. The `DiffEngine` LRU cache
   will be updated to key on `(branchName, rootSha, headSha)` so a no-change
   root advance skips all recomputation. Further optimisation deferred until
   profiling shows a real problem.

---

## Open Questions

5. **Non-shared roots (per-branch or auto-detected merge-base).** The initial
   implementation assumes a single explicit `root` shared by all branches.
   For repos where branches diverge from different points (e.g. one off
   `main`, one off `develop`), two generalisations are possible:
   - **Per-branch root:** each stack entry stores its own `root` field;
     workspace base = `git merge-base --octopus` of all roots.
   - **Auto merge-base:** no root config at all; workspace base is
     `git merge-base --octopus` of all branch tips.
   Both are valid extensions of the single-root model. Defer to a later
   phase; single explicit root covers the common case and is predictable.
