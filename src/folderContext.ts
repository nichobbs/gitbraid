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
import { WorktreeHealthService } from './worktreeHealthService'
import { CheckpointService } from './checkpointService'
import { StackPopulator } from './stackPopulator'
import { StackedPRToolImporter } from './stackedPRToolImporter'
import { SubmitStackService } from './submitStackService'
import { PRHostAdapter, pickAdapter, NullPRHostAdapter } from './prHostAdapter'
import { PersistentUndoLog } from './persistentUndoLog'
import { CommitListService } from './commitListService'
import { VirtualBranchStore } from './virtualBranchStore'
import { ParallelWorkspaceService } from './parallelWorkspaceService'
import { HunkDecorationProvider } from './hunkDecorationProvider'
import * as path from 'node:path'

// `StackContentProvider` is deliberately NOT created here — it registers
// a `vscode.workspace.registerTextDocumentContentProvider(scheme, ...)`
// which is global to the extension host.  Activation wires up a single
// registry-aware instance; URIs carry a `?folder=` query that routes each
// request to the owning folder's `StackResolver`.

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
	readonly virtualStore: VirtualBranchStore
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
	readonly healthSvc: WorktreeHealthService
	readonly checkpoint: CheckpointService
	readonly stackPopulator: StackPopulator
	readonly stackedToolImporter: StackedPRToolImporter
	readonly undoLog: PersistentUndoLog
	readonly commitList: CommitListService
	readonly parallelWs: ParallelWorkspaceService
	readonly hunkDeco: HunkDecorationProvider
	/** PR host adapter — resolved lazily on first use so extension activation stays cheap. */
	private _prAdapter: PRHostAdapter | undefined
	private _secrets: vscode.SecretStorage | undefined

	private _initialized = false
	private _disposed = false
	/** Watches `.worktrees/local-config.json` for external edits. */
	private _configWatcher: vscode.FileSystemWatcher | undefined
	/** Composite disposable that covers the plan-11 root-ref advance watcher. */
	private _rootRefWatcher: vscode.Disposable | undefined
	/** Debounce handle for root-advances detection. */
	private _rootAdvanceTimer: ReturnType<typeof setTimeout> | undefined

	constructor(root: vscode.Uri) {
		this.root = root
		this.bus = new FileChangeBus(root)
		this.config = new ConfigService()
		this.virtualStore = new VirtualBranchStore()
		this.branchStack = new BranchStackService(this.config, this.virtualStore)
		this.workspaceSync = new WorkspaceSync(this.config, this.virtualStore)
		this.diffEngine = new DiffEngine()
		this.hunkRouter = new HunkRouter(this.diffEngine)
		this.stackResolver = new StackResolver(this.config, this.branchStack, undefined, this.virtualStore)
		this.rebaseRecovery = new RebaseRecovery()
		this.rebaseSvc = new RebaseSuggestionService(this.config, this.branchStack, undefined, this.rebaseRecovery)
		this.stackCommands = new StackCommands(this.config, this.branchStack, this.rebaseSvc, root)
		this.stackShare = new StackShareService(this.config, root)
		this.scmManager = new BranchScmProviderManager(this.config, this.workspaceSync, root)
		this.undoStack = new UndoStack()
		this.api = new GitBraidApi(this.config, this.branchStack, this.workspaceSync, root, undefined, this.hunkRouter)
		this.healthSvc = new WorktreeHealthService(this.config, this.branchStack, root)
		this.checkpoint = new CheckpointService(this.config, vscode.Uri.joinPath(root, '.worktrees'))
		this.stackPopulator = new StackPopulator(this.config)
		this.stackedToolImporter = new StackedPRToolImporter(this.config, root)
		this.undoLog = new PersistentUndoLog(path.join(root.fsPath, '.worktrees'))
		this.commitList = new CommitListService()
		this.parallelWs = new ParallelWorkspaceService(this.config, root.fsPath)
		this.hunkDeco = new HunkDecorationProvider(this.config, this.parallelWs)
	}

	/** Inject VS Code's `SecretStorage` (for the Octokit PR adapter). */
	setSecretStorage(secrets: vscode.SecretStorage): void {
		this._secrets = secrets
	}

	/**
	 * Resolve a PR host adapter for this folder.  Caches the result; call
	 * {@link invalidatePRAdapter} to force a rebuild (e.g. after the user
	 * changes `gitbraid.prHost`).
	 */
	async getPRAdapter(): Promise<PRHostAdapter> {
		if (this._prAdapter) return this._prAdapter
		const secrets = this._secrets
		if (!secrets) {
			this._prAdapter = new NullPRHostAdapter()
			return this._prAdapter
		}
		this._prAdapter = await pickAdapter(this.root.fsPath, secrets)
		log.info(`FolderContext: PR adapter → ${this._prAdapter.name} for ${this.root.fsPath}`)
		return this._prAdapter
	}

	invalidatePRAdapter(): void {
		this._prAdapter = undefined
	}

	/**
	 * Construct a `SubmitStackService` for this folder.  Fresh per call because
	 * the underlying adapter may change (setting flip, secret stored).
	 */
	async buildSubmitStackService(): Promise<SubmitStackService> {
		const adapter = await this.getPRAdapter()
		return new SubmitStackService(this.config, this.branchStack, this.root, adapter)
	}

	/**
	 * One-shot async bring-up.  Idempotent — the second call is a no-op.
	 */
	async initialize(): Promise<void> {
		if (this._initialized) return
		this._initialized = true
		log.info(`FolderContext: initialising for ${this.root.fsPath}`)

		await this.config.load(this.root)
		// Hydrate the virtual-branch store from `.worktrees/virtual/*.jsonl`
		// before any worktree work runs so a save-during-startup doesn't race
		// an un-seeded store.
		await this.virtualStore.load(this.root, this.config.getVirtualBranches())

		// Watch the config file for external edits (e.g. manually removing
		// stale assignments) and reload automatically.
		this._configWatcher = vscode.workspace.createFileSystemWatcher(
			new vscode.RelativePattern(this.root, '.worktrees/gitbraid-config.json'),
		)
		this._configWatcher.onDidChange(() => void this.config.reload())
		this._configWatcher.onDidCreate(() => void this.config.reload())
		await this.stackShare.detectAndOfferTemplate()
		await this.branchStack.initStack(this.root)

		// Phase 4 — ensure the _workspace integration worktree exists whenever
		// a root branch is configured.
		const rootOnInit = this.config.getRoot()
		if (rootOnInit) {
			this.branchStack.ensureWorkspaceWorktree(rootOnInit).catch((e: unknown) => {
				log.warn(`FolderContext: ensureWorkspaceWorktree failed: ${e instanceof Error ? e.message : String(e)}`)
			})
		}
		this.config.onDidChangeStack(() => {
			const newRoot = this.config.getRoot()
			if (newRoot) {
				void this.branchStack.ensureWorkspaceWorktree(newRoot).catch((e: unknown) => {
					log.warn(`FolderContext: ensureWorkspaceWorktree on stack change failed: ${e instanceof Error ? e.message : String(e)}`)
				})
			}
		})

		this.workspaceSync.init(this.root, this.bus)
		this.stackPopulator.init(this.root)
		this.rebaseSvc.init(this.root)
		await this.scmManager.initialize()
		await this.stackPopulator.seedFromStack()

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

		// Plan 06 — invalidate the commit-list cache whenever a worktree's
		// git index or a primary save changes, so the tree view's "Commits"
		// bucket reflects new / amended commits without a manual refresh.
		this.bus.onDidChangeWorktree(() => this.commitList.invalidate())
		this.bus.onDidSavePrimary(() => this.commitList.invalidate())

		// Plan 11 — initial parallel-workspace diff computation (best-effort;
		// no root set means no-op until the user runs addBranch or changeRootBranch).
		if (this.config.getRoot()) {
			this.parallelWs.refresh().catch((e: unknown) => {
				log.warn(`FolderContext: parallelWs.refresh failed: ${e instanceof Error ? e.message : String(e)}`)
			})
		}

		// Phase 5 — watch the root branch ref for advances (e.g. git pull).
		this._startRootRefWatcher()

		log.info(`FolderContext: initialised for ${this.root.fsPath}`)
	}

	// ── Phase 5: root-advances watcher ─────────────────────────────────────────

	/**
	 * Install file-system watchers on `.git/refs/heads/**` and
	 * `.git/packed-refs`.  When either fires and the configured root SHA has
	 * changed, advance the `_workspace` worktree and refresh the parallel-
	 * workspace diffs so decorations and overlap detection stay current.
	 *
	 * If no root is configured yet the method waits for the next
	 * `onDidChangeStack` event before arming the watchers.
	 */
	private _startRootRefWatcher(): void {
		if (this._rootRefWatcher) {
			this._rootRefWatcher.dispose()
			this._rootRefWatcher = undefined
		}
		if (!this.config.getRoot()) {
			// Arm once root is set.
			const sub = this.config.onDidChangeStack(() => {
				if (this.config.getRoot()) {
					sub.dispose()
					this._startRootRefWatcher()
				}
			})
			return
		}

		const refWatcher = vscode.workspace.createFileSystemWatcher(
			new vscode.RelativePattern(this.root, '.git/refs/heads/**'),
		)
		const packedWatcher = vscode.workspace.createFileSystemWatcher(
			new vscode.RelativePattern(this.root, '.git/packed-refs'),
		)

		const onRefChange = () => {
			clearTimeout(this._rootAdvanceTimer)
			this._rootAdvanceTimer = setTimeout(() => { void this._onRootMayHaveAdvanced() }, 500)
		}

		this._rootRefWatcher = vscode.Disposable.from(
			refWatcher,
			refWatcher.onDidChange(onRefChange),
			refWatcher.onDidCreate(onRefChange),
			packedWatcher,
			packedWatcher.onDidChange(onRefChange),
		)
	}

	/**
	 * Called (debounced) when any root ref file changes.  Recomputes all branch
	 * diffs; if new overlaps are detected surfaces a single notification with
	 * an action to open the overlap-resolution dialog.
	 */
	private async _onRootMayHaveAdvanced(): Promise<void> {
		const root = this.config.getRoot()
		if (!root) return

		// Update the _workspace worktree to the new root tip (noop if absent).
		await this.branchStack.advanceWorkspaceWorktree(root)

		const newOverlaps = await this.parallelWs.refresh().catch((e: unknown) => {
			log.warn(`FolderContext: root-advance refresh failed: ${e instanceof Error ? e.message : String(e)}`)
			return [] as import('./configTypes').OverlapResolution[]
		})

		if (newOverlaps.length === 0) return

		const label = newOverlaps.length === 1
			? '1 new overlap detected'
			: `${String(newOverlaps.length)} new overlaps detected`

		void vscode.window.showWarningMessage(
			`GitBraid: root branch "${root}" advanced \u2014 ${label}.`,
			'Review Overlaps',
		).then((choice) => {
			if (choice === 'Review Overlaps') {
				void vscode.commands.executeCommand('gitbraid.changeRootBranch')
			}
		})
	}

	dispose(): void {
		if (this._disposed) return
		this._disposed = true
		// Reverse construction order so dependents tear down before
		// dependencies.
		this.hunkDeco.dispose()
		this.parallelWs.dispose()
		this._rootRefWatcher?.dispose()
		clearTimeout(this._rootAdvanceTimer)
		this.scmManager.dispose()
		this.stackPopulator.dispose()
		this.rebaseRecovery.dispose()
		this.rebaseSvc.dispose()
		this.healthSvc.dispose()
		this.stackResolver.dispose()
		this.workspaceSync.dispose()
		this.branchStack.dispose()
		this.virtualStore.dispose()
		this.config.dispose()
		this.undoStack.dispose()
		this.bus.dispose()
		this._configWatcher?.dispose()
	}
}
