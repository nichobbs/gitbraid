# Plan 17 - Pipelined Merge Queue

**Inspiration:** The article concludes that a global-lock merge queue does
not fit agent-scale merging and leans on post-merge verification instead
(https://www.anthropic.com/engineering/redesigning-source-control).
Extends plan 05.

**Status:** **Not started.** Tracking issue: #41.

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
