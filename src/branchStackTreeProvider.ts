import * as vscode from 'vscode'
import { ConfigService } from './configService'
import { WorkspaceSync } from './workspaceSync'
import { BranchStackEntry } from './configTypes'
import type { PRAwareness } from './prAwareness'
import { codiconForState, stateLabel } from './prAwareness'

// ─── Tree node types ──────────────────────────────────────────────────────────

export type StackTreeNode = BranchNode | FileNode | FloatingGroupNode | FloatingFileNode

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
	constructor(public readonly relativePath: string) {
		const label = relativePath.split('/').pop() ?? relativePath
		super(label, vscode.TreeItemCollapsibleState.None)
		this.contextValue = 'floatingFile'
		this.description = relativePath
		this.tooltip = `${relativePath} — not yet assigned to a branch`
		this.iconPath = new vscode.ThemeIcon('question')
		this.resourceUri = vscode.workspace.workspaceFolders?.[0]
			? vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, relativePath)
			: undefined
		this.command = this.resourceUri
			? { command: 'vscode.open', title: 'Open', arguments: [this.resourceUri] }
			: undefined
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

	constructor(
		private readonly _config: ConfigService,
		private readonly _sync: WorkspaceSync,
		private readonly _onAssign?: (rel: string, newBranch: string, previous: string | undefined) => void,
		private readonly _onUnassign?: (rel: string, previous: string) => void,
		private readonly _prAwareness?: PRAwareness,
	) {
		this._disposables.push(
			_config.onDidChangeAssignment(() => this.refresh()),
			_config.onDidChangeStack(() => this.refresh()),
			_sync.onDidFloatFile(() => this.refresh()),
			_sync.onDidSyncFile(() => this.refresh()),
		)
		if (_prAwareness) {
			this._disposables.push(_prAwareness.onDidChange(() => this.refresh()))
		}
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

	refresh(node?: StackTreeNode): void {
		this._onDidChangeTreeData.fire(node)
	}

	getTreeItem(element: StackTreeNode): vscode.TreeItem {
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
			// Root: one node per branch + floating group
			const stack = this._config.getStack()
			const floating = this._sync.getFloatingDirty()
			return [
				...stack.map((e) => new BranchNode(e)),
				new FloatingGroupNode(floating.length),
			]
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
			return this._sync.getFloatingDirty().map((rel) => new FloatingFileNode(rel))
		}

		return []
	}

	getParent(element: StackTreeNode): StackTreeNode | undefined {
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

	constructor(
		private readonly _sync: WorkspaceSync,
		private readonly _config: ConfigService,
	) {
		this._item = vscode.window.createStatusBarItem(
			'mbc-floating',
			vscode.StatusBarAlignment.Left,
			100,
		)
		this._item.command = 'gitbraid.focusStackView'
		this._item.name = 'MBC Floating Files'

		this._disposables.push(
			_sync.onDidFloatFile(() => this._update()),
			_config.onDidChangeAssignment(() => this._update()),
			this._item,
		)

		this._update()
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
		for (const d of this._disposables) {
			d.dispose()
		}
	}
}
