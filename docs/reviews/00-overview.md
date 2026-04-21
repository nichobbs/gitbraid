# GitBraid Code Review — Overview

Review performed against commit `6998dc7` on branch `claude/code-review-report-J9MhV`
(2026-04-21).

## Scope

The review covers the entire `src/` tree (Phase 1–5 services and the older
worktree-view code), the `test/` suite, `package.json`, the activation flow
in `extension.ts`, and supporting scripts/config (`esbuild.js`,
`.vscode-test.mjs`, `configTypes.ts`).

## Summary

GitBraid is an ambitious extension: it layers a per-branch file-assignment
model, a hunk-level routing pipeline, a synthesised per-branch SCM, and an
AI-facing tool API over git worktrees. The core design is coherent and the
Phase 1–3 services (`ConfigService`, `BranchStackService`, `WorkspaceSync`,
`DiffEngine`, `HunkRouter`) are reasonably well factored and tested.

However, the implementation has several recurring problems that should be
addressed before release:

1. **Shell-injection and quoting bugs** throughout the `git`-command layer
   (`gitFunctions.ts`, `mbcApi.ts`, `branchScmProvider.ts`,
   `rebaseSuggestionService.ts`, `stackResolver.ts`). The code favours
   `child_process.exec` with hand-quoted strings instead of `spawn` with an
   argv array.
2. **Two parallel view hierarchies** (`WorktreeView` + `BranchStackTreeProvider`)
   that duplicate state and have not been reconciled. The old worktree tree
   and its command surface (create/delete/lock/swap/patch) is largely
   orthogonal to the new Phase 2 stack model.
3. **Packaging inconsistencies**: the manifest claims `publisher: nihobbs`
   but the README and API gate references `nihobbs.gitbraid` while code
   references `nichobbs` elsewhere; the `activationEvents` entry is
   malformed; LM tools are not declared in `contributes.languageModelTools`.
4. **Testing gaps**: almost every file-level integration test shares a
   global `.worktrees/` inside `test_projects/proj1/`, and many suites
   mutate workspace state without reliable isolation. Several modules
   (`commands.ts`, `worktreeNodes.ts`, `branchScmProvider.ts`,
   `hunkCodeLensProvider.ts`, `extension.ts`) have no direct unit tests.
5. **Error paths swallow too much**: `catch {}` clauses are frequent and
   the logging layer double-logs notifications and throws on a successful
   command that happens to have `stderr` (e.g. `warning: LF…`).

## How to read the rest of this review

The review is split into themed documents under `docs/reviews/`:

| File | Theme |
| --- | --- |
| `01-architecture.md` | Module layering, singletons, activation order |
| `02-bugs-and-correctness.md` | Concrete bugs and correctness issues |
| `03-security.md` | Shell injection, path traversal, input validation |
| `04-testing.md` | Coverage gaps, flakiness, test strategy |
| `05-ui-and-ux.md` | Tree views, SCM, commands, walkthrough |
| `06-error-handling-and-logging.md` | Exception strategy, Logger class |
| `07-performance.md` | Debouncing, caching, watcher storm |
| `08-missing-features.md` | Roadmap items the PLAN implies but code omits |
| `09-packaging-and-branding.md` | `package.json`, publisher, identifiers |
| `10-priorities.md` | Suggested triage order |

Each file can be read independently; cross-references use the convention
`see 02-bugs-and-correctness.md#<anchor>`.
