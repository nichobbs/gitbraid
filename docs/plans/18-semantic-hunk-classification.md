# Plan 18 - Semantic Hunk Classification

**Inspiration:** The article's review tool distinguishes comment-only
changes from consequential logic changes
(https://www.anthropic.com/engineering/redesigning-source-control).
Builds on plan 04 (absorb).

**Status:** **Not started.** Tracking issue: #42.

## Goal

Classify each diff hunk into a coarse kind so routing, absorb, the UI and
agents can apply safer defaults to trivial changes.

## Rationale

`DiffHunk` carries only line ranges and patch text. Blame-based absorb
targeting is unreliable for reformatting and comment edits, and agents
have no cheap way to tell which hunks need careful review.

## Design

```ts
type HunkKind = 'whitespace' | 'comment' | 'import' | 'logic' | 'mixed'
```

New pure module `src/hunkClassifier.ts` (no `vscode` import) with
`classifyHunk(hunk, rules)` and `languageRulesFor(path)`; rules in
`src/languageRules.ts` for TS/JS, Java, Python, Go, Rust, C/C++, C#,
shell and YAML. Unknown extensions only support `whitespace`.

Classification is conservative: it must never label logic as trivial.
Block-comment state is tracked through context lines; if it cannot be
determined from the hunk, the hunk is `logic`. String literals containing
comment markers are handled and covered by tests. Markdown is `logic`.

### Integration (each independently flagged)

1. `DiffHunk.classification?` computed lazily and cached with the hunk.
2. CodeLens tag, gated by `gitbraid.showHunkKind` (default true).
3. `gitbraid.autoRouteTrivialHunks`: `off | whitespace | whitespace+comment`
   (default `off`); trivial hunks inherit the nearest assigned
   neighbour's branch. Never applies to `logic` or `mixed`.
4. Absorb: `skipTrivial` default true in the interactive UI, with a
   toggle in `runAbsorbUi`.
5. Agents: `kind` in `getFileHunks` (plan 12).
6. Phase 2: `renderStackBlock` adds a per-layer review-focus line.

## Sequencing

1. Classifier and fixtures.
2. CodeLens tag.
3. Absorb skipping.
4. Auto-routing.
5. Agent and PR-body integration after plan 12.

## Tests

Table-driven from real unified-diff fixtures per language: whitespace-only,
comment-only, import-only, one-character code change, comment next to code
(`mixed`), `//` inside a string, block comment opened above the hunk
(`logic`). Fuzz property: no hunk with a non-comment token is `comment`.
Absorb skips and includes trivial hunks per the toggle; auto-routing never
touches `logic`.

## Open questions

- Tree-sitter only if heuristic false negatives prove too high.
- Should refactor-equivalence (renames) become a kind later?
