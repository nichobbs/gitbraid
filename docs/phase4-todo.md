# Phase 4 — Branch Hierarchy & Stacking: Todo & Progress

**Goal**: Cumulative content resolution through the stack; automatic rebase
suggestions when a child branch falls behind its parent.

---

## Status Legend
- `[ ]` Not started
- `[~]` In progress
- `[x]` Complete

---

## 4.1 — StackResolver (`src/stackResolver.ts`)

- [x] `StackResolver.getResolvedContent(wsRoot, relativePath)` — reads live worktree
      file if it exists; falls back to `git show <branch>:<file>` for the assigned branch
- [x] `StackResolver.getCommittedContent(wsRoot, branch, relativePath)` — pure
      `git show <branch>:<file>` (no worktree read)
- [x] `StackResolver.getStackDiff(wsRoot, relativePath)` — `git diff <base>...<top> -- <file>`
      to show cumulative changes vs. the bottom of the stack
- [x] `StackResolver.getStackFiles()` — returns list of all files that have a stack assignment
- [x] `_sanitise(input)` helper: strips `../`, `./`, escapes `"` with `String.raw`
- [x] Imports use `node:` prefix (`node:util`, `node:child_process`, `node:path`)

---

## 4.2 — RebaseSuggestionService (`src/rebaseSuggestionService.ts`)

- [x] `RebaseSuggestionService.init(workspaceRoot)` — starts 5-minute polling interval
      and subscribes to `configService.onDidChangeStack`
- [x] `RebaseSuggestionService.getCommitsBehind(wsRoot, child, parent)` — runs
      `git rev-list --count <child>..<parent>` to count missed parent commits
- [x] `_checkAll()` — iterates stack entries; for each entry that is behind its parent,
      shows a VS Code notification offering "Rebase now" / "Dismiss"
- [x] `_rebaseBranch(name)` — runs `git rebase "<base>"` in the child's worktree;
      clears the `_notified` cache on success; surfaces errors via `showErrorMessage`
- [x] `rebaseBranch(name)` — public façade over `_rebaseBranch` (used by command)
- [x] `_notified: Set<string>` — debounces repeat notifications within a session
- [x] Polling interval: `CHECK_INTERVAL_MS = 5 * 60 * 1000` (5 minutes)
- [x] Implements `vscode.Disposable` (clears interval on dispose)

---

## 4.3 — Extension wiring (`src/extension.ts`)

- [x] Phase 4 services instantiated after Phase 3 block
- [x] `StackResolver` stored as `_stackResolver` (used by API / future commands)
- [x] `RebaseSuggestionService` registered in `context.subscriptions`
- [x] `multi-branch-checkout.rebaseBranch` command registered — prompts for branch if
      not supplied; calls `rebaseSvc.rebaseBranch(name)`

---

## 4.4 — Tests (`test/phase45.test.ts`)

- [x] `sr.1` — `git show HEAD:hello.txt` retrieves committed file content
- [x] `sr.2` — `git diff HEAD HEAD -- file` is empty for unchanged file
- [x] `sr.3` — `git rev-list --count HEAD..HEAD` returns `0`
- [x] `sr.4` — child branch reports 1 commit behind after parent advances

---

## Commit

- [x] Committed as `feat(phase4): stack resolver and rebase suggestion service` (4451014)
