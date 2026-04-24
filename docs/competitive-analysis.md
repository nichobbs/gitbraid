# GitBraid vs Other Stacked-Diff Tooling

_Last updated: 2026-04-25. Descriptions are based on publicly available
documentation current at the time of writing; verify against each
project's own docs before making claims._

> **What changed since 2026-04-24:** Main has landed the first-pass
> PR host integration (`PRHostAdapter`, `SubmitStackService`, the
> stacked-PR `gitbraid.submitStack` + `openStackedPR` commands), a
> read-only stacked-PR dashboard webview (`gitbraid.stackDashboard`),
> a merge-queue driver (`gitbraid.mergeStack` using GitHub's
> `enqueuePullRequest` GraphQL), a Sapling-style `gitbraid.absorbHunks`,
> an in-process MCP server (`src/mcpServer.ts`), a `CommitListService`
> data source for the per-branch commit inspector, the
> `singleCommit` branch flag with a toggle command (invariant not
> yet enforced at push/commit time), and a persistent JSONL undo
> log with `gitbraid.showUndoLog`. Several capability-matrix cells
> move from ❌ → 🟡 or ✅ as a result.

## Landscape at a glance

| Tool | Surface | State storage | Host integration | Philosophy |
| --- | --- | --- | --- | --- |
| **Graphite** (`gt`) | CLI + web app | `.git/refs/branch-metadata/*`, SaaS backend | First-class GitHub UI, paid tier | One PR per branch; restack on parent move |
| **git-spr** | CLI | Commit-message `pr-XXXX` trailers | GitHub | One commit = one PR |
| **git-stack** | CLI (Rust) | Pure git refs (`refs/branch-stack/*`) | GitHub/GitLab via `git push` | Stateless; thin veneer over `git rebase --onto` |
| **Sapling (`sl`)** | CLI + UI | Sapling-native graph (bidirectional git) | GitHub via `sl pr submit` | Replace git's model with a mutable commit graph |
| **ghstack** | CLI (Python) | Per-commit `ghstack-source-id` trailer | GitHub | One PR per commit, Meta-style |
| **gh-stack** | CLI | Detected from branch ancestry | GitHub | Lightweight CLI helper |
| **Stacked Git** (`stg`) | CLI | Patches in `refs/patches/*` | None (patch manager) | Patch queue on top of git |
| **git-branchless** | CLI | Reflog + virtual refs | Local only | Advanced rebase/undo UX |
| **GitButler** | Desktop app + sidecar | `.git/gitbutler/virtual_branches.toml` | Push to GitHub/GitLab | Virtual branches; work on many at once |
| **GitBraid** | VS Code extension + MCP server | `.worktrees/gitbraid-config.json` + `git worktree`s | GitHub via `PRHostAdapter` (Octokit + `vscode.github-pullrequests` adapters), merge-queue driver | File/hunk routing in a single workspace |

## Side-by-side feature matrix

Legend: `✅` shipped · `🟡` partial / feature-flagged / plan in flight · `❌` absent · `➖` not applicable

| Capability | Graphite | git-spr | git-stack | Sapling | GitButler | **GitBraid** |
| --- | --- | --- | --- | --- | --- | --- |
| Work on multiple branches concurrently without switching | ❌ | ❌ | ❌ | 🟡 | ✅ | ✅ |
| File-level assignment to branches | ❌ | ❌ | ❌ | ➖ | ✅ | ✅ |
| Hunk-level routing from one live edit | ❌ | 🟡 (via `git spr amend`) | ❌ | ✅ (`sl absorb`) | 🟡 (manual hunk move) | ✅ |
| Absorb hunks into existing commits (Sapling-style) | ❌ | ❌ | ❌ | ✅ | ❌ | ✅ (`gitbraid.absorbHunks`; blame-dominant attribution) |
| Per-branch SCM panel in-editor | ❌ | ❌ | ❌ | ➖ | ✅ | ✅ |
| Auto-rebase child branches on parent advance | ✅ | ✅ | ✅ | ✅ | 🟡 | 🟡 (`RebaseSuggestionService` + `RebaseRecovery`) |
| One-click "push whole stack" | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ (`gitbraid.pushStack`) |
| PR creation / sync | ✅ | ✅ | ✅ | ✅ | ✅ | 🟡 (`gitbraid.submitStack`; GitHub-only, Octokit + extension adapters; GitLab deferred) |
| PR stack visualisation (web UI or panel) | ✅ (web) | ❌ | ❌ | ❌ | 🟡 | 🟡 (`gitbraid.stackDashboard` webview; reviews/checks UI deferred) |
| Stacked-PR body linkage (cross-PR references) | ✅ | ❌ | ❌ | ❌ | ❌ | ✅ (idempotent `<!-- gitbraid:stack-* -->` block) |
| Merge queue integration | ✅ | ❌ | ❌ | ❌ | ❌ | 🟡 (`gitbraid.mergeStack` drives GitHub merge queue; tree-view queue decoration pending) |
| Per-commit identity that survives rewrites | ✅ (`gt`) | ✅ (trailer) | ❌ | ✅ | 🟡 | 🟡 (hunk anchors; no commit-level trailer yet) |
| Single-commit-per-PR enforcement | ❌ | ✅ | ❌ | ❌ | ❌ | 🟡 (flag + toggle command; commit/push invariant pending) |
| Per-branch commit inspector / graph | ✅ | ❌ | ❌ | ✅ (`sl`) | ✅ | 🟡 (`CommitListService` data source; tree nodes pending) |
| Persistent undo across sessions | ❌ | ❌ | ❌ | 🟡 (`sl undo`) | ❌ | 🟡 (`.worktrees/undo-log.jsonl` + `gitbraid.showUndoLog`; full replay pending) |
| VS Code tree view | 🟡 (extension) | ❌ | ❌ | 🟡 (ISL) | ❌ | ✅ |
| AI / LM tool integration | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ (VS Code LM tools + in-process MCP server) |
| MCP / external agent control | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ (`src/mcpServer.ts`, token-auth local socket) |
| Import from other stacked tools | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ (Graphite, git-stack, git-spr, GitButler, upstream) |
| Multi-root workspace | ➖ | ➖ | ➖ | ➖ | ❌ | ✅ |
| Works with vanilla git on the other side | ✅ | ✅ | ✅ | 🟡 | 🟡 | ✅ (worktrees are regular refs) |
| No external SaaS required | 🟡 | ✅ | ✅ | ✅ | ✅ | ✅ |

## Detailed comparisons

### Graphite (`gt`)

- **Model:** Every branch contains the cumulative diff up to that layer;
  restacking rewrites descendants when a parent moves.
- **Workflow:** `gt branch create` → edit → `gt modify` → `gt submit`
  pushes each branch as its own PR; a web app threads the PRs together.
- **Relative to GitBraid:**
  - Graphite makes you `git switch` between layers; GitBraid keeps you
    in one workspace and routes changes per file/hunk.
  - Graphite has mature host integration (draft management, polished
    review UI, PR threading, merge queue). GitBraid's 2026-04-25 wave
    closed a large part of this gap — PR creation/update with stacked
    body linkage, merge-queue driving, and a read-only dashboard all
    shipped — but Graphite still leads on review UX polish and
    breadth of hosts (GitLab, Bitbucket).
  - Graphite's web UI is the main draw for teams; GitBraid's
    strengths are in-editor routing, cross-branch absorb, and an
    AI/MCP agent surface.

### git-spr / ghstack

- **Model:** "One commit = one PR." Commits carry a trailer that ties
  them to a remote PR across rewrites.
- **Workflow:** Curate a linear series with `git rebase -i`, then
  `git spr update` or `ghstack submit` opens/updates one PR per commit.
- **Relative to GitBraid:**
  - These tools assume you have already decided which commit owns each
    change. GitBraid's defining feature is the *opposite*: let the work
    pile up and assign afterwards, at hunk granularity.
  - They compose well — use GitBraid to author and split, then git-spr
    to ship.

### git-stack

- **Model:** Pure-git, stateless. Parent/child relationships live in
  regular git refs.
- **Workflow:** `git stack push`, `git stack rebase`, `git stack sync`.
  No web app; relies on GitHub's stock UI for review.
- **Relative to GitBraid:**
  - git-stack is a thin CLI over `git rebase --onto`. GitBraid is a
    heavier abstraction (virtual workspace state, file routing,
    per-branch SCM) that happens to use worktrees underneath.
  - Together they work well — git-stack owns the branch chain, GitBraid
    handles authoring.

### Sapling

- **Model:** Replaces git's commit graph with Sapling's own
  (bidirectionally compatible). Stacks are a first-class concept, no
  branches.
- **Workflow:** `sl absorb` pushes amends down to the right ancestor;
  `sl pr submit` creates PRs.
- **Relative to GitBraid:**
  - Sapling replaces git; GitBraid layers onto it.
  - Both tools now have an `absorb`.  Sapling's operates _within_ a
    branch's history; GitBraid's (`gitbraid.absorbHunks`) operates
    _across branches_ by routing each hunk to its owning branch's
    worktree first, then running the same blame-dominant attribution.
  - Sapling's `sl undo` remains more powerful than GitBraid's
    informational undo log — replay-through-an-action is still TBD on
    the GitBraid side.

### GitButler

- **Closest cousin to GitBraid.** Lets you work in one place and assign
  changes to multiple "virtual branches" simultaneously.
- **Differences:**
  - GitButler is a standalone desktop app with a custom commit store.
    GitBraid is a VS Code extension using real `git worktree`s — so any
    other git tool sees normal branches.
  - Both tools now create PRs.  GitButler covers GitHub + GitLab;
    GitBraid's `submitStack` covers GitHub only (Octokit +
    `vscode.github-pullrequests` adapters), with GitLab deferred.
  - GitButler has richer UI polish for visualising parallel work and
    shipping commits-under-branch inspection; GitBraid has the data
    source (`CommitListService`) but hasn't yet hung the tree nodes.
  - GitBraid stays in the user's editor and exposes an AI/LM-tool
    surface plus an MCP server that GitButler doesn't.

### Stacked Git (StGit)

- **Model:** Patch queue on top of git (similar to `quilt`).
- **Relative to GitBraid:** Different problem — single-branch patch
  management vs multi-branch concurrent work. Not a direct competitor.

### git-branchless

- **Model:** Undo, visual log, and advanced rebase primitives.
- **Relative to GitBraid:** Useful alongside either tool; orthogonal.

## Where GitBraid is unique

- **Hunk-level routing from a single live edit.** No other tool lets
  you write a single file and send different hunks to different
  branches without explicit commit boundaries.
- **File-assignment metaphor** with Explorer decorations and a
  per-branch SCM panel surfaced inside VS Code.
- **AI / agent surface.** VS Code Language Model tools plus an
  in-process MCP server (`src/mcpServer.ts`) so any MCP-speaking
  client outside VS Code can drive the stack over a token-authed
  local socket.
- **Worktree-native.** Every branch in the stack is a real on-disk
  worktree. Every other git tool sees it normally — no hidden state,
  no custom commit store.
- **Cross-tool stack import.** Detects Graphite, git-stack, git-spr,
  GitButler, and plain-upstream metadata and rebuilds the inferred
  stack in `gitbraid-config.json`. None of the competitors offer
  this.
- **Absorb _across branches_.** `gitbraid.absorbHunks` applies the
  Sapling `sl absorb` heuristic, but scoped to each file's assigned
  branch — so a single editor buffer can produce fixups on N
  different branches in one command.

## Where GitBraid is behind

- **Host integration is GitHub-first and partial.** `submitStack`
  handles GitHub via Octokit or the `vscode.github-pullrequests`
  extension. GitLab is deferred; no Bitbucket / Azure DevOps
  adapters. Graphite / git-spr / ghstack / GitButler all cover
  more ground.
- **No native stack-review web UI** to match Graphite's dashboard —
  the in-editor `stackDashboard` webview is read-only for now
  (inline `Submit` / `Rebase` / `Open PR` / `Refresh` only; review
  decisions and check-run summaries deferred until the adapter
  exposes them).
- **Single-commit-per-PR mode is a flag, not a contract.** The
  `singleCommit` branch property is persisted and a toggle command
  exists, but `commitBranch` doesn't yet amend and the push path
  doesn't yet validate the invariant. git-spr / ghstack enforce
  this end-to-end.
- **Per-branch commit inspector is not yet in the tree.**
  `CommitListService` computes the data; the tree-provider
  integration (`CommitGroupNode` / `CommitNode` under each
  `BranchNode`) hasn't landed. GitButler and Sapling ship this
  polished.
- **Persistent undo is informational only.** `.worktrees/undo-log.jsonl`
  survives restarts and `gitbraid.showUndoLog` reveals it, but the
  "replay through this action" UX is pending — git-branchless
  remains the gold standard here.
- **No virtual branches without a worktree each.** GitButler's
  signature feature is still future work for GitBraid (plan 08).

## Positioning summary

Two axes capture the differences cleanly:

```
                     Edit one branch at a time         Edit many branches at once
                     ─────────────────────────         ─────────────────────────
PR-tool focused      Graphite, git-spr, ghstack        (rare)
Editor-integrated    Native VS Code git, GitLens       GitBraid, GitButler
```

GitBraid's distinguishing position is the bottom-right corner: an
editor-native tool that lets you author across many branches in one
workspace and route the work afterwards. The closest *capability*
cousin is GitButler; the closest *philosophy* cousin is Sapling; the
closest *workflow* cousin is Graphite.

With the 2026-04-25 wave, the gap to Graphite shrinks meaningfully —
GitBraid now has **first-class PR creation**, a **stacked-PR
dashboard**, **merge-queue driving**, and a **cross-branch absorb** —
but several of those pieces are still "read-only dashboard / flag
without enforcement / data source without tree node"
(see `docs/plans/` for each plan's status). The next wave should
close the remaining 🟡 cells: tree-view PR decorations + queue
position, commit-inspector nodes, and the `singleCommit` invariant
at commit/push time.

See `docs/plans/00-index.md` for the full list of implementation
plans keyed to the competitor features these matrix cells are
tracking.
