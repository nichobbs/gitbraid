# GitBraid — Usage Guide

GitBraid lets you work on several branches simultaneously in a single workspace.
Each changed file (or individual diff hunk) is **assigned** to a branch; GitBraid
tracks where each change belongs and lets you commit per-branch from the Source
Control panel.

---

## Concepts

| Term | Meaning |
|------|---------|
| **Stack** | An ordered list of branches, each building on the one below. Stored in `.worktrees/gitbraid-config.json` (never committed to the repo). If an older `.worktrees/local-config.json` exists, GitBraid migrates it on first load. |
| **Floating file** | A file with uncommitted changes that has not yet been assigned to any branch. Shown under **Floating (unassigned)** in the Branch Stack view. |
| **Assignment** | A mapping from a file path (or individual diff hunk) to a branch name. |
| **Worktree** | A separate Git working tree on disk, one per stacked branch. GitBraid creates and manages these automatically under `.worktrees/`. |

---

## Views

The **Branch Stack** view lives in its own **GitBraid** activity-bar icon (the braid
icon on the left sidebar). It shows the ordered stack with the **topmost layer first**:
each branch lists its assigned files; floating (unassigned) files appear at the bottom
under **Floating (unassigned)**.

Each branch node displays live health indicators:

| Indicator | Meaning |
|-----------|---------|
| `↑N` | N commits ahead of the branch's base |
| `↓N` | N commits behind the branch's base |
| `⦿` | Worktree has uncommitted changes |
| Warning icon | A rebase is currently in progress |

Unassigned (floating) files are colour-coded by age: grey (<1 h), yellow (1–24 h),
orange (1–7 days), red (>7 days).

A status-bar item shows the count of floating files so you always know when something
is unassigned. It hides automatically when the stack is empty or all files are assigned.

---

## Getting started

### 1 — Open the walkthrough

*Click the GitBraid icon in the activity bar* and follow the in-panel walkthrough, or
open it via *Help → Get Started* → search **GitBraid: Get Started**. It covers adding a
branch, assigning a file, and committing.

---

## Common workflows

### Add a branch to the stack

**Command Palette:** `GitBraid: Add Branch to Stack` (`gitbraid.addStackBranch`)
or **`Ctrl+Alt+B`**

1. A QuickPick shows existing local/remote branches. Select one, or choose
   **+ Create a new branch** at the top of the list and type a name.
2. Pick a base branch — the repository's default branch or any branch already in the stack.
3. GitBraid creates a git worktree for that branch under `.worktrees/`.

> To remove a branch: **Command Palette** → `GitBraid: Remove Branch from Stack`.

When a branch is added, GitBraid automatically copies any files it has committed
(relative to its base) into the primary workspace and assigns them to that branch.
This means the workspace immediately reflects the union of all layers — you do not
need to edit a file manually before it becomes visible. If two branches both introduce
the same file, the **highest layer** in the stack owns it in the workspace.

---

### Reorder the stack

The order of branches in the stack determines which layer wins when two branches touch
the same file (highest layer wins). The **Branch Stack** view shows branches top-layer-first.

**With the mouse:** drag a branch node onto another to insert it at that position.

**With the keyboard** (when a branch is selected in the Branch Stack view):
- `Alt+Up` — move the branch one position higher (makes it a higher layer)
- `Alt+Down` — move the branch one position lower (makes it a lower layer)

Both actions are also available via right-click → **Move Branch Up/Down in Stack**.

---

### Assign a floating file to a branch

Files with untracked or modified content that are not yet assigned appear under
**Floating (unassigned)** in the Branch Stack view.

**Option A — Explorer context menu**
Right-click the file → **GitBraid: Assign File to Branch** → pick a branch.

**Option B — Keyboard**
`Ctrl+Alt+A` — assigns the currently active editor file.

**Option C — Assign an entire folder**
Right-click a folder in Explorer → **GitBraid: Assign Folder to Branch**. Every
tracked file under the folder is assigned at once.

The file's name is decorated with the branch colour and a short badge in the Explorer.

**To unassign:** right-click → **GitBraid: Unassign File from Branch**, or use the
file's context menu in the Branch Stack view.

---

### Commit changes to a branch

Each stacked branch gets its own entry in the **Source Control** panel (`Ctrl+Shift+G`)
showing only the files assigned to it.

1. Open the Source Control panel.
2. Find the entry for the branch you want to commit (labelled **GitBraid: \<branch\>**).
3. Type a commit message in that branch's input box.
4. Press the ✓ **Commit** button (or run `GitBraid: Commit Branch`).

---

### Push or sync the whole stack

**Push stack** (`gitbraid.pushStack`) — pushes every branch in the stack to `origin`
in order (base first). Sets the upstream automatically on first push.

**Sync stack** (`gitbraid.syncStack`) — fetches from `origin` and rebases each branch
onto its parent, walking from the base outward. Stops on conflict and shows a recovery
dialog.

---

### Assign individual hunks to different branches

When a single file contains changes that belong to different branches:

1. Open the file — CodeLens links appear above each diff hunk.
2. Click **Assign Hunk to Branch** above the relevant hunk and pick a branch.
   Click **Unassign** to remove an existing hunk assignment.
3. Repeat for other hunks in the file.
4. Run `GitBraid: Route Hunks to Assigned Branches` (`gitbraid.routeHunks` /
   `Ctrl+Alt+R`) to apply the routing — this copies each hunk into the appropriate
   worktree.

If any two assigned hunks overlap, routing is blocked with a clear error message
until the conflict is resolved.

---

### Rebase a branch onto its parent

When a parent branch advances, GitBraid detects the gap and shows a notification.

- Click the **Rebase now** button in the notification, **or**
- Run `GitBraid: Rebase Branch onto Parent` (`gitbraid.rebaseBranch`) and pick the branch.

If the rebase pauses on a conflict, a dialog appears with **Open conflicts**,
**Abort**, and **Continue** options. **Open conflicts** launches VS Code's built-in
three-way merge editor for each conflicted file (falls back to a plain text tab on
older VS Code versions). Once all conflicts are resolved and staged, click **Continue**.

---

### Preview hunk routing (dry run)

Before routing hunks to worktrees, you can validate assignments without touching any
files on disk:

1. Run `GitBraid: Preview Hunk Routing (Dry Run)` from the Command Palette.
2. GitBraid runs `git apply --check` for each branch's patch inside the corresponding
   worktree — no changes are made.
3. Results (pass / fail per branch, plus any error output) appear in the **GitBraid**
   Output channel.

---

### Smart auto-assign

When you save a **new** file in a directory where every other assigned file already
belongs to a single branch, GitBraid displays a toast notification:

> *New file `src/feature/foo.ts` — assign to `feature/impl`?*

Click **Assign** to route the file immediately, or **Later** to handle it yourself.
The suggestion fires once per file per session so it will not repeat.

---

### Assign files by glob pattern

To assign many related files at once:

1. Run `GitBraid: Assign Files by Glob Pattern` from the Command Palette.
2. Enter a glob pattern relative to the workspace root (e.g. `src/auth/**`).
3. Choose a target branch.
4. Review matched files in a checkbox list — uncheck any you want to exclude.
5. Confirm. The entire batch is recorded as a single undoable action.

This command is also available as the `gitbraid_assignGlob` LM tool so AI
assistants can perform bulk assignment (e.g. *"Assign all auth-related files to
feature/auth"*).

---

### Named stack checkpoints

Before a risky rebase or large re-assignment, save a checkpoint:

- **Save** — `GitBraid: Save Stack Checkpoint` prompts for an optional label
  (e.g. `before-rebase`) and writes a timestamped snapshot to
  `.worktrees/checkpoints/`.
- **Restore** — `GitBraid: Restore Stack Checkpoint` shows a QuickPick with
  branch count and assignment count per snapshot. Restoring requires confirmation
  and replaces the current stack and assignments entirely.

Checkpoint files use the same JSON schema as `gitbraid-config.json` and can be
opened and inspected directly.

---

### Commit message templates

Set a per-branch template that pre-fills the SCM input box:

1. Right-click a branch in the Branch Stack view, or run
   `GitBraid: Set Commit Message Template` from the Command Palette.
2. Enter a template string. Supported variables:
   - `{branch}` — full branch name (e.g. `feature/auth`)
   - `{issue}` — first JIRA-style token in the branch name (e.g. `PROJ-123`)
   - `{scope}` — last path segment after `/` (e.g. `auth`)
3. The SCM input box is populated with the expanded template whenever it is
   empty (so hand-typed messages are never overwritten).
4. Leave the field blank to clear the template.

Example: template `feat({scope}): {issue} ` on branch `feature/PROJ-42-login`
expands to `feat(PROJ-42-login): PROJ-42 `.

---

### Team stack templates

Share your stack layout with new teammates:

1. Build and test your stack locally.
2. Run `GitBraid: Export Stack as Team Template`.
3. Enter optional onboarding instructions (shown to new teammates as a toast).
4. Commit the generated `.gitbraid/stack.json` to the repository.

When a teammate clones the repo and opens it in VS Code, GitBraid detects the
template and displays:

> *GitBraid: team stack template found — [your instructions]. Apply it?*

Clicking **Apply Template** imports the stack and assignments immediately.

---

### Undo and redo assignments

Assignments (file, hunk, reorder, add/remove branch) are reversible within the session.

- `Ctrl+Alt+Z` — undo the last assignment action
- `Ctrl+Alt+Shift+Z` — redo

The undo history holds the last 100 operations and is cleared when the session ends.

---

### Park files in a scratch area

A **scratch worktree** is a special branch that acts as a staging area for files
that aren't ready to be committed to any real branch yet.

**Command Palette:** `GitBraid: Add Scratch Area` (`gitbraid.addScratchWorktree`)

- Creates a `gitbraid-scratch` branch and worktree automatically.
- The scratch SCM panel hides the commit input box to make it visually distinct —
  files parked here are not intended for commit.
- Assign files to the scratch branch the same way as any other branch.
- Only one scratch area per workspace is supported; the command is a no-op if one
  already exists.

---

### Import and export a stack layout

**Export** (`gitbraid.exportStack`) — writes the current stack order and file
assignments to `.gitbraid/stack.json`. Commit this file to share the layout with
teammates.

**Import** (`gitbraid.importStack`) — reads `.gitbraid/stack.json` and merges it into
your local config. When a file is assigned to a different branch locally, a QuickPick
lets you choose which assignment wins.

---

### Stack diagram and PR-ready diff

**Copy Stack Diagram** (`gitbraid.copyStackDiagram`) — copies an ASCII representation
of the full stack to the clipboard, e.g.:

```
main
└── feature/base  [3 files]
    └── feature/impl  [5 files]
        └── feature/docs  [2 files]
```

**Open Stack Diff** (`gitbraid.openStackDiff`) — opens a diff editor comparing the
current file against the version at the base of the stack. Useful for reviewing
everything that will go into a PR before pushing.

---

### Worktree management (Branch Stack view)

Right-click a branch node in the **Branch Stack** view:

| Action | How |
|--------|-----|
| Open worktree in new window | Right-click branch → **Open in New Window** |
| Lock / unlock worktree | Right-click branch → **Lock Worktree** / **Unlock Worktree** |
| Copy file to another branch | Right-click an assigned file → **Copy File to Branch Worktree** |
| Move file to another branch | Right-click an assigned file → **Move File to Branch Worktree** |

---

## Configuration

Settings are under `gitbraid.*` in VS Code preferences.

| Setting | Default | Description |
|---------|---------|-------------|
| `gitbraid.syncDebounceMs` | `200` | Debounce delay (ms) before a saved file is synced to its worktree. |
| `gitbraid.showFloatingWarningOnCommit` | `true` | Warn when committing if floating (unassigned) files exist. |
| `gitbraid.prDecorationsEnabled` | `true` | Show PR status decorations on branch nodes in the stack view. |
| `gitbraid.defaultBranchColor` | `"#4ec9b0"` | Default colour for new stack branches. |
| `gitbraid.maxSyncFileSizeKb` | `10240` | Files larger than this (KB) are skipped during sync. |
| `gitbraid.rebaseCheckIntervalMinutes` | `5` | How often (minutes) to check whether a parent branch has advanced. Set to `0` to disable polling (checks happen on stack change and window focus). |
| `gitbraid.bidirectionalSync` | `false` | *(Experimental)* Sync changes made directly inside a worktree back to the primary workspace. |
| `gitbraid.mcpWriteEnabled` | `false` | Allow external MCP clients to call write tools. Read-only tools are always available while the MCP server is running. |
| `gitbraid.prHost` | `"auto"` | PR host: `auto`, `github`, `gitlab`, `bitbucket`, or `none`. `auto` detects from the `origin` remote. |
| `gitbraid.suggestImportOnActivate` | `false` | Offer to import a stack detected from Graphite / git-spr / git-stack / GitButler on activation. |
| `gitbraid.absorbRewritePushed` | `false` | Allow `Absorb Hunks` to rewrite commits already pushed to a remote. Dangerous. |
| `gitbraid.undoLogMaxEntries` | `500` | Entries retained in the persistent undo log (`.worktrees/undo-log.jsonl`). |
| `gitbraid.mergeQueuePollSeconds` | `30` | Polling interval for `Merge Stack` while waiting for each queued PR to land. |
| `gitbraid.telemetry.enabled` | `false` | Opt-in anonymous usage counters (command names only — never file contents or branch names). Also requires VS Code's global telemetry setting to be enabled. |

---

## Stacked PRs

GitBraid supports GitHub, GitLab, and Bitbucket as PR hosts. The host is picked
automatically from the `origin` remote; override with the `gitbraid.prHost` setting.

### Submit the stack as PRs

`GitBraid: Submit / Update Stacked PRs` (`gitbraid.submitStack`) pushes every branch
and opens (or updates) one PR per layer, wiring the `head` / `base` refs to stack
them. Each PR body is prefixed with a `<!-- gitbraid:stack-start -->` block that
lists every PR in the stack so reviewers can navigate without leaving the host.
Insert `<!-- gitbraid:no-touch -->` at the top of a PR body to tell GitBraid to
leave it alone.

### Set a token for non-extension hosts

Run `GitBraid: Set GitHub Token…` to store a PAT in VS Code's secret storage. For
GitLab and Bitbucket, use the same command — GitBraid prompts for which host you
are setting the token for (stored under `gitbraid.gitlabToken` or
`gitbraid.bitbucketToken`). Required scopes:

| Host | Scope |
|------|-------|
| GitHub | `repo` (add `workflow` if you need merge-queue enqueue) |
| GitLab | `api` (read + write merge requests) |
| Bitbucket | App password with `Pull requests: Write` and `Repositories: Read` |

### Merge queue

`GitBraid: Merge Stack via Queue` enqueues the topmost unmerged PR and polls for
completion before enqueuing the next. Support varies by host:

- **GitHub** — uses the native Merge Queue (requires queue to be enabled on the repo).
- **GitLab** — uses Merge Trains when available (paid tier); otherwise falls back to
  auto-merge when the pipeline succeeds.
- **Bitbucket** — no native queue; GitBraid surfaces a clear error and leaves the
  user to merge in order manually.

---

## Import a stack from another tool

Run `GitBraid: Import Stack from External Tool…` (`gitbraid.importStackedTool`).
GitBraid probes the repository for:

- Graphite (`.graphite_cache_persist`)
- git-stack (`.git/stack.json`)
- git-spr (PR-id trailer lines in commit messages)
- GitButler (`.git/gitbutler`)
- Plain-upstream (branches with `branch.<name>.merge` set)

…shows a preview of the inferred stack, then seeds `.worktrees/gitbraid-config.json`
so you do not have to rebuild the stack by hand. If the active tool is
auto-detected at activation, and `gitbraid.suggestImportOnActivate` is true, the
same prompt surfaces automatically.

---

## MCP server (external tools)

GitBraid ships with a Model Context Protocol server so AI agents and CLIs outside
VS Code can inspect and mutate the stack over stdio/JSON-RPC.

- **Start / stop** — `GitBraid: Start / Stop MCP Server` toggles a server that
  reuses the same service graph as the extension.
- **Read-only by default** — only `getStack`, `getFloatingFiles`,
  `getBranchStatus`, and `getStackDiagram` are exposed unless
  `gitbraid.mcpWriteEnabled` is set, at which point `addBranch`, `assignFile`,
  `assignHunk`, `assignGlob`, and `commitBranch` become available too.
- **Connect an agent** — point your MCP client (Claude Desktop, mcp-inspector,
  etc.) at the stdio endpoint the command reports.

The MCP surface is a strict subset of the extension's LM tools — the same
validation rules and audit logging apply.

---

## AI / chat integration

Nine language model tools allow AI assistants (e.g. GitHub Copilot Chat) to
interact with the stack programmatically. Reference them with `#gitbraid_*` in chat.

| Tool | What it does |
|------|-------------|
| `gitbraid_getStack` | Returns the current branch stack. |
| `gitbraid_addBranch` | Adds a branch to the stack. |
| `gitbraid_assignFile` | Assigns a file to a branch. |
| `gitbraid_assignHunk` | Assigns an individual diff hunk to a branch. |
| `gitbraid_getFloatingFiles` | Lists files not yet assigned to any branch. |
| `gitbraid_commitBranch` | Commits assigned files on a branch. |
| `gitbraid_getBranchStatus` | Returns staged/unstaged/untracked counts for a branch. |
| `gitbraid_getStackDiagram` | Returns an ASCII tree diagram of the stack. |
| `gitbraid_assignGlob` | Assigns all files matching a glob pattern to a branch. |

Example prompt: *"Assign src/auth.ts to the feature/auth branch and commit it with
the message 'feat: add auth module'."*

---

## Troubleshooting

**Stack view is empty** — run `GitBraid: Add Branch to Stack` (`Ctrl+Alt+B`) to add
the first branch.

**File is not appearing in the SCM entry for a branch** — check that the file is
assigned (look for the branch colour badge in the Explorer, or check the Branch Stack
view). If it shows under **Floating**, assign it first.

**Hunk routing produced unexpected results** — check the GitBraid output channel
(*View → Output → GitBraid*) for error details.

**Sync seems slow or stalls** — reduce `gitbraid.syncDebounceMs`, or check whether
`gitbraid.maxSyncFileSizeKb` is limiting a large generated file.

**"Branch is already checked out" error** — the branch is open in another git
worktree or another VS Code window. Close that window or run
`git worktree list` to identify where it is checked out.
