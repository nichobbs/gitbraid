# P0 — Blocker Fixes

These items must land before a public 0.1 release. They are either
confirmed vulnerabilities, confirmed runtime crashes, or data-loss risks.

Scope each item as a standalone PR wherever possible so rollback is
cheap if a regression surfaces.

---

## T1. Fix the no-op quote escape in `DiffEngine._sanitisePath`

**Files:** `src/diffEngine.ts:197-202`, `src/stackResolver.ts:158-164`
**Cross-ref:** `docs/reviews/02-bugs-and-correctness.md` ("Quote-escape
no-op"), `docs/reviews/03-security.md` ("_sanitise and _sanitisePath").

### Problem

`return normalised.replaceAll('"', String.raw\`"\`)` evaluates to
`replaceAll('"', '"')` — an identity function. Any path containing a
`"` closes the shell argument in `git diff`, enabling arbitrary
command injection via paths the user can reach (e.g. files checked
into a third-party dependency, or attacker-influenced rename).

### Fix

Replace the sanitiser and the `exec` call with a `spawn('git', [...],
{ shell: false })` invocation that passes the path as a separate argv
entry — no quoting needed. The argv migration is covered in depth in
`03-security-hardening.md#T1`; this P0 item is only the **targeted**
fix for the three callers that currently depend on the sanitiser:

1. `DiffEngine.getHunksForFile` — `git diff HEAD -- <path>`.
2. `DiffEngine.getHunksAgainstBranch` — `git diff <ref> -- <path>`.
3. `StackResolver.getFileContentAtRef` — `git show <ref>:<path>`.

Until the wider `spawn` migration lands, also add a hard assertion in
`_sanitisePath` that rejects paths containing `"`, `` ` ``, `$`, `\`,
`\n`, `|`, `;`, `&`, `<`, `>`, `(`, `)`, or leading `-`. Fail loud
with `GitError` rather than silently sanitising.

### Acceptance

- New test `diffEngine.injection.test.ts` that:
  - Creates a file called `evil";touch /tmp/pwned;echo ".ts` and
    asserts `/tmp/pwned` is **not** created after calling
    `getHunksForFile`.
  - Asserts `_sanitisePath` throws on each of the above
    metacharacters.
- Runtime behaviour for innocuous paths (`src/foo/bar.ts`, paths with
  spaces) is unchanged.

### Effort

½ day.

---

## T2. Fix `gitExec` popping a warning on every successful command

**File:** `src/gitFunctions.ts:122-142`
**Cross-ref:** `docs/reviews/06-error-handling-and-logging.md`
("gitExec error handling is too eager"),
`docs/reviews/10-priorities.md` #3.

### Problem

`gitExec` logs every non-empty `stderr` as an error **and** fires a
warning notification, regardless of exit code. `git` writes to stderr
on successful commands — `warning: LF will be replaced by CRLF`,
hint lines, progress counters, rebase messages. On Windows with CRLF
auto-conversion the extension surfaces one popup per save.

### Fix

Only surface `stderr` when the child exits non-zero. When exit is
zero, log stderr at `debug` level only. Keep the raw `stderr` on the
returned object so callers who want it (rebase output etc.) still
have access.

```ts
if (exitCode !== 0) {
    log.error(`git ${args.join(' ')} exited ${exitCode}: ${stderr}`)
    throw new GitError(exitCode, stdout, stderr)
}
if (stderr) log.debug(`git ${args.join(' ')} stderr: ${stderr}`)
```

### Acceptance

- `gitFunctions.test.ts` (new): stub child_process such that stdout,
  stderr, and exit=0 arrive; assert no `showWarningMessage` was
  called, no `log.error` was produced.
- Same test with exit=128: assert `GitError` thrown, caller gets
  stderr on the exception.
- Manual test on a CRLF repo: edit a tracked file, save, confirm no
  popup.

### Effort

½ day.

---

## T3. `discardChanges` must restore tracked files, not delete untracked

**File:** `src/commands.ts:421` (plus the confirmation modal that says
"Discard changes in X?")
**Cross-ref:** `docs/reviews/02-bugs-and-correctness.md`
("discardChanges uses git clean"), `docs/reviews/10-priorities.md` #4.

### Problem

The command is wired to `git clean -f <path>`, which deletes untracked
files and does nothing for modified tracked files. The confirmation
text promises "discard changes". Users who edit a tracked file and
choose "Discard" will see their edits remain; users who add a new
file and choose "Discard" lose it with no recovery.

### Fix

Switch to:

```ts
await runGit(['checkout', 'HEAD', '--', relativePath], { cwd: worktree })
```

For a node that represents an untracked file we should instead run
`git clean -f -- <path>` **after** a distinct, stronger confirmation
("Delete untracked file X? This cannot be undone."). Split the
behaviour along the `status` from `git status --porcelain`.

### Acceptance

- New `commands.discardChanges.test.ts`:
  - Modified tracked file → after discard, `git status` returns clean,
    file content matches `HEAD`.
  - Untracked file → discard is gated behind a second confirmation;
    confirming deletes the file; dismissing leaves it on disk.
- Confirmation copy updated to distinguish "Discard changes" vs
  "Delete untracked file".

### Effort

½ day.

---

## T4. Guard `git worktree remove --force`

**File:** `src/branchStackService.ts:_pruneOrphans`,
`src/branchStackService.ts:removeBranch` (anywhere `--force` is
invoked).
**Cross-ref:** `docs/reviews/security.md` Finding 5.

### Problem

`--force` discards uncommitted worktree edits silently. A user who
has worked inside `.worktrees/<branch>/` (e.g. opened it as a separate
VS Code window, or edited via terminal) loses those edits when the
branch is pruned or removed.

### Fix

Before running `--force`:

1. `git status --porcelain` inside the worktree.
2. If non-empty, raise a `BranchStackError('worktree has uncommitted
   changes')`. On the command path, present a modal:
   "Worktree has N uncommitted changes. Keep / Discard / Cancel?"
   with Cancel as default.
3. Only when the user picks Discard do we pass `--force`. On Keep we
   leave the worktree in place (and optionally delete the branch
   entry from `local-config.json` but keep the directory).

For `_pruneOrphans` specifically: make it **never** force-remove a
dirty orphan. Surface it to the user as "N orphan worktrees with
uncommitted changes — review and clean up manually" with a
`gitbraid.openOrphansDialog` command.

### Acceptance

- `branchStackService.prune.test.ts` (new) with a real git repo in
  tmp:
  - Orphan dir with clean status → pruned.
  - Orphan dir with modified file → left in place; function returns
    a list of skipped orphans.
- `removeBranch` test: dirty worktree → modal prompt (mocked) →
  Cancel path leaves the worktree; Discard path removes it.

### Effort

1 day.

---

## T5. Fix `activationEvents`

**File:** `package.json`
**Cross-ref:** `docs/reviews/01-architecture.md` §7,
`docs/reviews/09-packaging-and-branding.md`.

### Problem

```json
"activationEvents": [
    "onStartupFinished",
    "workspaceContains:filePattern:.git/HEAD"
]
```

- `workspaceContains:filePattern:<glob>` is not a valid activation
  event — the `filePattern:` prefix doesn't exist. The entry is dead.
- `onStartupFinished` activates the extension in **every** window,
  including workspaces without a git repo, where
  `extension.ts:27` throws a raw `Error('No workspace folder found')`
  — VS Code surfaces a red popup.

### Fix

```json
"activationEvents": [
    "workspaceContains:.git",
    "workspaceContains:.worktrees/local-config.json"
]
```

Additionally, in `extension.ts:activate`, replace the raw `throw` with
an early return when `workspaceFolders` is empty — log a single
`info` line and bail. For windows with multiple folders, pick the
first (document the limitation in the README) but **do not** throw.

### Acceptance

- Open VS Code with a non-git folder: no popup, no activation error
  in the Output.
- Open VS Code on a real repo: stack view appears; logs show
  `activating gitbraid …` once.
- Manifest validation: `vsce ls` does not warn about the activation
  events.

### Effort

¼ day.

---

## T6. Fix `git.revList` and `git.branch` reading `.stdout` from a string

**File:** `src/gitFunctions.ts:172-174`, `src/gitFunctions.ts:220-229`
**Cross-ref:** `docs/reviews/02-bugs-and-correctness.md`
("git.revList returns stringified fields", "git.branch() returns
undefined").

### Problem

`gitExec` resolves to a `string` (stdout). Both methods access
`.stdout` on that string, yielding `undefined`. The `any` annotation
hides the type error. Any caller of `revList` (invoked from
`WorktreeRoot.setCommitRef` during tree refresh) blows up at runtime.

### Fix

Drop the `.stdout` accesses and use the returned string directly:

```ts
async branch (workspaceUri: vscode.Uri): Promise<string> {
    const out = await this.gitExec('branch --show-current', workspaceUri.fsPath)
    return out.trim()
}
```

Also remove every `(r: any) => r.stdout` pattern in the file. While
here, change `gitExec`'s return type to `string` explicitly (it
currently narrows via inference, which is what hid the bug).

### Acceptance

- Unit test calls `git.branch(wsRoot)` on a fixture repo and asserts
  the result equals `main`.
- Unit test for `revList` that creates two branches, commits on each,
  and asserts the ahead/behind counts are numbers (not strings or
  `undefined`).
- Grep confirms no remaining `(r: any) => r.stdout` lines.

### Effort

¼ day.

---

## T7. Normalise publisher / identifier to a single spelling

**Files:** `package.json`, `README.md`, `extension.ts:458`,
`configService.ts:303`, `.gitignore`, changelog, walkthrough, SCM
group id (`MBC:` → `GitBraid:`), command titles.
**Cross-ref:** `docs/reviews/09-packaging-and-branding.md`,
`docs/reviews/10-priorities.md` #1.

### Problem

Three spellings coexist:

- `nihobbs` (package.json, README, extension.ts gitignore stamp)
- `nichobbs` (git origin remote, some docs)
- `kherring` (historical).

The Marketplace rejects a mismatch between `package.json`'s
`publisher` and the actual publisher account. The README's
`vscode.extensions.getExtension('nihobbs.gitbraid')` snippet will not
match a `nichobbs` build.

### Fix

1. Confirm the canonical spelling with the publisher account that
   will own the listing. (Owner decision — record in `CHANGELOG.md`.)
2. Global replace to the canonical spelling. Start with
   `git grep -n -e nihobbs -e nichobbs -e kherring` and triage.
3. Update the `.gitignore` stamp string so it is stable **and**
   idempotently detected by `_ensureGitignore`.
4. Update `MBC:` SCM group ids to `GitBraid:` and migrate
   `gitbraid.stackView.mbc-*` context keys if any exist.

### Acceptance

- `git grep nihobbs` and `git grep kherring` return zero results
  (nichobbs replaces if that is the canonical form).
- `vsce package --no-dependencies` builds cleanly.
- `README.md` usage snippet references the canonical id and compiles
  in a doc test.

### Effort

½ day.

---

## P0 exit criteria

- [ ] T1–T7 all merged and released as 0.1.0 pre-release candidate.
- [ ] Regression tests run green in CI on Linux, macOS, and Windows
      (Windows is where T2 is most visible).
- [ ] A manual smoke test checklist (`docs/remediation/smoke.md`, to
      be written as part of T5/T7) is completed without a single
      unexpected popup.
