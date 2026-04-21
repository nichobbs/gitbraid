# GitBraid — VS Code Extension

**Braid multiple branches together in one workspace.**

GitBraid lets you work on several branches simultaneously without context-switching.
Each file (or individual diff hunk) is assigned to a branch; GitBraid routes your
changes to the right worktree automatically, so every branch always contains exactly
the commits it should.

## Features

- **Branch stack** — maintain an ordered stack of branches where each layer builds
  on the one below. The workspace always reflects the cumulative top-of-stack state.
- **File assignment** — tag any file to a branch with a single command. Assigned
  files are decorated with the branch colour in the Explorer.
- **Hunk-level routing** — CodeLens above every diff hunk lets you direct individual
  hunks to different branches without leaving the editor.
- **Per-branch SCM** — each stacked branch gets its own Source Control entry with
  a dedicated commit message box and file list.
- **Rebase suggestions** — GitBraid watches for parent-branch advances and offers a
  one-click rebase to keep child branches up-to-date.
- **AI / chat integration** — seven VS Code language model tools (`mbc_getStack`,
  `mbc_assignFile`, `mbc_assignHunk`, `mbc_getFloatingFiles`, `mbc_commitBranch`,
  `mbc_getBranchStatus`, `mbc_addBranch`) let AI assistants interact with the stack
  programmatically.

## Quick Start

1. Open the **Getting Started** walkthrough (*Help → GitBraid: Get Started*).
2. Use **Add Branch to Stack** to create a stacked worktree branch.
3. Assign files or hunks to branches via the Explorer context menu or CodeLens.
4. Commit per-branch from the Source Control panel.

## Extension API

Other extensions can consume the GitBraid API:

```typescript
const ext = vscode.extensions.getExtension('nihobbs.gitbraid')
const api = await ext?.activate()
const stack = api?.getStack()         // BranchStackEntry[]
await api?.assignFile('src/foo.ts', 'feature/docs')
await api?.commitBranch('feature/docs', 'docs: update readme')
```

See [src/@types/MultiBranchCheckoutAPI.d.ts](src/@types/MultiBranchCheckoutAPI.d.ts)
for the full typed interface.

## Requirements

- VS Code ≥ 1.94.0
- Git ≥ 2.5 (for worktree support)

## 🔗 Links

* [GitHub - Microsoft/vscode - git extension](https://github.com/microsoft/vscode/blob/main/extensions/git/README.md)
