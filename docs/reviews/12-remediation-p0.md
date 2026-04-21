# P0 Remediation — Security, Data Loss, Crashes, Publish Blockers

**Target release:** 0.1.1 (hot-fix)
**Goal:** make the current feature set safe to run and publishable.

Do **not** start P1 work until every item here is green. Order within
the list reflects the critical path.

---

## SEC-001: Replace `exec`+string templates with `spawn`+argv

**Source:** [03-security.md](03-security.md) · [02-bugs-and-correctness.md](02-bugs-and-correctness.md#quote-escape-no-op-in-diffengine_sanitisepath)
**Severity:** Critical
**Exploitability:** High
**Effort:** L (1–2 weeks including tests)
**Blocks:** SEC-002, SEC-003, SEC-004, BUG-003
**Blocked by:** —

### Root cause
Every git invocation outside `hunkRouter.ts` uses
`util.promisify(child_process.exec)` with string templates. The ad-hoc
sanitisers (`_sanitise`, `safe(s)`) only escape `"` — and in one case
(`diffEngine.ts:201`) the escape is a no-op. Branch names, commit
messages, and paths flow directly from user input / remotes into
shell-interpreted commands.

### Proposed fix

1. Add `src/gitRunner.ts` with a single entry point:

   ```ts
   import { spawn, SpawnOptions } from 'node:child_process'

   export interface GitRunResult { stdout: string; stderr: string; code: number }

   export async function runGit(
       args: string[],
       opts: { cwd: string; input?: string; encoding?: 'utf8' | 'buffer' } = { cwd: process.cwd() },
   ): Promise<GitRunResult> {
       return new Promise((resolve, reject) => {
           const child = spawn('git', args, { cwd: opts.cwd, shell: false })
           let stdout: Buffer[] = []; let stderr = ''
           child.stdout.on('data', (b: Buffer) => stdout.push(b))
           child.stderr.on('data', (b: Buffer) => stderr += b.toString())
           child.on('error', reject)
           child.on('close', (code) => {
               const out = Buffer.concat(stdout)
               resolve({
                   stdout: opts.encoding === 'buffer' ? (out as unknown as string) : out.toString('utf8'),
                   stderr, code: code ?? 0,
               })
           })
           if (opts.input !== undefined) { child.stdin.write(opts.input); child.stdin.end() }
       })
   }
   ```

2. Migrate each call site. Remove the corresponding `_sanitise` /
   `safe(…)` helpers once the caller passes argv:

   - `gitFunctions.ts` — rewrite `Git.gitExec`, `Worktree.*`.
   - `branchStackService.ts:198` — `runGit(['worktree', 'add', '-b', name, absPath, base], …)`.
   - `diffEngine.ts:134,164,181` — argv diff/merge-base.
   - `rebaseSuggestionService.ts:158,181` — argv rebase / rev-list.
   - `stackResolver.ts:113,143` — argv show / diff.
   - `mbcApi.ts:133,139,154,156` — argv add / commit.
   - `branchScmProvider.ts:22,256` — argv status / commit.

3. Delete `_sanitise` (`stackResolver.ts:158-164`) and `_sanitisePath`
   (`diffEngine.ts:197-202`).

4. Keep the existing `spawn`-based `HunkRouter._applyPatch` as the
   template.

### Acceptance criteria
- `rg -n "child_process.exec|promisify\\(.*exec\\)" src/` returns **zero**
  matches (other than in `gitRunner.ts` if needed for compatibility
  during migration).
- A negative test that sets `branch = 'feat$(touch /tmp/pwned)'`
  through `MbcApi.addBranch` asserts `/tmp/pwned` does not exist after
  the call.
- A negative test for `commitBranch` with message
  ``"msg"; touch /tmp/pwned"`` asserts no file is created.
- All existing tests still pass.

### Verification
- Add `test/security/shellInjection.test.ts` covering at least
  `addBranch`, `commitBranch`, `assignFile`, `rebaseBranch`.
- Static check in CI: `rg -q "child_process\\.exec|promisify\\(.*exec\\)" src/ && exit 1 || exit 0`.

---

## SEC-002: Validate branch names via `git check-ref-format`

**Source:** [03-security.md](03-security.md#branch-name-validation-is-permissive)
**Severity:** High
**Exploitability:** Medium
**Effort:** S
**Blocks:** FEAT-007
**Blocked by:** SEC-001

### Root cause
`BRANCH_NAME_RE = /^[a-zA-Z0-9_./-]+$/` accepts `..`, leading `/`,
trailing `/`, consecutive dots, `.lock` suffix, and other names git
itself rejects. Combined with the injection surface (SEC-001), a
crafted name like `../../foo` passes validation.

### Proposed fix
Replace the regex with:

```ts
async function validateBranchName(name: string): Promise<void> {
    const { code } = await runGit(['check-ref-format', '--branch', name], { cwd: workspaceRoot.fsPath })
    if (code !== 0) throw new BranchStackError(`Invalid branch name: "${name}"`)
}
```

Call it both client-side (on QuickPick commit) and server-side
(`BranchStackService.addBranchToStack`).

### Acceptance criteria
- Test: `addBranchToStack('..', 'main')` rejects with `BranchStackError`.
- Test: `addBranchToStack('foo.lock', 'main')` rejects.
- Test: `addBranchToStack('valid/branch', 'main')` passes.

### Verification
Negative-path unit tests in `test/branchStackService.test.ts`.

---

## SEC-003: Contain relative paths to workspace root

**Source:** [03-security.md](03-security.md#_sanitise-and-_sanitisepath-are-not-sufficient)
**Severity:** High
**Exploitability:** Medium
**Effort:** S
**Blocks:** —
**Blocked by:** SEC-001

### Root cause
`path.normalize` + strip-leading-`..` is insufficient on Windows
(`..\..\`) and can leak `etc/passwd`-style paths depending on input
shape. Relied upon by `diffEngine`, `stackResolver`, and
`gitFunctions.show`.

### Proposed fix
Introduce `src/pathGuard.ts`:

```ts
import * as path from 'node:path'
export function assertInsideRoot(root: string, relativePath: string): string {
    const resolved = path.resolve(root, relativePath)
    const rootAbs = path.resolve(root) + path.sep
    if (resolved !== path.resolve(root) && !resolved.startsWith(rootAbs)) {
        throw new Error(`Path escapes workspace root: ${relativePath}`)
    }
    return path.relative(root, resolved).replaceAll(path.sep, '/')
}
```

Call this at every boundary that takes a user-supplied `relativePath`
and uses it as a git argument.

### Acceptance criteria
- Test: `assertInsideRoot('/ws', '../../etc/passwd')` throws.
- Test: `assertInsideRoot('/ws', 'src/foo.ts')` returns `'src/foo.ts'`.
- Test on Windows-style input: `assertInsideRoot('C:\\ws', '..\\..\\etc')` throws.

### Verification
`test/pathGuard.test.ts`.

---

## SEC-004: Redact credentials in logged git errors

**Source:** [03-security.md](03-security.md#logging-sensitive-data)
**Severity:** Medium
**Exploitability:** Low
**Effort:** S
**Blocks:** —
**Blocked by:** SEC-001

### Root cause
`gitFunctions.ts:134` logs the full `GitErrorResponse` including
command line; command lines may contain `https://user:token@host` URLs
if a user adds a worktree against a remote with inline credentials.

### Proposed fix
Add a redactor helper:

```ts
function redact(s: string): string {
    return s.replace(/https?:\/\/[^:/\s]+:[^@\s]+@/g, (m) => m.replace(/:[^@]+@/, ':***@'))
}
```

Apply to every `log.error` / `log.warn` that stringifies a git error
object.

### Acceptance criteria
- Test: logging a string containing `https://alice:ghp_xxx@github.com`
  writes `https://alice:***@github.com` to the output channel.

### Verification
Grep: `rg "JSON.stringify\\(e" src/` → all calls wrapped in `redact(…)`.

---

## BUG-001: `discardChanges` restores tracked files, not just deletes untracked

**Source:** [02-bugs-and-correctness.md](02-bugs-and-correctness.md#discardchanges-uses-git-clean)
**Severity:** Critical
**Exploitability:** N/A (user-triggered data loss)
**Effort:** S
**Blocks:** —
**Blocked by:** SEC-001

### Root cause
`commands.ts:421` runs `git clean -f <path>` on every "discard". For
untracked files this is correct; for tracked modifications it does
**nothing** (silent no-op) while the confirmation dialog promises to
discard changes.

### Proposed fix
Split behaviour by file group (the group is already known on the
`WorktreeFile` node):

```ts
async discardChanges(node: WorktreeFile) {
    const file = node.uri.fsPath
    if (node.group === FileGroup.Untracked) {
        await runGit(['clean', '-f', '--', file], { cwd: node.getRepoUri().fsPath })
    } else {
        // tracked modifications or staged: restore
        await runGit(['restore', '--staged', '--worktree', '--', file], { cwd: node.getRepoUri().fsPath })
    }
}
```

Update the confirmation message to match the actual action
(`cleanMessage` in `gitFunctions.ts` already differentiates — wire it
through).

### Acceptance criteria
- Test: create a tracked file, modify it, call `discardChanges`, assert
  the file content matches `HEAD`.
- Test: create an untracked file, call `discardChanges`, assert file is
  gone.
- Test: stage a tracked file, call `discardChanges`, assert unstaged
  and restored.

### Verification
Add `test/commands.discardChanges.test.ts` (new — see TEST-001).

---

## BUG-002: `revList` and `branch()` read `.stdout` off a string

**Source:** [02-bugs-and-correctness.md](02-bugs-and-correctness.md#gitrevlist-returns-stringified-fields) · [02-bugs-and-correctness.md](02-bugs-and-correctness.md#gitbranch-returns-undefined)
**Severity:** Critical
**Exploitability:** N/A (runtime crash)
**Effort:** S
**Blocks:** BUG-003
**Blocked by:** SEC-001 (both call sites rewritten in the migration)

### Root cause
`gitExec` returns the trimmed stdout string, but callers do
`r.stdout.trim()` or `r.stdout` expecting the raw `{stdout,stderr}`
object. Any code path that calls `git.revList` (worktree commit-ref
updates on tree refresh) crashes.

### Proposed fix
During the SEC-001 migration, rewrite these callers to use the new
`runGit` signature explicitly:

```ts
async revList(revA: string, revB: string) {
    const { stdout, code } = await runGit(
        ['rev-list', '--left-right', '--count', `${revA}..${revB}`],
        { cwd: workspaceRoot.fsPath },
    )
    if (code !== 0) return { ahead: 0, behind: 0 }
    const [ahead, behind] = stdout.trim().split('\t').map((n) => Number.parseInt(n, 10) || 0)
    return { ahead, behind }
}
```

Delete all `(r: any) => r.stdout` lambdas in `gitFunctions.ts`.

### Acceptance criteria
- Test: `git.revList('HEAD', 'HEAD')` resolves to `{ ahead: 0, behind: 0 }`.
- Test: opening a workspace with two worktrees does not throw.
- Static check: `rg "\\): any\\).*=>.*stdout" src/` returns zero results.

### Verification
Unit tests; manual smoke test with two worktrees.

---

## BUG-003: `activationEvents` is malformed

**Source:** [01-architecture.md](01-architecture.md#7-activation-events-are-misconfigured)
**Severity:** High
**Exploitability:** N/A
**Effort:** S
**Blocks:** —
**Blocked by:** —

### Root cause
```json
"activationEvents": [
    "onStartupFinished",
    "workspaceContains:filePattern:.git/HEAD"
]
```
The second entry is malformed; only `onStartupFinished` fires. The
extension activates on every window (including non-git), where
`activate()` immediately throws.

### Proposed fix
```json
"activationEvents": [
    "workspaceContains:.git",
    "workspaceContains:.git/HEAD"
]
```

Also soften the activation throw (`extension.ts:27`) to a log-and-return:

```ts
if (!vscode.workspace.workspaceFolders?.length) {
    log.info('no workspace folder — skipping activation')
    return undefined
}
```

### Acceptance criteria
- Open a folder without `.git` → extension does not activate, no error
  dialog.
- Open a folder with `.git` → extension activates.

### Verification
Manual + add an activation smoke test via `vscode-test` harness.

---

## BUG-004: Hunk-index assignments silently drift after edits

**Source:** [02-bugs-and-correctness.md](02-bugs-and-correctness.md#hunk-indices-are-fragile-identifiers)
**Severity:** High
**Exploitability:** N/A (silent wrong-branch commits)
**Effort:** M
**Blocks:** —
**Blocked by:** —

### Root cause
`ConfigService.setHunkAssignment(rel, hunkIndex, branch)` persists the
numeric index. Any subsequent edit re-indexes hunks. Persisted
assignments then map to arbitrary, unrelated lines.

### Proposed fix
Two changes, pick one per hunk type:

1. **Transient hunk assignments** — don't persist at all. Keep them in
   `WorkspaceSync`'s in-memory map and require the user to run
   `routeHunks` before editing further. `CodeLens` greys out stale
   assignments as soon as the document version changes.

2. **Persistent-by-header** — change the schema to key by header plus
   a content-hash fingerprint:

   ```ts
   interface HunkAssignmentV2 {
       header: string            // '@@ -10,5 +10,6 @@ fn …'
       startLine: number
       endLine: number
       bodyHash: string          // sha1 of the `- `/`+` body lines
       branch: string
   }
   ```

   On read, match by `(header, bodyHash)` first, fall back to
   `(startLine, endLine)`.

Recommendation: ship option 1 for 0.1.1 (smaller blast radius), move to
option 2 during P1 as part of `FEAT-003` (hunk router UX).

### Acceptance criteria
- Test: assign hunk 0 → edit the file above the hunk to shift line
  numbers → assignment still maps to the same content, or is cleared
  with a user-visible warning.

### Verification
`test/hunkIndexDrift.test.ts`.

---

## PKG-001: Unify publisher / identifier across the tree

**Source:** [09-packaging-and-branding.md](09-packaging-and-branding.md#publisher--identifier-inconsistencies)
**Severity:** Critical (blocks Marketplace publish)
**Exploitability:** N/A
**Effort:** S
**Blocks:** PKG-002, PKG-003, UX-001
**Blocked by:** —

### Root cause
Three spellings coexist: `nihobbs` (package.json, README), `nichobbs`
(git origin, .gitignore comment), `kherring` (legacy). Marketplace id
is `<publisher>.<name>` — picking the wrong one breaks the README
snippet and the activation hook.

### Proposed fix
1. Decide the canonical spelling. Treat the git remote
   (`github.com/nichobbs/gitbraid`) as the source of truth unless the
   user confirms otherwise.
2. Search & replace globally:
   ```
   rg -l "nihobbs|nichobbs|kherring" | xargs sed -i 's/nihobbs/<CANON>/g; s/kherring/<CANON>/g'
   ```
3. Update:
   - `package.json` → `publisher`, `repository.url`, `homepage`,
     `bugs.url`.
   - `README.md` → API snippet, links.
   - `extension.ts:458` → `.gitignore` stamp.
   - `configService.ts` anywhere the stamp leaks.
   - `CHANGELOG.md`, `PUBLISH.md` references.

### Acceptance criteria
- `rg "nihobbs|kherring" .` returns zero results.
- `rg "nichobbs" .` returns exactly the canonical spelling in expected
  files.
- `npx vsce package` succeeds and the produced `.vsix` has the right
  `publisher.name` identity.

### Verification
CI check: a grep-based lint step.

---

## PKG-002: Declare `languageModelTools` in `package.json`

**Source:** [08-missing-features.md](08-missing-features.md#language-model-tools) · [09-packaging-and-branding.md](09-packaging-and-branding.md#languagemodeltools)
**Severity:** High (feature is advertised but non-functional)
**Exploitability:** N/A
**Effort:** S
**Blocks:** FEAT-006
**Blocked by:** PKG-001

### Root cause
Seven LM tools are registered at runtime but not contributed in
`package.json`, so Copilot Chat cannot discover them.

### Proposed fix
Add under `contributes`:

```json
"languageModelTools": [
    {
        "name": "mbc_getStack",
        "displayName": "Get GitBraid Stack",
        "modelDescription": "Returns the current branch stack…",
        "canBeReferencedInPrompt": true,
        "toolReferenceName": "getStack",
        "inputSchema": { "type": "object", "properties": {}, "required": [] }
    },
    … for all 7 tools …
]
```

Fill input schemas using the interface types in `lmTools.ts`.
Rename `mbc_*` to `gitbraid_*` for consistency with the new branding.

### Acceptance criteria
- Copilot Chat auto-completes `#getStack`, `#assignFile`, etc.
- `vsce package` emits no manifest-validation warnings.

### Verification
Manual smoke test in VS Code Insiders with Copilot Chat.

---

## PKG-003: Declare `capabilities` and bump `engines.vscode`

**Source:** [09-packaging-and-branding.md](09-packaging-and-branding.md#capabilities) · [09-packaging-and-branding.md](09-packaging-and-branding.md#enginesvscode)
**Severity:** Medium (misbehaviour in remote / untrusted / virtual)
**Exploitability:** Low
**Effort:** S
**Blocks:** —
**Blocked by:** PKG-001

### Root cause
No `capabilities` block. Extension runs in virtual workspaces where it
crashes, and in untrusted workspaces where git hooks run user code.
`engines.vscode ^1.94.0` is below the stable cut-off for LM tools.

### Proposed fix
```json
"engines": { "vscode": "^1.95.0" },
"capabilities": {
    "virtualWorkspaces": { "supported": false,
        "description": "GitBraid requires a local git CLI and worktrees." },
    "untrustedWorkspaces": { "supported": false,
        "description": "Runs git commands that may execute user-defined hooks." }
}
```

### Acceptance criteria
- Opening GitBraid in a virtual workspace shows the standard VS Code
  notice instead of throwing.
- Opening in untrusted mode prompts the user to trust the workspace.

### Verification
Manual; document in `PUBLISH.md`.

---

## PKG-004: Remove `private: true` before publishing

**Source:** [09-packaging-and-branding.md](09-packaging-and-branding.md#repository-metadata)
**Severity:** Medium (publish block)
**Exploitability:** N/A
**Effort:** S
**Blocks:** —
**Blocked by:** PKG-001

### Root cause
`"private": true` instructs npm (and by extension `vsce`) to refuse
publish.

### Proposed fix
Flip to `false` once PKG-001/002 are in. Run `npx vsce package` in CI
to catch regressions.

### Acceptance criteria
- `npx vsce publish --no-git-tag-version --dry-run` completes in CI.

### Verification
Add to the CI matrix.

---

## P0 release checklist

Before cutting 0.1.1, ensure all of the below are checked:

- [ ] SEC-001 — every git call uses `spawn`+argv (`rg -c 'child_process'` = 0)
- [ ] SEC-002 — branch-name validation delegates to git
- [ ] SEC-003 — path-guard module + callers updated
- [ ] SEC-004 — URL credentials redacted in logs
- [ ] BUG-001 — discard-changes tests pass
- [ ] BUG-002 — legacy tree view loads without throwing
- [ ] BUG-003 — extension doesn't activate on non-git workspaces
- [ ] BUG-004 — stale-hunk test or doc-note on transient behaviour
- [ ] PKG-001 — publisher is canonical everywhere
- [ ] PKG-002 — LM tools listed under `contributes`
- [ ] PKG-003 — `capabilities` + engine bump
- [ ] PKG-004 — `private: false`
- [ ] All existing tests pass
- [ ] Manual smoke on macOS + Windows (primary, +1 stacked branch, one assigned file, one commit)
- [ ] `npx vsce package` produces a valid `.vsix`
- [ ] CHANGELOG updated with "0.1.1 — Hotfix"
