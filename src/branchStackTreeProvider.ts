import * as vscode from 'vscode'
import * as path from 'node:path'
import { ConfigService } from './configService'
import { WorkspaceSync } from './workspaceSync'
import { BranchStackEntry } from './configTypes'
import type { PRAwareness } from './prAwareness'
import { codiconForState, stateLabel } from './prAwareness'
import type { WorktreeHealthService } from './worktreeHealthService'
import { git } from './gitFunctions'
import { worktreePath } from './branchStackService'
import type { CommitListService, CommitSummary } from './commitListService'

// ─── Tree node types ──────────────────────────────────────────────────────────

export type FileStatus = 'modified' | 'staged' | 'new' | 'committed'

export type StackTreeNode =
	| ProjectNode
	| BranchNode
	| FileNode
	| FileStatusGroupNode
	| FloatingGroupNode
	| FloatingFileNode
	| CommitGroupNode
	| CommitNode

/**
 * Root-level node representing the workspace folder (project).  Branch nodes
 * are shown as its children so the active folder name is visible at a glance.
 * Only created when a `rootUri` is supplied to the provider — omitted in
 * test contexts that construct the provider without a URI.
 */
export class ProjectNode extends vscode.TreeItem {
	readonly kind = 'project' as const
	constructor(public readonly rootUri: vscode.Uri) {
		const name = path.basename(rootUri.fsPath)
		super(name, vscode.TreeItemCollapsibleState.Expanded)
		this.contextValue = 'project'
		this.iconPath = new vscode.ThemeIcon('root-folder')
		this.tooltip = rootUri.fsPath
		this.resourceUri = rootUri
	}
}

/** A branch in the stack — top-level node. */
export class BranchNode extends vscode.TreeItem {
	readonly kind = 'branch' as const
	constructor(public readonly entry: BranchStackEntry) {
		super(entry.name, vscode.TreeItemCollapsibleState.Collapsed)
		this.contextValue = 'branch'
		this.iconPath = new vscode.ThemeIcon('git-branch')
		this.tooltip = `Branch: ${entry.name} (base: ${entry.base})`
		this.description = entry.base
	}
}

/** A scratch worktree node — parking area for files not to be committed. */
export class ScratchNode extends vscode.TreeItem {
	readonly kind = 'branch' as const
	constructor(public readonly entry: BranchStackEntry) {
		super(entry.name, vscode.TreeItemCollapsibleState.Collapsed)
		this.contextValue = 'scratchBranch'
		this.iconPath = new vscode.ThemeIcon('pinned')
		this.tooltip = `Scratch area: ${entry.name} — files parked here are not committed`
		this.description = 'scratch'
	}
}

/** A file assigned to a branch — child of BranchNode or FileStatusGroupNode. */
export class FileNode extends vscode.TreeItem {
	readonly kind = 'file' as const
	constructor(
		public readonly relativePath: string,
		public readonly branchName: string,
		/** When set, this node lives inside a status group rather than directly under the branch. */
		public readonly parentGroupStatus?: FileStatus,
	) {
		const label = relativePath.split('/').pop() ?? relativePath
		super(label, vscode.TreeItemCollapsibleState.None)
		this.contextValue = 'assignedFile'
		this.description = relativePath
		this.tooltip = `${relativePath} → ${branchName}`
		this.iconPath = vscode.ThemeIcon.File
		// Do NOT set resourceUri — that would cause the branch badge from
		// FileDecorationProvider to appear here (redundant since files are
		// already grouped under their branch node).
		const fileUri = vscode.workspace.workspaceFolders?.[0]
			? vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, relativePath)
			: undefined
		this.command = fileUri
			? { command: 'vscode.open', title: 'Open', arguments: [fileUri] }
			: undefined
	}
}

/** A status-category group under a BranchNode (Modified / Staged / New / Committed). */
export class FileStatusGroupNode extends vscode.TreeItem {
	readonly kind = 'fileStatusGroup' as const

	private static readonly _labels: Record<FileStatus, string> = {
		modified: 'Modified',
		staged: 'Staged',
		new: 'New',
		committed: 'Committed',
	}
	private static readonly _icons: Record<FileStatus, string> = {
		modified: 'diff-modified',
		staged: 'diff-added',
		new: 'diff-added',
		committed: 'check',
	}

	constructor(
		public readonly status: FileStatus,
		public readonly branchName: string,
		public readonly files: readonly string[],
	) {
		super(FileStatusGroupNode._labels[status], vscode.TreeItemCollapsibleState.Expanded)
		this.contextValue = 'fileStatusGroup'
		this.description = String(files.length)
		this.iconPath = new vscode.ThemeIcon(FileStatusGroupNode._icons[status])
	}
}

/**
 * The current checkout branch — shown at the top of the stack tree if it is
 * not already a managed stack entry.  Files can be assigned to it; no worktree
 * sync occurs (they stay in the primary workspace).
 */
export class CurrentBranchNode extends BranchNode {
	constructor(name: string) {
		super({ name, color: '', order: 0, base: '' })
		this.description = '(current)'
		this.iconPath = new vscode.ThemeIcon('folder-active')
		this.tooltip = `Current branch: ${name} — files stay in the workspace`
		this.contextValue = 'currentBranch'
	}
}

/**
 * Plan 06 — a collapsible "Commits" bucket under each BranchNode that
 * lists the commits unique to that branch vs its parent.  Acts only as a
 * grouping container: children are rendered by the provider via
 * {@link CommitListService.listCommits}.
 */
export class CommitGroupNode extends vscode.TreeItem {
	readonly kind = 'commitGroup' as const
	constructor(
		public readonly branchName: string,
		public readonly base: string,
		public readonly worktreeDir: string,
		count: number,
	) {
		super('Commits', vscode.TreeItemCollapsibleState.Collapsed)
		this.contextValue = 'commitGroup'
		this.iconPath = new vscode.ThemeIcon('git-commit')
		this.description = count > 0 ? `${String(count)}` : undefined
		this.tooltip = `${String(count)} commit(s) on ${branchName} ahead of ${base}`
	}
}

/**
 * A single commit shown under a {@link CommitGroupNode}.  Clicking opens a
 * read-only editor with `git show --patch <sha>` output via the
 * `gitbraid-commit:` content provider.
 */
export class CommitNode extends vscode.TreeItem {
	readonly kind = 'commit' as const
	constructor(
		public readonly summary: CommitSummary,
		public readonly branchName: string,
		public readonly worktreeDir: string,
	) {
		super(summary.shortSha, vscode.TreeItemCollapsibleState.None)
		this.contextValue = 'commit'
		this.iconPath = new vscode.ThemeIcon('git-commit')
		this.description = summary.subject
		const date = summary.date.toLocaleString()
		this.tooltip = new vscode.MarkdownString(
			`**${summary.shortSha}** · ${date}\n\n${summary.subject}\n\n*by ${summary.author}*`,
		)
		// Delegate to a command — the content provider lives in the
		// extension host, so we can't give the tree item an openable URI
		// directly (the scheme isn't registered in sub-contexts).
		this.command = {
			command: 'gitbraid.showCommit',
			title: 'Show commit',
			arguments: [{ sha: summary.sha, worktreeDir, branch: branchName }],
		}
	}
}

/** The "Floating (unassigned)" group node — always last. */
export class FloatingGroupNode extends vscode.TreeItem {
	readonly kind = 'floatingGroup' as const
	constructor(count: number) {
		super('Floating (unassigned)', vscode.TreeItemCollapsibleState.Expanded)
		this.contextValue = 'floatingGroup'
		this.iconPath = new vscode.ThemeIcon('warning')
		this.description = count > 0 ? `${count} file(s)` : undefined
	}
}

/** A floating file — child of FloatingGroupNode. */
export class FloatingFileNode extends vscode.TreeItem {
	readonly kind = 'floatingFile' as const
	constructor(
		public readonly relativePath: string,
		floatingSince?: number,
	) {
		const label = relativePath.split('/').pop() ?? relativePath
		super(label, vscode.TreeItemCollapsibleState.None)
		this.contextValue = 'floatingFile'
		this.description = relativePath
		this.resourceUri = vscode.workspace.workspaceFolders?.[0]
			? vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, relativePath)
			: undefined
		this.command = this.resourceUri
			? { command: 'vscode.open', title: 'Open', arguments: [this.resourceUri] }
			: undefined

		const { icon, tooltip } = _floatingAgeDecoration(relativePath, floatingSince)
		this.iconPath = icon
		this.tooltip = tooltip
	}
}

function _floatingAgeDecoration(
	relativePath: string,
	floatingSince: number | undefined,
): { icon: vscode.ThemeIcon, tooltip: string } {
	const base = `${relativePath} — not yet assigned to a branch`
	if (floatingSince === undefined) {
		return { icon: new vscode.ThemeIcon('question'), tooltip: base }
	}
	const elapsed = Date.now() - floatingSince
	const HOUR = 60 * 60 * 1000
	const DAY = 24 * HOUR
	if (elapsed < HOUR) {
		return { icon: new vscode.ThemeIcon('question'), tooltip: `${base}\nFloating for less than an hour` }
	}
	if (elapsed < DAY) {
		const h = Math.round(elapsed / HOUR)
		return {
			icon: new vscode.ThemeIcon('question', new vscode.ThemeColor('editorWarning.foreground')),
			tooltip: `${base}\nFloating for ${h} hour${h !== 1 ? 's' : ''}`,
		}
	}
	const days = Math.round(elapsed / DAY)
	if (elapsed < 7 * DAY) {
		return {
			icon: new vscode.ThemeIcon('question', new vscode.ThemeColor('list.warningForeground')),
			tooltip: `${base}\nFloating for ${days} day${days !== 1 ? 's' : ''}`,
		}
	}
	return {
		icon: new vscode.ThemeIcon('question', new vscode.ThemeColor('editorError.foreground')),
		tooltip: `${base}\nFloating for ${days} day${days !== 1 ? 's' : ''}`,
	}
}

/**
 * Map a two-character porcelain XY code to a `FileStatus` category.
 * `undefined` means the file is not in the status output → it is clean.
 */
function _categorizeXY(xy: string | undefined): FileStatus {
	if (xy === undefined) return 'committed'
	const x = xy[0]
	const y = xy[1]
	if (x === '?' && y === '?') return 'new'
	if (x !== ' ' && x !== '?' && (y === ' ' || y === undefined)) return 'staged'
	return 'modified'
}

// ─── Tree data provider ───────────────────────────────────────────────────────

/**
 * Drives the "Branch Stack" tree view (`gitbraid.stackView`).
 *
 * Tree structure:
 * ```
 * ▼ feature/docs
 *     README.md
 *     src/foo.ts
 * ▼ feature/impl
 *     src/bar.ts
 * ▼ Floating (unassigned)
 *     src/config.ts  ⚠
 * ```
 */
const INTERNAL_MIME = 'application/vnd.code.tree.gitbraidStack'
const URI_LIST_MIME = 'text/uri-list'

export class BranchStackTreeProvider
	implements vscode.TreeDataProvider<StackTreeNode>,
		vscode.TreeDragAndDropController<StackTreeNode>,
		vscode.Disposable {

	private readonly _onDidChangeTreeData = new vscode.EventEmitter<StackTreeNode | undefined>()
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event

	// TreeDragAndDropController contract
	readonly dropMimeTypes: readonly string[] = [INTERNAL_MIME, URI_LIST_MIME]
	readonly dragMimeTypes: readonly string[] = [INTERNAL_MIME, URI_LIST_MIME]

	private readonly _disposables: vscode.Disposable[] = []
	/**
	 * Event subscriptions scoped to the current folder context.  On
	 * `setContext(...)` these get torn down and re-created against the new
	 * context's services so the tree reflects the active folder's state.
	 */
	private _contextDisposables: vscode.Disposable[] = []

	private _config: ConfigService
	private _sync: WorkspaceSync
	private _rootUri: vscode.Uri | undefined
	private _healthSvc: WorktreeHealthService | undefined
	private _healthDisposable: vscode.Disposable | undefined

	/** The currently checked-out branch name; refreshed on HEAD change. */
	private _currentBranch: string | undefined = undefined

	/**
	 * Cache of git-status groups per branch, populated during `_getBranchChildren`.
	 * Keyed by branch name. Cleared on every `refresh()` so it stays current.
	 */
	private readonly _statusCache = new Map<string, { staged: string[], modified: string[], new: string[], committed: string[] }>()

	constructor(
		config: ConfigService,
		sync: WorkspaceSync,
		private readonly _onAssign?: (rel: string, newBranch: string, previous: string | undefined) => void,
		private readonly _onUnassign?: (rel: string, previous: string) => void,
		private readonly _prAwareness?: PRAwareness,
		rootUri?: vscode.Uri,
		healthSvc?: WorktreeHealthService,
		private readonly _commitList?: CommitListService,
	) {
		this._config = config
		this._sync = sync
		this._rootUri = rootUri
		this._setHealthSvc(healthSvc)
		this._wireContext()

		if (_prAwareness) {
			this._disposables.push(_prAwareness.onDidChange(() => this.refresh()))
		}
	}

	private _setHealthSvc(healthSvc: WorktreeHealthService | undefined): void {
		this._healthDisposable?.dispose()
		this._healthDisposable = undefined
		this._healthSvc = healthSvc
		if (healthSvc) {
			this._healthDisposable = healthSvc.onDidChange(() => this.refresh())
		}
	}

	/** Expose the currently-bound config — used by `_onAssign` closures. */
	get config(): ConfigService { return this._config }

	/**
	 * Swap the bound context.  Used by the extension activation to follow
	 * the active folder in multi-root workspaces (multi-root phase 2).
	 * Idempotent — passing the same services is a no-op.
	 *
	 * The `root` parameter is optional for back-compat; when omitted, the
	 * previously-bound root is retained.  Production callers should pass the
	 * new folder's root so the HEAD watcher + `git.branch` lookup follow the
	 * active folder.
	 */
	setContext(config: ConfigService, sync: WorkspaceSync, rootUri?: vscode.Uri, healthSvc?: WorktreeHealthService): void {
		const nextRoot = rootUri ?? this._rootUri
		const rootUnchanged = nextRoot === this._rootUri
			|| (nextRoot !== undefined && this._rootUri !== undefined && nextRoot.fsPath === this._rootUri.fsPath)
		if (config === this._config && sync === this._sync && rootUnchanged && healthSvc === this._healthSvc) return
		for (const d of this._contextDisposables) d.dispose()
		this._contextDisposables = []
		this._config = config
		this._sync = sync
		this._rootUri = nextRoot
		this._setHealthSvc(healthSvc)
		this._wireContext()
		this.refresh()
	}

	private _wireContext(): void {
		this._contextDisposables.push(
			this._config.onDidChangeAssignment(() => this.refresh()),
			this._config.onDidChangeStack(() => void this._refreshCurrentBranch().then(() => this.refresh())),
			this._sync.onDidFloatFile(() => this.refresh()),
			this._sync.onDidSyncFile(() => this.refresh()),
		)

		// Per-folder `.git/HEAD` watcher — rebuilt when `setContext(...)`
		// swaps the root so branch switches in the active folder drive the
		// tree's CurrentBranchNode, even in multi-root workspaces.  Test
		// contexts that construct the provider without a root skip this.
		if (this._rootUri) {
			const headWatcher = vscode.workspace.createFileSystemWatcher(
				new vscode.RelativePattern(this._rootUri, '.git/HEAD'),
			)
			this._contextDisposables.push(
				headWatcher,
				headWatcher.onDidChange(() => void this._refreshCurrentBranch().then(() => this.refresh())),
			)
		}
		// Seed the cache for the newly bound root before the first render.
		void this._refreshCurrentBranch()
	}

	// ── Drag & drop ───────────────────────────────────────────────────────────

	async handleDrag(
		source: readonly StackTreeNode[],
		dataTransfer: vscode.DataTransfer,
	): Promise<void> {
		// Only file nodes are draggable; branches are handled separately as reorders.
		const payload = source
			.map((n) => {
				if (n.kind === 'file') return { kind: 'file', relativePath: n.relativePath }
				if (n.kind === 'floatingFile') return { kind: 'file', relativePath: n.relativePath }
				if (n.kind === 'branch') return { kind: 'branch', name: n.entry.name }
				return undefined
			})
			.filter((x): x is { kind: string, relativePath?: string, name?: string } => x !== undefined)
		dataTransfer.set(INTERNAL_MIME, new vscode.DataTransferItem(JSON.stringify(payload)))
	}

	async handleDrop(
		target: StackTreeNode | undefined,
		dataTransfer: vscode.DataTransfer,
	): Promise<void> {
		// 1. Internal payload — file or branch move inside the stack tree.
		const internal = dataTransfer.get(INTERNAL_MIME)
		if (internal) {
			let payload: Array<{ kind: string, relativePath?: string, name?: string }>
			try {
				payload = JSON.parse(await internal.asString()) as typeof payload
			} catch {
				return
			}
			await this._applyInternalDrop(payload, target)
			return
		}

		// 2. External drop — e.g. a file from the Explorer (text/uri-list).
		const uriList = dataTransfer.get(URI_LIST_MIME)
		if (uriList && target) {
			const raw = await uriList.asString()
			const uris = raw.split(/\r?\n/).filter(Boolean).map((s) => {
				try { return vscode.Uri.parse(s) } catch { return undefined }
			}).filter((u): u is vscode.Uri => u !== undefined)
			const targetBranch = target.kind === 'branch' ? target.entry.name : undefined
			if (!targetBranch) return
			const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri
			if (!wsRoot) return
			for (const u of uris) {
				const rel = vscode.workspace.asRelativePath(u, false)
				if (rel.startsWith('.worktrees/')) continue
				const previous = this._config.getAssignment(rel)
				await this._config.setAssignment(rel, targetBranch)
				this._onAssign?.(rel, targetBranch, previous)
			}
		}
	}

	private async _applyInternalDrop(
		payload: Array<{ kind: string, relativePath?: string, name?: string }>,
		target: StackTreeNode | undefined,
	): Promise<void> {
		// Branch-onto-branch drops → reorder the stack.
		const branchDrags = payload.filter((p) => p.kind === 'branch' && p.name)
		if (branchDrags.length > 0 && target?.kind === 'branch') {
			const current = this._config.getStack().map((e) => e.name)
			const moved = branchDrags[0].name!
			const targetName = target.entry.name
			// Skip if either the dragged or target branch is not a managed stack entry
			// (e.g. the CurrentBranchNode which is shown but not in the stack config).
			if (!current.includes(moved) || !current.includes(targetName)) return
			const without = current.filter((n) => n !== moved)
			const insertAt = without.indexOf(targetName)
			if (insertAt < 0) return
			without.splice(insertAt, 0, moved)
			await this._config.reorderStack(without)
			return
		}

		// File drags → reassign to the target branch, or unassign if dropped on
		// the floating group.
		const fileDrags = payload.filter((p) => p.kind === 'file' && p.relativePath)
		if (fileDrags.length === 0) return

		if (target?.kind === 'branch') {
			for (const fd of fileDrags) {
				const rel = fd.relativePath!
				const previous = this._config.getAssignment(rel)
				await this._config.setAssignment(rel, target.entry.name)
				this._onAssign?.(rel, target.entry.name, previous)
			}
		} else if (target?.kind === 'floatingGroup' || target === undefined) {
			for (const fd of fileDrags) {
				const rel = fd.relativePath!
				const previous = this._config.getAssignment(rel)
				await this._config.removeAssignment(rel)
				if (previous !== undefined) {
					this._onUnassign?.(rel, previous)
				}
			}
		}
	}

	/** Fetches the current branch name from git and caches it. */
	private async _refreshCurrentBranch(): Promise<void> {
		try {
			this._currentBranch = await git.branch(this._rootUri)
		} catch {
			this._currentBranch = undefined
		}
	}

	refresh(node?: StackTreeNode): void {
		// Clear the status cache so the next getChildren call re-runs git status
		if (!node) this._statusCache.clear()
		this._onDidChangeTreeData.fire(node)
	}

	getTreeItem(element: StackTreeNode): vscode.TreeItem {
		if (element.kind === 'project') return element
		if (element.kind === 'branch') {
			// ── Health dashboard ────────────────────────────────────────────────
			if (this._healthSvc) {
				const health = this._healthSvc.getHealth(element.entry.name)
				if (health) {
					const indicators: string[] = []
					if (health.aheadCount > 0) indicators.push(`↑${String(health.aheadCount)}`)
					if (health.behindCount > 0) indicators.push(`↓${String(health.behindCount)}`)
					if (health.dirty) indicators.push('⦿')
					const healthStr = indicators.join(' ')
					const base = element.entry.base
					element.description = healthStr ? `${base}  ${healthStr}` : base

					if (health.rebasing) {
						element.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('editorWarning.foreground'))
						const tip = typeof element.tooltip === 'string' ? element.tooltip : `Branch: ${element.entry.name} (base: ${element.entry.base})`
						element.tooltip = `${tip}\n⚠ Rebase in progress`
					}
				}
			}

			// ── PR awareness ────────────────────────────────────────────────────
			if (this._prAwareness) {
				const info = this._prAwareness.getForBranch(element.entry.name)
				if (info) {
					const icon = `$(${codiconForState(info.state)})`
					const existing = typeof element.description === 'string' ? element.description : ''
					element.description = existing ? `${icon} ${existing}` : icon
					const baseTooltip = typeof element.tooltip === 'string' ? element.tooltip : `Branch: ${element.entry.name} (base: ${element.entry.base})`
					element.tooltip = `${baseTooltip}\n${stateLabel(info.state)} #${String(info.number)} — ${info.title}`
				}
			}
		}
		return element
	}

	getChildren(element?: StackTreeNode): vscode.ProviderResult<StackTreeNode[]> {
		if (!element) {
			// When a rootUri is set, the root level contains a single ProjectNode;
			// branches and the floating group are its children.  Without a rootUri
			// the flat list is returned directly (backwards-compatible for tests).
			if (this._rootUri) {
				return [new ProjectNode(this._rootUri)]
			}
			return this._branchChildren()
		}

		if (element.kind === 'project') {
			return this._branchChildren()
		}

		if (element.kind === 'branch') {
			return this._getBranchChildren(element)
		}

		if (element.kind === 'fileStatusGroup') {
			return element.files.map((rel) => new FileNode(rel, element.branchName, element.status))
		}

		if (element.kind === 'floatingGroup') {
			return this._sync.getFloatingDirty().map((rel) => new FloatingFileNode(rel, this._sync.getFloatingSince(rel)))
		}

		if (element.kind === 'commitGroup') {
			if (!this._commitList) return []
			const entry = this._config.getBranch(element.branchName)
			if (!entry) return []
			return this._commitList
				.listCommits(element.worktreeDir, element.branchName, element.base)
				.then((commits) => commits.map((c) => new CommitNode(c, element.branchName, element.worktreeDir)))
		}

		return []
	}

	/**
	 * Resolve the git working-tree directory for `element`.
	 * - CurrentBranchNode (files live in main workspace) → `_rootUri`
	 * - All other managed branches → their worktree under `.worktrees/`
	 * Returns undefined when no rootUri is set (e.g. test contexts).
	 */
	private _getWorktreeCwd(element: BranchNode): vscode.Uri | undefined {
		if (!this._rootUri) return undefined
		if (element.contextValue === 'currentBranch') return this._rootUri
		return worktreePath(this._rootUri, element.entry.name)
	}

	/**
	 * Returns the file children for a branch node.  When a rootUri is
	 * available the list is enriched with git-status groups and ignored files
	 * are filtered out.  Falls back to a plain sorted file list when git is
	 * unavailable or the worktree doesn't exist yet.
	 */
	private _getBranchChildren(element: BranchNode): vscode.ProviderResult<StackTreeNode[]> {
		const branchName = element.entry.name
		const assignments = this._config.getAllAssignments()
		let assigned = Object.entries(assignments)
			.filter(([, b]) => b === branchName)
			.map(([rel]) => rel)
			.sort((a, b) => a.localeCompare(b))

		const cwd = this._getWorktreeCwd(element)

		// Plan 06 — when we have a worktree and a CommitListService wired in,
		// prepend a "Commits" bucket listing commits unique to this branch.
		// Only consult the service for *managed* stack branches (the
		// current-branch pseudo-entry has no base and is skipped).
		const commitGroupP = (async (): Promise<CommitGroupNode | undefined> => {
			if (!cwd || !this._commitList) return undefined
			if (element.contextValue === 'currentBranch') return undefined
			const base = element.entry.base
			if (!base) return undefined
			try {
				const commits = await this._commitList.listCommits(cwd.fsPath, branchName, base)
				if (commits.length === 0) return undefined
				return new CommitGroupNode(branchName, base, cwd.fsPath, commits.length)
			} catch {
				return undefined
			}
		})()

		if (assigned.length === 0) {
			return commitGroupP.then((grp) => grp ? [grp] : [])
		}

		if (!cwd) {
			// No rootUri (test context) — return flat list without grouping
			return assigned.map((rel) => new FileNode(rel, branchName))
		}

		return Promise.all([commitGroupP, git.statusPorcelain(cwd)]).then(([grp, statusMap]) => {
			// Filter out git-ignored files
			assigned = assigned.filter((rel) => statusMap.get(rel) !== '!!')
			const children: StackTreeNode[] = grp ? [grp] : []
			if (assigned.length === 0) return children
			return [...children, ...this._groupByStatus(branchName, assigned, statusMap)]
		})
	}

	/**
	 * Group a list of relative paths by their porcelain git status and return
	 * the appropriate tree nodes.  Populates `_statusCache` as a side-effect
	 * so that `getParent` can reconstruct group nodes without re-running git.
	 * When all files share the same status the group wrapper is omitted and
	 * FileNode items are returned directly (avoids single-item nesting).
	 */
	private _groupByStatus(
		branchName: string,
		assigned: string[],
		statusMap: Map<string, string>,
	): StackTreeNode[] {
		const grouped = { staged: [] as string[], modified: [] as string[], new: [] as string[], committed: [] as string[] }
		for (const rel of assigned) {
			grouped[_categorizeXY(statusMap.get(rel))].push(rel)
		}
		this._statusCache.set(branchName, grouped)

		const statuses: FileStatus[] = ['modified', 'staged', 'new', 'committed']
		const nonEmpty = statuses.filter((s) => grouped[s].length > 0)
		if (nonEmpty.length <= 1) {
			return assigned.map((rel) => new FileNode(rel, branchName))
		}
		return nonEmpty.map((s) => new FileStatusGroupNode(s, branchName, grouped[s]))
	}

	/**
	 * Returns the children of the project/root node: the active branch first
	 * (if it is not already a managed stack entry), then managed stack branches	 * sorted alphabetically, then the floating group at the end.
	 */
	private _branchChildren(): StackTreeNode[] {
		const stack = this._config.getStack()
		const floating = this._sync.getFloatingDirty()
		const nodes: StackTreeNode[] = []
		// Active checkout branch — shown first when not already in the managed stack.
		if (this._currentBranch && !stack.some(e => e.name === this._currentBranch)) {
			nodes.push(new CurrentBranchNode(this._currentBranch))
		}
		// Non-scratch branches in descending stack order (topmost layer first),
		// scratch branches appended at the end (they are unordered parking areas).
		const nonScratch = stack.filter(e => !e.scratch).sort((a, b) => b.order - a.order)
		const scratchBranches = stack.filter(e => e.scratch)
		for (const e of nonScratch) nodes.push(new BranchNode(e))
		for (const e of scratchBranches) nodes.push(new ScratchNode(e))
		nodes.push(new FloatingGroupNode(floating.length))
		return nodes
	}

	getParent(element: StackTreeNode): StackTreeNode | undefined {
		if (element.kind === 'project') return undefined
		if (element.kind === 'branch' || element.kind === 'floatingGroup') {
			return this._rootUri ? new ProjectNode(this._rootUri) : undefined
		}
		if (element.kind === 'fileStatusGroup') {
			const entry = this._config.getBranch(element.branchName)
			return entry ? new BranchNode(entry) : undefined
		}
		if (element.kind === 'file') {
			if (element.parentGroupStatus !== undefined) {
				// File lives inside a status group — reconstruct the group node from cache
				const cached = this._statusCache.get(element.branchName)
				const files = cached?.[element.parentGroupStatus] ?? [element.relativePath]
				return new FileStatusGroupNode(element.parentGroupStatus, element.branchName, files)
			}
			const entry = this._config.getBranch(element.branchName)
			return entry ? new BranchNode(entry) : undefined
		}
		if (element.kind === 'floatingFile') {
			return new FloatingGroupNode(this._sync.getFloatingDirty().length)
		}
		return undefined
	}

	dispose(): void {
		this._onDidChangeTreeData.dispose()
		this._healthDisposable?.dispose()
		for (const d of this._contextDisposables) d.dispose()
		this._contextDisposables = []
		for (const d of this._disposables) {
			d.dispose()
		}
	}
}

// ─── Status bar item ──────────────────────────────────────────────────────────

/**
 * Status bar item showing the count of floating (unassigned) dirty files.
 * Clicking it focuses the branch stack tree view.
 */
export class FloatingStatusBarItem implements vscode.Disposable {

	private readonly _item: vscode.StatusBarItem
	private readonly _disposables: vscode.Disposable[] = []
	private _contextDisposables: vscode.Disposable[] = []

	private _sync: WorkspaceSync
	private _config: ConfigService

	constructor(sync: WorkspaceSync, config: ConfigService) {
		this._sync = sync
		this._config = config
		this._item = vscode.window.createStatusBarItem(
			'gitbraid-floating',
			vscode.StatusBarAlignment.Left,
			100,
		)
		this._item.command = 'gitbraid.focusStackView'
		this._item.name = 'GitBraid Floating Files'
		this._disposables.push(this._item)
		this._wireContext()
		this._update()
	}

	/** Swap bound services on active-folder switch (multi-root phase 2). */
	setContext(sync: WorkspaceSync, config: ConfigService): void {
		if (sync === this._sync && config === this._config) return
		for (const d of this._contextDisposables) d.dispose()
		this._contextDisposables = []
		this._sync = sync
		this._config = config
		this._wireContext()
		this._update()
	}

	private _wireContext(): void {
		this._contextDisposables.push(
			this._sync.onDidFloatFile(() => this._update()),
			this._config.onDidChangeAssignment(() => this._update()),
		)
	}

	private _update(): void {
		const count = this._sync.getFloatingDirty().length
		const stackSize = this._config.getStack().length
		if (stackSize === 0 || count === 0) {
			// T41: hide the status bar item when the stack is empty or no
			// floating files — it's pure noise otherwise.
			this._item.hide()
			return
		}
		this._item.text = `$(warning) ${count} unassigned`
		this._item.tooltip = `GitBraid: ${count} floating file(s) not assigned to a branch`
		this._item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground')
		this._item.show()
	}

	dispose(): void {
		for (const d of this._contextDisposables) d.dispose()
		this._contextDisposables = []
		for (const d of this._disposables) {
			d.dispose()
		}
	}
}
