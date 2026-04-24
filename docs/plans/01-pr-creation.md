# Plan 01 — PR Creation and Sync Per Branch

**Inspiration:** Graphite `gt submit`, git-spr `git spr update`,
ghstack `ghstack submit`.

**Status:** **Implementing.** Core adapter seam + `gitbraid.submitStack` /
`gitbraid.openStackedPR` / `gitbraid.setGithubToken` commands are landed;
Octokit + VS Code extension adapters present; body rewriting with idempotent
stacked-PR block is wired.  GitLab backend still deferred.  See
`src/prHostAdapter.ts`, `src/submitStackService.ts`, and
`src/commands/prCommands.ts`.

## Goal

Given a stack of N branches in GitBraid, let the user run one command
that, for every branch in the stack:

1. Pushes the branch to the configured remote.
2. Ensures a PR exists on the host (open or draft) whose base is the
   parent branch in the stack.
3. Updates the PR body with a generated "stacked PR" header listing
   the branches above and below.
4. Surfaces the PR status (open / merged / draft / closed / checks-passing)
   as a decoration on the `BranchNode` in the stack tree.

## Rationale

PR creation is the single biggest gap between GitBraid and the
competitor tools. Without it the user still has to open the GitHub
UI for every branch and set each PR's base manually — which is where
most of the error-prone toil lives.

## Constraints

- No hard dependency on a paid SaaS.
- Work with GitHub today; GitLab and Bitbucket backends pluggable
  later.
- Prefer the `vscode.github-pullrequests` extension when installed
  (users already have auth). Fall back to Octokit via a PAT from
  `gitbraid.githubToken` secret storage.

## Design

### New module: `src/prHostAdapter.ts`

```ts
export interface PRMetadata {
  number: number
  url: string
  state: 'open' | 'merged' | 'closed' | 'draft'
  base: string
  head: string
  title: string
  body: string
  checksStatus?: 'pending' | 'success' | 'failure'
}

export interface PRHostAdapter {
  /** Does the adapter know how to talk to this repo's remote? */
  detect(repoRoot: string): Promise<boolean>
  getPR(branch: string): Promise<PRMetadata | undefined>
  createPR(input: CreatePRInput): Promise<PRMetadata>
  updatePR(number: number, patch: Partial<CreatePRInput>): Promise<PRMetadata>
  listOpen(): Promise<PRMetadata[]>
}
```

Implementations:
- `GitHubVSCodeAdapter` — wraps the `vscode.github-pullrequests`
  extension's exported API.
- `GitHubOctokitAdapter` — direct REST/GraphQL when the extension is
  absent.
- `NullAdapter` — degrades gracefully (commands return "Not supported
  for this remote").

### New command: `gitbraid.submitStack`

1. For each entry in the sorted stack:
   - Run `git push --set-upstream origin <branch>` via `IGitRunner`.
   - If no PR: call `adapter.createPR({ head, base })`.
   - Otherwise: call `adapter.updatePR(..., { base })` to repoint if
     the parent changed.
2. Render a progress notification "Submitted N of M branches".
3. Rewrite each PR body with a collapsible "stacked PRs" block:
   ```
   <!-- gitbraid:stack-start -->
   Stacked PRs (bottom first):
   1. #123 feature/a
   2. #124 feature/b  <- you are here
   3. #125 feature/c
   <!-- gitbraid:stack-end -->
   ```

### Decorations

`BranchStackTreeProvider` pulls `PRMetadata` from an in-memory cache
keyed by branch name. `BranchNode.description` gains a suffix such as
`#123 · open · ✓ checks`.

Refresh triggers:
- After `submitStack` completes.
- On a 5-minute polling timer (reuse `RebaseSuggestionService` pattern).
- On explicit `gitbraid.refreshPRStatus` command.

## Data model changes

- `BranchStackEntry` gains an optional `prNumber?: number` field. It is
  a **cache**, not a source of truth; the adapter is always authoritative.
- New VS Code setting `gitbraid.prHost` = `"auto" | "github" | "gitlab" | "none"`.
- New secret-storage key `gitbraid.githubToken` for the Octokit fallback.

## Command surface

| Command | Title |
| --- | --- |
| `gitbraid.submitStack` | Submit / update stacked PRs |
| `gitbraid.refreshPRStatus` | Refresh PR status for stack |
| `gitbraid.openStackedPR` | Open this branch's PR in the browser |

## Tests

- Unit tests for the stack-PR body renderer (deterministic string output).
- Fake `PRHostAdapter` that records calls; integration test that
  submits a 3-branch stack and asserts:
  - 3 `createPR` calls with correctly nested `base` values.
  - On a second submit with a parent rename, `updatePR` is called with
    the new `base`.
- Snapshot test of the stacked-PR body block.

## Sequencing

1. Ship `PRHostAdapter` seam + `NullAdapter`.
2. Implement `GitHubVSCodeAdapter`.
3. Ship `gitbraid.submitStack` + decoration.
4. Add Octokit fallback.
5. GitLab adapter (deferred).

## Open questions

- Should PR body updates be opt-in (flag) to avoid overwriting a user's
  hand-edited description? Default **on** but honour a sentinel
  "do-not-touch" comment at the top of the description.
- How do we handle a user who has already created PRs with a different
  tool (Graphite)? Plan 07 (importer) should pre-populate
  `BranchStackEntry.prNumber` from Graphite metadata.
