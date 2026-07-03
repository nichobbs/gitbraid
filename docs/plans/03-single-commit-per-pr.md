# Plan 03 — Optional One-Commit-Per-PR Mode

**Inspiration:** git-spr, ghstack.

**Status:** **Implemented.** Data model flag `singleCommit` is in place on
`BranchStackEntry`, with `ConfigService.setSingleCommit` and the
`gitbraid.toggleSingleCommitMode` command. The amend rewrite runs inside
`BranchScmProvider.commitBranch` (amends `HEAD` instead of appending when
`entry.singleCommit === true`), and `StackCommands.pushStack` validates the
invariant via `singleCommit.ts`'s `validateStack`/`promptSquashForViolations`
before pushing — this doc's original "Design" section below is now a
description of the shipped behaviour, not a proposal.

## Goal

Allow a branch to carry the constraint "exactly one commit". When
committing to such a branch, the existing commit is amended instead of
appended. Before push, GitBraid validates the invariant and prompts to
squash if the user has accumulated extras.

## Rationale

Teams that review via GitHub are noticeably happier when each PR is a
single commit (clean diff, easy revert). Tools like ghstack enforce
this. GitBraid can offer it as a per-branch opt-in.

## Design

### Data model

Extend `BranchStackEntry`:

```ts
interface BranchStackEntry {
  // ...existing fields...
  singleCommit?: boolean   // default: false
}
```

### Commit hook

`branchScmProvider.commitBranch(branch)`:

- If `entry.singleCommit === true` and `HEAD` ≠ parent base:
  - Run `git commit --amend -m <msg>` instead of `git commit`.
- If `HEAD` is already past the parent base by > 1 commit on this
  branch:
  - Prompt: "This branch is configured as single-commit. Squash 3
    commits into one?"
  - On accept: `git reset --soft <parent-base>` → `git commit -m <msg>`.

### Push hook

`stackCommands.pushStack` validates the invariant for each
`singleCommit` branch before pushing. Failures abort the push and
offer a "Squash now" action.

### UI

Add a right-click menu item on `BranchNode`:

- **Set single-commit mode** / **Clear single-commit mode**.

Show a small `$(squash)` icon in the branch tree description when the
flag is on.

## Command surface

| Command | Title |
| --- | --- |
| `gitbraid.toggleSingleCommitMode` | Toggle single-commit mode |

## Tests

- Unit test: commit on a `singleCommit: true` branch calls
  `git commit --amend`.
- Integration test: with 3 commits on the branch, toggling to
  single-commit offers the squash; on accept, the branch ends up at
  1 commit.

## Sequencing (historical — all steps below have shipped)

1. Schema bump (`CONFIG_SCHEMA_VERSION = 3`). Migration: default
   `singleCommit` to `false` on every existing entry.
2. Core behaviour in `BranchScmProvider.commitBranch`.
3. UI affordance.
4. Push-time validation.

## Open questions

- Should the mode become default for branches created with a base of
  `main` and a name starting with `fix/`? Probably no — keep it
  explicit.
