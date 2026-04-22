# Suggested Triage Order (2026-04-21 review)

> **Status (2026-04-22):** All P0 and most P1–P2 items have been resolved.
> See `docs/remediation/outstanding.md` for the current open list.

A pragmatic ordering of the findings across the other review files.
Scope-hardening before feature work.

## P0 — block a public 0.1 release

1. **Publisher / identifier inconsistency** (`09-packaging-and-branding.md`).
   `nihobbs` vs `nichobbs` vs `kherring`. Until this is fixed, the
   Marketplace upload will fail and the README's `getExtension(...)`
   snippet cannot work.
2. **Shell injection surface** (`03-security.md`). Move every git
   invocation to `spawn` with argv. The no-op quote-escape at
   `diffEngine.ts:201` alone is a confirmed vuln.
3. **`gitExec` stderr handling triggers popups on every successful
   command** (`06-error-handling-and-logging.md`). LF/CRLF warnings
   will make the extension unusable on Windows.
4. **`discardChanges` uses `git clean`** — discards **untracked**
   files instead of reverting tracked changes. Data-loss risk
   (`02-bugs-and-correctness.md#discardchanges-uses-git-clean`).
5. **`activationEvents` malformed** (`01-architecture.md#7-activation-events-are-misconfigured`)
   — throws a red error on any workspace without a repo.
6. **`revList` and `branch()` return `undefined`** in the legacy git
   layer (`02-bugs-and-correctness.md`). Runtime crashes during tree
   refresh.

## P1 — block a real user pilot

7. **Drag-and-drop reassignment** (`05-ui-and-ux.md`, `08-missing-features.md`).
   Primary interaction model promised by the plan.
8. **Hunk index reassignment fragility** (`02-bugs-and-correctness.md`).
   Silent miscommitment of code into the wrong branch.
9. **LM tool declarations missing from `package.json`**
   (`08-missing-features.md#language-model-tools`). Without these,
   Copilot Chat cannot find the tools.
10. **File watcher storm** (`01-architecture.md#4-file-watcher-storm`,
    `07-performance.md`). Every save triggers N × 2 git invocations.
11. **Two tree views / command surfaces** (`01-architecture.md#1-two-overlapping-viewcommand-hierarchies`).
    Confusing UX with divergent state.
12. **`StackResolver` is dead code** (`08-missing-features.md`). The
    whole "cumulative workspace view" vision is not wired in.
13. **Bidirectional sync** missing
    (`08-missing-features.md#bidirectional-sync-plan-13`). Without it,
    `git rebase` inside a worktree silently desyncs the primary.
14. **Walkthrough images missing** and walkthrough title still reads
    "Multi-Branch Checkout" (`05-ui-and-ux.md`, `09-packaging`).

## P2 — hygiene and polish

15. **Test isolation** (`04-testing.md#2-tests-share-global-workspace-state`).
    Move each suite to a tmp workspace.
16. **Add tests for `commands.ts`, `branchScmProvider.ts`,
    `hunkCodeLensProvider.ts`, `worktreeNodes.ts`** (`04-testing.md#1-entire-modules-have-no-direct-tests`).
17. **Honour user settings** (`02-bugs-and-correctness.md`):
    `syncDebounceMs`, `showFloatingWarningOnCommit`,
    `prDecorationsEnabled`, `defaultBranchColor`.
18. **Logger fixes** (`06-error-handling-and-logging.md`): stop
    recreating the singleton, fix double-fire, guard stack-trace
    helper.
19. **Typed-error standardisation** in the API layer.
20. **Dead code removal**: commented `patchToWorktree` block in
    `commands.ts`, unused error types in `errors.ts`, the commented-out
    `WorktreeNode` definitions at the top of `worktreeNodes.ts`.
21. **Performance**: debounce CodeLens, cache SCM status per branch,
    parallelise initial worktree creation with concurrency cap.

## P3 — roadmap

22. **Stack push/sync commands** (`08-missing-features.md#push-stack--sync-stack`).
23. **Rebase-conflict recovery UI**
    (`08-missing-features.md#stack-wide-conflict-recovery`).
24. **Batch "assign subtree to branch"**.
25. **Undo** for assignment / sync / commit actions.
26. **PR awareness** via `vscode.github-pullrequests`.
27. **MCP server** (opt-in; see `PLAN.md §5.3`).
28. **CI pipeline + coverage threshold** (`04-testing.md#10-cicoverage-target`).
29. **Multi-root workspace support** (deferred from `02`, enough complexity
    to deserve its own design note).
30. **Drag-to-reorder stack** (`08-missing-features.md#drag-aware-stack-reordering`).

## Effort estimate (rough)

| Phase | Items | Effort |
| --- | --- | --- |
| P0 | 1–6 | ~2 weeks |
| P1 | 7–14 | ~4–6 weeks |
| P2 | 15–21 | ~3 weeks (can parallelise) |
| P3 | 22–30 | open-ended |

## Quick wins (≤ 1 day each)

Pick off these before tackling the larger items; each fixes something
visible with minimal code.

- Remove the `"This is welcome content!"` placeholder in `viewsWelcome`.
- Replace `"Multie Branch Checkout"` command title typo.
- Fix `isPrumary` typo in the context-value regex.
- Delete `gitbraid.patchToWorktree` registration (hidden behind
  `"when": "false"` but still wired up).
- Hide `FloatingStatusBarItem` when the stack is empty.
- Replace `syncDebounceMs` constant with a `configService.getWorkspaceSetting`
  call.
- Remove unused `FileGroupError`, `WorktreeParentError`,
  `UpdateTreeError`.
- Swap `fs.readFileSync` for `fs.promises.readFile` in
  `ConfigService._readFromDisk`.
