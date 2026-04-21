import * as vscode from 'vscode'
import { ConfigService } from './configService'
import { WorkspaceSync } from './workspaceSync'
import { BranchStackEntry } from './configTypes'

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
 * Drives the "Branch Stack" tree view (`multi-branch-checkout.stackView`).
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
export class BranchStackTreeProvider
	implements vscode.TreeDataProvider<StackTreeNode>, vscode.Disposable {

	private readonly _onDidChangeTreeData = new vscode.EventEmitter<StackTreeNode | undefined>()
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event

	private readonly _disposables: vscode.Disposable[] = []

	constructor(
		private readonly _config: ConfigService,
		private readonly _sync: WorkspaceSync,
	) {
		this._disposables.push(
			_config.onDidChangeAssignment(() => this.refresh()),
			_config.onDidChangeStack(() => this.refresh()),
			_sync.onDidFloatFile(() => this.refresh()),
			_sync.onDidSyncFile(() => this.refresh()),
		)
	}

	refresh(node?: StackTreeNode): void {
		this._onDidChangeTreeData.fire(node)
	}

	getTreeItem(element: StackTreeNode): vscode.TreeItem {
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
		this._item.command = 'multi-branch-checkout.focusStackView'
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
		if (count === 0) {
			this._item.text = '$(check) MBC'
			this._item.tooltip = 'Multi-Branch Checkout: no floating files'
			this._item.backgroundColor = undefined
		} else {
			this._item.text = `$(warning) ${count} unassigned`
			this._item.tooltip = `Multi-Branch Checkout: ${count} floating file(s) not assigned to a branch`
			this._item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground')
		}
		this._item.show()
	}

	dispose(): void {
		for (const d of this._disposables) {
			d.dispose()
		}
	}
}
