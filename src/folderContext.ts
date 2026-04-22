import * as vscode from 'vscode'
import { log } from './channelLogger'
import { ConfigService } from './configService'
import { BranchStackService } from './branchStackService'
import { WorkspaceSync } from './workspaceSync'
import { DiffEngine } from './diffEngine'
import { HunkRouter } from './hunkRouter'
import { StackResolver } from './stackResolver'
import { RebaseSuggestionService } from './rebaseSuggestionService'
import { GitBraidApi } from './gitBraidApi'
import { StackCommands } from './stackCommands'
import { RebaseRecovery } from './rebaseRecovery'
import { StackShareService } from './stackShareService'
import { BranchScmProviderManager } from './branchScmProvider'
import { UndoStack } from './undoStack'
import { FileChangeBus } from './fileChangeBus'

/**
 * All per-folder state for a single `vscode.WorkspaceFolder` that is a git
 * repository.  Multi-root workspaces get one `FolderContext` per eligible
 * folder, managed by {@link FolderRegistry} (see `folderRegistry.ts`).
 *
 * The three previously-singleton services — `ConfigService`,
 * `BranchStackService`, `WorkspaceSync` — are now per-folder.  Services
 * that are stateless or share a single process-wide resource
 * (`DiffEngine`, `HunkRouter`, the LM tool registry) can still live on
 * the extension host; they just need a folder argument.
 *
 * ## Lifecycle
 *
 * - **Construction** is synchronous and cheap — it just instantiates the
 *   services.  It does NOT load the config from disk or create worktrees.
 * - **`initialize()`** is async and does the full activation work: load
 *   `local-config.json`, create missing worktrees, wire rebase-recovery
 *   watchers, build the SCM provider.
 * - **`dispose()`** tears every service down in reverse order.  Idempotent.
 *
 * Tests that only need cheap in-memory state (no worktrees on disk) can
 * skip `initialize()` entirely and exercise individual services directly.
 */
export class FolderContext implements vscode.Disposable {

	readonly root: vscode.Uri
	readonly bus: FileChangeBus
	readonly config: ConfigService
	readonly branchStack: BranchStackService
	readonly workspaceSync: WorkspaceSync
	readonly diffEngine: DiffEngine
	readonly hunkRouter: HunkRouter
	readonly stackResolver: StackResolver
	readonly rebaseSvc: RebaseSuggestionService
	readonly stackCommands: StackCommands
	readonly rebaseRecovery: RebaseRecovery
	readonly stackShare: StackShareService
	readonly scmManager: BranchScmProviderManager
	readonly undoStack: UndoStack
	readonly api: GitBraidApi

	private _initialized = false
	private _disposed = false

	constructor(root: vscode.Uri) {
		this.root = root
		this.bus = new FileChangeBus(root)
		this.config = new ConfigService()
		this.branchStack = new BranchStackService(this.config)
		this.workspaceSync = new WorkspaceSync(this.config)
		this.diffEngine = new DiffEngine()
		this.hunkRouter = new HunkRouter(this.diffEngine)
		this.stackResolver = new StackResolver(this.config, this.branchStack)
		this.rebaseSvc = new RebaseSuggestionService(this.config, this.branchStack)
		this.stackCommands = new StackCommands(this.config, this.branchStack, this.rebaseSvc, root)
		this.rebaseRecovery = new RebaseRecovery()
		this.stackShare = new StackShareService(this.config, root)
		this.scmManager = new BranchScmProviderManager(this.config, this.workspaceSync, root)
		this.undoStack = new UndoStack()
		this.api = new GitBraidApi(this.config, this.branchStack, this.workspaceSync, root)
	}

	/**
	 * One-shot async bring-up.  Idempotent — the second call is a no-op.
	 */
	async initialize(): Promise<void> {
		if (this._initialized) return
		this._initialized = true
		log.info(`FolderContext: initialising for ${this.root.fsPath}`)

		await this.config.load(this.root)
		await this.branchStack.initStack(this.root)

		this.workspaceSync.init(this.root, this.bus)
		this.rebaseSvc.init(this.root)
		await this.scmManager.initialize()

		// Watch every stack worktree for mid-rebase state.
		const watchAll = () => {
			for (const entry of this.config.getStack()) {
				if (this.branchStack.worktreeExists(entry.name)) {
					this.rebaseRecovery.watch(this.branchStack.getWorktreePath(entry.name).fsPath)
				}
			}
		}
		watchAll()
		this.config.onDidChangeStack(() => watchAll())

		log.info(`FolderContext: initialised for ${this.root.fsPath}`)
	}

	dispose(): void {
		if (this._disposed) return
		this._disposed = true
		// Reverse construction order so dependents tear down before
		// dependencies.
		this.scmManager.dispose()
		this.rebaseRecovery.dispose()
		this.rebaseSvc.dispose()
		this.stackResolver.dispose()
		this.workspaceSync.dispose()
		this.branchStack.dispose()
		this.config.dispose()
		this.undoStack.dispose()
		this.bus.dispose()
	}
}
