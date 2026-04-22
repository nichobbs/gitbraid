# ADR 0001 — MCP server

- **Status**: Proposed.
- **Date**: 2026-04-22.
- **Relates to**: `docs/PLAN.md §5.3`, `docs/remediation/08-features-and-api.md`
  (LM tools), `src/lmTools.ts`.

## Context

`src/lmTools.ts` registers seven tools via `vscode.lm.registerTool(...)`
and declares them in `package.json:contributes.languageModelTools`.
Those tools drive the full write surface of the extension — `addBranch`,
`assignFile`, `assignHunk`, `commitBranch`, `getStack`, `getBranchStatus`,
`getFloatingFiles`.  They are reachable **only from inside VS Code's
Copilot Chat.**

Model Context Protocol (MCP) is Anthropic's transport for exposing tools
and resources to AI clients over stdio or HTTP/SSE.  Clients that can't
reach the LM tools today include Claude Desktop, Cursor, standalone
agents, and CLI automation.  The plan has flagged an MCP server as a
stretch goal since Phase 5; this ADR surfaces the decisions required
before committing to it.

## The questions we actually need to answer

### 1. Is there user demand we can point at?

The LM-tool surface covers the in-VS-Code story.  GitBraid's core
invariants — the Branch Stack tree, top-of-stack workspace resolution,
SCM panels — are tied to a running editor.  Worktree state lives on
disk and *could* be driven headlessly, but operations like "open
resolved content" or "pick a conflicted file to edit" don't make sense
without an editor attached.

Two user scenarios would justify MCP:

- **External agents driving bulk assignments.**  A GitHub Action or
  local CLI that reads a codeowners-style file and calls
  `assignFile(path, branch)` for every entry.  Plausible, and users
  have asked for import/export (T71) which is the same shape.
- **Claude Desktop / non-VS-Code editors.**  A developer who lives in
  Cursor but still wants per-branch stacking.  Valuable but demands we
  decouple GitBraid's value from VS Code's tree views — which we can't
  do without a full re-architecture.

**Verdict:** There's a realistic case for the first scenario.  The
second is a product decision that lies outside this ADR's scope.

### 2. Transport: stdio vs HTTP/SSE

- **stdio** — client spawns the server as a subprocess.  Simplest
  security story (process-local, no network listener).  Only one
  client at a time.
- **HTTP/SSE** — server listens on a port, multiple clients connect.
  Requires port management, auth, TLS in any shared environment.

We're a VS Code extension; the process is owned by VS Code.  That
makes stdio awkward — the client would have to spawn *our* server
somehow, but we're already running inside VS Code's extension host.
Two workable shapes:

- **A**: VS Code launches a child process on `gitbraid.startMcpServer`,
  and that child proxies back into the extension via a pipe.  Messy.
- **B**: The extension host itself listens on a local Unix socket (or
  named pipe on Windows) and speaks MCP over it.  Clients connect
  explicitly to the path.  Simple, OS-local, no network.
- **C**: The extension starts a loopback HTTP server on a random port
  and writes the port to a known file (`~/.gitbraid/mcp-port`).
  Clients read the file.  More moving parts than B.

**Recommendation:** **B — a local Unix/named-pipe listener.**  It
matches the security model of other in-editor services (VS Code's own
debug adapter protocol uses pipes) and sidesteps port collision on
shared hosts.

### 3. Security model

Exposing the write surface (commitBranch, assignFile, pushStack) to
*any* MCP client is a privilege-escalation surface.  Options:

- **(a) Workspace-trust gate only.**  Server won't start in an
  untrusted workspace.  Necessary but not sufficient — any local
  process can connect once the server is up.
- **(b) Per-session auth token.**  On first start, the extension
  generates a random token and shows it via a notification.  The user
  copies it into their MCP client config.  Connections that don't
  present the token are rejected.  Matches Anthropic's official MCP
  servers.
- **(c) Consent dialog per distinct tool.**  VS Code shows a modal
  the first time any tool is invoked; user can "allow for session"
  or "allow always".  High friction for bulk automation.
- **(d) Read-only mode.**  Server exposes only `getStack`,
  `getFloatingFiles`, `getBranchStatus`; writes stay VS-Code-only.
  Cuts 60% of the value but removes the biggest risk.

**Recommendation:** **(a) + (b) combined.**  Gate on workspace trust,
require a per-session token.  Ship the read-only mode from (d) as a
separate setting (`gitbraid.mcpWriteEnabled`, default false) so
cautious users get observability without exposing mutation.

### 4. Lifecycle

The server must not start implicitly on activation — that surprises
users and opens a listener they didn't consent to.  Explicit command:
`gitbraid.startMcpServer` toggles it; the status bar shows the state.
Deactivation closes the socket, drops the token.  Reload / window close
both need graceful teardown so the socket file isn't orphaned.

### 5. API surface

Start with a 1:1 mapping of the existing LM tools plus the gaps from
`08-features-and-api.md#language-model-tools`:

| Tool | In LM tools today? | Added by this ADR? |
| --- | --- | --- |
| `getStack` | Yes | — |
| `getFloatingFiles` | Yes | — |
| `getBranchStatus` | Yes | — |
| `getStackStatus` | — | Yes |
| `addBranch` | Yes | — |
| `removeBranch` | — | Yes |
| `reorderStack` | — | Yes |
| `assignFile` | Yes | — |
| `unassignFile` | — | Yes |
| `assignHunk` | Yes | — |
| `removeHunkAssignment` | — | Yes |
| `routeHunks` | — | Yes |
| `commitBranch` | Yes | — |
| `rebaseBranch` | — | Yes |
| `pushStack` / `syncStack` | — | (maybe; deferred) |

**Resources.** MCP has a first-class `resources` concept.  Obvious
candidate: `gitbraid-stack://<workspace-folder>/<relative-path>` as a
readable resource returning the top-of-stack view of a file.  That's
already implemented via the `StackContentProvider` (T12) — plumbing it
through MCP is mechanical.

Multi-root (ADR follow-up — see `src/folderRegistry.ts` once the
multi-root refactor lands) means every tool needs an optional folder
argument; the server defaults to the active folder.

### 6. Dependencies

`@modelcontextprotocol/sdk` (~150 KB) becomes the first non-trivial
runtime dependency.  Currently the extension has zero `dependencies`,
only `devDependencies`.  Acceptable cost if we commit to MCP; not
worth paying for a "maybe we'll use this" feature.

### 7. Discovery

How clients find the server:

- **Claude Desktop** reads
  `~/Library/Application Support/Claude/claude_desktop_config.json`.
  Needs a static path to spawn, not our dynamic socket.  So Claude
  Desktop would need a tiny helper CLI that reads the port/socket
  path from `~/.gitbraid/mcp-endpoint` and proxies.
- **Cursor / other MCP clients** — typically accept a custom command
  or URL.  Our socket path + token become a single config line.
- **CLI automation** — scripts can read `~/.gitbraid/mcp-endpoint`
  and the token from a well-known location.

Document the endpoint file shape in
`docs/mcp-integration.md` when the feature lands.

## Decision

**Proposed direction:**

1. **Opt-in** `gitbraid.startMcpServer` command.  Not started on
   activation.
2. **Local Unix socket / Windows named pipe** transport (no network
   listener).
3. **Auth**: random per-session token surfaced via notification;
   clients must present it.  Workspace-trust required.
4. **Read-only by default**; `gitbraid.mcpWriteEnabled` (false by
   default) gates mutation tools.
5. **1:1 LM tool mapping + the seven gaps** listed above.  Resources:
   `gitbraid-stack://` for top-of-stack file content.
6. **Single new runtime dep** (`@modelcontextprotocol/sdk`).

## Consequences

### Positive

- External AI clients can drive the full GitBraid surface, not just
  Copilot Chat.
- MCP resources complement the existing `gitbraid-stack:` URI scheme
  without duplicating the implementation.
- The read-only default means the feature ships with a safe story and
  users opt into write tools deliberately.

### Negative

- First non-trivial runtime dependency; adds ~150 KB to the bundle.
- Socket path + token lifecycle is an extra moving part in every
  packaging regression.
- External integrations (Claude Desktop) need a helper CLI for
  discovery, or users have to wire up the socket path manually —
  both are meaningful friction compared to the in-VS-Code story.

### Neutral

- Surface parity with LM tools means the code is largely "call the
  existing service" plumbing rather than new logic.

## Alternatives considered

- **HTTP/SSE transport on a random loopback port.**  Rejected:
  strictly more moving parts than a socket with no benefit for the
  "single local user" scenario.
- **Standalone CLI that invokes the exported API.**  Rejected for the
  first cut: requires VS Code to be running, and two deliverables
  (extension + CLI) is more to ship.  Could revisit if the read-only
  CLI shape proves popular.
- **Skip MCP entirely, document LM tools better.**  Viable if user
  demand doesn't materialise.  Worth re-evaluating in six months.

## Open questions for implementation

- Does `vscode.workspace.fs` work inside an MCP tool handler running
  on a non-VS-Code-originated stack frame?  Probably yes (it's
  provider-backed) but needs verification.
- What happens when two VS Code windows are open on the same repo and
  both try to start MCP servers?  Socket path collision.  Likely
  resolution: start-on-demand picks a per-process socket name
  (`gitbraid-mcp-<pid>`) and the endpoint file holds the active one.
- Logging — write MCP traffic to `log.debug` only or a separate
  channel?  Argument for a dedicated channel: chatty transport noise
  shouldn't crowd the main output.
