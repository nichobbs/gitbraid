# Packaging and Manifest

Items that land in `package.json`, `CHANGELOG.md`, `resources/`, build
scripts, and devDependencies. Several are "quick wins" (≤ 30 minutes
each).

---

## T76. Publisher/id normalisation

Covered as P0 item T7. Cross-linked here for completeness —
`09-packaging.md` is the place to record the canonical spelling and
the audit commands.

Audit command:

```
git grep -nE "nihobbs|nichobbs|kherring"
```

---

## T77. Fix `activationEvents`

Covered as P0 item T5. Preferred final state:

```json
"activationEvents": [
    "workspaceContains:.git",
    "workspaceContains:.worktrees/local-config.json"
]
```

---

## T78. Declare `capabilities`

**File:** `package.json`
**Cross-ref:** `docs/reviews/09-packaging-and-branding.md`,
`docs/reviews/missing-features.md` F9.

### Fix

```json
"capabilities": {
    "virtualWorkspaces": {
        "supported": false,
        "description": "GitBraid requires local git worktrees."
    },
    "untrustedWorkspaces": {
        "supported": "limited",
        "description": "GitBraid runs git commands that can trigger repository hooks."
    }
}
```

---

## T79. Declare `extensionKind: ["workspace"]`

**File:** `package.json`

### Fix

Ensure the extension runs only workspace-side (where the git binary
lives), not UI-side for remote-ssh users.

---

## T80. `engines.vscode` → 1.95+

**File:** `package.json`
**Cross-ref:** `docs/reviews/09-packaging-and-branding.md`
("engines.vscode").

### Fix

Bump `"vscode": "^1.95.0"` so `contributes.languageModelTools`
stabilises. Smoke-test on the lowest supported version.

---

## T81. Marketplace metadata

**Files:** `package.json`

### Fix

- `"preview": true` stays for 0.1, remove at 1.0.
- `"private": false` (currently `true` blocks `vsce publish`).
- `"categories": ["SCM Providers", "Other"]` (lead with SCM).
- Add `"keywords": ["git", "worktree", "stacked-prs", "branch", "scm"]`.
- `repository.url` matches the actual GitHub URL (after T7 decides
  the canonical spelling).
- `bugs`, `homepage`, `icon` all consistent.

---

## T82. `scripts` and build hygiene

**File:** `package.json`
**Cross-ref:** `docs/reviews/09-packaging-and-branding.md`.

### Fix

- `"vscode:prepublish": "npm run lint && npm run compile && npm test"`.
- Collapse `compile`/`build` into one; alias the other.
- `install-vsix` script: switch to
  `node -p "require('./package.json').version"` so it works under
  pnpm and yarn.

---

## T83. Drop obsolete devDependencies

**File:** `package.json`

### Fix

Remove `mocha-reporter-sonarqube`, `mocha-multi-reporters`,
`tsconfig-paths`, one of `ts-node` / `@swc-node/register`.

---

## T84. Commit walkthrough PNGs / fix walkthrough copy

Covered as T16. Mentioned here so the packaging checklist is
complete.

---

## T85. Dedicated activity-bar view container (stretch)

**File:** `package.json`
**Cross-ref:** `docs/reviews/09-packaging-and-branding.md` ("Missing
contributions → views/container").

### Fix

Moves the two views out of the shared SCM container into a dedicated
GitBraid activity bar item. Defer until T11 settles the two-view
question so we don't rebrand twice.

---

## T86. Keybinding suggestions

**File:** `package.json`

### Fix

Ship at least:

- `gitbraid.addStackBranch` → `ctrl+alt+b`
- `gitbraid.assignFile` → `ctrl+alt+a`
- `gitbraid.routeHunks` → `ctrl+alt+r`

On macOS substitute `cmd+alt+*`. Document in README.

---

## Packaging exit criteria

- [ ] `vsce package --no-dependencies` produces a valid `.vsix`.
- [ ] Marketplace upload passes validation (dry run via
      `vsce verify-pat` + `vsce show`).
- [ ] `npm ls` reports zero extraneous dependencies.
- [ ] Walkthrough + README consistent with the canonical brand.
