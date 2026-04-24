# GitBraid — VS Code Extension

**Braid multiple branches together in one workspace.**

GitBraid lets you work on several branches simultaneously without context-switching.
Each file (or individual diff hunk) is assigned to a branch; GitBraid routes your
changes to the right worktree automatically, so every branch always contains exactly
the commits it should.

## Features

- **Branch stack** — maintain an ordered stack of branches where each layer builds
  on the one below. The workspace always reflects the cumulative top-of-stack state.
  Branches in the **Branch Stack** view are ordered top-layer-first; drag or use
  `Alt+Up` / `Alt+Down` to reorder them.
- **Layered workspace population** — when a branch is added to the stack its
  committed files (relative to its base) are automatically copied into the primary
  workspace and assigned. The highest layer wins when two branches introduce the same
  file, so the workspace always reflects the true union of the stack.
- **File assignment** — tag any file to a branch with a single command. Assigned
  files are decorated with the branch colour and a short badge in the Explorer.
- **Hunk-level routing** — CodeLens above every diff hunk lets you direct individual
  hunks to different branches without leaving the editor.
- **Per-branch SCM** — each stacked branch gets its own Source Control entry with
  a dedicated commit message box and file list.
- **Push / sync stack** — push all branches to origin in one command, or rebase
  each branch onto its parent to keep the whole stack up-to-date.
- **Stacked PRs on GitHub, GitLab, and Bitbucket** — `gitbraid.submitStack`
  creates one PR per layer with the right `head`/`base` refs, injects a shared
  "Stacked PRs" block into every body, and (on GitHub Merge Queue / GitLab
  Merge Trains) can enqueue the stack for a queue-driven land via
  `gitbraid.mergeStack`.
- **Absorb hunks** — `gitbraid.absorbHunks` amends existing commits that touch
  the same lines you just edited, so fix-ups land in the right commit instead
  of piling up as new ones.
- **Cross-tool importer** — detects Graphite / git-spr / git-stack / GitButler /
  plain-upstream metadata and seeds the GitBraid stack in one click so users
  migrating from another tool don't have to rebuild it by hand.
- **MCP server** — launch a Model Context Protocol server (`gitbraid.startMcpServer`)
  so external agents and CLIs can inspect or mutate the stack without opening
  VS Code. Read-only by default; mutation tools are gated behind
  `gitbraid.mcpWriteEnabled`.
- **Rebase assistance** — GitBraid watches for parent-branch advances, offers
  one-click rebase, and presents a conflict recovery UI (including VS Code's
  built-in three-way merge editor) when rebases pause.
- **Worktree health** — the Branch Stack tree view shows live ahead/behind
  commit counts, dirty indicators, and rebase-in-progress warnings for every
  branch without leaving the editor.
- **Floating-file aging** — unassigned files are colour-coded in the tree view
  by how long they have gone unassigned (grey → yellow → orange → red).
- **Smart auto-assign** — when you save a new file in a directory where every
  other file already belongs to a single branch, GitBraid offers to assign it
  automatically.
- **Assign by glob** (`gitbraid.assignGlob`) — enter a glob pattern, preview
  matched files in a checkbox list, and assign them all in one undoable step.
  Also available as the `gitbraid_assignGlob` LM tool for AI-driven bulk assignment.
- **Named checkpoints** (`gitbraid.saveCheckpoint` / `gitbraid.restoreCheckpoint`)
  — snapshot the full stack and assignments before risky rebases; restore from a
  QuickPick of saved snapshots with branch and assignment counts.
- **Commit message templates** (`gitbraid.setCommitTemplate`) — per-branch
  template pre-populates the SCM input box with variables `{branch}`, `{issue}`
  (JIRA token), and `{scope}` (last path segment).
- **Team stack templates** (`gitbraid.exportStackTemplate`) — export a template
  to `.gitbraid/stack.json`; new teammates are offered a one-click "Apply
  Template" prompt when they open the repo without an existing stack.
- **Routing preview** (`gitbraid.previewRouting`) — dry-run all hunk
  assignments with `git apply --check`; see per-branch pass/fail in the Output
  panel before committing anything.
- **PR-ready diff** (`gitbraid.openStackDiff`) — diff the current workspace
  against the base of the stack in a dedicated editor tab.
- **Stack diagram** (`gitbraid.copyStackDiagram`) — copy an ASCII tree of the
  stack (branch names, bases, file counts) to the clipboard.
- **Undo / redo** — assignment and hunk-assignment actions are reversible within
  the session (`Ctrl+Alt+Z` / `Ctrl+Alt+Shift+Z`).
- **Scratch area** — create a `gitbraid-scratch` worktree as a parking area for files
  that aren't ready for any branch yet. The scratch SCM panel hides the commit input
  so it stays visually distinct. Use **GitBraid: Add Scratch Area** from the command
  palette to create one.
- **Import / export** — share a stack layout with teammates via `.gitbraid/stack.json`
  committed to the repository.
- **AI / chat integration** — nine VS Code language model tools (`gitbraid_getStack`,
  `gitbraid_assignFile`, `gitbraid_assignHunk`, `gitbraid_getFloatingFiles`,
  `gitbraid_commitBranch`, `gitbraid_getBranchStatus`, `gitbraid_addBranch`,
  `gitbraid_getStackDiagram`, `gitbraid_assignGlob`) let AI assistants interact
  with the stack programmatically. The same tool set is available over MCP.

## Quick Start

1. Open the **Getting Started** walkthrough (*GitBraid → Get Started* in the activity
   bar, or *Help → Get Started* → search **GitBraid**).
2. Use **GitBraid: Add Branch to Stack** to create a stacked worktree branch.
3. Assign files or hunks to branches via the Explorer context menu or CodeLens.
4. Commit per-branch from the Source Control panel.

## Keyboard shortcuts

| Action | Windows / Linux | macOS |
|--------|----------------|-------|
| Add branch to stack | `Ctrl+Alt+B` | `Cmd+Alt+B` |
| Assign file to branch | `Ctrl+Alt+A` | `Cmd+Alt+A` |
| Route hunks | `Ctrl+Alt+R` | `Cmd+Alt+R` |
| Open stack view | `Ctrl+Alt+T` | `Cmd+Alt+T` |
| Move branch up in stack | `Alt+Up` _(Branch Stack focused)_ | `Alt+Up` |
| Move branch down in stack | `Alt+Down` _(Branch Stack focused)_ | `Alt+Down` |
| Undo last assignment | `Ctrl+Alt+Z` | `Cmd+Alt+Z` |
| Redo last assignment | `Ctrl+Alt+Shift+Z` | `Cmd+Alt+Shift+Z` |

## Extension API

Other extensions can consume the GitBraid API:

```typescript
const ext = vscode.extensions.getExtension('nichobbs.gitbraid')
const api = await ext?.activate() as GitBraidExportedAPI
const stack = api?.getStack()                            // BranchStackEntry[]
await api?.assignFile('src/foo.ts', 'feature/docs')
await api?.commitBranch('feature/docs', 'docs: update readme')
await api?.reorderStack(['feature/base', 'feature/docs'])
api?.onDidSyncFile(({ relativePath, branch }) => { /* … */ })
```

See [`src/@types/GitBraidAPI.d.ts`](src/@types/GitBraidAPI.d.ts) for the full typed
interface.

## Telemetry

GitBraid ships with **opt-in, anonymous** usage counters (command names only —
never file contents, paths, branch names, or remote URLs). It is off by default.
To enable it set `gitbraid.telemetry.enabled: true`; VS Code's global telemetry
setting must also be on. Events are counted locally and emitted through a
pluggable sink so a downstream reporter (Application Insights, Sentry, …) can
be wired in without touching command code. See `USAGE.md` for the event list.

## Requirements

- VS Code ≥ 1.95.0
- Git ≥ 2.5 (for worktree support)
