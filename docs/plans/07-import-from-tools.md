# Plan 07 — Import Stacks From Other Tools (RM-012)

**Inspiration:** n/a — closes the migration gap for users coming from
Graphite, git-spr, git-stack, GitButler.

**Status:** **Implementing this iteration.** See
`src/stackedPRToolImporter.ts` and the companion command
`gitbraid.importStackedTool`.

## Goal

On demand (and optionally at activation time), detect metadata from a
stacked-PR tool already active in this repository, present a preview
of the inferred stack, and on accept seed `.worktrees/local-config.json`
with matching `BranchStackEntry` records.

## Rationale

Rebuilding a stack from scratch is the single biggest friction when
moving between tools. A 10-branch Graphite stack is painful to
recreate by hand; having GitBraid offer "I found a Graphite stack,
import it?" turns a 30-minute manual job into one click.

## Supported tools (v1)

| Tool | Detection | Parent/child source |
| --- | --- | --- |
| **Graphite** | `.git/refs/branch-metadata/*` or `.graphite_repo_config` | `parentBranchName` JSON field |
| **git-spr** | Commit-message trailer `pr-[0-9]+` on branch tips | Branch order inferred via `git log --oneline <remote-trunk>..<branch>` |
| **git-stack** | Refs under `refs/branch-stack/*` | Symbolic parent ref |
| **GitButler** | `.git/gitbutler/virtual_branches.toml` | TOML `applied`/`upstream` fields |
| **Plain upstream** | `branch.<name>.merge` in `.git/config` | Falls back to upstream tracking branch |

When multiple tools are detected the user picks one in a QuickPick.

## Design

### `src/stackedPRToolImporter.ts`

```ts
export type StackedTool = 'graphite' | 'git-spr' | 'git-stack' | 'gitbutler' | 'upstream'

export interface DetectedStack {
  tool: StackedTool
  source: string        // path / config key that was read
  entries: Array<{
    name: string
    base: string
    order: number       // 1-based from the base of the stack
  }>
  warnings: string[]
}

export interface ImportPreview {
  newBranches: Array<{ name: string, base: string }>
  conflicts: Array<{ name: string, existing: BranchStackEntry }>
  unknown: string[]     // branches referenced as base but not seen anywhere
}

export class StackedPRToolImporter {
  constructor(
    private readonly _config: ConfigService,
    private readonly _workspaceRoot: vscode.Uri,
    private readonly _runner: IGitRunner,
  ) {}

  /** Probe the repo for any known metadata. Return all matches. */
  async detect(): Promise<DetectedStack[]>

  /** Diff a detected stack against the current config. */
  preview(stack: DetectedStack): ImportPreview

  /** Apply the preview — skip conflicts unless `overwriteExisting` is true. */
  async apply(stack: DetectedStack, overwriteExisting?: boolean): Promise<{
    addedBranches: number
    skipped: number
  }>
}
```

### Detector internals

Each detector is a pure function over filesystem state so we can unit
test them without real git. Shape:

```ts
interface ToolDetector {
  name: StackedTool
  detect(repoRoot: string, runner: IGitRunner): Promise<DetectedStack | undefined>
}
```

Detection strategies:

- **Graphite**
  - Look for `.graphite_repo_config` at the repo root, or
    `.git/refs/branch-metadata/**`.
  - If present, walk every ref under `branch-metadata/<branch>` and
    parse the JSON content (or call `git cat-file -p`) for
    `parentBranchName`.
  - Order: topologically sort so parents precede children.
- **git-spr**
  - Look at every local branch's tip commit message via
    `git log -1 --format=%B <branch>`.
  - Match the `^pr-\d+$` trailer.
  - Order by the commit's position in the first-parent log reachable
    from the repo's default branch.
- **git-stack**
  - `git for-each-ref refs/branch-stack` for the ref list.
  - Each ref points at a parent; walk the chain.
- **GitButler**
  - Read `.git/gitbutler/virtual_branches.toml`.
  - Each `[branches.<id>]` section has a `name` and `upstream`.
- **Upstream fallback**
  - `git config --get-regexp 'branch\..*\.merge'` gives every local
    branch's configured upstream. Filter to those whose upstream is
    local — i.e. another branch in the repo.

### Command surface

| Command | Title |
| --- | --- |
| `gitbraid.importStackedTool` | Import stack from external tool… |

Flow:

1. Call `importer.detect()` — if empty, show
   `No stacked-PR tooling detected in this repo`.
2. If multiple tools: QuickPick to choose.
3. Render a preview QuickPick or modal:
   ```
   Found 3 branches in Graphite:
     ✓ feature/a  (new)
     ✓ feature/b → feature/a  (new)
     ⚠ feature/c → feature/b  (exists; will skip)
   ```
4. Confirm → `importer.apply()` → success toast.

### Activation-time suggestion (opt-in)

When `gitbraid.suggestImportOnActivate: true` (default `false`) and a
`DetectedStack` is present at activation, show a non-modal
"Import 3 branches from Graphite?" notification.

### Settings

| Key | Default | Description |
| --- | --- | --- |
| `gitbraid.suggestImportOnActivate` | `false` | Offer to import detected stacked tooling when the extension activates |

## Data model

No schema changes. Results funnel through the existing
`ConfigService.addBranch`.

## Tests

Test fixtures live under `test/fixtures/importer/`:

- `graphite/` — sample `.git/refs/branch-metadata/*` file contents.
- `git-stack/` — sample `refs/branch-stack` contents.
- `git-spr/` — sample `git log` stdout with PR trailers.
- `gitbutler/virtual_branches.toml` — sample TOML.

Tests:

- `StackedPRToolImporter.detect()` against each fixture directory.
- `preview()` with an empty config returns every detected branch as
  `newBranches`.
- `apply()` with overwrite `false` skips existing entries.
- Integration: against a real `TmpRepo` with synthetic
  `branch-metadata` refs, `apply()` ends with the expected stack in
  `local-config.json`.

## Sequencing

1. Detector interface and first implementation (Graphite) — **this PR**.
2. git-stack and git-spr detectors — **this PR** (thin implementations).
3. GitButler detector — **this PR** (TOML parse).
4. Command + QuickPick flow — **this PR**.
5. Activation-time suggestion — follow-up PR.
6. GitLab variants — deferred.

## Open questions

- Do we import Graphite's branch-specific colours? Probably yes when
  present, else use `gitbraid.defaultBranchColor`.
- On apply, should we also `git fetch` the branches to make sure they
  exist locally? Start with "no" and rely on
  `BranchStackService.addBranchToStack` to fall back to remote
  lookups.
- What if a detected branch doesn't exist locally at all? Warn in the
  preview ("branch not fetched; import skipped") and skip.
