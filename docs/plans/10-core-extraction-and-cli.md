# Plan 10 — Core extraction & CLI feasibility

**Status:** Analysis. Not scheduled for implementation.

## Why we'd do it

Today GitBraid's logic lives inside a VS Code extension. Three growing use
cases want the same logic without VS Code:

1. **CI pipelines** — `gitbraid preview-routing` as a pre-submit check,
   `gitbraid submit-stack` from a release workflow, `gitbraid export` /
   `import` for fleet onboarding.
2. **External agents / MCP clients** — Claude Desktop, mcp-inspector, and
   custom orchestrators already talk to GitBraid via `src/mcpServer.ts`,
   but the server currently runs inside the extension host. An
   independent `gitbraid-mcp` process is cheaper to reason about and to
   distribute.
3. **Headless / non-VS-Code editors** — JetBrains, Zed, Neovim users keep
   asking. Porting the VS Code extension is multi-month; wrapping a
   shared core with a thin editor plug-in is not.

## Current coupling map

We audited every `src/*.ts` (excluding known UI files) for
`import … from 'vscode'`. Summary:

| Bucket | Count | Examples |
|---|---|---|
| **Trivially core-safe** (zero vscode) | 8 | `configTypes.ts`, `diffEngine.ts`, `errors.ts`, `gitIndex.ts`, `gitRunner.ts`, `globMatcher.ts`, `pathGuard.ts`, `persistentUndoLog.ts` |
| **Moderate** (Uri, workspace.fs, EventEmitter, Disposable) | ~18 | `configService.ts`, `branchStackService.ts`, `workspaceSync.ts`, `diffEngine.ts` (edges), `fileChangeBus.ts`, `folderContext.ts`, `folderRegistry.ts`, `gitBraidApi.ts`, `gitFunctions.ts`, `stackContentProvider.ts`, `stackPopulator.ts`, `undoStack.ts`, `utils.ts`, `workspaceSync.ts`, `channelLogger.ts`, `prHostAdapter.ts`, `commitListService.ts`, `prAwareness.ts` |
| **Heavy** (must stay in extension) | ~12 | `extension.ts`, `lmTools.ts`, `mcpServer.ts` (registration path), `stackDashboardView.ts`, `branchScmProvider.ts`, `branchStackTreeProvider.ts`, `fileDecorationProvider.ts`, `hunkCodeLensProvider.ts`, `hunkRouter.ts` (uses QuickPick), `stackCommands.ts` (withProgress), `commands/**`, `errorSurfacer.ts` |

So roughly **30 of 45 non-UI modules** already have minimal VS Code coupling.
The remaining friction is concentrated in a few boundary APIs:

### Top three friction points

1. **`vscode.Uri` vs. absolute paths** — used across `configService`,
   `branchStackService`, `workspaceSync`, `stackContentProvider`. The
   surface is wide but the semantics are thin: every callsite wants
   `.fsPath` back. Trivial to replace with a `string`-based `Path` type
   and an adapter that hydrates/dehydrates at the VS Code boundary.
2. **`vscode.EventEmitter` / `vscode.Event`** — the async event bus is
   everywhere. The Node `node:events` `EventEmitter` is a close analogue;
   a three-method shim (`emit / on / dispose`) keeps both environments
   happy.
3. **`vscode.workspace.fs` + `createFileSystemWatcher` + `RelativePattern`** —
   the only module that fundamentally needs a VS Code replacement is
   `fileChangeBus.ts`, because `chokidar` (or Node's `fs.watch`) have
   different semantics. Plan: put `fileChangeBus` behind an interface
   that the core takes as a dependency, with a `VSCodeFileWatcher` impl
   in the extension and a `ChokidarFileWatcher` impl in the CLI.

## Proposed package layout

```
gitbraid-core/        (pure, zero vscode imports)
  ├── config/          configService, configTypes, configMigration
  ├── git/             gitRunner, gitFunctions, gitIndex, diffEngine
  ├── stack/           branchStackService, stackPopulator, stackResolver
  ├── hunks/           hunkRouter, hunkAnchors
  ├── pr/              prHostAdapter (github, gitlab, bitbucket, null)
  ├── undo/            undoStack, persistentUndoLog
  └── interfaces/      FileWatcher, Clock, SecretsStore, Logger, TelemetrySink

gitbraid-vscode/       (the current extension, slimmed)
  └── adapts the interfaces to vscode.* APIs

gitbraid-cli/          (new)
  ├── bin/gitbraid.ts
  └── uses chokidar + process.env + dotenv + winston to satisfy interfaces

gitbraid-mcp/          (new, out-of-process twin of mcpServer.ts)
  └── wraps gitbraid-core behind the MCP transport
```

## Effort estimate

| Phase | Days | Notes |
|---|---|---|
| Extract interfaces (`FileWatcher`, `Clock`, `SecretsStore`, `Logger`, `TelemetrySink`) | 1 | Mostly name-finding; all four already have implicit shapes in code. |
| Move trivially-safe 8 files into `gitbraid-core` package (npm workspace) | 1 | Add a `tsconfig.base.json`, cross-package imports. |
| Refactor moderate-bucket files to take injected adapters instead of direct `vscode.*` | 4 | Largest phase; bulk is `configService`, `branchStackService`, `workspaceSync`, `fileChangeBus`. Every callsite change is mechanical but there are many. |
| Write VS Code adapter shims to keep the extension green | 1 | Tests act as the spec; regression risk is low if we preserve the call signatures. |
| Build `gitbraid-cli` — argument parsing, `chokidar` watcher, `keytar` secrets | 3 | Start with read-only commands (`stack`, `status`, `diagram`), then `preview-routing`, `submit`, `push`. |
| Spin `mcpServer` out of process | 1 | The MCP tool registrations are already declarative; the change is mostly build/packaging. |
| **Total** | **≈11 dev-days** | Plus buffer for shared-infra issues (publish flow, release tags, CI matrix). |

## Risk areas

- **`SecretStorage` for CLI** — VS Code has a first-class secrets API; CLI
  needs a platform-native fallback (`keytar` on macOS/Windows, libsecret on
  Linux) or a clear "env-var or fail" posture. Recommendation: env var by
  default, opt-in to keyring.
- **Watcher parity** — Our tests currently assume vscode's watcher
  semantics. `chokidar` is close but not identical (e.g. `add` events for
  pre-existing files on startup). The abstraction boundary has to absorb
  this.
- **Logger output channel** — `channelLogger.ts` logs to
  `window.createOutputChannel`. The CLI needs stderr/stdout or a file
  writer. Straightforward, but every `log.info` call flows through the
  same logger instance, so the swap has to happen once at startup.

## Recommendation

**Worth doing — but only after** the MCP server is heavily used. Today
MCP runs in-process inside the extension host; the real forcing function
is when an external agent wants to use GitBraid without VS Code running
at all. At that point the out-of-process MCP server motivates core
extraction naturally, and the CLI is ~2 extra days of mostly
argument-parsing work on top.

Don't extract prematurely. The current architecture is well-factored
enough that the extraction remains cheap — every new service that
follows the "constructor takes dependencies" pattern keeps the door open
without paying rent.
