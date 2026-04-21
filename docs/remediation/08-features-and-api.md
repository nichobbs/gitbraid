# Features and API

Items that the `PLAN.md` implies but the codebase omits, plus public-API
symmetry so downstream tools (including LM tools) can automate the
whole workflow.

---

## T63. Wire `detectOverlaps` into `routeFile`

**File:** `src/hunkRouter.ts:routeFile`
**Cross-ref:** `docs/reviews/missing-features.md` F1,
`docs/reviews/index.md` highest-priority #1.

### Fix

Before applying patches:

```ts
const overlaps = detectOverlaps(hunks)
if (overlaps.length > 0) {
    throw new BranchStackError(
        `Cannot route: ${overlaps.length} overlapping hunk assignments. ` +
        `Reassign the overlapping hunks and try again.`,
    )
}
```

Combined with T25 the message surfaces as a user notification rather
than silent `git apply` failure.

### Effort

¼ day.

---

## T64. Fix zero-line hunk endLine

**File:** `src/diffEngine.ts:parseDiffHunks`
**Cross-ref:** `docs/reviews/bugs.md` B3.

### Fix

```ts
const endLine = newCount === 0 ? currentStart - 1 : currentStart + newCount - 1
```

Add fixture covering `@@ -5,3 +5,0 @@`.

### Effort

¼ day.

---

## T65. Parse multi-remote branch names correctly

**File:** `src/gitFunctions.ts:252`
**Cross-ref:** `docs/reviews/02-bugs-and-correctness.md` ("Git
branch listing parses remote names wrongly").

### Fix

Parse `git branch -r`'s own output rather than stripping the first
path segment. Preserve the remote prefix in the returned objects:

```ts
interface RemoteBranchRef { remote: string, name: string, fullName: string }
```

UI layers that want the short form can strip `origin/` themselves.

### Effort

½ day.

---

## T66. Rename `getCommitsBehind` → `getCommitsAhead(parent, child)`

**File:** `src/rebaseSuggestionService.ts:181`
**Cross-ref:** `docs/reviews/02-bugs-and-correctness.md`
("getCommitsBehind returns the wrong number").

### Fix

The method argument order was `(childBranch, parentBranch)` and the
name was "behind" — semantically inverted. Pick one and make it
internally consistent. Callers' expected value is "how many commits
has parent advanced that child hasn't absorbed yet" — so
`getCommitsAhead(parent, child)` reads naturally.

Update callers and strengthen the test (currently passes `'HEAD','HEAD'`
and asserts zero — insufficient).

### Effort

½ day.

---

## T67. Push-stack / sync-stack commands

**File:** new `src/stackCommands.ts`, `src/extension.ts`,
`package.json`
**Cross-ref:** `docs/reviews/08-missing-features.md` ("Push-stack /
sync-stack"), `docs/reviews/missing-features.md` F5.

### Fix

- `gitbraid.pushStack` — for each branch in order:
  - ensure upstream via `git push -u origin <branch>` on first push.
  - subsequent pushes: `git push origin <branch>` (non-forced by
    default; opt-in `--force-with-lease` for post-rebase).
- `gitbraid.syncStack` — for each branch in order:
  - `git fetch origin <branch>` then `git rebase <parent>`.
  - stop on conflict, surface T70 recovery UI.

### Effort

2 days.

---

## T68. Assign subtree to branch

**Files:** `src/commands.ts`, context-menu contribution in
`package.json`
**Cross-ref:** `docs/reviews/08-missing-features.md` ("Assign all
files on branch"), `docs/reviews/missing-features.md` F6 adjacent.

### Fix

Right-click on a folder in Explorer → `"GitBraid: Assign subtree to
branch…"`. Collects every tracked file under the folder, runs
`ConfigService.setAssignment` in batch, honours the debounced write
(T48).

### Effort

½ day.

---

## T69. Undo stack for assignments / hunk assignments

**File:** new `src/undoStack.ts`
**Cross-ref:** `docs/reviews/08-missing-features.md` ("Undo"),
`docs/reviews/missing-features.md` F7,
`docs/reviews/architecture.md` ("No undo/redo support").

### Fix

In-memory ring buffer (size 100) of inverse operations. Commands:

- `gitbraid.undoLastAssignment` — pops from the buffer and replays.
- `gitbraid.redoLastAssignment` — paired stack.

Scope: assignment / hunk-assignment / reorder / add / remove branch.
Not persisted across sessions.

### Effort

1 day.

---

## T70. Rebase conflict recovery UI

**Files:** `src/rebaseSuggestionService.ts`, new
`src/rebaseConflictView.ts`, `package.json`
**Cross-ref:** `docs/reviews/08-missing-features.md` ("Stack-wide
conflict recovery"), `docs/reviews/missing-features.md` F8.

### Fix

- On `git rebase` non-zero exit: detect mid-rebase state via
  `.git/rebase-merge/` existence in the worktree.
- Show a modal with: `Open conflicted files` / `Abort (--abort)` /
  `Continue (--continue)` / `Show instructions`.
- Register commands `gitbraid.rebaseAbort`, `gitbraid.rebaseContinue`.
- Watch `.git/rebase-merge/` for removal; emit
  `onDidCompleteRebase` and refresh.

### Effort

2 days.

---

## T71. Assignment import / export

**Files:** `src/mbcApi.ts` (two new methods), new command
registrations, `package.json`
**Cross-ref:** `docs/reviews/08-missing-features.md` ("Export /
import stack"), `docs/reviews/missing-features.md` F6.

### Fix

- Export → writes `.gitbraid/stack.yaml` (or `stack.json` — pick one)
  **committed** to the repo, describing stack order and assignments
  but not local paths.
- Import → merges into `local-config.json`, giving the user a
  QuickPick when there are conflicts between personal assignments
  and the imported layout.

### Effort

1 day.

---

## T72. Public API symmetry

**File:** `src/mbcApi.ts`, type export
**Cross-ref:** `docs/reviews/08-missing-features.md` ("API surface
gaps").

### Fix

Add:

- `reorderStack(orderedNames: string[]): Promise<void>`
- `routeHunks(relativePath: string): Promise<boolean>`
- `rebaseBranch(name: string): Promise<void>`
- `getHunkAssignments(relativePath: string): HunkAssignment[]`
- `onDidSyncFile` event re-export
- `onDidFloatFile` event re-export

### Effort

½ day.

---

## T73. Default branch detection

**File:** `src/branchStackService.ts`, `src/extension.ts:addStackBranch`
**Cross-ref:** `docs/reviews/08-missing-features.md` ("Handle main
being renamed").

### Fix

Compute default branch once from `git symbolic-ref
refs/remotes/origin/HEAD` with a fallback to `git config
--get init.defaultBranch` and finally `main`. Expose through
`ConfigService.getDefaultBranch()` and use it wherever `main` is
hard-coded (`addStackBranch` base picker, `_createWorktree` default
base).

### Effort

½ day.

---

## T74. Detect "branch already checked out" early

**File:** `src/branchStackService.ts:addBranch`
**Cross-ref:** `docs/reviews/08-missing-features.md` ("Handle
worktree-inside-worktree edge cases").

### Fix

Before `git worktree add`, check `git worktree list --porcelain` for
a row matching the branch. If present, raise a friendly error rather
than letting git bubble a cryptic "is already checked out at X".

### Effort

¼ day.

---

## T75. PR awareness via `vscode.github-pullrequests` (opt-in)

**Files:** new `src/prIntegration.ts`
**Cross-ref:** `docs/reviews/08-missing-features.md` ("PR
awareness"), `docs/reviews/missing-features.md` F5.

### Fix

- Runtime feature detection for the extension id.
- If present, decorate each `BranchNode` with the PR status
  (`$(git-pull-request-draft)` etc.).
- Gate behind `gitbraid.prDecorationsEnabled` (which is now finally
  honoured — see T39).

### Effort

1–2 days.

---

## Features exit criteria

- [ ] Overlap detection blocks routing with a clear message.
- [ ] Stack push/sync commands are documented in USAGE.md.
- [ ] Public API mirrors internal capability.
- [ ] LM tools (from T15) cover the same surface as the public API.
