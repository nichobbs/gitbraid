# Plan 08 — Virtual Branches (No Worktree Each)

**Inspiration:** GitButler.

**Status:** Planned.

## Goal

Optional mode in which a stack entry does **not** require a
`.worktrees/<branch>/` directory. Instead, the branch's dirty state
is kept in memory and only materialised into a real worktree when the
user commits.

## Rationale

For very short-lived branches (scratch work, speculative
exploration), creating a worktree is overhead — both on disk and in
startup time. GitButler's "virtual branches" skip that cost.

## Trade-offs

- **Pro:** faster add/remove of stack entries, less disk usage.
- **Con:** breaks the "worktree-native" invariant GitBraid otherwise
  upholds. External git tools can't see a virtual branch.

## Design sketch

### Data model

```ts
interface BranchStackEntry {
  // ...existing...
  virtual?: boolean    // default false
}
```

When `virtual === true`:

- `BranchStackService._ensureWorktree` is a no-op.
- `WorkspaceSync._syncFile` writes the content into an in-memory
  store keyed by `<branch>:<relativePath>` in `WorkspaceSync`.
- `BranchScmProvider` reads the virtual store instead of
  `git status` for that branch.
- Commit promotes: `git worktree add` + write every pending file +
  `git add .` + `git commit -m <msg>`.

### Command surface

| Command | Title |
| --- | --- |
| `gitbraid.addVirtualBranch` | Add virtual branch to stack |
| `gitbraid.materialiseVirtualBranch` | Create worktree for virtual branch |

## Tests

- Deterministic tests over the virtual-sync map.
- Integration test where a virtual branch is materialised and the
  resulting worktree contains exactly the virtual store's contents.

## Open questions

- Overlap with the `scratch` feature (which is already persistent but
  hidden from SCM)? Virtual branches are a superset — can we unify?
