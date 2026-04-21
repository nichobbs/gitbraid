# GitBraid Remediation Plan — Overview

This plan consolidates the findings from the two review passes in
`docs/reviews/` (the numbered `00-overview.md` … `10-priorities.md` set and
the parallel `architecture.md` / `bugs.md` / `security.md` / etc. set) into
a concrete, ordered programme of work.

The plan is intentionally split across multiple files so that each chunk
stays readable, reviewable, and self-contained.

## Reading order

| File | Theme | When to work it |
| --- | --- | --- |
| `01-p0-blockers.md` | Security + correctness issues that block a 0.1 public release | First |
| `02-p1-correctness.md` | Bugs and structural problems that block a pilot | Second |
| `03-security-hardening.md` | Deeper security work: `spawn` migration, path + ref validation, config concurrency, workspace trust | Parallel to P1 |
| `04-error-and-logging.md` | Logger, typed errors, `catch {}` policy, command-wrapper | Parallel to P1 |
| `05-ui-and-ux.md` | Tree views, walkthrough, QuickPicks, drag-and-drop, decorations, status bar, accessibility | Parallel to P1 |
| `06-performance.md` | Watcher storm, CodeLens debounce, config writes, parallel init, caching | After P1 |
| `07-testing.md` | Test isolation, integration tests, coverage floor, CI | Alongside P2 |
| `08-features-and-api.md` | Missing features, LM tool declarations, public API gaps, stacked PR tooling | P2 → P3 |
| `09-packaging.md` | Publisher / branding / manifest / `activationEvents` / `engines` / scripts | Quick wins + before publish |
| `10-sequencing.md` | Milestones, parallelisation, acceptance criteria | Use as the execution tracker |

Each chapter uses the same structure:

1. **Summary** — what problem we are solving and why now.
2. **Tasks** — numbered, each with file/line references, acceptance
   criteria, and rough effort.
3. **Cross-refs** — which review sections each task closes out.

## Priority summary

The most severe items, carried forward from `docs/reviews/10-priorities.md`
and `docs/reviews/security.md` with the named-set additions folded in:

### P0 (block a public 0.1)

- Shell injection surface and the no-op quote escape in
  `diffEngine._sanitisePath` (`reviews/02-bugs…`, `reviews/03-security`).
- `gitExec` popping a warning for every `stderr` write (LF/CRLF warnings
  make the extension unusable on Windows) (`reviews/06-error-handling…`).
- `discardChanges` maps to `git clean -f`, deleting untracked files instead
  of restoring tracked changes — data-loss-adjacent
  (`reviews/02-bugs…`).
- `git worktree remove --force` discarding uncommitted worktree edits
  (`reviews/security.md` Finding 5).
- `activationEvents` is malformed; `workspaceContains:filePattern:.git/HEAD`
  is dead, extension activates in repo-less windows and throws
  (`reviews/01-architecture`, `reviews/09-packaging`).
- `git.revList()` and `git.branch()` reading `r.stdout` from a string —
  runtime crashes on every worktree tree refresh
  (`reviews/02-bugs…`).
- Publisher id inconsistency (`nihobbs` / `nichobbs` / `kherring`) — blocks
  Marketplace publish and breaks `getExtension('nihobbs.gitbraid')` from
  the README (`reviews/09-packaging`).

### P1 (block a real pilot)

- Hunk-index fragility — assignments silently re-point after edits
  (`reviews/02-bugs…`).
- `branchToWorktreeDirName` not injective — two branches can collide
  onto one worktree (`reviews/02-bugs…`, `reviews/bugs.md` B4).
- Watcher storm across `extension.ts` + `workspaceSync.ts`
  (`reviews/01-architecture`, `reviews/07-performance`).
- Two tree views with divergent state (`reviews/01-architecture`,
  `reviews/05-ui-and-ux`).
- `StackResolver.getResolvedContent` is dead code — the cumulative
  workspace view from `PLAN §4.1` is not wired in (`reviews/08-missing…`).
- No bidirectional sync (`reviews/08-missing…`, `reviews/missing-features.md` F2).
- `_syncing` flag drops saves arriving during sync instead of deferring
  them (`reviews/bugs.md` B1/B2).
- LM tools registered at runtime but not declared in
  `contributes.languageModelTools` — Copilot Chat cannot see them
  (`reviews/08-missing…`, `reviews/09-packaging`).
- Walkthrough images missing; walkthrough / SCM still use the "Multi
  Branch Checkout" brand (`reviews/05-ui-and-ux`, `reviews/09-packaging`).
- Drag-and-drop reassignment promised by `PLAN §2.3` is not implemented
  (`reviews/05-ui-and-ux`, `reviews/08-missing…`).

### P2 (hygiene, polish, correctness)

- Test isolation per suite, integration tests against a real temp repo,
  coverage floor, CI workflow (`reviews/04-testing`, `reviews/testing.md`).
- Honour user-facing settings that are currently ignored
  (`syncDebounceMs`, `showFloatingWarningOnCommit`,
  `prDecorationsEnabled`, `defaultBranchColor`)
  (`reviews/02-bugs…`, `reviews/05-ui-and-ux`).
- Logger fixes — stop recreating the singleton, fix double-fire on
  `notification`, guard `getCallerSourceLine` behind log level
  (`reviews/06-error-handling…`).
- Standardise typed errors in API surface
  (`reviews/06-error-handling…`).
- Remove dead code: commented `patchToWorktree` block, unused error
  types, stale `worktreeNodes` definitions
  (`reviews/10-priorities` quick wins).
- Performance: debounce CodeLens, cache SCM status per branch,
  parallelise initial worktree creation with a concurrency cap
  (`reviews/07-performance`, `reviews/performance.md`).
- Tighten `configTypes.isValidConfig` per-field (`reviews/02-bugs…`,
  `reviews/code-quality.md` Q7).

### P3 (roadmap)

- Stack push/sync commands, rebase-conflict recovery UI, batch "assign
  subtree", undo/redo, PR awareness via `vscode.github-pullrequests`,
  optional MCP server, drag-to-reorder stack, multi-root workspace
  support.

## Ground rules

1. **No destructive changes without tests.** Every P0/P1 fix lands with
   at least one regression test. Where a shell command is being
   migrated to `spawn` with argv, the first change in the PR is the
   negative test that proves injection is now blocked.
2. **Refactors go last.** Don't combine the command-wrapper refactor
   (`code-quality.md` Q1) with a P0 fix. The command wrapper lands as
   its own change and subsequent fixes use it.
3. **Dead code leaves the tree before it gets rewritten.** `commands.ts`
   has ~80 lines of commented `patchToWorktree`; delete before touching
   the file for anything else.
4. **Keep the two reviews in sync as remediation progresses.** After
   each milestone, annotate the closed findings in `docs/reviews/` with
   a `RESOLVED in <commit>` header so future contributors don't re-open
   them.

## Status dashboard

Annotated during execution. Checkpoint SHAs refer to the
`claude/code-review-remediation-ro7uo` branch.

### Landed

| Task | Checkpoint | Notes |
| --- | --- | --- |
| T1 — DiffEngine quote-escape no-op | 6cb9fcc / 8f68e91 | Metachar reject; full spawn migration still on plan. |
| T9 — injective branchToWorktreeDirName | b14bf4c | 7-char sha1 suffix; `initStack` migrates legacy slug-only dirs and runs `git worktree repair`. |
| T15 — LM tool manifest declarations | b14bf4c | All seven tools declared with inputSchema and toolReferenceName. |
| T19 — `git check-ref-format` validation | b14bf4c | Two-tier: cheap regex pre-filter → spawn for edge cases git rejects. |
| T20 — path-containment helper | b14bf4c | New `src/pathGuard.ts` + test suite; wired into DiffEngine. |
| T23 — workspace trust gating | b14bf4c | `activate()` defers until `onDidGrantWorkspaceTrust` in untrusted workspaces. |
| T24 — single `.gitignore` writer | b14bf4c | Duplicate in `extension.ts` removed; single writer preserves CRLF/LF. |
| T54 — `IGitRunner` seam | ce0a575 | Interface + `ProcessGitRunner` + `FakeGitRunner` + unit tests. |
| T61 — CI workflow + ESLint config | ce0a575 | `.github/workflows/ci.yml` runs lint + build + test + vsce package on Linux / macOS / Windows. Minimal `.eslintrc.json` so the lint script finally works. |
| T18 — spawn migration | 9bb9a96 / 92aee1c | Complete. `DiffEngine`, `StackResolver`, `RebaseSuggestionService`, `BranchStackService._worktreeIsDirty`, `MbcApi`, and `BranchScmProviderManager` all use `IGitRunner` (spawn, shell:false). Injection payloads traverse as argv. |
| T21 — config optimistic-concurrency | 92aee1c | `_writeToDisk` detects concurrent writes via mtime, reloads, merges via `mergeConfigs`, retries up to 3 times, then throws. |
| T12 — stack content provider | a2b4322 | New `src/stackContentProvider.ts` + `gitbraid.openResolvedAtTop` + `gitbraid.showStackDiff` commands. |
| T13 — bidirectional sync | a2b4322 | Opt-in `gitbraid.bidirectionalSync` setting; per-file generation counter breaks ping-pong loops. |
| T17 — drag-and-drop | a2b4322 | `BranchStackTreeProvider` is a `TreeDragAndDropController`. File → branch reassigns; file → floating unassigns; branch → branch reorders; Explorer drops accepted. |
| T57 — debounce fake-timer tests | a2b4322 | New `test/workspaceSync.debounce.test.ts` covers `syncDebounceMs` and the defer-during-sync path. |
| T8 — stable hunk identifiers | (current) | `HunkAnchor` persisted alongside `HunkAssignment`. `HunkRouter.routeFile` reconciles by `bodyHash` (exact) or line-range overlap (fuzzy) before applying. Schema version bumped to 2 with backwards-compatible migration. |
| T10 — shared FileChangeBus | (current) | `src/fileChangeBus.ts` collapses the duplicate `**/*` watchers in `extension.ts` into one broadcaster emitting `onDidSavePrimary` / `onDidDeletePrimary` / `onDidChangeWorktree` / `onDidAnyFileChange`. |
| T2 — gitExec stderr popup | 6cb9fcc | stderr logged at debug on success, error only on non-zero exit. |
| T3 — discardChanges data-loss | 6cb9fcc | Tracked files restored via `git checkout HEAD --`, untracked via `clean -f`. |
| T5 — activationEvents malformed | 6cb9fcc | Replaced by `workspaceContains:.git` / `.worktrees/local-config.json`; no-workspace case early-returns. |
| T6 — revList/branch undefined | 6cb9fcc | Methods return real strings/numbers. |
| T7 — Publisher/id normalisation | 6cb9fcc | Canonical spelling `nichobbs` applied across package.json, README, LICENSE, tests, gitignore stamp. |
| T11 (partial) — dead code removal | 8f68e91 | Commented `patchToWorktree` block and three unused error types deleted. |
| T14 — defer saves during sync | pre-existing | Already implemented; verified. |
| T15 (pending) — LM tool declarations | — | Still TODO: requires adding `contributes.languageModelTools` entries. |
| T27 — toUri Windows paths | 6cb9fcc | Regex now accepts both `C:\foo` and `C:/foo`. |
| T28 — log.notification double-fire | 6cb9fcc | Single showInformationMessage call; disabled path short-circuits. |
| T29 — Logger.getInstance singleton | 6cb9fcc | Idempotent; resetForTest added. |
| T30 — getCallerSourceLine cost | 6cb9fcc | Gated behind Debug log level. |
| T31 (partial) — typed errors | 8f68e91 | `MbcApi.commitBranch` throws `GitError`; unused types removed; `GitBraidError` union exported. |
| T32 — Promise.allSettled | 78b7ebf | `BranchScmProviderManager._refreshAll` switched. |
| T33 — rebase dialog await | e172305 | Flat `const choice = await …` pattern. |
| T37 — addStackBranch QuickPick polish | 78b7ebf | Groups + top "new branch" item + no default-to-main on Escape. |
| T39 — ignored user settings | 78b7ebf | `syncDebounceMs`, `prDecorationsEnabled`, `showFloatingWarningOnCommit`, `maxSyncFileSizeKb` all wired. |
| T41 — FloatingStatusBarItem hiding | 8f68e91 | Hides when stack empty or count zero. |
| T42 — CodeLens containment + unassign | e172305 | Path split-segment check; new `gitbraid.unassignHunk` command + lens. |
| T52 — file-size guard on sync | 78b7ebf | New `gitbraid.maxSyncFileSizeKb` setting. |
| T63 — overlap detection wired | pre-existing | Already wired in hunkRouter.routeFile; confirmed. |
| T64 — zero-line hunk endLine | 6cb9fcc | Now returns `startLine − 1` so overlap detection is correct. |
| T65 — remote branch listing | 6cb9fcc | Keeps non-`origin/` remote prefixes. |
| T72 (partial) — API surface symmetry | e172305 | Added reorderStack, getHunkAssignments, removeHunkAssignment, onDidSyncFile, onDidFloatFile. |
| T73 — default branch detection | 78b7ebf | `detectDefaultBranch()` replaces hard-coded `main`. |
| T74 — branch-already-checked-out | 78b7ebf | Surfaced before `git worktree add` runs. |
| T76–T78 (partial) — manifest | e172305 | Publisher, capabilities, extensionKind, activation events, categories. |
| Redaction for git command logs | 6cb9fcc | `redactCredentials`/`redactGitError` scrub user:token@ URLs + PATs. |
| Config cross-window concurrency warn | e172305 | mtime observed at read time; write checks for external modification. |

### Landed (P2)

| Task | Notes |
| --- | --- |
| T4, T46, T48, T49, T51 | dirty-check for `--force`, concurrency-capped `initStack`, async+debounced config writes, cleaner `getAllNodes`, bounded `_floatingDirty`. |
| T45, T47, T53 | CodeLens debounce + LRU, per-branch SCM TTL cache, `getHunksForFile` LRU. |
| T38, T43, T44, T31 | expanded decoration palette, `package.nls.json` scaffold, shared `showError` / `withErrorHandler`, typed errors in `utils.ts`. |
| T80–T86, T62 | engines bumped to ^1.95, `private:false`, SCM Providers category, trimmed devDeps, activity-bar container, default keybindings. |
| T55, T56 | `test/helpers/tmpRepo.ts` + `test/integration/` scaffold with a first real-git sanity suite. |
| T59, T60 | `errorSurfacer.test.ts`, `configMigration.test.ts` with a v1 fixture. |
| Coverage gate | `.github/workflows/ci.yml` runs `scripts/check-coverage.mjs` against the lcov report (non-blocking baseline for now). |

### Still to land

- T11 (full tree-view reconciliation — retire the legacy worktree
  view or drive it from the same data model).
- T16 (walkthrough PNGs — asset capture).
- Migrate downstream consumers (`BranchScmProviderManager`,
  `BranchStackTreeProvider`, `BranchFileDecorationProvider`) off
  their own event subscriptions onto the new `FileChangeBus`.
- Harden coverage-floor thresholds once a baseline lcov is in hand.
- P3 roadmap items per `10-sequencing.md`.

## Acceptance

This plan is "done" when:

- Every P0 item has a merged fix and a test.
- Every P1 item has a merged fix, a test, and an updated review note.
- `npm run lint`, `npm test`, and `npx vsce package --no-dependencies`
  all succeed in CI on every PR.
- Coverage is ≥ 70% lines / 60% branches, enforced by the test runner.
- The Marketplace listing metadata (publisher, name, icon, walkthrough
  assets, categories) is internally consistent.
