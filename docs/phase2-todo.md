# Phase 2 — SCM Integration & UI: Todo & Progress

**Goal**: Per-branch SCM providers, Explorer file decorations, enhanced stack
tree view, status bar.

---

## Status Legend
- `[ ]` Not started
- `[~]` In progress
- `[x]` Complete
- `[!]` Blocked / difficulty — see notes

---

## 2.1 — File Decoration Provider (`src/fileDecorationProvider.ts`)

- [x] Implements `vscode.FileDecorationProvider`
- [x] Reads current assignments from `ConfigService`
- [x] Colours Explorer entries using the owning branch's `color` field
- [x] Floating/unassigned dirty files get a `?` badge and neutral colour
- [x] Tooltip shows branch name and assignment status
- [x] Listens to `ConfigService.onDidChangeAssignment` and fires decoration update
- [x] Listens to `WorkspaceSync.onDidFloatFile` and fires decoration update
- [x] Registered via `vscode.window.registerFileDecorationProvider`

---

## 2.2 — Per-Branch SCM Providers (`src/branchScmProvider.ts`)

- [x] One `vscode.SourceControl` instantiated per branch in the stack
- [x] Each provider has resource groups: `Changes`, `Staged Changes`
- [x] `Floating` resource group at top level for unassigned dirty files
- [x] Resource group population: run `git status --porcelain` in each worktree
- [x] Commit action on a provider: calls `git commit -m <message>` in worktree
- [x] Pre-commit: if floating files exist, show warning (not a block) listing them
- [x] Listens to `ConfigService.onDidChangeStack` — adds/removes providers when branches change
- [x] `dispose()` tears down all per-branch `SourceControl` instances

---

## 2.3 — Branch Stack Tree View (`src/branchStackTreeProvider.ts`)

- [x] `vscode.TreeDataProvider<StackTreeNode>` implementation
- [x] Top-level nodes: one per branch in stack order, plus a `Floating` node
- [x] Branch node shows branch name with colour icon; collapses to show files
- [x] File nodes under branch: files assigned to that branch
- [x] Floating node: files in `WorkspaceSync.getFloatingDirty()` with `⚠` icon
- [x] Right-click on file node → "Assign to branch" (opens QuickPick)
- [x] Right-click on branch node → "Remove from stack" action
- [x] Refreshes automatically on `ConfigService.onDidChangeAssignment` and `onDidChangeStack`
- [x] Registered as `multi-branch-checkout.stackView` view

---

## 2.4 — Status Bar Item

- [x] Shows floating file count: `$(warning) N unassigned`
- [x] Zero floating files: hidden (or shows a green check)
- [x] Click → focuses the stack tree view
- [x] Updates on `WorkspaceSync.onDidFloatFile`
- [x] Updates on `ConfigService.onDidChangeAssignment` (file assigned clears floating)

---

## 2.5 — "Assign File to Branch" Command (Explorer context)

- [x] `multi-branch-checkout.assignFile` already registered in Phase 1
- [ ] Add to Explorer context menu in `package.json` (`editor/context` and `explorer/context`)
- [ ] `multi-branch-checkout.unassignFile` in context menu too

---

## 2.6 — Bootstrap in `extension.ts`

- [x] Instantiate `FileDecorationProvider` and push to `context.subscriptions`
- [x] Instantiate `BranchStackTreeProvider`, register tree view, push to subscriptions
- [x] Instantiate `StatusBarManager`, push to subscriptions
- [x] Instantiate `BranchScmProviderManager`, push to subscriptions
- [x] Register tree-view-related commands (`stackView.refresh`, `stackView.assignFile`)

---

## 2.7 — Tests

### FileDecorationProvider tests (`test/fileDecorationProvider.test.ts`)
- [x] Assigned file returns correct colour and no badge
- [x] Floating file returns `?` badge
- [x] Untracked file returns `undefined` (no decoration)
- [x] Decoration updates when assignment changes (`onDidChangeAssignment`)

### BranchScmProvider tests (`test/branchScmProvider.test.ts`)
- [ ] Provider created for each stack branch
- [ ] Resource group populated from `git status` output
- [ ] Floating warning shown when floating files exist before commit
- [ ] Provider disposed and removed when branch removed from stack

### BranchStackTreeProvider tests (`test/branchStackTreeProvider.test.ts`)
- [x] Root children match stack branches + Floating node
- [x] File nodes appear under correct branch
- [x] Floating node contains floating dirty files
- [x] Tree refreshes on assignment change

---

## Commit Plan

| Commit | Contents |
|--------|----------|
| `feat: add FileDecorationProvider with per-branch colours` | `fileDecorationProvider.ts` + tests |
| `feat: add BranchScmProvider for per-branch SCM panels` | `branchScmProvider.ts` + tests |
| `feat: add stack tree view and status bar` | `branchStackTreeProvider.ts` + status bar + tests |
| `feat: wire Phase 2 UI services into extension activation` | updated `extension.ts`, `package.json` context menus |

---

## Known Gaps / Future Work

- Drag-and-drop file reassignment in the tree view deferred (requires
  `TreeDragAndDropController` — complex, low priority).
- SCM provider commit flow is basic: no amend, no interactive staging.
  Full staging UI deferred to Phase 3.
- `git status` polling inside `BranchScmProvider` is triggered on save events
  only; background fetch-triggered status updates not yet supported.
