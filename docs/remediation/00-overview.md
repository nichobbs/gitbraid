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

## Acceptance

This plan is "done" when:

- Every P0 item has a merged fix and a test.
- Every P1 item has a merged fix, a test, and an updated review note.
- `npm run lint`, `npm test`, and `npx vsce package --no-dependencies`
  all succeed in CI on every PR.
- Coverage is ≥ 70% lines / 60% branches, enforced by the test runner.
- The Marketplace listing metadata (publisher, name, icon, walkthrough
  assets, categories) is internally consistent.
