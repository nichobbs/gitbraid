# Security Hardening

Covers the deeper security programme after P0 has patched the confirmed
holes. Main theme: eliminate shell string concatenation, validate at
boundaries, and honour VS Code's workspace trust model.

---

## T18. Migrate every git invocation from `exec` to `spawn(..., { shell: false })`

**Files:** `src/gitFunctions.ts` (central runner), `src/diffEngine.ts`,
`src/stackResolver.ts`, `src/rebaseSuggestionService.ts`,
`src/branchStackService.ts`, `src/mbcApi.ts`,
`src/branchScmProvider.ts`
**Cross-ref:** `docs/reviews/03-security.md` ("Systemic issue —
shell string concatenation"), `docs/reviews/code-quality.md` Q6.

### Plan

1. Add `runGit(args: string[], opts: { cwd: string, input?: string })`
   in `gitFunctions.ts` that spawns `git` directly with
   `shell: false`, enforces `maxBuffer`-equivalent (streaming stdout
   buffered into an array capped at 100 MB), and resolves with
   `{ stdout, stderr, exitCode }`.
2. Replace each `exec(\`git … "${x}"\`, ...)` call site:
   - `DiffEngine.getHunksForFile`: `runGit(['diff', 'HEAD', '--', relativePath], …)`
   - `DiffEngine.getHunksAgainstBranch`: `runGit(['diff', mergeBase, '--', relativePath], …)`
   - `DiffEngine._mergeBase`: `runGit(['merge-base', ref1, ref2], …)`
   - `StackResolver.getFileContentAtRef`: `runGit(['show', `${ref}:${relativePath}`], …)` — note: `ref:path` is still a single argv token, but now the shell can no longer interpret metacharacters inside it; keep the `path.resolve` containment check (T20) for belt-and-braces.
   - `StackResolver.getStackDiff`: `runGit(['diff', `${base}...${top}`, '--', relativePath], …)`.
   - `RebaseSuggestionService._rebaseBranch`: `runGit(['rebase', base], { cwd: worktree })`.
   - `RebaseSuggestionService._countRevsBehind`: `runGit(['rev-list', '--count', `${child}..${parent}`], …)`.
   - `BranchStackService._createWorktree`: `runGit(['worktree', 'add', '-b', branch, absPath, base], …)`.
   - `MbcApi.commitBranch`: `runGit(['commit', ...gpgFlag, '-m', message], { cwd: wtDir })`.
   - `MbcApi.stageFiles`: `runGit(['add', '--', ...paths], …)`.
   - `BranchScmProviderManager.commitBranch`: same pattern.
3. Delete every `_sanitise` and `safe()` helper. They were necessary
   only to block shell metacharacters.
4. Keep the path-containment check from T20 as a defence in depth
   against `ref:../../etc/passwd`.

### Acceptance

- A shell-injection suite (`test/injection.test.ts`) exercising
  branch name, commit message, and path payloads; asserts no marker
  files are created and no external commands run.
- No `exec(\`git ...\`)` template literal anywhere in `src/`.
- `grep -R "String.raw" src/` returns zero results.

### Effort

3 days.

---

## T19. Replace the permissive branch-name regex with `git check-ref-format`

**File:** `src/branchStackService.ts:13`
**Cross-ref:** `docs/reviews/03-security.md` ("Branch name validation
is permissive").

### Problem

```ts
const BRANCH_NAME_RE = /^[a-zA-Z0-9_./-]+$/
```

passes values git rejects (`..`, leading/trailing `/`, `@{`, `.lock`,
`../../foo`, whitespace, consecutive dots). Also does not reject
`HEAD`, `refs/heads/foo` (branch names with namespaces the user
should not be using).

### Fix

Use `git check-ref-format --branch <name>` via `runGit`. Exit 0 →
valid, non-zero → throw `BranchStackError` with a friendly message
derived from git's own diagnostic.

Keep the regex as a cheap pre-filter before spawning git (reject
empty strings and characters not in `[a-zA-Z0-9_./\-@+]`) to avoid
spawning on obvious garbage.

### Acceptance

- Test cases from git's own documentation: `.foo`, `foo.`, `foo..bar`,
  `foo.lock`, `foo bar`, `/foo`, `foo/`, `HEAD`, `@` all rejected.
- Valid: `feature/a`, `release-1.2.3`, `user/fix-#42`,
  `hotfix_release-2024.01`.

### Effort

½ day.

---

## T20. Validate resolved paths stay inside the workspace root

**Files:** `src/diffEngine.ts`, `src/stackResolver.ts`,
`src/workspaceSync.ts`, `src/branchStackService.ts`, new
`src/pathGuard.ts`
**Cross-ref:** `docs/reviews/03-security.md` ("_sanitisePath"
weakness), `docs/reviews/security.md` Finding 2.

### Fix

Add `pathGuard.requireInside(wsRoot: string, relativePath: string): string`
that returns an absolute path guaranteed to start with `wsRoot + sep`,
throwing `ConfigError('path escapes workspace root')` otherwise.

Call it wherever a relative path crosses a service boundary (config
set, diff, sync, resolver). Normalise slashes first
(`relativePath.split(/[\\/]/g).join('/')`) to keep the guard
cross-platform.

### Acceptance

- Unit tests for `../../etc/passwd`, `..\\..\\foo` (Windows-style),
  `foo/./bar/../..` and `foo/../../../etc/passwd`.
- No `_sanitisePath` helper remaining in the codebase.

### Effort

1 day.

---

## T21. Protect `local-config.json` from concurrent writes

**File:** `src/configService.ts:_readFromDisk`, `_writeToDisk`
**Cross-ref:** `docs/reviews/security.md` Finding 3,
`docs/reviews/architecture.md` ("No cross-window awareness").

### Fix

Optimistic concurrency:

1. On read, stash `stat.mtime` and content hash.
2. On write: re-stat; if `mtime` differs or hash differs, reload,
   re-apply the in-memory diff (we track the last operation), then
   retry. Up to 3 retries, then surface a `ConfigError` with "Config
   changed externally — review `.worktrees/local-config.json`".
3. Write continues to use `tmp + rename` for atomicity.

### Acceptance

- Integration test with two `ConfigService` instances sharing the
  same file; both add a branch; assert both branches survive in the
  final file.

### Effort

1 day.

---

## T22. Redact credentials from logged git output

**Files:** `src/gitFunctions.ts` (logging path), `src/channelLogger.ts`
**Cross-ref:** `docs/reviews/03-security.md` ("Logging sensitive
data"), `docs/reviews/security.md` Finding 6.

### Fix

Central `redact(str: string): string` that replaces:

- `https?://[^:@/]+:[^@/]+@` → `https://***:***@`
- `Authorization: .*` → `Authorization: ***`
- `ghp_[A-Za-z0-9]{20,}` / `github_pat_[A-Za-z0-9_]{20,}` → `***`

Apply in every `log.error`, `log.warn`, `log.info` that emits git
command lines or error objects.

### Acceptance

- Test: an error object with `cmd: 'git clone https://user:tok@host/repo'`
  logged through `log.error` → output contains `***:***@host` not
  the token.

### Effort

½ day.

---

## T23. Honour workspace trust

**File:** `src/extension.ts:activate`, `package.json:capabilities`
**Cross-ref:** `docs/reviews/security.md` Finding 4,
`docs/reviews/missing-features.md` F9,
`docs/reviews/09-packaging-and-branding.md`.

### Fix

1. Declare:
   ```json
   "capabilities": {
     "virtualWorkspaces": { "supported": false, "description": "GitBraid requires a local git worktree." },
     "untrustedWorkspaces": { "supported": "limited", "description": "GitBraid runs git commands that can trigger repository hooks." }
   }
   ```
2. In `activate`, check `vscode.workspace.isTrusted`. If false:
   - register a no-op API stub,
   - show a banner via `viewsWelcome` explaining why commands are
     disabled,
   - register an `onDidGrantWorkspaceTrust` listener that calls the
     real `activate`.

### Acceptance

- Open a folder, pick "Don't trust" in the trust dialog → stack view
  shows the banner, no git subprocesses spawn.
- Grant trust → full activation happens without a reload.

### Effort

1 day.

---

## T24. Single owner for `.gitignore` stamping

**Files:** `src/extension.ts:442-459`, `src/configService.ts:287-313`
**Cross-ref:** `docs/reviews/03-security.md` (".gitignore
injection"), `docs/reviews/09-packaging-and-branding.md`.

### Problem

Two independent writers race on activation. In a worst case one
overwrites the other's marker, leaving `.worktrees/` uncovered.

### Fix

- Delete the write in `extension.ts`.
- Keep `ConfigService._ensureGitignore` as the only writer.
- Replace CRLF with `os.EOL` (the current code always writes `\n`,
  which produces mixed line endings on Windows).
- Make the marker comment stable and detectable so we never append
  twice:
  ```
  ## gitbraid: manage .worktrees/ (do not remove this line)
  .worktrees/
  ```

### Acceptance

- Running activation twice appends nothing the second time.
- Windows test repo with CRLF `.gitignore` → no mixed line endings
  after stamping.

### Effort

½ day.

---

## Security exit criteria

- [ ] No `exec()` calls with template-string arguments in `src/`.
- [ ] Injection suite passes on Linux, macOS, Windows.
- [ ] Redaction suite passes; `log.error` output with tokens is
      masked.
- [ ] Manifest declares `virtualWorkspaces` and `untrustedWorkspaces`.
- [ ] Concurrent-writer test passes for `ConfigService`.
