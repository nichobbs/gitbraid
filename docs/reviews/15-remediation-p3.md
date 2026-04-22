# P3 Remediation — Roadmap

**Target release:** 1.0 and beyond
**Goal:** features that go beyond parity with `PLAN.md`.

P3 items are not blocked by the release cycle; each warrants its own
ADR (architecture decision record) before implementation. Entries
below are deliberately terser than P0–P2 — treat them as briefs.

---

## RM-001: Conflict-recovery UI

**Source:** [08-missing-features.md](08-missing-features.md#stack-wide-conflict-recovery)
**Effort:** L

Provide first-class rebase conflict recovery:

- Detect a paused rebase inside a branch worktree.
- Surface the affected files in a dedicated "Rebase conflicts" SCM
  group.
- Context actions: `Continue rebase`, `Abort rebase`, `Skip commit`.
- A walkthrough card explaining the flow.

Dependencies: ARCH-002 (FileChangeBus), FEAT-004 (stack rebase).

---

## RM-002: Batch assign — folder → branch

**Source:** [08-missing-features.md](08-missing-features.md#assign-all-files-on-branch)
**Effort:** S–M

Context menu on a folder in the Explorer → "Assign subtree to branch…"
Walks the folder, calls `ConfigService.setAssignment` for each tracked
file. Shows a preview QuickPick with counts.

---

## RM-003: Undo stack for assignments / syncs / commits

**Source:** [08-missing-features.md](08-missing-features.md#undo)
**Effort:** M

Ring buffer (in memory) of reversible actions. Commands:
`gitbraid.undoLastAction`, `gitbraid.showActionHistory`. Commits are
undone via `git reset --soft HEAD^` scoped to the relevant worktree.

Risk: users will expect unlimited depth. Scope to the session and
document the limitation.

---

## RM-004: PR awareness integration

**Source:** [08-missing-features.md](08-missing-features.md#pr-awareness-plan-43)
**Effort:** M

Optional integration with `vscode.github-pullrequests`. When the
extension is present, surface PR status (open/draft/merged) as a
decoration on each `BranchNode`. Respect the existing
`gitbraid.prDecorationsEnabled` setting.

Guard the dependency: no hard extension dependency; feature-detect
via `vscode.extensions.getExtension('GitHub.vscode-pull-request-github')`.

---

## RM-005: Multi-root workspace support

**Source:** [02-bugs-and-correctness.md](02-bugs-and-correctness.md#workspace-root-assumptions-scattered-throughout)
**Effort:** L

Every service currently assumes `workspaceFolders[0]`. Design required:
- One stack per root, or one stack spanning roots?
- Where does `local-config.json` live in a multi-root world?
- Activity-bar view per root or aggregated?

Start with an ADR. Conservative approach: one stack **per** root, stored
in that root's `.worktrees/local-config.json`. The extension creates
multiple `BranchStackService` instances keyed by root URI.

---

## RM-006: Virtual workspace support

**Source:** [09-packaging-and-branding.md](09-packaging-and-branding.md#capabilities)
**Effort:** XL

Currently we declare unsupported in capabilities (PKG-003). To support
virtual workspaces the whole stack of services would need a
`vscode.workspace.fs`-only backend plus a non-local git runner (e.g.
the GitHub REST/GraphQL API for read). Unlikely to be worth it;
document the decision not to.

---

## RM-007: MCP server

**Source:** `PLAN.md §5.3`
**Effort:** L

Embed an MCP server inside the extension host so external AI clients
can drive it. Challenges:
- VS Code extension host process model — the server must survive
  extension reloads or advertise address-change handling to clients.
- Transport: stdio works only for a single client; prefer HTTP on a
  loopback port with token auth.
- Scope: read-only first release; write methods gated behind a
  confirmation prompt mirroring the LM-tools confirmations.

ADR required.

---

## RM-008: Exportable stack templates

**Source:** [08-missing-features.md](08-missing-features.md#export--import-stack)
**Effort:** M

A `.gitbraid/stack.yaml` file, **committed**, describing the default
stack layout for a repo. Different from `local-config.json` in that
it's team-shared. On first open, the extension offers to materialise
the template.

---

## RM-009: Keybindings + quick-pick command palette UX

**Source:** [09-packaging-and-branding.md](09-packaging-and-branding.md#keybindings)
**Effort:** S

Declare default keybindings for core operations
(`gitbraid.assignFile`, `gitbraid.routeHunks`,
`gitbraid.addStackBranch`). Consider adding a custom command
palette (`gitbraid.commands`) for power users.

---

## RM-010: Telemetry (opt-in)

**Effort:** M

Anonymous usage counters (commands invoked, stack size, error codes)
via the official `@vscode/extension-telemetry` package. Mandatory
opt-in prompt at first activation. Publish a privacy notice alongside.

Not in scope until 1.0 is published and we have real users.

---

## RM-011: Hot-reload of `local-config.json`

**Effort:** S

If a user hand-edits `local-config.json`, watch the file and reload
`ConfigService` in-place, firing the standard change events. Currently
the config is read once at activation.

---

## RM-012: Import existing stacked PR tooling

**Effort:** M

Interop with Graphite (`gt`), git-spr, git-stack, or similar. On
first run, detect their metadata (e.g. `~/.graphite` /
`refs/branch-stack/*`) and offer to import into `local-config.json`.

---

## Prioritisation within P3

When P0–P2 are complete, expected order of attack:

1. RM-001 (conflict recovery) — dovetails with FEAT-004.
2. RM-002 (batch assign) — tiny, high value.
3. RM-003 (undo) — safety net for mistakes.
4. RM-009 (keybindings) — trivial win.
5. RM-005 (multi-root) — unblocks enterprise-scale users.
6. RM-004 (PR awareness).
7. RM-008 (stack templates).
8. RM-011 (config hot-reload).
9. RM-012 (import from existing tooling).
10. RM-007 (MCP).
11. RM-010 (telemetry) — only after sizeable install base.
12. RM-006 (virtual workspaces) — probably never.
