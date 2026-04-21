# Security Review

## Threat Model

GitBraid runs locally inside VS Code with the same OS privileges as the user. It reads
and writes files in the workspace, spawns `git` subprocesses, and persists state to
`.worktrees/local-config.json`. There is no network surface, no authentication layer,
and no user-supplied data that traverses a trust boundary other than file paths and
branch names entered via VS Code quick-picks.

The primary risks are therefore:

1. **Command injection** via unsanitised strings passed to shell commands.
2. **Path traversal** via crafted relative paths reaching outside the workspace.
3. **Data corruption** from concurrent access to the config file.
4. **Privilege escalation through git hooks** in attacker-controlled repositories.

---

## Finding 1 — Command Injection via Branch Names (Low Risk, Good Mitigation)

Branch names are validated against `BRANCH_NAME_RE = /^[a-zA-Z0-9_./-]+$/` before use.
Names are then double-quoted when interpolated into shell strings, e.g.:

```typescript
// branchStackService.ts
await git.worktree.add(`-b "${branchName}" "${absPath}" "${base}"`)
```

The regex prevents the characters needed to break out of double quotes (`"`, `` ` ``,
`$`, `\`, `!`). This mitigation is sound.

**Recommendation:** Prefer passing arguments as an array to `child_process.spawn`
rather than constructing shell strings. This eliminates the quoting concern entirely
and is more readable. `gitFunctions.ts` already uses `exec` (shell string); migrating
to `spawn` with an args array for security-sensitive calls is low effort.

---

## Finding 2 — Path Traversal in DiffEngine (Low Risk, Adequate Mitigation)

`DiffEngine._sanitisePath()` strips leading `../` sequences and escapes double quotes:

```typescript
const normalised = path.normalize(relativePath).replace(/^(\.\.\/|\.\.\\)+/, '')
return normalised.replaceAll('"', String.raw`"`)
```

`path.normalize` collapses `a/../../../etc/passwd` to `../../etc/passwd`, then the
regex strips leading `../` pairs. However, `path.normalize` on POSIX turns
`foo/../../etc/passwd` into `../etc/passwd` — a single leading `../` — which the regex
does strip. This is correct.

**Recommendation:** Add a post-normalisation check that the resulting path does not
start with `..` at all (rather than stripping until it doesn't), and add a test case
for deeply nested traversal strings. The current approach works but is fragile to read.

---

## Finding 3 — Config File Has No Concurrent-Write Protection (Medium Risk)

`ConfigService._writeToDisk()` uses a write-then-rename pattern, which protects against
partial writes but not against two writers racing:

```
Window A: reads config (version 1)
Window B: reads config (version 1)
Window A: writes new config (version 2, adds branch X)
Window B: writes new config (version 2, adds branch Y)  ← clobbers A's write
```

With multiple VS Code windows on the same repository, one window's changes will
silently overwrite the other's.

**Recommendation:** Add an optimistic-concurrency check: store the file's `mtime` at
read time and refuse to write if `mtime` has changed. On conflict, reload from disk,
re-apply the in-memory change, and retry. This requires no external locking primitive
and handles the common case cleanly.

---

## Finding 4 — Git Hook Execution in Untrusted Repositories (Medium Risk)

`git apply --index` (used in `HunkRouter._applyPatch`) and all other git commands run
in worktree directories. If a repository contains malicious `.git/hooks/` scripts, those
hooks can execute with the user's privileges whenever git operations run. This is a
general git risk, not unique to GitBraid, but worth acknowledging.

**Recommendation:** Document in the README that GitBraid should not be used in
repositories you do not trust, consistent with VS Code's own workspace trust model.
Consider respecting VS Code's `workspace.isTrusted` API and disabling git subprocess
calls in untrusted workspaces.

---

## Finding 5 — `git worktree remove --force` Silently Discards Changes (High UX Risk)

In `BranchStackService`, orphaned worktrees are pruned with `--force`:

```typescript
await runGit(['worktree', 'remove', '--force', worktreePath])
```

If a worktree has uncommitted changes (e.g. the user edited files directly in the
worktree), `--force` discards them without any warning.

**Recommendation:** Before using `--force`, run `git status --porcelain` in the
worktree. If it reports dirty files, prompt the user for confirmation or refuse to
remove and surface an error instead.

---

## Finding 6 — Sensitive Data in Log Output (Low Risk)

`channelLogger.ts` logs file paths, branch names, and partial file content to the VS
Code Output channel. In most workspaces this is harmless, but repositories containing
secrets in filenames (e.g., `.env.production`) will have those names appear in the
Output panel and potentially in any log-forwarding tools a user has configured.

**Recommendation:** No immediate action required. If log levels are surfaced as a user
setting in the future, ensure `debug`-level logs (which may include content snippets)
are off by default.

---

## Summary Table

| Finding | Severity | Status |
|---|---|---|
| Command injection via branch names | Low | Mitigated by regex + quoting |
| Path traversal in DiffEngine | Low | Mitigated; recommend hardening |
| Concurrent config writes | Medium | **Unmitigated** |
| Git hook execution in untrusted repos | Medium | **Undocumented** |
| Force-remove discards uncommitted changes | High (data loss) | **Unmitigated** |
| Sensitive filenames in logs | Low | Acceptable for now |
