# Plan 02 — Stacked-PR Dashboard

**Inspiration:** Graphite web app.

**Status:** **Implementing (read-only webview).** See
`src/stackDashboardView.ts`; `gitbraid.stackDashboard` is registered as a
webview view in the activity-bar container.  Inline actions currently wire
`Submit`, `Rebase`, `Open PR`, and `Refresh`; reviews/checks UI is deferred
until the PR adapter exposes them.  Depends on [plan 01](01-pr-creation.md).

## Goal

In-editor webview that renders the current stack as a vertical
dependency graph with one node per branch, showing per-PR state:
number, title, base, author, review decisions, CI status.

## Rationale

A stacked-PR review is hard to orient in a flat GitHub list. A
dedicated panel — always aware of which branch you're on — would make
the review of stacked work dramatically easier.

## Design

### New webview: `GitBraid Stack Dashboard`

- Registered as `gitbraid.stackDashboard` (webview view, not a panel),
  hosted in the existing `gitbraid` activity-bar container.
- Data sources:
  - `ConfigService.getStack()` — branch metadata.
  - `PRHostAdapter.getPR(branch)` — PR state (plan 01).
  - `rebaseSuggestionService.getCommitsBehind(child, parent)` — drift.
- Renders vertical node-and-line SVG. Each node shows:
  - Branch name + icon (current-branch dot).
  - PR number + state (open / draft / merged) with GitHub icon.
  - Check status (✓ / ⌛ / ✗).
  - Review decisions (thumb / comment count).
  - "Behind parent by N commits" when non-zero.
- Click handlers:
  - Branch name → `gitbraid.switchBranch` for that branch.
  - PR number → open in browser.
  - "Rebase" / "Submit" / "Open PR" inline actions.

### Communication

Webview uses `postMessage` for commands; extension host posts
`state` updates on `onDidChangeStack`, `onDidChangeAssignment`, and
`PRAwareness.onDidRefresh`.

## Data model

No schema changes.

## Tests

- Snapshot test of the deterministic HTML render for a 3-branch stack.
- Message-bus test that a `{"cmd":"rebase","branch":"x"}` post invokes
  the corresponding command.

## Sequencing

1. Build the webview skeleton + empty-state view.
2. Wire the read-only rendering.
3. Wire inline actions.
4. Add the "checks" and "reviews" affordances once PR adapter exposes
   them.

## Open questions

- Do we want a Mermaid-like ASCII fallback for the command-palette
  flow (`gitbraid.getStackDiagram` already exists as an LM tool)?
  Probably reuse the same renderer for plain-text output.
