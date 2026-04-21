# Architecture Review

## Strengths

- **Clear phase-by-phase layering** (Config → Stack → Sync → SCM/Views →
  Hunks → API) mirrors `docs/PLAN.md` and makes the module graph easy to
  follow.
- **Events-first boundary** between services: `ConfigService` exposes
  `onDidChangeAssignment` / `onDidChangeStack`, and
  `WorkspaceSync` exposes `onDidSyncFile` / `onDidFloatFile`. Downstream
  UI components (`BranchStackTreeProvider`, `BranchFileDecorationProvider`,
  `FloatingStatusBarItem`, `BranchScmProviderManager`) subscribe rather
  than poll.
- **Exported API object** (`MbcApi`) cleanly wraps the services and is the
  same surface the LM tools speak to, which keeps AI-driven paths and
  human-driven paths behaviourally aligned.

## Issues

### 1. Two overlapping view/command hierarchies

`extension.ts` activates **both** the legacy `WorktreeView` and the new
`BranchStackTreeProvider`. The commands registered on the legacy view
(`gitbraid.createWorktree`, `deleteWorktree`, `lockWorktree`,
`swapWorktrees`, `launchWindowForWorktree`, `copyToWorktree`,
`moveToWorktree`, `stageNode`, `unstageNode`, `discardChanges`, …) talk
to a separate `nodeMaps` tree that is orthogonal to the branch stack.
The user is exposed to **two different ways to add a branch/worktree**
with two different mental models (`Create Branch / Worktree` vs
`Add Branch to Stack`).

Recommendation: decide which model wins. Either

- Retire the legacy view and fold its useful operations (lock/unlock,
  "open in new window") into the stack tree's context menu, or
- Drive the legacy view from the same `ConfigService.getStack()` state so
  the two views cannot disagree.

`swapWorktrees` is already a stub (`'Not yet implemented'`,
`commands.ts:337`) — a good signal that the legacy view is a carryover.

### 2. Singleton pattern is inconsistent

`ConfigService`, `BranchStackService`, and `WorkspaceSync` are all
singletons with `getInstance()` / `resetInstance()`. Meanwhile `MbcApi`,
`StackResolver`, `RebaseSuggestionService`, `DiffEngine`,
`HunkRouter`, `BranchFileDecorationProvider`, `BranchScmProviderManager`,
`BranchStackTreeProvider`, and `HunkCodeLensProvider` are plain classes
constructed in `extension.ts` with manual dependency injection.

Singletons make testing fragile (every test has to remember to call
`resetInstance()`) and hide the fact that `ConfigService` is effectively
an application-wide global. Prefer constructor injection for everything;
let `activate()` own the one instance.

### 3. `extension.ts` is a 460-line activate() function

`activate()` constructs services, registers ~30 commands, sets up two
watchers, and mutates user settings (`files.exclude`) and `.gitignore`.
It has multiple numbered `log.info('197 ')` artefacts, commented-out
legacy code, and two file watchers that overlap with `WorkspaceSync`'s
own watcher.

Recommendation:

- Split activation into `bootstrap(context)`, `registerCommands(context)`,
  and `registerWatchers(context)` modules.
- Move the `filesExcludeWorktreesDir` / `ignoreWorktreesDir` helpers to
  `workspaceBootstrap.ts` — `ConfigService._ensureGitignore()` already
  does half the job, which is duplication waiting to drift.
- Delete the commented-out `patchToWorktree` block in `commands.ts`
  (~100 lines of dead code at `commands.ts:10-107`).

### 4. File watcher storm

Three separate watchers fire on overlapping patterns:

| Location | Pattern | Purpose |
| --- | --- | --- |
| `extension.ts:366` | `**/*` (create, delete) | Calls `api.refreshUri` / `api.refresh` |
| `extension.ts:367` | `**/.git/index` (change) | Refreshes worktree view |
| `workspaceSync.ts:79` | `**/*` (create, change, delete) | Sync to branch worktree |

Each save triggers the legacy view refresh **and** the sync pipeline.
`WorkspaceSync`'s `_syncing` reentrancy flag prevents it looping on its
own writes, but the legacy `api.refresh*` path is not guarded and will
re-run `git status` for every file under every worktree on every save.

Recommendation: route every FS-level concern through a single shared
`FileChangeBus` that emits domain events (`fileSaved`, `fileDeleted`,
`worktreeIndexChanged`) and let each service subscribe.

### 5. Circular/ad-hoc module dependencies

`hunkCodeLensProvider.ts:172` uses a dynamic `await import('./hunkRouter')`
inside `OverlayDiagnostics.refreshForUri` to avoid an import cycle. This
is a smell — the router has no dependency on the code-lens provider, so
the top-level import should work. The dynamic import also defeats
tree-shaking and adds async overhead on every refresh.

### 6. State lives in three places

Per-file assignment state exists in:

1. `ConfigService._config.assignments` (the persistent source of truth).
2. `BranchStackTreeProvider`'s returned `FileNode[]` (rebuilt per
   `getChildren` call — fine).
3. `branchScmProvider.ts`'s groups, populated by shelling out to
   `git status --porcelain` on each refresh (slow, duplicates work
   `WorkspaceSync` already knows about).

The SCM provider could reuse `WorkspaceSync`'s in-memory knowledge of
what each worktree contains instead of forking `git status` per branch
on every save.

### 7. Activation events are misconfigured

```json
"activationEvents": [
    "onStartupFinished",
    "workspaceContains:filePattern:.git/HEAD"
]
```

`workspaceContains:` takes a glob directly, not a `filePattern:` key.
The second entry is effectively dead and the extension activates only
via `onStartupFinished`, which means it activates for every window —
including those without a git repo, where activation immediately throws
(`extension.ts:27`, `throw new Error('No workspace folder found')`).

Fix: replace with `"workspaceContains:.git"` and/or gate the throw
behind a soft "no workspace → skip activation" check.
