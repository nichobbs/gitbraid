# GitBraid vs Other Stacked-Diff Tooling

_Last updated: 2026-04-24. Descriptions are based on publicly available
documentation current at the time of writing; verify against each
project's own docs before making claims._

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
| **GitBraid** | VS Code extension | `.worktrees/local-config.json` + `git worktree`s | *(not yet)* | File/hunk routing in a single workspace |

## Side-by-side feature matrix

Legend: `✅` shipped · `🟡` partial · `❌` absent · `➖` not applicable

| Capability | Graphite | git-spr | git-stack | Sapling | GitButler | **GitBraid** |
| --- | --- | --- | --- | --- | --- | --- |
| Work on multiple branches concurrently without switching | ❌ | ❌ | ❌ | 🟡 | ✅ | ✅ |
| File-level assignment to branches | ❌ | ❌ | ❌ | ➖ | ✅ | ✅ |
| Hunk-level routing from one live edit | ❌ | 🟡 (via `git spr amend`) | ❌ | ✅ (`sl absorb`) | 🟡 (manual hunk move) | ✅ |
| Per-branch SCM panel in-editor | ❌ | ❌ | ❌ | ➖ | ✅ | ✅ |
| Auto-rebase child branches on parent advance | ✅ | ✅ | ✅ | ✅ | 🟡 | 🟡 (`RebaseSuggestionService`) |
| One-click "push whole stack" | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ (`gitbraid.pushStack`) |
| PR creation / sync | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |
| PR stack visualisation (web UI) | ✅ | ❌ | ❌ | ❌ | 🟡 | ❌ |
| Merge queue integration | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Per-commit identity that survives rewrites | ✅ (`gt`) | ✅ (trailer) | ❌ | ✅ | 🟡 | 🟡 (hunk anchors only) |
| Single-commit-per-PR enforcement | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ |
| VS Code tree view | 🟡 (extension) | ❌ | ❌ | 🟡 (ISL) | ❌ | ✅ |
| AI / LM tool integration | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ (13 tools) |
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
  - Graphite has mature host integration (PR threading, merge queue,
    draft management); GitBraid has *none* yet.
  - Graphite's web UI is the main draw for teams; GitBraid's strengths
    are in-editor routing and AI-driven automation.

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
  - `sl absorb` is the closest spiritual cousin to GitBraid's hunk
    routing — but absorb works *within* a single branch's history,
    while GitBraid routes *across* branches.

### GitButler

- **Closest cousin to GitBraid.** Lets you work in one place and assign
  changes to multiple "virtual branches" simultaneously.
- **Differences:**
  - GitButler is a standalone desktop app with a custom commit store.
    GitBraid is a VS Code extension using real `git worktree`s — so any
    other git tool sees normal branches.
  - GitButler has built-in GitHub/GitLab integration; GitBraid doesn't.
  - GitButler has richer UI polish for visualising parallel work.
  - GitBraid stays in the user's editor and exposes an AI/LM-tool
    surface that GitButler doesn't.

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
- **Language-model tools.** The 13 `gitbraid_*` LM tools let Copilot
  Chat (and any LM agent) read and mutate the stack programmatically.
- **Worktree-native.** Every branch in the stack is a real on-disk
  worktree. Every other git tool sees it normally — no hidden state,
  no custom commit store.

## Where GitBraid is behind

- **No host integration.** Graphite, git-spr, ghstack, GitButler all
  create and track PRs. GitBraid stops at `git push`.
- **No single-commit-per-PR enforcement** (git-spr / ghstack style).
- **No web UI for reviewing a stack as stacked PRs.**
- **No import path** from other stacked tools (see RM-012 / the
  importer implementation plans).

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

See `docs/plans/interop-features.md` and the individual plans under
`docs/plans/` for specific features these tools have that GitBraid
currently doesn't.
