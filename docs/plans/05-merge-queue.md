# Plan 05 — Merge-Queue Aware Push

**Inspiration:** Graphite merge queue; GitHub Merge Queue.

**Status:** **Implementing.** `PRHostAdapter` now exposes
`enqueue` / `dequeue` / `queueStatus` and `GitHubOctokitAdapter` implements
them via GitHub GraphQL (`enqueuePullRequest` / `dequeuePullRequest`).
`MergeQueueService` in `src/mergeQueueService.ts` drives the stack
bottom-up with a poll loop; `gitbraid.mergeStack` wires it through
`withProgress(..., { cancellable: true })`.  Tree-view `queued #N`
decoration still pending.

## Goal

Integrate with GitHub Merge Queue so `gitbraid.submitStack` can
optionally enqueue PRs rather than merge them directly. Surface
queue-position in the tree view.

## Rationale

For teams with a merge queue enabled, the "merge now" button doesn't
work; PRs have to be added to the queue via GraphQL. A user who
submits from GitBraid should be able to queue the whole stack in
dependency order.

## Design

### `PRHostAdapter` additions

```ts
enqueue(prNumber: number): Promise<{ position: number }>
dequeue(prNumber: number): Promise<void>
queueStatus(prNumber: number): Promise<{
  inQueue: boolean,
  position?: number,
  requiredChecks: string[],
  passingChecks: string[],
}>
```

### Workflow

`gitbraid.mergeStack`:

1. Ensure every PR in the stack has the required labels / approvals.
2. From the bottom up, call `adapter.enqueue(prNumber)`.
3. Poll every 30 s; advance once the previous PR has merged.
4. Surface progress in the status bar (`$(list-ordered) 2/5 in queue`).

### Tree-view decoration

`BranchNode.description` appends `· queued #3` when in queue.

## Tests

- Fake adapter with scripted queue behaviour (PR N merges T seconds
  after enqueue).
- Assert `mergeStack` waits for each predecessor before enqueuing the
  next.

## Sequencing

Deferred until plan 01 has shipped and we have real user demand.
