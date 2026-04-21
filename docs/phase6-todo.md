# Phase 6 — Polish & Hardening: Todo & Progress

**Goal**: Complete `package.json` manifest — declare all commands, add a proper
configuration schema, and wire a Getting Started walkthrough.

---

## Status Legend
- `[ ]` Not started
- `[~]` In progress
- `[x]` Complete

---

## 6.1 — New views (`package.json` → `contributes.views`)

- [x] `multi-branch-checkout.stackView` added to `scm` view container (alongside
      the existing `worktreeView`)

---

## 6.2 — Commands (`package.json` → `contributes.commands`)

New commands declared (previously implemented but undeclared):

- [x] `multi-branch-checkout.stackView.refresh` — Refresh Branch Stack
- [x] `multi-branch-checkout.focusStackView` — Focus Branch Stack View
- [x] `multi-branch-checkout.scm.commitBranch` — Commit Branch
- [x] `multi-branch-checkout.scm.refreshAll` — Refresh All SCM Providers
- [x] `multi-branch-checkout.assignFile` — Assign File to Branch
- [x] `multi-branch-checkout.unassignFile` — Unassign File from Branch
- [x] `multi-branch-checkout.addStackBranch` — Add Branch to Stack
- [x] `multi-branch-checkout.removeStackBranch` — Remove Branch from Stack
- [x] `multi-branch-checkout.routeHunks` — Route Hunks to Assigned Branches
- [x] `multi-branch-checkout.assignHunk` — Assign Hunk to Branch
- [x] `multi-branch-checkout.rebaseBranch` — Rebase Branch onto Parent

---

## 6.3 — Configuration (`package.json` → `contributes.configuration`)

Replaced empty array with typed settings object:

- [x] `multi-branch-checkout.syncDebounceMs` (number, default 200) — debounce for
      workspace-sync file-change events
- [x] `multi-branch-checkout.showFloatingWarningOnCommit` (boolean, default true) —
      warn when committing while floating files exist
- [x] `multi-branch-checkout.prDecorationsEnabled` (boolean, default true) — toggle
      branch-assignment colour decorations in the Explorer
- [x] `multi-branch-checkout.defaultBranchColor` (string, default `#4ec9b0`) — hex
      colour applied to newly added stack branches

---

## 6.4 — Walkthrough (`package.json` → `contributes.walkthroughs`)

Four-step Getting Started guide:

- [x] Step 1 — **Add a branch to the stack** → `addStackBranch` command
- [x] Step 2 — **Assign a file to a branch** → `assignFile` command
- [x] Step 3 — **Commit to a branch** → `scm.commitBranch` command
- [x] Step 4 — **Add another layer / Rebase** → `rebaseBranch` command

---

## Commit

- [x] Committed as `feat(phase6): new commands, settings, and walkthrough in package.json` (62bbd62)
