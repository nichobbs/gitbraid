# Feature Implementation Plans

Implementation plans for capabilities that competitor tools ship but
GitBraid does not — derived from
[`docs/competitive-analysis.md`](../competitive-analysis.md).

Each plan follows the same template (goal, rationale, design, surface,
data model, sequencing, tests, open questions). Plans are living
documents — update them as decisions are made and link from
`docs/remediation/outstanding.md` when work starts.

## Current plans

| Plan | Feature | Inspired by | Status |
| --- | --- | --- | --- |
| [01-pr-creation.md](01-pr-creation.md) | Create & update PRs per branch | Graphite, git-spr, ghstack | **Implementing** |
| [02-pr-stack-visualisation.md](02-pr-stack-visualisation.md) | Stacked-PR dashboard in-editor | Graphite web app | **Implemented (Waves A/B/C + PR-body preview + reviews/checks drawer + native QuickPick menu)** |
| [03-single-commit-per-pr.md](03-single-commit-per-pr.md) | Optional one-commit-per-PR mode | git-spr, ghstack | **Implemented (enforced at commit + push)** |
| [04-absorb-equivalent.md](04-absorb-equivalent.md) | `gitbraid.absorb` — route hunks into existing commits | Sapling `sl absorb` | **Implementing** |
| [05-merge-queue.md](05-merge-queue.md) | Merge-queue aware push | Graphite | **Implementing** |
| [06-richer-stack-graph.md](06-richer-stack-graph.md) | Graphical stack view + commit inspector | GitButler | **Implemented (tree-view CommitNodes + dashboard commits drawer)** |
| [07-import-from-tools.md](07-import-from-tools.md) | RM-012 — import stacks from Graphite/git-spr/git-stack/GitButler | n/a | **Implementing** |
| [08-virtual-branches.md](08-virtual-branches.md) | Virtual branches without a worktree each | GitButler | **Landed** |
| [09-undo-log.md](09-undo-log.md) | Persistent undo across sessions | git-branchless, Sapling | **Implemented (replay supported)** |
| [11-parallel-branch-workspace.md](11-parallel-branch-workspace.md) | Parallel-branch workspace with diff-derived hunk decoration | GitButler | **Design** |

## Shared conventions

- Commands follow the `gitbraid.<verb>` naming, registered through
  `src/commands/`.
- Services live in `src/<name>Service.ts` (or plain `<name>.ts` when
  they're a single class with no service role).
- Every new service gets a dedicated unit test in `test/`, using
  `TmpRepo` for integration flavour tests.
- Every user-facing command gets a walkthrough note before it ships
  out of preview.

## Sequencing rationale

Priorities approximate the following logic:

1. **RM-012 (plan 07)** first — low-risk, self-contained, unlocks real
   user migration from competitor tools.
2. **PR creation (plan 01)** next — closes the single biggest gap
   between GitBraid and Graphite. Requires design of the API shim so
   either Octokit or the `vscode.github-pullrequests` extension can
   back it.
3. **Absorb equivalent (plan 04)** — cheap follow-on to the existing
   hunk router.
4. **Stack visualisation (plan 02)** — once we have PR metadata, a
   webview becomes useful.
5. Remaining plans can be tackled opportunistically.
