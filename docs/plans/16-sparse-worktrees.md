# Plan 16 - Sparse Worktrees

**Inspiration:** Scion's on-demand tree fetching, where sparse and
virtual checkouts need no special support
(https://www.anthropic.com/engineering/redesigning-source-control).

**Status:** **Implemented** (see "As built"). Tracking issue: #40.

## Goal

Optionally create each branch worktree with `git sparse-checkout`
limited to the directories that branch owns, growing the cone on demand.

## Rationale

`BranchStackService._createWorktree` makes a full checkout per branch.
In a large repo, N branches cost N full checkouts in disk, checkout time
and watcher load, though each branch usually owns a handful of files.
Virtual branches (plans 08 and 11) avoid worktrees only for uncommitted
work.

## Design

### Setting

`gitbraid.sparseWorktrees`: `off | auto | always` (default `auto`).
`auto` enables sparse mode above `gitbraid.sparseWorktreeThreshold`
tracked files (default 20000), counted once per base oid. Requires git
2.25 or later; older versions degrade to `off` with one warning.

### Creation

1. `git worktree add --no-checkout .worktrees/<slug> -b <name> <base>`
2. `git sparse-checkout init --cone`
3. `git sparse-checkout set <dirs>`: parents of assigned and
   hunk-assigned files, plus `gitbraid.sparseAlwaysInclude`
4. `git checkout`

### Growing the cone

Every owned path must be in the cone at sync time. `WorkspaceSync` calls
`ensureInCone(branch, dir)` (running `sparse-checkout add`) before the
copy, under the existing per-branch serialisation. The cone per branch is
tracked in memory and refreshed from `git sparse-checkout list`.

### Stack resolution

An absent file on disk no longer implies absence from the branch.
`StackResolver` and `StackContentProvider` gain `isInCone(branch, path)`
and use committed state (`git show` / `cat-file -e`) for out-of-cone
paths.

### Rebase, commit, status

Git handles skip-worktree paths; verify with tests that
`BranchScmProvider` does not report out-of-cone files as deleted and that
a rebase conflict outside the cone is added to the tracked cone with a
logged warning.

### Existing worktrees

Command `gitbraid.setWorktreeSparse` converts a branch either way.
Nothing is converted automatically.

## Sequencing

1. Cone-aware resolver (no behaviour change in full mode).
2. Sparse creation behind the setting (`always` only).
3. `auto` threshold and the convert command.

## Tests

- `tmpRepo` with `a/`, `b/`, `c/`: only `a/` on disk; assigning `c/x`
  adds `c/` before sync completes.
- Resolver output identical in sparse and full modes.
- No spurious deletions in SCM status.
- Git below 2.25 falls back with one warning.
- Rebase conflict outside the cone keeps tracking consistent.

## Open questions

- Windows long paths and case-insensitivity under sparse-checkout.
- Do any language servers or tools read the worktrees directly?

## As built

- `src/sparseWorktree.ts` (`SparseWorktreeService`): git version probe (once, one warning), `shouldUseSparse` (off / always / auto with a tracked-file count cached per base oid), `initCone`, `ensureInCone` (serialised per worktree, skips covered paths without touching git), `isInCone`, `convert`.
- `BranchStackService._createWorktree` builds the worktree with `--no-checkout`, then `init --cone`, `set <owned dirs + gitbraid.sparseAlwaysInclude>`, `checkout`. Any failure removes the half-built worktree and falls back to a full one with a warning. `setWorktreeSparse` backs the new `gitbraid.setWorktreeSparse` command; nothing is converted automatically.
- `WorkspaceSync._syncFile` calls `ensureInCone` before the copy (wired from `FolderContext`).
- `StackResolver` needed no change: it already falls back to `git show` when the worktree lacks the file, which is exactly the out-of-cone case. A test pins that sparse and full modes return identical bytes.
- Fixed on the way: `git.worktree.add/addNew/remove` ran in the first workspace folder, which is wrong for other folders of a multi-root workspace. They now take the folder's root.

Not done: the "rebase conflict outside the cone" test, the Windows long-path / case-insensitivity check, and survey of tools that read worktrees directly (open questions above are unchanged). Writes other than `WorkspaceSync` (hunk routing, reverse sync) rely on the cone already covering owned directories.
