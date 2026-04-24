# Plan 02 — Stacked-PR Dashboard

**Inspiration:** Graphite web app; GitButler panel; Sapling ISL.

**Status:** **Implemented (Waves A/B/C).**  See
`src/stackDashboardView.ts`, `src/dashboardSnapshot.ts`,
`src/dashboardMessages.ts`, and
`src/commands/dashboardCommands.ts`.  Rich-PR-body preview and
native context-menu polish remain as follow-ups; core
functionality (data surface, actions, drill-down, search,
persistence) ships now.  Depends on
[plan 01](01-pr-creation.md) for PR-host integration.

## Goal

In-editor webview that renders the current stack as a vertical dependency
graph with one node per branch, surfacing per-branch / per-PR state and
allowing every common stack operation inline so the user rarely needs to
drop to the Command Palette.

## Rationale

The tree view is the right surface for file-level drill-down; the
dashboard is the right surface for stack-level overview.  Graphite ships
one, GitButler ships one, Sapling ISL ships one — GitBraid's read-only
webview is the thinnest version of the idea and leaves every action for
another surface.  Three waves close that gap.

## Design

Broken into three waves so each checkpoint is shippable on its own.

### Wave A — make it useful (rendering only)

Pure data-surface additions — no new commands, no new actions.

- **Current-branch marker.**  `collect()` reads `git branch
  --show-current` per folder and sets a new `isCurrent: boolean` on
  `DashboardBranchRow`.  The branch name row gets a `●` badge + tooltip.
- **Assigned-files count** per row.  Derived from
  `config.getAllAssignments()` at collection time.  Clickable later
  (Wave C).
- **Floating-files banner** at the top of the view.  `sync.getFloatingDirty()`
  produces a count; zero means the banner is hidden.
- **CI / checks status pill** next to the PR pill.  Reads
  `PRMetadata.checksStatus` (already in the type).  Renders `✓` /
  `⌛` / `✗` via theme tokens (`--vscode-testing-iconPassed` /
  `--vscode-testing-iconQueued` / `--vscode-testing-iconFailed`).
- **Commits ahead / behind** parent.  Behind count is already on
  `DashboardBranchRow.behindCount` (unused today); add `aheadCount` via
  `git rev-list --count base..branch`.  Render as `↑3 ↓1` badges.
- **`singleCommit` icon.**  When `config.getBranch(row.name)?.singleCommit
  === true`, render a `$(squash)` glyph with tooltip "Single-commit
  mode — commits will amend".
- **Adapter-status strip** at the bottom.  `FolderContext.getPRAdapter()
  .name` produces one of "GitHub (Octokit)" / "GitHub (VS Code)" /
  "None" / similar.  Renders as small text at the bottom of the view.

**Architecture:**
- Extract the `collect()` data into `src/dashboardSnapshot.ts` typed as
  `StackSnapshot`, with helpers to convert to DashboardData.  Reused by
  Wave C's search + sorting.
- No new settings.
- No change to the webview message contract.

**Tests:** extend `test/stackDashboardView.test.ts` with:
- Snapshot of HTML for a 3-branch stack with every field populated.
- Individual field-rendering tests (current-branch marker, checks pill
  variants, floating banner shown vs. hidden, singleCommit icon).

### Wave B — make it actionable

Action surface + delta patching.  This is where the dashboard stops
being "nice-to-look-at" and becomes a workflow centre.

- **Typed message contract** shared between provider and webview script:
  ```ts
  export type DashboardRequest =
    | { kind: 'submit' }
    | { kind: 'mergeStack' }
    | { kind: 'refresh' }
    | { kind: 'openPr';          branch: string }
    | { kind: 'rebase';           branch: string }
    | { kind: 'switchBranch';     branch: string }
    | { kind: 'moveBranchUp';     branch: string }
    | { kind: 'moveBranchDown';   branch: string }
    | { kind: 'removeBranch';     branch: string }
    | { kind: 'commit';           branch: string }
    | { kind: 'pushBranch';       branch: string }
    | { kind: 'absorbHunks';      branch: string }
    | { kind: 'routeHunks';       branch: string }
    | { kind: 'toggleSingleCommit'; branch: string }
    | { kind: 'setCommitTemplate';  branch: string }
    | { kind: 'copyBranchName';   branch: string }
    | { kind: 'copyPrUrl';        branch: string }
    | { kind: 'openWorktree';     branch: string }
    | { kind: 'addBranch' }
    | { kind: 'assignFloating' }
    | { kind: 'saveCheckpoint' }
    | { kind: 'showUndoLog' }
  ```
  Exported from `src/dashboardMessages.ts`.  The webview imports the
  same module via an inlined type-only alias (script is bundled into
  the HTML).

- **Per-row `⋯` menu button** opens an inline popup with contextual
  actions.  VS Code context menus don't work on webview elements, so
  the menu is hand-rolled HTML positioned via CSS near the button.

- **Top-toolbar additions:**
  `Add branch` / `Submit` / `Merge stack` / `Save checkpoint` /
  `Show undo log` — calls the matching commands through the typed
  contract.

- **Floating-banner action:** "Assign N files…" opens
  `gitbraid.assignFile` pre-filtered to the floating set.

- **Delta row patching.**  Today every event rewrites
  `webview.html`, which blows away scroll + focus + in-flight `<input>`
  state.  Replace with `postMessage({ kind: 'patchRow', branchName,
  row })` + a small script-side reconciler that patches a single row
  element.  Initial load still sets full HTML.

- **Progress streaming** — subscribe to the `Submit` / `MergeStack` flows
  and push per-branch progress notifications into the webview via a
  second message kind `{ kind: 'progress', ... }`.  Script renders a
  strip at the top of the view; `Cancel` dispatches a `cancel`
  request.

**Architecture:**
- New `src/commands/dashboardCommands.ts` holds the request-dispatch
  function: `handleDashboardRequest(req, deps)`.  Both tests and the
  webview's `onDidReceiveMessage` route through it.
- `StackDashboardView._handleMessage` becomes a thin
  `handleDashboardRequest(req, deps)` call.

**Tests:**
- Unit tests over `handleDashboardRequest` for every `kind`, with a
  spy deps stub recording commands executed.
- Reconciler test: provider emits a `patchRow` message, DOM mirror
  correctly updates only the targeted branch row.

### Wave C — make it rich

Drill-down, search, persistence, and shared snapshot.

- **Collapsible per-row sections:**
  - Commits — uses `CommitListService` (Plan 06).  Each commit row
    inside the dashboard has a click-to-open action backed by
    `gitbraid.showCommit`.
  - Files — breaks down the assigned-files count into a clickable
    list, Explorer-style.
  - PR body — shows the rendered stacked-PR block (from
    `renderStackBlock()`) so the user sees what Submit would write.

- **Search / filter box** in the toolbar; scopes the visible rows to
  matches on name / PR number / subject.

- **Inline edit** for branch-level commit template (click an `<input>`
  field, dispatches `setCommitTemplate`).

- **Webview state persistence** via `acquireVsCodeApi().getState()` /
  `setState()` for scroll, collapsed section state, and search query.

- **Shared `StackSnapshot`.**  The LM tool `gitbraid_getStackDiagram`
  and the MCP server already build ASCII / JSON representations of
  the stack; lift the common computation into
  `src/dashboardSnapshot.ts` (introduced in Wave A) so one function
  answers "what does the stack look like right now?" for every
  caller.

**Architecture:**
- The webview script grows — extract it into
  `src/webview/dashboardScript.ts`, compile via esbuild to
  `dist/webview/dashboardScript.js`, and inject it via a `<script
  src>` from `asWebviewUri()`.
- A `WebviewReconciler` class on the script side owns DOM mutation;
  kept framework-free (still under ~300 LOC).

**Tests:**
- Snapshot with each section expanded.
- Search filter narrows the rendered row set.
- `setState()` round-trip survives a simulated reload.
- Shared `StackSnapshot` produces identical output for the LM tool,
  the MCP server, and the dashboard given the same inputs.

## Data model changes

- `DashboardBranchRow` gains `isCurrent`, `aheadCount`,
  `assignedFilesCount`, `singleCommit`, and `checksStatus` (all
  optional).
- New exported `StackSnapshot` type — `Plan`-specific shape reused by
  LM/MCP/Dashboard.
- New message-kind union (above).

## Command surface

Wave B introduces no new commands — every `kind` in the contract
dispatches to an existing `gitbraid.*` command.  Wave C may add
`gitbraid.assignFloating` as a convenience that scopes
`gitbraid.assignFile` to the floating set.

## Settings

- `gitbraid.dashboard.autoRefreshMinutes` (default 5) — poll cadence
  for PR / check status.  Accepts 0 to disable.

## Sequencing

1. **Wave A — data surface** (1–2 days).  Pure rendering; no contract
   changes.  **Implementing in this branch.**
2. **Wave B — actions + delta patching** (3 days).
3. **Wave C — sections + search + shared snapshot** (1 week).

Each wave lands with its own tests and is independently shippable.

## Open questions

- **Context-menu UX.**  Hand-rolled inline popups are sufficient but
  less polished than VS Code native menus.  Acceptable for v0.x;
  revisit once the VS Code webview API grows native menu support.
- **Webview bundling.**  The current inline `<script>` is fine for
  Wave A/B.  Wave C's reconciler might push us over the "inline is
  readable" threshold, so an `esbuild` sub-bundle is in the plan.
- **Search indexing.**  For very large stacks (20+ branches × ~100
  commits each) the in-memory filter is cheap enough; no need for an
  index service.
