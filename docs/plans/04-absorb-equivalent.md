# Plan 04 — `gitbraid.absorb`

**Inspiration:** Sapling `sl absorb`, Mercurial `hg absorb`.

**Status:** **Implementing.** Core routine lives in `src/absorb.ts`
(`absorbFiles` / `dominantCommitForHunk`) with the `gitbraid.absorbHunks`
command wired in `src/commands/prCommands.ts`.  Uses the existing
`DiffEngine` for hunk extraction and `git blame --line-porcelain` for
attribution.  The `gitbraid.absorbRewritePushed` setting guards the
rewrite-already-pushed path.

## Goal

Given pending uncommitted edits across several files, intelligently
fold each hunk into the *existing* commit that most recently modified
those same lines — **scoped to the file's assigned branch**.

Today GitBraid's hunk router targets *branches*, not *commits*. Absorb
would target *commits within the assigned branch's history*.

## Rationale

A common workflow:

1. You realise a bug in a branch three commits back.
2. You edit the affected lines in your working copy.
3. You want the fix to become part of that earlier commit, not a
   fix-up commit on top.

Sapling's `absorb` automates this; it is one of the single most-loved
commands in that tool. GitBraid is well-placed to offer an equivalent
because the file → branch mapping is already known.

## Design

### Command

`gitbraid.absorbHunks` — runs on the active file (or every assigned
file if invoked from a tree view).

### Algorithm per file

1. Compute hunks against the worktree's `HEAD` (existing `DiffEngine`).
2. For each hunk:
   1. Run `git blame -L <startLine>,<endLine> -- <file>` in the owning
      branch's worktree to map old-file line ranges to commits that
      authored them.
   2. The dominant commit (most lines attributed) is the absorb target.
3. Group hunks by target commit.
4. For each target commit (starting from the oldest):
   1. Stage just those hunks.
   2. Run `git commit --fixup=<targetSha>`.
5. When every hunk is staged, run `git rebase -i --autosquash <parent>`
   with `GIT_SEQUENCE_EDITOR=:` to apply silently.

### Safeguards

- Bail out with a user-visible warning if:
  - The target commit is not in the current branch's history (stop at
    the branch's merge-base with its parent).
  - The target commit is already pushed and the user has
    `gitbraid.absorbRewritePushed: false`.
  - Two different hunks in the same file target two different commits
    with no clear majority (ambiguous blame). Fall back to "normal"
    commit in the target branch.

### Command surface

| Command | Title |
| --- | --- |
| `gitbraid.absorbHunks` | Absorb hunks into owning commits |

## Data model

No schema changes; absorb is transient.

## Tests

- Integration test with `TmpRepo`:
  - Create three commits modifying lines 1–10, 11–20, 21–30 of a file.
  - Modify lines 5 and 25 in the worktree.
  - Run `absorbHunks`.
  - Assert two new fixup commits, both autosquashed after rebase.
- Unit test for the "dominant commit" heuristic with a synthetic
  `git blame` output.
- Negative test: pushed commits + `absorbRewritePushed: false` rejects
  the absorb with a clear message.

## Sequencing

1. Add a `GitBlame` helper in `gitFunctions.ts`.
2. Ship the dominant-commit heuristic in `src/absorb.ts`.
3. Wire `gitbraid.absorbHunks`.
4. Add a "safe mode" setting that runs `absorb --dry-run` and shows
   the plan before doing anything.

## Open questions

- Commit-message customisation: should absorb preserve the original
  commit's message or tag it with "(absorb: <hunk-summary>)"? Default:
  preserve as-is.
