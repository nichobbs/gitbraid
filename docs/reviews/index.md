# GitBraid Code Review

**Date:** April 2026  
**Scope:** Full codebase review — `src/` (5,938 lines), `test/` (3,010 lines), configuration, and docs  
**Version reviewed:** 0.1.0 (commit `6998dc7`)

---

## Summary

GitBraid is a well-conceived VS Code extension that solves a real problem: developing
multiple stacked features simultaneously without constant branch-switching. The core
architecture is clean, the TypeScript is idiomatic, and the test coverage is reasonable
for a 0.1 release.

The main areas for improvement are:

| Theme | Key issue | Priority |
|---|---|---|
| **Security** | Force-remove discards uncommitted worktree changes silently | High |
| **Bugs** | `pathExists()` throws instead of returning false | Medium |
| **Bugs** | `_syncing` flag causes saves during sync to be dropped, not deferred | Medium |
| **Architecture** | `extension.ts` too large; `WORKTREES_DIR` duplicated | Medium |
| **Testing** | No integration tests; UI components entirely untested | Medium |
| **Missing features** | Overlap detection not wired into routing workflow | High |
| **Missing features** | No bi-directional sync, no stacked-PR tooling | Low |
| **Code quality** | Unhandled promise rejections in all command handlers | High |
| **Performance** | Sequential hunk routing; overly broad file watcher | Low |

---

## Review Files

- [architecture.md](architecture.md) — Layered design analysis, singleton concerns, dead code, missing resilience
- [security.md](security.md) — Command injection, path traversal, concurrent writes, force-remove data loss
- [bugs.md](bugs.md) — Six specific defects with reproduction paths and fixes
- [testing.md](testing.md) — Coverage gaps, missing integration tests, recommendations
- [performance.md](performance.md) — Sequential routing, unbounded config growth, broad file watcher
- [missing-features.md](missing-features.md) — Ten absent or incomplete features
- [code-quality.md](code-quality.md) — Promise handling, duplicated constants, dead code, ESLint gaps

---

## Highest-Priority Actions

1. **Wire `detectOverlaps()` into `routeFile()`** — overlapping hunk assignments silently
   produce `git apply` failures with no user explanation. The code already exists; it
   just needs to be connected. (`missing-features.md` F1)

2. **Add an error handler wrapper for all command registrations** — every command
   currently swallows errors silently via `void`. One shared wrapper function fixes all
   of them at once. (`code-quality.md` Q1)

3. **Guard `git worktree remove --force`** — check for dirty files before forcing
   removal; prompt the user if any exist. (`security.md` Finding 5)

4. **Fix `pathExists()`** — the function throws on missing paths instead of returning
   `false`, contradicting its signature. (`bugs.md` B5)

5. **Defer saves that arrive during a sync** — the `_syncing` guard currently drops
   events that arrive while a write is in progress. (`bugs.md` B2)
