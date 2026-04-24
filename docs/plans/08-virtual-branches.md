# Plan 08 — Virtual Branches

**Inspiration:** GitButler's "virtual branches" model.

**Status:** Landed 2026-04-24.  See `src/virtualBranchStore.ts`,
`src/commands/virtualBranchCommands.ts`, and the virtual-branch section in
`USAGE.md`.

## TL;DR — why this is worth building

Virtual branches are the single biggest differentiator GitBraid currently
lacks against GitButler, and they unblock four concrete user journeys
that stacked-branch tools today force compromises on:

1. **Parallel speculative work.** The user has two half-formed ideas and
   isn't sure which will survive review. With worktree-backed branches,
   spinning up a throwaway costs ~1 s of `git worktree add` and leaves a
   tree on disk they have to remember to prune. With virtual branches,
   the cost is zero — the branch exists only as a set of in-memory
   hunk assignments.
2. **Working with untrusted code.** Junior engineers and external
   contributors routinely want to partition a patch *before* committing
   to a branch name. GitBraid already supports "floating" files; virtual
   branches generalise that to "partial branches with no worktree yet"
   so users can shape the PR structure before any write hits disk.
3. **Heavy-reorganisation sessions.** When the user decides mid-session
   that a file belongs to a new, as-yet-unpushed branch, the current
   flow is: create a worktree, assign the file, realise the shape is
   wrong, delete the worktree, start over. Virtual branches remove the
   round-trip entirely — the branch is just a label on a set of hunk
   assignments.
4. **Large monorepos.** On a 200 k-file repo, `git worktree add` + the
   initial scan can take 3–10 s. Every stack entry pays that cost.
   Virtual branches defer it until the user actually commits.

None of these are addressed by the "scratch worktree" feature we
already ship; scratch is a single, persistent parking lot with one hard
rule (no commits). Virtual branches are plural and lifecycle-aware —
they are real branches that just haven't materialised yet.

## The strategic case

### Competitive positioning

Our `docs/competitive-analysis.md` ranks GitButler ahead on two axes:
(a) virtual branches, (b) GPU-fast UI. We will never win on (b) inside
VS Code, but (a) is a purely backend feature and GitBraid's worktree
infrastructure already has every primitive it needs. Closing this gap
promotes GitBraid from "Graphite-equivalent with better UI" to "covers
everything GitButler does, without forcing a standalone app".

### Workflow completeness

GitBraid's current model has a visible seam: everything is a file/hunk
assignment *until* you commit, at which point it becomes a branch with
a worktree, an SCM panel, PR state, etc. Users describe this as "going
over a cliff" — reversible operations suddenly feel heavy. Virtual
branches smooth that curve by making the "branch" a first-class
concept at the same low-cost tier as "assignment".

### Why not just lean harder on scratch / floating files?

Scratch is one bucket, and it can't hold multiple logical changes at
once. Floating is the opposite — per-file, no grouping. Virtual
branches are the missing middle: *grouped, labelled, not-yet-committed
sets of changes*. Adding another ad-hoc bucket to cover one of the
four journeys above would save time short-term but leaves the concept
model fragmented. One well-named primitive is cheaper to teach.

## Data model

```ts
interface BranchStackEntry {
  name: string
  color: string
  order: number
  base: string
  virtual?: boolean    // default false
}
```

When `virtual === true`:

- `BranchStackService._ensureWorktree` is a no-op.
- `WorkspaceSync._syncFile` writes to a keyed in-memory store
  `Map<virtualBranchName, Map<relativePath, Buffer>>` instead of an
  on-disk worktree. The store is serialised to
  `.worktrees/virtual/<branch>.jsonl` on every sync so a reload
  doesn't lose work.
- `BranchScmProvider` reads from the virtual store when showing the
  SCM panel, exactly as it would read `git status` for a materialised
  branch.
- `StackResolver` treats the virtual store as the top-of-stack layer
  for cumulative resolution — users still see the unified workspace.

### Materialisation (commit-time promotion)

First commit on a virtual branch promotes it atomically:

1. `git worktree add .worktrees/<slug> <base>`.
2. Apply every (path, content) pair from the virtual store.
3. `git add .` + `git commit -m <msg>`.
4. Flip `virtual: false` in `gitbraid-config.json`.
5. Delete `.worktrees/virtual/<branch>.jsonl`.

If step 1 fails (disk full, branch name collision), the commit fails
and the virtual store is untouched — the user can retry without
losing work.

## Command surface

| Command | Title |
|---|---|
| `gitbraid.addVirtualBranch` | Add virtual branch to stack |
| `gitbraid.materialiseVirtualBranch` | Create worktree for virtual branch |
| `gitbraid.discardVirtualBranch` | Discard virtual branch (with confirmation) |

The existing `gitbraid.addStackBranch` gets a "Virtual (no worktree yet)"
toggle in its QuickPick flow, so users don't have to learn a new command
just to try the feature.

## Testing strategy

- Unit: the virtual store — round-trips, overwrite semantics, serialisation
  parity with `git status` output shape.
- Integration: add a virtual branch, assign three files, commit. Assert
  that the resulting worktree contains exactly the three files with the
  exact contents and is checked out at the expected branch head.
- Regression: turn a previously-virtual branch into a worktree branch;
  assert that a subsequent `gitbraid.routeHunks` behaves identically to
  an always-materialised branch.

## Known risks

- **External git tools can't see virtual branches.** `git branch -a`
  won't list them because they don't exist yet. Mitigation: the Branch
  Stack view clearly labels virtual entries, and the command palette
  always offers "Materialise" as the first action on a virtual node.
- **Persistence + crash safety.** The virtual store is disk-backed
  (`.worktrees/virtual/*.jsonl`) precisely so a VS Code crash doesn't
  lose an hour of work. We reuse the same atomic-temp-file write
  discipline `ConfigService` already uses.
- **Overlap with `scratch`.** Scratch is a single, commit-forbidden
  parking lot. Virtual branches are plural and commit-on-demand. They
  are a superset — once virtual branches ship, `scratch` can either
  be reframed as "the one virtual branch you always have" or removed
  in favour of a well-known virtual-branch name (`scratch`). Decide
  during implementation; not blocking.

## Recommendation

Schedule after the GitLab/Bitbucket host-adapter work lands and before
the core-extraction work in Plan 10. The feature is self-contained —
it does not touch `prHostAdapter`, telemetry, or the CLI surface — so
it can proceed in parallel without creating merge pain.

Effort estimate: ~1.5 weeks, dominated by the serialisation/crash-safety
edge cases, not the happy path.
