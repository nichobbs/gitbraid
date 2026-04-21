# UI / UX Remediation

User-visible polish. Most items are small but accumulate into an
extension that "feels" correct.

---

## T35. Fix `viewsWelcome` placeholder + welcome copy

**Files:** `package.json:views.scm` (welcome), any other
`viewsWelcome` strings
**Cross-ref:** `docs/reviews/05-ui-and-ux.md`,
`docs/reviews/10-priorities.md` quick wins.

### Fix

Replace `"This is welcome content!"` with:

```
No branches in your stack yet.
[Add Branch to Stack](command:gitbraid.addStackBranch)
[Open Walkthrough](command:workbench.action.openWalkthrough)
```

On the Branch Stack view provide a similar welcome that links to the
walkthrough when the stack is empty.

### Effort

¼ day.

---

## T36. Command-palette hygiene

**File:** `package.json:contributes.commands`
**Cross-ref:** `docs/reviews/05-ui-and-ux.md`.

### Fix

- Set `category: "GitBraid"` on every palette-visible command.
- Rename `"Multie Branch Checkout: Open file"` →
  `"GitBraid: Open File"`.
- Rename `"Compare with"` (category `other`) →
  `"GitBraid: Compare With…"`.
- Collapse the four refresh variants (`gitbraid.refresh`,
  `refreshView`, `stackView.refresh`, `scm.refreshAll`) into one
  `gitbraid.refresh` that refreshes every tree via the file-change
  bus. Remove the others from palette; keep them as internal ids
  only if anything still dispatches them.
- Fix `isPrumary` typo in the `when` clause; verify the `primary=true`
  context value matches in `worktreeNodes.ts:497`.

### Effort

½ day.

---

## T37. QuickPick flow polish for `addStackBranch`

**File:** `src/extension.ts:196-267`
**Cross-ref:** `docs/reviews/05-ui-and-ux.md` ("QuickPick flow").

### Fix

- Surface the "new branch" entry at the **top** with a `$(plus)` icon
  and description `"Create a new branch"`.
- Add kind-separated groups: `local`, `remote`, `new` using
  `QuickPickItemKind.Separator`.
- On `onDidHide` *without* accept, reject the outer promise as
  `user-cancelled`; do not default to `main`.
- Wrap `validateBranchName` errors in friendly copy:
  `"'${name}' is not a valid git branch name: ${reason}"`.
- Replace the double-dispose pattern with a single `dispose()` in
  `onDidHide`.

### Effort

½ day.

---

## T38. File decoration: use `ThemeColor`, add `badge`

**File:** `src/fileDecorationProvider.ts`
**Cross-ref:** `docs/reviews/05-ui-and-ux.md` ("File decorations").

### Fix

- Drop the hex → `charts.*` bucket. Accept any `ThemeColor` id and
  fall back to a stable hash-based palette that supports 16+ unique
  values.
- Generate a 1–2 character `badge` per branch (first two letters of
  the slug, with collisions suffixed by a digit).
- Honour `gitbraid.prDecorationsEnabled` — currently declared but
  ignored (see T39).
- Respect `gitbraid.defaultBranchColor` literally (today it
  silently bucketises).

### Effort

1 day.

---

## T39. Wire ignored user settings

**Files:** `src/fileDecorationProvider.ts`
(`prDecorationsEnabled`), `src/branchScmProvider.ts:242-253`
(`showFloatingWarningOnCommit`), `src/workspaceSync.ts:8`
(`syncDebounceMs`), `src/rebaseSuggestionService.ts:11`
(`rebaseCheckIntervalMinutes`, to be added)
**Cross-ref:** `docs/reviews/02-bugs-and-correctness.md`,
`docs/reviews/code-quality.md` Q8,
`docs/reviews/10-priorities.md` #17.

### Fix

- Add `ConfigService.getWorkspaceSetting<T>(key, default)` that
  reads from `vscode.workspace.getConfiguration('gitbraid')` and
  caches via `onDidChangeConfiguration`.
- Replace every `const DEBOUNCE_MS = 200` / `CHECK_INTERVAL_MS` with
  a lookup.
- Add `gitbraid.rebaseCheckIntervalMinutes` to `package.json`.
- Add `gitbraid.maxSyncFileSizeKb` (see T48).

### Effort

½ day.

---

## T40. Rebrand SCM groups and LM tool names

**Files:** `src/branchScmProvider.ts` (ids `mbc-*` → `gitbraid-*`,
titles `"MBC: "` → `"GitBraid: "`), `src/lmTools.ts`
(`mbc_*` → `gitbraid_*`), plus any `package.json` or test references
**Cross-ref:** `docs/reviews/05-ui-and-ux.md`,
`docs/reviews/09-packaging-and-branding.md`.

### Fix

Migrate in lock-step with the T15 manifest additions so tool names
match. Keep a deprecation shim that registers the old `mbc_*`
aliases for one release, emitting a warning when called.

### Effort

½ day.

---

## T41. Hide `FloatingStatusBarItem` when idle, codicon lock state

**Files:** `src/floatingStatusBarItem.ts`, `src/worktreeNodes.ts`
(emoji lock glyphs)
**Cross-ref:** `docs/reviews/05-ui-and-ux.md`,
`docs/reviews/10-priorities.md` quick wins.

### Fix

- Hide the status-bar item when `getStack().length === 0` **or**
  `count === 0`.
- Replace the `🔒`/`🔓` emoji with `$(lock)` / `$(unlock)` codicons
  so screen readers announce them sensibly.
- Localise the `"${count} file(s)"` string via `vscode.l10n.t`.

### Effort

¼ day.

---

## T42. CodeLens UX: separate "reassign" and "unassign" lenses

**File:** `src/hunkCodeLensProvider.ts`
**Cross-ref:** `docs/reviews/05-ui-and-ux.md` ("Hunk CodeLens UX"),
`docs/reviews/08-missing-features.md` ("Unassign hunk").

### Fix

Emit two lenses for an assigned hunk:

1. `$(git-branch) Hunk → feature/a` → opens reassign picker.
2. `$(trash) Unassign` → calls `removeHunkAssignment`.

Fix the containment check for `.worktrees` paths:

```ts
const rel = path.relative(wsRoot, document.uri.fsPath)
if (rel === '' || rel.split(path.sep).includes('.worktrees')) return []
```

### Effort

½ day.

---

## T43. Accessibility + i18n sweep

**Files:** various
**Cross-ref:** `docs/reviews/05-ui-and-ux.md` ("Accessibility").

### Fix

- Replace user-facing emoji with codicons (done in T41 — extend to
  any others).
- Wrap visible strings in `vscode.l10n.t(...)`. Commit a baseline
  `package.nls.json` so future translation is a data-only change.

### Effort

1 day.

---

## T44. Error surfacing standard

**Files:** everywhere `log.error` is the only user signal
**Cross-ref:** `docs/reviews/05-ui-and-ux.md` ("Error surfacing").

### Fix

Define a helper in `commandWrapper.ts` (T25):

```ts
export function showError (title: string, e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    void vscode.window.showErrorMessage(`${title}: ${msg}`, 'Open Output')
        .then(pick => { if (pick === 'Open Output') log.show() })
}
```

Use it for user-initiated failures (sync failure, rebase failure,
worktree add failure). Keep `log.error` for background / silent
paths.

### Effort

¼ day (helper) + distributed adoption.

---

## UI/UX exit criteria

- [ ] Every palette command shows under "GitBraid: ".
- [ ] Walkthrough renders fully.
- [ ] Drag-and-drop (T17) works for file reassignment and stack
      reorder.
- [ ] All user-facing settings actually take effect.
- [ ] Emoji removed from user-facing strings.
