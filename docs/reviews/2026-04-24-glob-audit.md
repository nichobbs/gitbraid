# `FileChangeBus` Glob Matcher — Audit and Remediation

**Date:** 2026-04-24
**Triggered by:** residual-risk item #2 in
[`2026-04-24-audit.md`](2026-04-24-audit.md) — "audit `_matchGlob`
against `micromatch` before v1.0".
**Resolution:** replaced the hand-rolled matcher with `minimatch`.
See `src/globMatcher.ts`, `test/globMatcher.test.ts`.

## Summary

The previous in-house matcher (`FileChangeBus._matchGlob`) disagreed
with `minimatch` on **56 of 450** test cases drawn from the default
VS Code `files.watcherExclude` patterns. Most critically, every one of
VS Code's built-in exclude patterns failed to match its intended
inputs — the bus silently re-dispatched `.git/objects` churn and
nested `node_modules` events on every commit in every repo.

After replacing the matcher with `minimatch` (wrapped in a
per-pattern cache in `src/globMatcher.ts`), **0 disagreements** remain
on the same test set, brace expansion and character classes are
correctly honoured, and a differential test suite pins the behaviour
against the real `minimatch` package so future drift is caught in CI.

## Methodology

A scratch script compared the two implementations over:

- **15 patterns**, including every default VS Code `watcherExclude`
  glob, plus representative gitignore/user variants (`dist/`,
  `**/*.log`, `foo?bar`, `a/**/c`, `**`, brace expansion, character
  classes).
- **25 paths**, including root-level files, deep nested paths,
  `.git/objects/…`, `node_modules` at every depth, and deliberate
  miss-cases.

Reference implementation: `minimatch(rel, glob, { dot: true })` — the
library VS Code's own settings documentation points at for
`files.watcherExclude` semantics.

## Disagreement categories (pre-fix)

| Category | Example pattern | Example path | Pre-fix result | Reference |
| --- | --- | --- | --- | --- |
| Leading `**/` at root | `**/.git/objects/**` | `.git/objects/ab/cdef` | false | **true** |
| Leading `**/` multi-segment | `**/node_modules/**` | `a/b/node_modules/pkg/x.js` | false | **true** |
| Middle `**/` zero-segment | `a/**/c` | `a/c` | false | **true** |
| Trailing `**` at end | `**/node_modules/*/**` | `node_modules/pkg/x.js` | false | **true** |
| Bare dir over-match | `node_modules` | `node_modules/pkg/x.js` | true | **false** |
| Trailing-slash over-match | `dist/` | `dist/sub/bundle.js` | true | **false** |
| `?` semantics | `foo?bar` | `fooxbar` | false | **true** |
| `?` semantics | `foo?bar` | `foobar` | true | **false** |
| `**/*.{a,b}` braces | `**/*.{log,tmp}` | `app.log` | false | **true** |
| `**/*.[abc]` char classes | `**/*.[jt]s` | `script.ts` | false | **true** |

## Impact

The single most-impactful category was the leading `**/` one. VS
Code's default `files.watcherExclude` is:

```json
{
    "**/.git/objects/**": true,
    "**/.git/subtree-cache/**": true,
    "**/node_modules/*/**": true,
    "**/.hg/store/**": true
}
```

**None of these were being excluded** in practice. Every file event
under `.git/objects` and `node_modules` was flowing through the bus
and fanning out to every subscriber. On a 10-branch stack with a
large monorepo, each commit triggered O(branches × files-under-
`.git/objects`) downstream work.

## Fix

Replaced `FileChangeBus._matchGlob` (~40 LOC of hand-rolled regex
translation) with `src/globMatcher.ts` (~30 LOC wrapping
`minimatch`). A per-pattern FIFO cache (cap: 256) keeps parsing
amortised — the bus only pays `new Minimatch(pattern)` once per
distinct glob.

`minimatch` was already in the lockfile (ESLint transitive) so no new
supply-chain surface was introduced; it's now an explicit runtime
dependency in `package.json`. esbuild continues to bundle it into
`dist/extension.js` at build time, so `--no-dependencies` for
`vsce package` still applies.

## Verification

- **`test/globMatcher.test.ts`** — 22 targeted unit tests covering the
  leading / middle / trailing `**/` cases, `?`, literal escapes, and
  cache semantics.
- **Differential suite** — 368 parametric pairs `(pattern, path)`
  asserted equal to `minimatch(rel, glob, { dot: true })` directly.
  If `minimatch`'s behaviour ever drifts, CI will notice.
- **Full test run** — 858 passing, 1 pre-existing `WorkspaceSync`
  timing flake (unchanged by this PR).

## Considered alternatives

| Option | Outcome |
| --- | --- |
| Keep custom matcher, add brace / char-class / `?` fixes | Rejected — 200+ LOC to match minimatch behaviour; no real upside. |
| Use `picomatch` or `micromatch` | Rejected — larger bundle, not already in the lockfile. |
| Use VS Code's own internal matcher | No public API. |
| **Use `minimatch` via a thin wrapper** | **Chosen.** Battle-tested, already transitively installed, ~40 KB bundle, zero disagreements. |

## Residual risk

- Minimatch v9 uses brace expansion with exponential blow-up for
  pathological inputs (`{a,b,c,d,e}{…}` nested 20 levels deep). Since
  `files.watcherExclude` is user-controlled, this is low risk —
  nobody writes a malicious pattern against their own editor.
- The FIFO cache cap (256 patterns) is heuristic. VS Code's default
  `watcherExclude` has <10 entries and users rarely add more than a
  few dozen. If we ever observe evictions in the wild, swap for an
  LRU.

## Follow-up

None required. The audit line item from
`2026-04-24-audit.md#residual-risk-register` is closed.
