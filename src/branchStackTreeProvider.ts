import * as vscode from 'vscode'
import * as path from 'node:path'
import { ConfigService } from './configService'
import { WorkspaceSync } from './workspaceSync'
import { BranchStackEntry } from './configTypes'
import type { PRAwareness } from './prAwareness'
import { codiconForState, stateLabel } from './prAwareness'
import { git } from './gitFunctions'

// ─── Tree node types ──────────────────────────────────────────────────────────

export type StackTreeNode = ProjectNode | BranchNode | FileNode | FloatingGroupNode | FloatingFileNode

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

/** A file assigned to a branch — child of BranchNode. */
export class FileNode extends vscode.TreeItem {
	readonly kind = 'file' as const
	constructor(
		public readonly relativePath: string,
		public readonly branchName: string,
	) {
		const label = relativePath.split('/').pop() ?? relativePath
		super(label, vscode.TreeItemCollapsibleState.None)
		this.contextValue = 'assignedFile'
		this.description = relativePath
		this.tooltip = `${relativePath} → ${branchName}`
		this.iconPath = vscode.ThemeIcon.File
		this.resourceUri = vscode.workspace.workspaceFolders?.[0]
			? vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, relativePath)
			: undefined
		this.command = this.resourceUri
			? { command: 'vscode.open', title: 'Open', arguments: [this.resourceUri] }
			: undefined
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

	/** The currently checked-out branch name; refreshed on HEAD change. */
	private _currentBranch: string | undefined = undefined

	constructor(
		config: ConfigService,
		sync: WorkspaceSync,
		private readonly _onAssign?: (rel: string, newBranch: string, previous: string | undefined) => void,
		private readonly _onUnassign?: (rel: string, previous: string) => void,
		private readonly _prAwareness?: PRAwareness,
		rootUri?: vscode.Uri,
	) {
		this._config = config
		this._sync = sync
		this._rootUri = rootUri
		this._wireContext()

		if (_prAwareness) {
			this._disposables.push(_prAwareness.onDidChange(() => this.refresh()))
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
	setContext(config: ConfigService, sync: WorkspaceSync, rootUri?: vscode.Uri): void {
		const nextRoot = rootUri ?? this._rootUri
		const rootUnchanged = nextRoot === this._rootUri
			|| (nextRoot !== undefined && this._rootUri !== undefined && nextRoot.fsPath === this._rootUri.fsPath)
		if (config === this._config && sync === this._sync && rootUnchanged) return
		for (const d of this._contextDisposables) d.dispose()
		this._contextDisposables = []
		this._config = config
		this._sync = sync
		this._rootUri = nextRoot
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
		this._onDidChangeTreeData.fire(node)
	}

	getTreeItem(element: StackTreeNode): vscode.TreeItem {
		if (element.kind === 'project') return element
		if (element.kind === 'branch' && this._prAwareness) {
			const info = this._prAwareness.getForBranch(element.entry.name)
			if (info) {
				// Prepend a PR-state codicon to the description so the user can
				// tell at a glance whether the branch has an open / draft /
				// merged PR.  The tooltip carries the full PR title + number.
				const icon = `$(${codiconForState(info.state)})`
				const existing = typeof element.description === 'string' ? element.description : ''
				element.description = existing ? `${icon} ${existing}` : icon
				const baseTooltip = typeof element.tooltip === 'string' ? element.tooltip : `Branch: ${element.entry.name} (base: ${element.entry.base})`
				element.tooltip = `${baseTooltip}\n${stateLabel(info.state)} #${String(info.number)} — ${info.title}`
			}
		}
		return element
	}

	getChildren(element?: StackTreeNode): StackTreeNode[] {
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
			const assignments = this._config.getAllAssignments()
			const children: FileNode[] = []
			for (const [rel, branch] of Object.entries(assignments)) {
				if (branch === element.entry.name) {
					children.push(new FileNode(rel, branch))
				}
			}
			return children.sort((a, b) => a.relativePath.localeCompare(b.relativePath))
		}

		if (element.kind === 'floatingGroup') {
			return this._sync.getFloatingDirty().map((rel) => new FloatingFileNode(rel, this._sync.getFloatingSince(rel)))
		}

		return []
	}

	/**
	 * Returns the children of the project/root node: the active branch first
	 * (if it is not already a managed stack entry), then managed stack branches
	 * sorted alphabetically, then the floating group at the end.
	 */
	private _branchChildren(): StackTreeNode[] {
		const stack = this._config.getStack()
		const floating = this._sync.getFloatingDirty()
		const nodes: StackTreeNode[] = []
		// Active checkout branch — shown first when not already in the managed stack.
		if (this._currentBranch && !stack.some(e => e.name === this._currentBranch)) {
			nodes.push(new CurrentBranchNode(this._currentBranch))
		}
		// Managed stack branches: non-scratch sorted alphabetically first, scratch last.
		const sorted = [...stack].sort((a, b) => a.name.localeCompare(b.name))
		for (const e of sorted) {
			nodes.push(e.scratch ? new ScratchNode(e) : new BranchNode(e))
		}
		nodes.push(new FloatingGroupNode(floating.length))
		return nodes
	}

	getParent(element: StackTreeNode): StackTreeNode | undefined {
		if (element.kind === 'project') return undefined
		if (element.kind === 'branch' || element.kind === 'floatingGroup') {
			return this._rootUri ? new ProjectNode(this._rootUri) : undefined
		}
		if (element.kind === 'file') {
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
