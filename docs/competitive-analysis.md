# GitBraid vs Other Stacked-Diff Tooling

_Last updated: 2026-04-26. Descriptions are based on publicly available
documentation current at the time of writing; verify against each
project's own docs before making claims._

> **What changed since 2026-04-25:** The dashboard webview has been
> reworked across three waves — data surface (current-branch
> marker, ahead/behind counts, checks pill, floating banner,
> single-commit icon, assigned-files count, adapter strip), action
> surface (typed message contract, per-row ⋯ menu covering ~15
> actions, delta row patching), and drill-down (collapsible Commits
> + Files drawers per row backed by `CommitListService`, search
> filter, webview state persistence).  The three "gaps" flagged on
> 2026-04-25 also closed: single-commit mode now enforces amend at
> commit time and offers squash-to-one at push time; the
> CommitListService tree nodes are wired into the stack tree view;
> persistent undo supports replay-through-an-action via
> `gitbraid.showUndoLog`.  Matrix cells move from 🟡 → ✅
> accordingly.

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
| PR creation / sync | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ (`gitbraid.submitStack`; GitHub via Octokit + extension adapters, plus GitLab/Bitbucket/Azure DevOps REST adapters) |
| PR stack visualisation (web UI or panel) | ✅ (web) | ❌ | ❌ | ❌ | 🟡 | ✅ (`gitbraid.stackDashboard` webview with per-row action menu, commits/files drawers, search + state persistence) |
| Stacked-PR body linkage (cross-PR references) | ✅ | ❌ | ❌ | ❌ | ❌ | ✅ (idempotent `<!-- gitbraid:stack-* -->` block) |
| Merge queue integration | ✅ | ❌ | ❌ | ❌ | ❌ | 🟡 (`gitbraid.mergeStack` drives GitHub merge queue; tree-view queue decoration pending) |
| Per-commit identity that survives rewrites | ✅ (`gt`) | ✅ (trailer) | ❌ | ✅ | 🟡 | 🟡 (hunk anchors; no commit-level trailer yet) |
| Single-commit-per-PR enforcement | ❌ | ✅ | ❌ | ❌ | ❌ | ✅ (flag + toggle + amend on commit + squash-on-push prompt) |
| Per-branch commit inspector / graph | ✅ | ❌ | ❌ | ✅ (`sl`) | ✅ | ✅ (tree-view CommitNodes + dashboard commits drawer) |
| Persistent undo across sessions | ❌ | ❌ | ❌ | 🟡 (`sl undo`) | ❌ | ✅ (replay through action via `gitbraid.showUndoLog`) |
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
    shipped, and GitLab/Bitbucket/Azure DevOps adapters now cover the
    same hosts GitButler does — but Graphite still leads on review UX
    polish (inline comment threading, cross-PR diff browsing) and on
    native merge-queue depth per host (GitLab Merge Trains are
    Ultimate-tier only via GitBraid's adapter; Bitbucket/Azure DevOps
    have no native queue at all).
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
  - `sl undo` and `gitbraid.showUndoLog` are now closer in capability:
    both support replaying back to a past point (GitBraid via
    `undoReplay.ts`'s `buildReplayPlan`/`applyReplay`). Sapling's is
    still the more mature implementation given its head start.

### GitButler

- **Closest cousin to GitBraid.** Lets you work in one place and assign
  changes to multiple "virtual branches" simultaneously.
- **Differences:**
  - GitButler is a standalone desktop app with a custom commit store.
    GitBraid is a VS Code extension using real `git worktree`s — so any
    other git tool sees normal branches.
  - Both tools now create PRs.  GitButler covers GitHub + GitLab;
    GitBraid's `submitStack` covers GitHub (Octokit +
    `vscode.github-pullrequests` adapters), GitLab, Bitbucket, and
    Azure DevOps via dedicated `PrHostAdapter` implementations —
    broader host coverage, though GitButler's GitHub/GitLab support
    is more battle-tested.
  - GitButler still has richer UI polish for visualising parallel work;
    GitBraid's commits-under-branch inspection (`CommitListService`
    backing collapsible `CommitGroupNode`/`CommitNode` tree items) has
    closed most of the gap but is newer and less battle-tested.
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
- **Typed webview contract + delta patching.** The dashboard
  persists scroll, search-query, and drawer-open state across
  reloads; updates to a single branch row patch in place without
  blowing away the user's interaction state.  Not common in
  editor-embedded stack UIs.

## Where GitBraid is behind

- **Host integration is broad but less polished than Graphite's.**
  `submitStack` now has adapters for GitHub (Octokit or the
  `vscode.github-pullrequests` extension), GitLab, Bitbucket, and
  Azure DevOps. What's missing is depth per host: no native
  merge-queue integration outside GitHub/GitLab, and review-comment
  surfacing is newer and less polished than Graphite's or
  GitButler's.
- **Stack-review web UI polish trails Graphite.**  `stackDashboard`
  now covers full actions (per-row menu rendered via a native VS
  Code QuickPick — both click-on-⋯ and right-click on the row open
  it — plus submit / merge / checkpoint / undo, commits + files
  drawers, search, state persistence), the PR-body preview drawer
  and a reviews & checks drawer (reviewState, reviewCount,
  per-check rows with external links, populated when the PR
  adapter supplies detail).  Graphite's dedicated web app still
  wins on stacked-PR diff browsing, inline comment threading, and
  cross-PR code suggestions — those remain out of scope for the
  in-editor panel.
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
dashboard**, **merge-queue driving**, a **cross-branch absorb**, and
(since) commit-inspector tree nodes and `singleCommit` enforcement at
commit/push time (see `docs/plans/` for each plan's status). The
remaining 🟡 cell worth closing next is tree-view PR decorations +
queue position — `PRHostAdapter.queueStatus()` exists but nothing in
`branchStackTreeProvider.ts` or the dashboard surfaces it yet.

See `docs/plans/00-index.md` for the full list of implementation
plans keyed to the competitor features these matrix cells are
tracking.
