# Plan 11 — Zero-Worktree Virtual Branches

**Inspiration:** GitButler's virtual branches (the *full* version — no
worktree, ever, not even after the first commit).

**Status:** Design only. Not scheduled; see "Recommendation" below.

**Relationship to Plan 08:** Plan 08 ("Virtual Branches", landed
2026-04-24) gave GitBraid a *staging* form of virtual branches — a
branch can exist as pure metadata + an in-memory/JSONL-backed file
store until the user is ready to commit, at which point
`materialiseBranch()` promotes it to a real `git worktree` and the
virtual store is torn down. That covers three of GitButler's four
journeys (speculative work, untrusted-code partitioning,
heavy-reorg sessions) but not the fourth: **a branch that never gets a
worktree, including after it has real commits on it.** This plan scopes
that remaining gap.

## Why this is still worth doing

Our own competitive analysis and the code-review that prompted this doc
both flag the same thing: on a large repo, `git worktree add` plus its
initial checkout is the single most expensive operation in GitBraid's
hot path, and every stack layer pays it once at materialisation time.
For a stack with 6+ layers on a 200k-file monorepo, that's minutes of
wall-clock time and a proportional amount of extra disk space (one full
checkout per layer). GitButler avoids this entirely by never touching
the working tree for background branches — it manipulates the git
object database and index directly.

Landing this would let GitBraid say "you never pay the worktree tax
unless you explicitly want a live working copy of a branch" — a
qualitatively different pitch than "worktrees, but we hide the
plumbing," and it's the last item on the competitive-analysis matrix
where GitButler is still ahead architecturally rather than just in UI
polish.

## Why this is a design doc and not a PR

This is not a bounded, additive change like the fixes in this same
review pass. It touches the assumption, load-bearing throughout the
codebase, that **every non-scratch, non-pending-virtual branch in the
stack has a worktree directory on disk.** That assumption is baked into:

- `BranchStackService` — worktree path is the primary key used to find
  a branch's on-disk state (`worktreePath()`, used in >15 call sites).
- `WorkspaceSync` — `_syncFile` writes into `worktreePath(...)`;
  `_reverseSync`/bidirectional sync watches `.worktrees/*/**`.
- `StackResolver.getResolvedContent` — falls back through worktree →
  `git show <branch>:<path>` in that order; a zero-worktree branch has
  no worktree tier at all.
- `BranchScmProvider` — one `vscode.SourceControl` per branch, backed by
  a real working directory; VS Code's SCM API is designed around
  working-tree diffs (`resourceStates` point at real file URIs).
- `HunkRouter` — applies patches via `git apply --index <worktreeDir>`,
  which requires a working tree and an index to apply *into*.
- `Absorb` — stages hunks and runs `rebase --autosquash` inside a
  worktree.
- `MergeQueueService` / `SubmitStackService` — push a worktree's local
  branch ref to `origin`; a zero-worktree branch's ref only exists if
  something already wrote a commit object and moved the ref, which
  today only ever happens via a real working tree.

None of these are wrong to rely on today — they're reasonable given the
current architecture. But it means "let a virtual branch stay virtual
past its first commit" isn't a localized change; it's closer to adding
a second storage backend that every one of the above needs to become
polymorphic over, and getting the abstraction boundary right the first
time matters more than shipping fast, given how much this review pass
already learned about how expensive races and edge cases in this exact
area (materialisation, the virtual store) are to fix after the fact.

## Proposed model

### Data model addition

```ts
interface BranchStackEntry {
  name: string
  color: string
  order: number
  base: string
  virtual?: boolean       // existing: staging-only, pre-first-commit
  headless?: boolean       // NEW: true = this branch has real commits
                           //      but intentionally has no worktree
}
```

A branch can be in one of three states going forward:
1. **`virtual: true`** (existing) — no commits yet, files live in
   `VirtualBranchStore`, `materialiseBranch()` is the only way out
   (worktree *or* headless — see migration below).
2. **`headless: true`** (new) — has ≥1 real commit, ref exists, but no
   `.worktrees/<slug>` directory. File content for this branch is
   served by reading git objects directly (blob content via
   `git cat-file`), not by reading a working tree.
3. **neither** (today's default) — worktree-backed, unchanged.

### Committing without a working tree

The core new primitive is a **synthetic commit path**, built entirely
from plumbing commands (no working tree, no index file on disk beyond
an in-memory one):

1. Start from the branch's current tree (`git rev-parse
   <branch>^{tree}`, or the base branch's tree for the branch's first
   commit).
2. For each `(path, content)` pending change recorded in
   `VirtualBranchStore` for this branch: `git hash-object -w --stdin`
   the new blob, then splice it into the tree structure in memory.
3. `git mktree` (once per modified directory, bottom-up) to build the
   new tree object(s) reflecting the spliced blobs.
4. `git commit-tree <new-tree> -p <branch-current-commit> -m <message>`
   to create the commit object.
5. `git update-ref refs/heads/<branch> <new-commit-sha>`.

This is the same approach `isomorphic-git` and GitButler's Rust core
use, and it's the only way to create a commit without ever writing a
checkout to disk. `git commit-tree`/`git mktree`/`git hash-object -w`
are all plumbing commands with stable, scriptable output — no parsing
of human-readable git output required.

### Resolving content for a headless branch

`StackResolver.getResolvedContent` gains a third tier ahead of the
worktree fallback:

```
virtual store (uncommitted, in VirtualBranchStore)
  → headless committed content (git cat-file blob, no worktree)
  → worktree (existing: dirty file, then `git show`)
```

A headless branch can *still* have an uncommitted virtual-store layer
on top of its committed history — the two aren't mutually exclusive.
"Headless" describes the committed tier's storage; "virtual" describes
whether there's an uncommitted staging layer. In practice this means a
branch's lifecycle is: `virtual → (first commit) → headless → (user
runs "Create Worktree") → worktree-backed`, and materialisation from
headless to worktree-backed is always available as an escape hatch —
same principle Plan 08 already established (never trap the user in a
state they can't get out of).

### SCM panel parity — the hardest part

VS Code's `vscode.SourceControl` API models a *working directory*: a
`SourceControlResourceGroup`'s resource states point at real file URIs
that the built-in diff/quick-diff providers open directly. A headless
branch has no such files. Two options, not mutually exclusive:

- **(a) Virtual document provider for headless branches**, extending
  `StackContentProvider`'s existing `gitbraid-stack:`/`gitbraid-base:`
  scheme pattern: resource states point at synthetic URIs backed by
  `git cat-file`, VS Code's diff view already knows how to diff two
  arbitrary `TextDocumentContentProvider`-backed URIs against each
  other (`vscode.diff` doesn't require real files on either side).
  Staging/unstaging becomes an operation on the in-memory tree-splice
  described above rather than a real `git add`.
- **(b) On-demand ephemeral worktree for the SCM panel only** — create
  a worktree lazily the moment the user opens a headless branch's SCM
  panel, and discard it (not delete the branch — just the worktree) when
  they close it or switch away. This sacrifices some of the disk-cost
  win but reuses 100% of the existing `BranchScmProvider` code, which
  is a meaningfully smaller/safer change. Given the primary cost driver
  identified above is worktree creation happening *for every stack
  layer, always*, an ephemeral-on-demand worktree that only exists
  while the user is actively looking at that one branch still captures
  most of the win.

Recommendation if/when this is scheduled: **start with (b)**. It's a
much smaller diff, ships the disk/IO win (which is the concrete,
measured problem) without touching the SCM provider's working-tree
assumption, and can be upgraded to (a) later as a pure performance
optimization once the rest of the headless-branch plumbing has proven
itself in production.

### Hunk routing and Absorb

`HunkRouter.routeFile`'s `git apply --index <worktreeDir>` has no
headless equivalent without a working tree. Two paths:
- Reuse the ephemeral-worktree approach from the SCM panel section
  above — hunk routing already only runs when the user takes an
  explicit action, so paying worktree-creation cost at that moment
  (rather than eagerly, at branch-creation time) is exactly the
  deferred-cost model Plan 08 established for the pre-commit case.
- Longer-term: teach `HunkRouter` to build the patched blob directly
  (read current blob via `cat-file`, apply the unified diff to the
  in-memory string, `hash-object -w` the result) and splice it via the
  same tree-manipulation primitive as regular commits. This avoids
  `git apply` entirely but is a meaningfully larger lift (re-implementing
  patch application instead of shelling out to git for it) and should
  only be pursued if the ephemeral-worktree approach's performance
  turns out to be insufficient in practice.

`Absorb` depends on `rebase --autosquash`, which fundamentally needs a
working tree (rebase materialises every intermediate commit). This
should stay worktree-only — Absorb is already a deliberate,
occasional operation, not something in the steady-state hot path Plan
08/11 are trying to make cheap.

### Rebasing a headless branch when its base moves

Since there's no working tree, a headless branch can't use `git rebase`
directly either. Rebasing a headless branch onto a new base means:
walk the branch's own commits from base..head, and for each one, replay
its tree-diff onto the new base's tree via the same
hash-object/mktree/commit-tree primitive, in order. This is
functionally a rebase implemented in plumbing — doable, but it's real
new code, not a call to `git rebase`, and needs its own conflict-
detection story (see below) since there's no working tree to leave in
a conflicted state for the user to resolve by hand.

### Conflict handling without a working tree

`git rebase`'s conflict UX (stop, leave markers in the working tree,
`git rebase --continue`) has no equivalent without a working tree.
Two options:
- Detect the conflict up-front via `git merge-tree` (a plumbing command
  that performs a merge entirely on tree objects and reports conflicts
  without touching the working tree or index) and, if it would
  conflict, **refuse the headless rebase and materialise the branch to
  a real worktree instead**, falling back to today's conflict-resolution
  UX. This means headless mode is a fast path for the common
  (non-conflicting) case and gracefully degrades to the existing,
  well-tested worktree path for the uncommon (conflicting) one — no
  new conflict-resolution UI needs to be built at all for v1.
- (Future) build a real 3-way-merge UI for the tree-object case. Not
  recommended for the initial version — the fallback above gets 90% of
  the value for a fraction of the risk.

## Phased rollout

1. **Phase 1 — plumbing only, feature-flagged, no UI.** Implement
   commit-without-worktree as an internal `BranchStackService` method,
   covered by unit tests against a real git repo (`TmpRepo`), with no
   command surface yet. Prove out hash-object/mktree/commit-tree
   correctness (including edge cases: file deletion, new files in new
   subdirectories, binary files) in isolation.
2. **Phase 2 — headless commit from the virtual-branch flow.**
   `materialiseBranch()` gains a `mode: 'worktree' | 'headless'` option;
   default stays `'worktree'` (today's behaviour). Users can opt a
   specific virtual branch into headless mode from its context menu.
   `StackResolver`'s third content tier ships here.
3. **Phase 3 — SCM panel + hunk routing via ephemeral worktree.** The
   (b) approach above. This is what makes headless branches usable
   day-to-day rather than just committable.
4. **Phase 4 — rebase support via `merge-tree` fast path.** Only after
   phases 1-3 have real usage data on how often headless branches
   actually need rebasing (if most users materialise before rebasing
   anyway, this phase may not be worth its cost).
5. **Not planned:** headless Absorb, headless bidirectional sync. Both
   stay worktree-only indefinitely per the reasoning above.

Each phase is independently shippable and reversible — a user can
always materialise a headless branch to a real worktree and nothing
about that path changes.

## Open questions to resolve before Phase 1 starts

- **Binary file handling.** `hash-object`/`cat-file` both handle binary
  content fine, but `VirtualBranchStore` already truncates files over
  10 MB (`MAX_FILE_BYTES`) — need to confirm that ceiling still makes
  sense for committed (not just staged) content, or whether headless
  mode needs its own, possibly different, size policy.
- **Multi-root workspace interaction.** `FolderRegistry` creates one
  service graph per folder; does a headless branch's git object writes
  need to go through the *folder's* repo specifically, or could commit-
  tree plumbing run against the wrong folder's `.git` if two folders
  share a remote? (Almost certainly need to thread `FolderContext`
  through explicitly rather than relying on `cwd`.)
- **Telemetry.** `Telemetry` already anonymises stack *shape*; does
  "headless vs worktree" count as shape data worth recording (to learn
  whether Phase 4 is worth building), and if so what's the anonymised
  bucketing?
- **Undo/redo.** `PersistentUndoLog` currently models undo in terms of
  config/assignment mutations; a headless commit is a git-object-level
  mutation with no natural "undo" beyond `git reset` — needs its own
  undo-log entry type and replay semantics, analogous to how Plan 09's
  undo log already special-cases hunk (re)assignment vs. plain
  config changes.

## Recommendation

Do not schedule until:
1. Plan 08's virtual branches have real production usage data showing
   users regularly hit the cost this is meant to solve (large-repo
   worktree-creation latency), and
2. The other fixes from this review pass have had at least one release
   cycle to prove out — this plan's Phase 3 in particular reuses
   `BranchScmProvider`, which this review found already has real
   concurrency-related bugs in its *existing*, simpler, worktree-only
   form; adding a second storage backend to a component that just had
   its first-ever race-condition fix is higher risk than the size of
   this doc might suggest.

Effort estimate once scheduled: Phase 1 alone is comparable in scope to
Plan 08's original implementation (~1.5 weeks); Phases 2-4 together are
larger than Plan 08 was, since Plan 08 never had to solve the "SCM panel
without a working tree" or "rebase without a working tree" problems —
those only exist because Plan 08 always materialises to a worktree
before those operations become possible.
