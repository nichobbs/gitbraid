# Plan 18 - Semantic Hunk Classification

**Inspiration:** The article's review tool distinguishes comment-only
changes from consequential logic changes
(https://www.anthropic.com/engineering/redesigning-source-control).
Builds on plan 04 (absorb).

**Status:** **Implemented** (steps 1 to 4; see "As built"). Tracking issue: #42.

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

## As built

- `src/languageRules.ts` (data) and `src/hunkClassifier.ts` (pure, no `vscode` import). `classifyFileHunks(hunks, fileText, path)` is the entry point; `classifyHunk` is the per-hunk core. `src/hunkKinds.ts` adds the disk-reading wrapper, `DiffHunk.classification?`, and the auto-routing inheritance.
- **The file text is required.** A hunk alone cannot say whether it starts inside a block comment or a multi-line string, so without the file (or when the hunk does not match it, or the file is over 2 MiB) every hunk is `logic`.
- Lexical state is established by lexing the file up to the hunk. A hunk whose old and new sides end in different states (it opens or closes a comment or string) is `logic`, and so is every later hunk of the file, because their old-side state is then unknown.
- Whole-hunk comparison, context included: a statement moved past its neighbours is `logic`, not `whitespace`. Within a line, spacing is normalised only in C-like languages and never between two word characters or two operator characters (`a + +b` is not `a ++b`, `a / *p` is not `a /*p`); lines containing `/` in JS/TS are compared exactly (regex literals); string contents are never normalised; Python and YAML keep indentation.
- Magic comments (`@ts-ignore`, `eslint-disable`, `type: ignore`, `go:generate`, `+build`, shebangs, `#region`, ...) count as code. Languages with constructs the lexer does not handle disqualify the whole file: Rust raw strings, C/C++ raw strings, C# verbatim strings, shell heredocs, YAML block scalars. Markdown is always `logic`; unknown extensions only treat trailing whitespace/CRLF as trivial.
- Surfaces: CodeLens tag (`gitbraid.showHunkKind`, default on, skipped for unsaved documents); absorb `skipTrivial` (command layer passes `gitbraid.absorbSkipTrivial`, default true, trivial hunks stay in the worktree with a stated reason; the library default is false); `gitbraid.autoRouteTrivialHunks` (`off` default | `whitespace` | `whitespace+comment`) used by the Route Hunks command and `GitBraidApi.routeHunks`: inherited assignments exist only for that run and are never written to the config.
- Tests: a table of 70 real `git diff` fixtures across the languages above, seeded property tests (code edits are never trivial, comment/whitespace-only edits always are) and mutation checks of every safety rule.

Not done: `kind` in the agent `getFileHunks` tool and the `renderStackBlock` review-focus line (steps 5 and 6 depend on plan 12 landing); Java/Go/Rust/C# multi-line imports (a multi-line import hunk is `logic`); refactor-equivalence kinds. Residual limits: JS/TS regex literals that contain `//` or `/*` can fool the lexer (escaped slashes are handled); inheritance for auto-routing uses the live hunk indices, so a file whose stored assignments are stale relative to the live diff may inherit from the wrong neighbour (overlaps are still rejected by the router).
