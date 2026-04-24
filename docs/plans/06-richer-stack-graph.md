# Plan 06 — Richer Stack Graph and Commit Inspector

**Inspiration:** GitButler commit graph view.

**Status:** **Partially implementing.** The data source (`CommitListService`
in `src/commitListService.ts`) is in place with caching and the
`parseLogOutput` helper.  Tree-provider integration that hangs
`CommitGroupNode` / `CommitNode` off each `BranchNode` is still to do.

## Goal

Inside the GitBraid activity-bar container, offer a collapsible
"Commits" panel under each branch node that lists the commits unique
to that branch (vs its base). Clicking a commit opens a
`vscode.diff` between `<commit>^` and `<commit>` scoped to that
branch's worktree.

## Rationale

Today the stack tree shows branches and their assigned files but not
their commits. If a user wants to see "what have I committed on
`feature/a` so far?" they have to run `git log` in the terminal.

## Design

### New tree nodes

```ts
class CommitGroupNode {  // child of BranchNode
  readonly kind = 'commitGroup'
  label = 'Commits'
}
class CommitNode {       // child of CommitGroupNode
  readonly kind = 'commit'
  readonly sha: string
  readonly subject: string
  readonly date: Date
}
```

### Data source

```ts
class CommitListService {
  async listCommits(branch: string): Promise<CommitNode[]>
  // `git log --format=%H%x00%s%x00%ai <parent>..<branch>` via IGitRunner
}
```

Cache per branch; invalidate on `FileChangeBus.gitIndexChanged` for
the worktree, or on explicit refresh.

### Context actions

- **Show commit diff** — opens a multi-diff view.
- **Revert commit** — `git revert <sha>` inside the worktree.
- **Reword** — interactive rebase single commit.
- **Fixup here** — prepares a fixup commit against this commit using
  the user's current staging.

## Tests

- Snapshot test for `CommitListService.listCommits` against a fixed
  `git log` stdout.
- Tree provider test that three commits on a branch render as three
  `CommitNode` items under the `CommitGroupNode`.

## Open questions

- Show merges and authorship? Keep the row minimal; put author/date
  in the tooltip.
