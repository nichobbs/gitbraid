# Plan 09 — Persistent Undo Across Sessions

**Inspiration:** git-branchless, Sapling's "smartlog" history.

**Status:** **Implemented (replay supported).** See
`src/persistentUndoLog.ts`; each `FolderContext` owns a
`.worktrees/undo-log.jsonl` writer and assignment changes are mirrored
to it. The `gitbraid.showUndoLog` QuickPick reads it, and
`src/undoReplay.ts`'s `buildReplayPlan`/`applyReplay` implement
replay-through-this-action — picking a past entry undoes every
recorded change newer than it.

## Goal

Persist the undo ring from `src/undoStack.ts` to
`.worktrees/undo-log.jsonl` so a VS Code restart doesn't lose the
user's recent reversible actions.

## Rationale

The current undo stack is in-memory only. A VS Code crash, window
reload, or restart loses all undo history. Persistent undo is what
makes tools like `git-branchless` feel reassuring to experiment with.

## Design

### Storage

One JSON object per action, newline-delimited:

```
{"ts":"2026-04-24T10:03:01.132Z","action":"assign-file","path":"src/foo.ts","from":null,"to":"feature/a"}
{"ts":"2026-04-24T10:03:14.887Z","action":"add-branch","name":"feature/b","base":"feature/a"}
```

Bounded by a configurable line cap (default 500). On write, truncate
the head to keep under the cap.

### API

```ts
class PersistentUndoLog {
  async load(): Promise<UndoEntry[]>
  async append(entry: UndoEntry): Promise<void>
  async popLast(): Promise<UndoEntry | undefined>
  async replay(limit: number): Promise<void>
}
```

Wire into `undoStack.ts` so `recordAssignFile`, `recordAddBranch`,
etc. also append to the log. `gitbraid.undoLastAction` pops from the
log.

### UI

`gitbraid.showUndoLog` opens a QuickPick listing the last N entries
with relative timestamps; selecting one undoes all actions from the
top of the stack down to that point (classic "undo through this
action").

## Tests

- Append → load round-trip with 1000 entries.
- Cap enforcement (cap = 5; after 7 appends, 5 entries survive).
- Corrupt line tolerance — one malformed line doesn't abort the load.

## Open questions

- Should the log live in `.worktrees/` (personal) or
  `.gitbraid/` (potentially shared)? Definitely personal.
