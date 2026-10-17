# Plan 17 - Pipelined Merge Queue

**Inspiration:** The article concludes that a global-lock merge queue does
not fit agent-scale merging and leans on post-merge verification instead
(https://www.anthropic.com/engineering/redesigning-source-control).
Extends plan 05.

**Status:** **Implemented** (phase 1; see "As built"). Tracking issue: #41.

## Goal

An opt-in mode where `MergeQueueService` keeps several layers in flight
without ever merging a child before its parent.

## Rationale

`mergeStack` is strictly serial: enqueue, poll until merged (30 s poll,
30 min default timeout), then the next layer. Total time is the sum of
every layer's CI and queue time.

## Invariants

- A layer merges only after its parent has merged, or in a batch the host
  guarantees ordered.
- No orphaned queued child after any failure or cancel.
- Default behaviour is unchanged.

## Design

Setting `gitbraid.mergeStrategy`: `serial` (default) or `pipelined`.

1. **Pre-flight (parallel):** for every layer verify the PR exists, is
   open, not draft, and has the expected base. Any failure aborts before
   anything is enqueued.
2. **Retarget:** when Li merges and L(i+1) still targets the old parent
   branch, call new optional adapter method `retargetPR(prNumber, newBase)`.
3. **Sliding window:** at most `gitbraid.mergePipelineDepth` layers in
   flight (default 2, range 1 to 5). New adapter capability
   `supportsOrderedQueue`; when false, enqueue depth is clamped to 1 while
   later layers still get early checks.
4. **Failure policy:** if Li fails, stop enqueuing, dequeue all in-flight
   layers above it, and report `blockedBy`.
5. **Cancellation:** abort polling and dequeue in-flight layers unless
   `gitbraid.mergeKeepQueuedOnCancel` is set.
6. **Polling:** one loop polling all in-flight layers with
   `Promise.allSettled`, interval backing off to 120 s when idle and
   keeping `MAX_CONSECUTIVE_PR_NOT_FOUND` per layer.

### Phase 2

Optional `gitbraid.postMergeCheckCommand` run in the trunk worktree after
the final merge.

### Results

`MergeStackResult.state`: `merged | failed | blocked | skipped`, plus
`blockedBy?`. Progress reports merged, in-flight and pending counts.

## Sequencing

1. Extract `SerialStrategy` with a golden test.
2. Pre-flight and results shape.
3. Pipelined strategy for GitHub only.
4. Other adapters as capability allows.

## Tests

Fake adapter and injected `Clock`: serial golden output; depth 2 with four
layers enqueues L3 only after L1 merges and beats serial wall-clock; L2
failure dequeues L3 and L4; pre-flight failure enqueues nothing; cancel
dequeues in-flight layers; unsupported adapters clamp depth; retarget
called once.

## Open questions

- Verify against a real GitHub merge queue before enabling by default.
- Whether GitLab merge trains map onto `supportsOrderedQueue`.

## As built

- `MergeQueueService.mergeStack` dispatches on `options.strategy` (`serial` default, unchanged apart from every result now carrying `state`). `_mergePipelined` implements pre-flight, retarget, the sliding window, the failure policy, cancellation and backoff polling as designed. Settings: `gitbraid.mergeStrategy`, `gitbraid.mergePipelineDepth` (1 to 5, default 2), `gitbraid.mergeKeepQueuedOnCancel`.
- `PRHostAdapter` gained optional `supportsOrderedQueue` and `retargetPR`. Only `GitHubOctokitAdapter` sets the former (GitHub's queue is FIFO per branch); others clamp to depth 1 but still get pre-flight and the new result states. When `retargetPR` is absent the service falls back to `updatePR(n, { base })`.
- A layer is retargeted to trunk (the bottom layer's base) just before it is enqueued if it still targets its parent, since a host queue only accepts PRs against its own branch. This differs slightly from the plan, which retargeted after the parent merged: with a window above 1 the parent has not merged yet.
- Pre-flight checks existence, open (not draft or closed) and expected base; on failure nothing is enqueued, the offending layer is `failed` and the remaining unmerged layers are `skipped`.
- Failure: stop enqueuing, dequeue every in-flight layer above the failed one, mark layers above as `blocked` with `blockedBy`. Layers below keep running. Cancel dequeues in-flight layers unless `mergeKeepQueuedOnCancel`.
- Polling is one `Promise.allSettled` round over all in-flight layers; the interval grows 1.5x per idle round up to 120 s and resets on progress; `MAX_CONSECUTIVE_PR_NOT_FOUND` applies per layer.

Not done: phase 2 `postMergeCheckCommand`; verification against a real GitHub merge queue (the strategy stays opt-in); GitLab merge trains. Known risk: a child whose branch contains its parent's commits could land them if the parent is removed from the queue and the host does not drop the child; the failure policy dequeues the child, but there is an unavoidable race window on the host side.
