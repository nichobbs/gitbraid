# Bugs and Correctness Issues

The list below is ordered roughly by severity.

## High

### Quote-escape no-op in `DiffEngine._sanitisePath`

`diffEngine.ts:201`

```ts
return normalised.replaceAll('"', String.raw`"`)
```

`String.raw\`"\`` evaluates to a single `"` character, so this line
replaces double-quotes with themselves — a no-op. A path containing a
double quote would close the argument on the shell command line in
`getHunksForFile` / `getHunksAgainstBranch` and allow arbitrary command
injection. The intended replacement is `\\"` (shell-level escape) or,
better, switch to `spawn(['diff', 'HEAD', '--', path])` without a shell
entirely. See `03-security.md` for more on this pattern.

### Git branch listing parses remote names wrongly

`gitFunctions.ts:252`

```ts
.map(s => s.replace(/^[^/]+\//, ''))
```

This strips everything before the first `/`, turning
`origin/feature/docs` into `feature/docs` — but also turning
`upstream/fork/main` into `fork/main`. Multiple remotes with overlapping
branch names collide silently. Use `s.replace(/^origin\//, '')` or, for
multi-remote support, keep the remote prefix as part of the label.

### `branchToWorktreeDirName` is not injective

`branchStackService.ts:19-21`

```ts
return branchName.replaceAll('/', '-').replaceAll(/[^a-zA-Z0-9._-]/g, '_')
```

Both `feature/a` and `feature-a` map to `feature-a`, so the stack can
silently point two branches at the same worktree directory, and
`_pruneOrphans` can delete the "wrong" one. Two options:

- Encode with a stable hash suffix: `feature-a__${sha1(name).slice(0,7)}`.
- Keep a reverse lookup inside `local-config.json` (`{ name: dirName }`).

### `RebaseSuggestionService.getCommitsBehind` returns the wrong number

`rebaseSuggestionService.ts:181`

```ts
`git rev-list --count "${safe(childBranch)}..${safe(parentBranch)}"`
```

`A..B` lists commits reachable from `B` but not `A`, i.e. "how far ahead
is B compared to A". For the child-behind-parent question the direction
is correct (`parent` ahead of `child`), but the **rest of the service**
describes this value as "commits behind" on `entry.name` — which is
the child. The test `'getCommitsBehind: returns 0 when branches are
equal (HEAD vs HEAD)'` accidentally masks the semantic by passing
`'HEAD', 'HEAD'` for both params.

Confirm naming: either rename the method to `getCommitsAhead(parent,
child)` or swap `child`/`parent` arg order.

### `git.revList` returns stringified fields

`gitFunctions.ts:220-229`

```ts
const counts = r.stdout.trim().split('\t')   // r is actually a string
return { ahead: counts[0], behind: counts[1] }
```

`gitExec` already returns the stdout string, not the `{stdout, stderr}`
object, so `r.stdout.trim()` is `undefined.trim()`. Any caller of
`revList` will throw. Callers include `WorktreeRoot.setCommitRef`
(`worktreeNodes.ts:372`), which is invoked during tree refresh —
expect this to blow up at runtime whenever a non-primary worktree is
shown.

Also: `counts[0]` (left side of `--left-right --count`) is `A..B`
**left-only** count; the earlier comment "ahead/behind" reversal should
be double-checked once the crash is fixed.

### `git.branch()` returns `undefined`

`gitFunctions.ts:172-174`

```ts
return this.gitExec('branch --show-current', workspaceUri.fsPath)
    .then((r: any) => { return r.stdout })
```

Same bug — `gitExec` returns a string, so `r.stdout` is `undefined`. The
`any` annotation disables the compiler's protection. Search for all
`(r: any) => { return r.stdout }` in `gitFunctions.ts`.

### `fileExists` accepts an invalid path check

`utils.ts:16-18`

```ts
export function pathExists (uri: vscode.Uri) {
    const r = fs.statSync(uri.fsPath)
    return r !== undefined
}
```

`fs.statSync` **throws** on ENOENT (unless `{ throwIfNoEntry: false }`
is passed); it never returns `undefined`. `pathExists` therefore throws
on missing paths instead of returning `false`. `fileExists` and
`dirExists` below it do handle the exception.

### `migrateConfig` mutates shared input

`configTypes.ts:124-147` mutates the `config` argument. `isValidConfig`
also runs type assertions on external data that is treated as a
`BranchConfig` without further validation (e.g. `stack[].name` can be
anything, including `null`). If a user hand-edits the JSON file and puts
an integer for `name`, the extension will write it to disk in future
saves without noticing. Validate each `BranchStackEntry` field with a
guard function.

## Medium

### Hunk indices are fragile identifiers

`ConfigService.setHunkAssignment(rel, hunkIndex, branch)` stores hunk
assignments keyed by the **current** hunk index — but the index changes
the moment the user makes any other edit to the file (even whitespace).
Persisted hunk assignments will silently apply to the wrong lines
after a save. Two mitigations:

- Store `(startLine, endLine, header)` tuples instead of numeric
  indices, and reconcile on load.
- Mark hunk assignments as transient: clear them on file modification
  and re-derive them via the `HunkRouter` the moment the user runs
  `gitbraid.routeHunks`.

### Workspace-root assumptions scattered throughout

Almost every service calls
`vscode.workspace.workspaceFolders![0].uri`. Multi-root workspaces are
broken (silently picking the first root) and single-folder workspaces
without a folder throw at activation. `extension.ts:27` throws a raw
`Error('No workspace folder found')` from `activate`, which VS Code
presents as a red notification rather than quietly skipping activation.

### `dirExists` is called synchronously on workspace.fs-backed URIs

`utils.ts` uses `fs.statSync` on `vscode.Uri.fsPath`. For virtual
workspaces or remote-ssh, `uri.fsPath` may not point at a real disk
path. `commands.ts:227` and `commands.ts:353` call `dirExists` during
activation, making the extension incompatible with virtual workspaces.
Either short-circuit activation for non-`file` schemes or switch to
`vscode.workspace.fs.stat`.

### Orphan pruning is aggressive

`BranchStackService._pruneOrphans` will remove any directory under
`.worktrees/` that isn't in the config. Because `branchToWorktreeDirName`
is not injective (see above) a rename could transform a valid worktree
into an orphan. Pruning also runs automatically on init, before the
user has any chance to intervene. Add an opt-in setting
(`gitbraid.pruneOrphanWorktreesOnStartup`, default false) or at least a
confirmation prompt when uncommitted changes exist.

### Rebase service has no timer cancellation on error

`rebaseSuggestionService.ts:56`:

```ts
this._intervalHandle = setInterval(() => { void this._checkAll() }, CHECK_INTERVAL_MS)
```

`_checkAll` is fired-and-forgotten. If an individual iteration throws
outside its try/catch (e.g. `worktreePath` on an un-initialised service)
it becomes an unhandled rejection and is lost. Wrap the body with a
`try/catch` and log.

### `watcherChange.onDidChange` ignores a recently-created directory

`extension.ts:370-387`: the handler stats the URI, ignores directories,
then calls `api.refresh(repoNode)`. But it runs on **every** `.git/index`
change, including index writes from `WorkspaceSync`'s own
`_syncing` writes. This is not the same file path, but the legacy
refresh will still re-run for every synthetic commit.

### `discardChanges` uses `git clean`

`commands.ts:421` maps "discard changes" to `git clean -f <path>`. That
removes untracked files, but it **does not** discard modifications to
tracked files. The correct operation is `git checkout -- <path>` (or
`git restore --staged --worktree`). The confirmation text even says
"discard changes in X", but the implementation deletes rather than
restores. This is a data-loss-adjacent bug.

### `commitBranch` quoting is inconsistent

`mbcApi.ts:137`

```ts
const safeMsg = message.replaceAll('"', String.raw`\"`)
await execAsync(`git commit${gpgFlag} -m "${safeMsg}"`, { cwd: wtDir })
```

The escape handles `"` but not `` ` ``, `$`, `\`, or command
substitution. A commit message like ``fix: $(rm -rf /)`` runs a
subshell. Compare with `branchScmProvider.ts:256` which uses
`JSON.stringify(message)` — the right approach — or use
`spawn('git', ['commit', '-m', message])` to avoid a shell entirely.

### `branchStackService._createWorktree` string-concatenates args

```ts
await git.worktree.add(`-b "${branchName}" "${absPath}" "${base}"`)
```

Same class of shell-injection issue. `validateBranchName` guards the
branch name, but `absPath` can contain spaces, parentheses, or
double-quotes on macOS/Windows paths. Switch to a method signature that
accepts an array.

### `_showBranchFile` swallows most errors

`stackResolver.ts:147-152`:

```ts
if (!msg.includes('does not exist') && !msg.includes('Path') && !msg.includes('does not exist in')) {
    log.warn(...)
}
```

This relies on the localised `git` error strings; users with
non-English locales (LC_ALL) will spam the Output channel. Prefer
checking `git`'s exit code (128 for bad ref, 1 for path missing in
tree) via `spawn`.

## Low

### `config._onDidChangeAssignment.fire({ branch: undefined })` for hunk remove

When `removeHunkAssignment` fires the event, both `branch` and
`previousBranch` are `undefined` — losing information about which branch
the hunk previously belonged to. `BranchFileDecorationProvider` and
`BranchScmProviderManager` both subscribe and might behave incorrectly
given the missing context.

### Tree-view `FloatingGroupNode` is always re-created

`BranchStackTreeProvider.getChildren(root)` constructs a fresh
`FloatingGroupNode` on every call. VS Code uses reference equality to
track expand/collapse state; the group will flicker closed on every
refresh. Cache it on the provider instance or use `id` strings.

### `worktreeView.ts` has a 2-second hard timeout

`worktreeView.ts:58`:

```ts
setTimeout(() => reject(new Error('Timeout after 2000ms waiting for DidTreeDataChange event')), 2000)
```

This rejects real-world slow refreshes (large repos over slow disks).
Either drop the timeout or make it configurable.

### `getAllNodes` walks three levels with O(n) lookups

`worktreeNodes.ts:28-45` walks `tree → children → children` and logs
every node via `log.info`. For a 10-branch × 1000-file workspace this
produces 10 000 log lines on every `getNode` call. Drop the `info`
logs, or `.debug` them.

### `nodeMaps.tree.pop()` removes the only root when exactly one worktree exists

`worktreeView.ts:136-138`:

```ts
if (nodeMaps.tree.length == 1) {
    nodeMaps.tree.pop()
}
```

This is presumably meant to hide the tree when only the primary
worktree exists, but it deletes the node entirely — subsequent calls to
`nodeMaps.getPrimaryRootNode()` will throw `WorktreeNotFoundError`.
Remove this block or replace it with a UI-level `viewsWelcome` message.

### `log.notification` double-fires info messages

`channelLogger.ts:92-96`:

```ts
if (this.notificationsEnabled) {
    void window.showInformationMessage(message)
}
void window.showInformationMessage(message)
```

Two `showInformationMessage` calls fire whenever `notificationsEnabled`
is true. This is noisy.

### `FileDecorationProvider` ignores `prDecorationsEnabled` setting

The setting is declared in `package.json` (`gitbraid.prDecorationsEnabled`)
but nothing reads it; decorations are always on. Either wire the setting
to `provideFileDecoration` or remove the declaration.

### `showFloatingWarningOnCommit` setting is ignored

Same issue — `branchScmProvider.ts:242-253` always shows the warning.

### `syncDebounceMs` setting is ignored

`workspaceSync.ts:8` uses a hard-coded `DEBOUNCE_MS = 200`. The config
plumbing (`ConfigService`) doesn't even expose a `get(key)` accessor
for VS Code workspace settings — it's only for the `local-config.json`.

### Command ID typos

- `commands.ts:175` registers `gitbraid.openFile` with title
  `"Multie Branch Checkout: Open file"` ("Multie" is a typo and
  the branding is out of date — see `09-packaging-and-branding.md`).
- `package.json:295`: `/viewItem =~ /isPrumary=true/` — typo for
  `isPrimary`, and the corresponding context value in
  `worktreeNodes.ts:497` is actually `primary=true` not `isPrumary`.
  The `swap worktrees` inline action will never be visible.

### `extension.ts:458` writes a UTF-8-encoded BOM-less gitignore

The line concatenates `content + '\n## added by …'` and creates a
`Buffer.from(...)`. On a CRLF-normalised repo this introduces mixed line
endings (existing `\r\n` plus new `\n`). Use `os.EOL` or preserve the
existing line ending style.
