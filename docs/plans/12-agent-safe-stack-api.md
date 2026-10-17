# Plan 12 - Agent-Safe Stack API

**Inspiration:** Anthropic's "Redesigning source control" write-up
(https://www.anthropic.com/engineering/redesigning-source-control):
when most clients are agents, they take whichever path is easiest, so
the API must enforce invariants and be the easiest path.

**Status:** **Not started.** Tracking issue: #36.

## Goal

Make the stack API layer the single place where stack invariants are
enforced, so the UI, the LM tools, the MCP server and any future CLI
(see plan 10) get identical protection. Give agents enough read data
over MCP that they never need to shell out to git inside `.worktrees/`.

## Rationale

- `src/mcpTools.ts` write tools only check `writeGate()` and then call
  the API. `removeBranch` forwards a caller-supplied `force`, so an
  agent can discard dirty worktrees or virtual-store content without the
  confirmation a human would get.
- There are no MCP read tools for per-file hunks, per-branch diffs or
  per-file ownership, so agents fall back to `git diff` in worktrees.
- `LmTools` (9 tools) and MCP (14 tools) are registered separately and
  have drifted.
- `ConfigService.reorderStack` silently ignores unknown names.

## Design

### Invariants module

New `src/stackInvariants.ts`: pure functions over a `ConfigService`
snapshot returning `{ ok: true } | { ok: false, code, message, hint }`.

| Code | Rule |
| --- | --- |
| `BRANCH_NOT_FOUND` | target branch is not in the stack |
| `BRANCH_MERGED` | target branch's PR is merged |
| `ASSIGN_PATH_ESCAPE` | path fails `pathGuard.requireInside` |
| `HUNK_STALE` | `hunkIndex` out of range for current hunks |
| `FORCE_REQUIRES_CONFIRMATION` | automated caller requested `force` |
| `STACK_CYCLE` | add or reorder would create a base cycle |
| `REORDER_INCOMPLETE` | `orderedNames` is not a permutation of the stack |

Checks run inside `GitBraidApiFacade`, not in tool handlers.

### Caller identity

Facade write methods take an optional `caller: 'ui' | 'lm' | 'mcp' | 'api'`
(default `'api'`).

- `force: true` from `lm` or `mcp` returns `FORCE_REQUIRES_CONFIRMATION`
  unless `gitbraid.agentAllowForce` is true (default false).
- The caller is recorded in the `PersistentUndoLog` entry detail and
  shown in the undo QuickPick.

### Structured errors

MCP errors return `structuredContent: { code, message, hint }` plus the
same JSON as text. `hint` names the sanctioned next call.

### New read tools

- `getFileOwnership(relativePath)`
- `getFileHunks(relativePath, { includePatch? })`
- `getBranchDiff(branch, { stat? })`, capped by `gitbraid.agentMaxDiffBytes`
  (default 200 KB) with a `truncated` flag
- `getUndoLog(limit)`

### One registry

`src/agentToolRegistry.ts`: table of `{ name, description, inputSchema,
kind, handler }`. `registerMcpTools` and `registerLmTools` both iterate
it. LM tool names keep the `gitbraid_` prefix.

## Surface

Settings: `gitbraid.agentAllowForce`, `gitbraid.agentMaxDiffBytes`.
New LM tool entries in `package.json` `languageModelTools`.

## Sequencing

1. `stackInvariants.ts` plus facade wiring (no tool changes).
2. Registry refactor with identical tool set (pure refactor).
3. Structured errors and `caller`.
4. New read tools.

Land after plan 15 if `getFileHunks` should benefit from the new cache.

## Tests

- One case per invariant code (`fakeGitRunner`).
- `force` gating on and off; write gate still blocks.
- Registry drift test: every tool exists in both MCP and LM.
- Integration: indices from `getFileHunks` are accepted by `assignHunk`.

## Open questions

- Should `rebaseBranch` also require confirmation for agent callers when
  the branch has been pushed?
- Does the MCP client need a version handshake for the structured error
  change?

## As built

- `src/agentToolRegistry.ts` is the single tool registry; `src/agentHost.ts` builds the per-call context (settings read live) and logs write calls to the output channel; `src/mcpTools.ts` and `src/lmTools.ts` are thin adapters. Parity tests compare the registry with the chat manifest in `package.json` and with the MCP tool listing.
- Invariants live in `GitBraidApi` (`src/stackInvariants.ts`), not the facade: UI commands call services directly and are not routed through them.
- Deviations from the plan: `BRANCH_MERGED` is not implemented (needs network PR state); caller identity is not threaded through the API, force policy is enforced in the tool layer via `ctx.allowForce`, and the audit trail is the output channel rather than the undo log; MCP gained `getStackDiagram`/`assignGlob`, chat gained `getStackStatus` and working `pullBranch`/`syncBranch`; each omission from a surface carries a stated reason.
