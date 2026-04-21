# Packaging and Branding Review

## Publisher / identifier inconsistencies

`package.json`:

```json
"name": "gitbraid",
"publisher": "nihobbs",
"repository": { "url": "https://github.com/nihobbs/gitbraid" }
```

`README.md`:

```ts
vscode.extensions.getExtension('nihobbs.gitbraid')
```

The assistant context for this review says the repo is
`nichobbs/gitbraid`, and commit `74d48cf` "updates vscode extension
identifier from 'kherring.multi-branch-checkout' to 'nichobbs.gitbraid'
in .gitignore". So there are **three** spellings in the tree:

- `nihobbs` (package.json, README, extension.ts:458 `.gitignore` stamp)
- `nichobbs` (git origin, .gitignore changelog reference)
- `kherring` (historical, likely fully removed but worth auditing)

Pick one publisher id, normalise across every file:

```bash
grep -r "nihobbs\|nichobbs\|kherring" .
```

## Walkthrough assets missing

`package.json:63` references:

```
resources/walkthrough-add-branch.png
resources/walkthrough-assign-file.png
resources/walkthrough-commit.png
resources/walkthrough-rebase.png
```

None of these exist. Running the walkthrough will render broken
image placeholders. Either check the images in or drop `media`.

## Branding is half-done

- Walkthrough title: `"Get Started with Multi-Branch Checkout"` —
  should be `"Get Started with GitBraid"`.
- Configuration title: `"Multi-Branch Checkout"` — same.
- Command title: `"Multie Branch Checkout: Open file"` (typo + old
  brand).
- SCM group names: `"MBC: …"`, `"MBC: Floating (unassigned)"`.
- Logger output channel: `"gitbraid"` ✅.
- Activation log line: `"activating gitbraid …"` ✅.

## `activationEvents` is malformed

```json
"activationEvents": [
    "onStartupFinished",
    "workspaceContains:filePattern:.git/HEAD"
]
```

The correct form is `workspaceContains:<glob>`, not
`workspaceContains:filePattern:<glob>`. The second entry is dead. Fix:

```json
"activationEvents": [
    "workspaceContains:.git"
]
```

Drop `onStartupFinished` — activating on every startup slows VS Code
for windows that have no git repo.

## Missing contributions

### `languageModelTools`

Seven LM tools registered in code, zero declared in `package.json`
(see `08-missing-features.md#language-model-tools`). Copilot Chat
cannot discover them.

### `views/container`

Both tree views are placed into the built-in SCM container. For
discoverability, consider a dedicated Activity Bar view container:

```json
"viewsContainers": {
    "activitybar": [
        { "id": "gitbraid", "title": "GitBraid", "icon": "resources/icon.svg" }
    ]
},
"views": {
    "gitbraid": [
        { "id": "gitbraid.stackView", "name": "Branch Stack" },
        { "id": "gitbraid.worktreeView", "name": "Worktrees" }
    ]
}
```

### `keybindings`

None declared. Power users will want key bindings for `assignFile`,
`routeHunks`, `addStackBranch`.

### `extensionKind`

Declaring `"extensionKind": ["workspace"]` (or `["workspace", "ui"]`)
controls whether the extension runs in remote or local. Since
GitBraid needs a local git CLI, it should be `["workspace"]`.

### `capabilities`

```json
"capabilities": {
    "virtualWorkspaces": {
        "supported": false,
        "description": "GitBraid requires a local git worktree."
    },
    "untrustedWorkspaces": {
        "supported": false,
        "description": "GitBraid runs git commands that could execute arbitrary user code via hooks."
    }
}
```

Declare these explicitly; VS Code otherwise assumes `true`, and the
extension will load into contexts it can't handle.

## `preview: true`

`"preview": true` is appropriate for a 0.1.0 release. When moving to
1.0 remove this and add a proper changelog entry.

## `engines.vscode`

`"^1.94.0"` is fine. However, `vscode.lm.registerTool` and
`languageModelTools` contributions both require **1.95+** for stable
API (they were proposed in earlier versions). Bump to `^1.95.0` or
guard the tools behind a feature flag.

## Repository metadata

- `private: true` will block `vsce publish`. For a published extension
  set `"private": false`.
- `"license": "MIT"` — but the `LICENSE` file should be checked for
  completeness (it exists at 1047 bytes, appears correct).
- `"categories": ["Other"]` — consider `["SCM Providers"]` instead;
  that's the dedicated category for git-adjacent tooling and will put
  GitBraid in the right Marketplace section.

## `scripts`

- `npm run compile` and `npm run build` both run `node esbuild.js`. Pick
  one name and alias the other.
- `"vscode:prepublish": "npm run compile"` does not run tests or lint.
  Add `"vscode:prepublish": "npm run lint && npm run compile && npm run test"`.
- `install-vsix` uses `${npm_package_version}` — works with npm but
  not with pnpm or yarn. Note in a CONTRIBUTING doc or use
  `node -p "require('./package.json').version"`.

## `devDependencies` audit

Dead or questionable:

- `@swc-node/register` and `ts-node` — two TS loaders; keep one.
- `mocha-reporter-sonarqube`, `mocha-multi-reporters` — commit `4519ab4`
  says "remove legacy Sonar infrastructure" but these remain.
- `tsconfig-paths` — no path aliases defined in `tsconfig.json` (it's a
  17-line file that doesn't use `paths`). Drop.

## `esbuild.js` review

Not shown here, but typical pitfalls to check:

- Is `vscode` marked as an external dependency? (it must be; VS Code
  provides it at runtime)
- Is `sourcemap: true` set so stack traces from users are debuggable?
- Is the bundle minified for production but not for `--watch`?

## `.gitignore`

The extension writes to the repo's `.gitignore` at activation
(`extension.ts:458` and `configService.ts:303`) — two independent
writers. Pick one. Also, the comment format
`## added by vscode extension 'nihobbs.gitbraid'` is a signature that
will appear in every user's repo; standardise it and maybe make it
a recognisable marker that the service can detect for idempotency.
