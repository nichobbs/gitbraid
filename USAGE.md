# GitBraid — Usage Guide

GitBraid lets you work on several branches simultaneously in a single workspace.
Each changed file (or individual diff hunk) is **assigned** to a branch; GitBraid
tracks where each change belongs and lets you commit per-branch from the Source
Control panel.

---

## Concepts

| Term | Meaning |
|------|---------|
| **Stack** | An ordered list of branches, each building on the one below. Stored in `.worktrees/local-config.json` (never committed). |
| **Floating file** | A file with uncommitted changes that has not yet been assigned to any branch. Shown under **Floating (unassigned)** in the Branch Stack view with a ⚠ icon. |
| **Assignment** | A mapping from a file path (or individual diff hunk) to a branch name. |
| **Worktree** | A separate Git working tree on disk, one per stacked branch. GitBraid creates and manages these automatically. |

---

## Views

Both views live in the **Source Control** panel (git icon in the Activity Bar).

| View | Purpose |
|------|---------|
| **GitBraid (Worktrees)** | Shows all worktrees and their changed files. Use for staging, discarding, copying/moving files between worktrees. |
| **Branch Stack** | Shows the ordered stack. Each branch lists its assigned files; floating (unassigned) files appear at the bottom. |

A status-bar item shows the count of floating files so you always know when
something is unassigned.

---

## Getting started

### 1 — Open the walkthrough

*Help → Get Started* → search **GitBraid: Get Started**.
The walkthrough covers adding a branch, assigning a file, and committing.

---

## Common workflows

### Add a branch to the stack

**Command Palette:** `GitBraid: Add Branch to Stack`
(`gitbraid.addStackBranch`)

1. Enter a branch name (e.g. `feature/my-feature`).
2. Pick a base branch — `main` or any branch already in the stack.
3. GitBraid creates a new git worktree for that branch.

> To remove a branch: **Command Palette** → `GitBraid: Remove Branch from Stack`.

---

### Assign a floating file to a branch

Files with untracked or modified content that are not yet assigned appear under
**Floating (unassigned)** in the Branch Stack view.

**Option A — Explorer context menu**
Right-click the file → **Assign File to Branch** → pick a branch.

**Option B — Command Palette**
`GitBraid: Assign File to Branch` (`gitbraid.assignFile`) — uses the currently
active editor file if no URI is provided.

The file's name is decorated with the branch colour in the Explorer.

**To unassign:** right-click → **Unassign File from Branch**, or
`gitbraid.unassignFile` from the Command Palette.

---

### Commit changes to a branch

Each stacked branch gets its own entry in the **Source Control** panel showing
only the files assigned to it.

1. Open the Source Control panel.
2. Find the entry for the branch you want to commit.
3. Type a commit message in that branch's input box.
4. Press the ✓ **Commit** button (or run `GitBraid: Commit Branch`).

---

### Assign individual hunks to different branches

When a single file contains changes that belong to different branches:

1. Open the file — CodeLens links appear above each diff hunk.
2. Click **Assign Hunk to Branch** above the relevant hunk and pick a branch.
3. Repeat for other hunks in the file.
4. Run `GitBraid: Route Hunks to Assigned Branches` (`gitbraid.routeHunks`) to
   apply the routing — this copies each hunk into the appropriate worktree and
   clears the hunk assignments for that file.

---

### Rebase a branch onto its parent

When a parent branch advances, GitBraid detects the gap and offers a notification.

- Click the notification button, **or**
- Run `GitBraid: Rebase Branch onto Parent` (`gitbraid.rebaseBranch`) and pick
  the branch.

---

### Worktree management (GitBraid Worktrees view)

From the **GitBraid (Worktrees)** view toolbar or by right-clicking a worktree
root:

| Action | How |
|--------|-----|
| Create worktree | Toolbar `+` button |
| Delete worktree | Right-click → **Delete Branch / Worktree** (worktree must be unlocked) |
| Open in new window | Right-click → **Open worktree in new window** |
| Lock / unlock | Right-click → **Lock worktree** / **Unlock worktree** |
| Swap primary worktree | Right-click the primary worktree → **Swap worktree** |
| Copy file to another worktree | Right-click a file → **Copy to worktree** |
| Move file to another worktree | Right-click a file → **Move to worktree** |
| Stage / unstage / discard | Inline buttons or right-click on files/groups |

---

## Configuration

Settings are under `gitbraid.*` in VS Code preferences.

| Setting | Default | Description |
|---------|---------|-------------|
| `gitbraid.syncDebounceMs` | `500` | Debounce delay (ms) for workspace sync on file changes. |
| `gitbraid.showFloatingWarningOnCommit` | `true` | Warn when committing if floating (unassigned) files exist. |
| `gitbraid.prDecorationsEnabled` | `true` | Show branch-colour decorations on files in the Explorer. |
| `gitbraid.defaultBranchColor` | `"#4CAF50"` | Default colour for new stack branches. |

---

## AI / chat integration

Seven language model tools allow AI assistants (e.g. GitHub Copilot Chat) to
interact with the stack programmatically:

| Tool | What it does |
|------|-------------|
| `mbc_getStack` | Returns the current branch stack. |
| `mbc_addBranch` | Adds a branch to the stack. |
| `mbc_assignFile` | Assigns a file to a branch. |
| `mbc_assignHunk` | Assigns an individual diff hunk to a branch. |
| `mbc_getFloatingFiles` | Lists files not yet assigned to any branch. |
| `mbc_commitBranch` | Commits assigned files on a branch. |
| `mbc_getBranchStatus` | Returns staged/unstaged/untracked counts for a branch. |

Example prompt: *"Assign src/auth.ts to the feature/auth branch and commit it
with the message 'feat: add auth module'."*

---

## Troubleshooting

**Stack view is empty** — run `GitBraid: Add Branch to Stack` to add the first
branch.

**File is not appearing in the SCM entry for a branch** — check that the file is
assigned (look for the branch colour in the Explorer, or check the Branch Stack
view). If it shows under Floating, assign it first.

**Hunk routing produced unexpected results** — check the GitBraid output channel
(*View → Output → GitBraid*) for error details.
