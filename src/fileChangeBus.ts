import * as vscode from 'vscode'

/**
 * Domain-level events emitted by {@link FileChangeBus}.  Consumers subscribe
 * here instead of creating their own file-system watchers, collapsing what
 * was previously an N-way fanout into a single broadcaster.
 *
 * Subscribers today: `WorkspaceSync`, `BranchScmProviderManager`,
 * `BranchStackTreeProvider`, `BranchFileDecorationProvider`.  The bus is
 * designed so adding a new listener is a one-line `bus.onDidSavePrimary(...)`
 * — not another `vscode.workspace.createFileSystemWatcher('**')` call.
 *
 * See `docs/remediation/02-p1-correctness.md#T10` for the full design.
 */
export interface PrimarySaveEvent {
	uri: vscode.Uri
	relativePath: string
}

export interface WorktreeChangeEvent {
	uri: vscode.Uri
	/** Directory name under `.worktrees/` — e.g. "feature-a__1a2b3c4". */
	worktreeDirName: string
	/** Path relative to the worktree root — e.g. "src/foo.ts". */
	relativePath: string
	/** Whether the file was deleted from the worktree (vs. created or changed). */
	deleted: boolean
}

/**
 * Minimal contract so components can pull in the bus without importing the
 * implementation class (keeps test doubles cheap).
 */
export interface IFileChangeBus extends vscode.Disposable {
	readonly onDidSavePrimary: vscode.Event<PrimarySaveEvent>
	readonly onDidDeletePrimary: vscode.Event<PrimarySaveEvent>
	readonly onDidChangeWorktree: vscode.Event<WorktreeChangeEvent>
	/** Fires once per change regardless of source — handy for UI refreshes. */
	readonly onDidAnyFileChange: vscode.Event<void>
}

export class FileChangeBus implements IFileChangeBus {

	private readonly _onDidSavePrimary = new vscode.EventEmitter<PrimarySaveEvent>()
	private readonly _onDidDeletePrimary = new vscode.EventEmitter<PrimarySaveEvent>()
	private readonly _onDidChangeWorktree = new vscode.EventEmitter<WorktreeChangeEvent>()
	private readonly _onDidAnyFileChange = new vscode.EventEmitter<void>()

	readonly onDidSavePrimary = this._onDidSavePrimary.event
	readonly onDidDeletePrimary = this._onDidDeletePrimary.event
	readonly onDidChangeWorktree = this._onDidChangeWorktree.event
	readonly onDidAnyFileChange = this._onDidAnyFileChange.event

	private readonly _disposables: vscode.Disposable[] = []

	/**
	 * @param workspaceRoot  Root to watch.  `.worktrees/` is special-cased
	 *                       into the worktree channel so downstream code can
	 *                       distinguish "user saved a file" from "worktree
	 *                       changed under the hood".
	 *
	 * Respects `files.watcherExclude` — paths matched by the user's exclusion
	 * globs are silently discarded before reaching any subscriber, matching the
	 * behaviour of VS Code's built-in git extension (F3).
	 */
	constructor(workspaceRoot: vscode.Uri) {
		this._excludeGlobs = FileChangeBus._readWatcherExcludes()
		const watcher = vscode.workspace.createFileSystemWatcher(
			new vscode.RelativePattern(workspaceRoot, '**/*'),
			false, false, false,
		)
		this._disposables.push(
			watcher,
			watcher.onDidChange((uri) => this._dispatch(uri, workspaceRoot, 'change')),
			watcher.onDidCreate((uri) => this._dispatch(uri, workspaceRoot, 'change')),
			watcher.onDidDelete((uri) => this._dispatch(uri, workspaceRoot, 'delete')),
			vscode.workspace.onDidChangeConfiguration((e) => {
				if (e.affectsConfiguration('files.watcherExclude')) {
					this._excludeGlobs = FileChangeBus._readWatcherExcludes()
				}
			}),
		)
	}

	private _excludeGlobs: string[]

	private static _readWatcherExcludes(): string[] {
		const raw = vscode.workspace
			.getConfiguration('files')
			.get<Record<string, boolean>>('watcherExclude', {})
		return Object.entries(raw)
			.filter(([, enabled]) => enabled)
			.map(([pattern]) => pattern)
	}

	private _isExcluded(rel: string): boolean {
		if (this._excludeGlobs.length === 0) return false
		return this._excludeGlobs.some((glob) => FileChangeBus._matchGlob(glob, rel))
	}

	/**
	 * Minimal glob matcher covering the common `files.watcherExclude` patterns:
	 * - `**​/node_modules/**` style double-star prefix/suffix
	 * - `node_modules/**` leading directory
	 * - `dist/` trailing slash (directory prefix)
	 */
	private static _matchGlob(glob: string, rel: string): boolean {
		// Strip trailing slash — treat as directory prefix
		const normalGlob = glob.endsWith('/') ? glob.slice(0, -1) : glob
		// Convert glob to a simple regex: ** → .*  * → [^/]*  . → \.
		const pattern = normalGlob
			.replace(/[.+^${}()|[\]\\]/g, '\\$&')
			.replace(/\\\*\\\*/g, '.*')
			.replace(/\*/g, '[^/]*')
		const re = new RegExp(`^${pattern}(/|$)`)
		return re.test(rel)
	}

	dispose(): void {
		this._onDidSavePrimary.dispose()
		this._onDidDeletePrimary.dispose()
		this._onDidChangeWorktree.dispose()
		this._onDidAnyFileChange.dispose()
		for (const d of this._disposables) {
			d.dispose()
		}
	}

	private _dispatch(uri: vscode.Uri, root: vscode.Uri, kind: 'change' | 'delete'): void {
		const rel = relativePathFrom(root, uri)
		if (!rel) {
			return
		}
		if (rel.startsWith('.git/') || rel === '.git') {
			return
		}
		if (this._isExcluded(rel)) {
			return
		}

		this._onDidAnyFileChange.fire()

		if (rel === '.worktrees' || rel.startsWith('.worktrees/')) {
			const worktreeMatch = /^\.worktrees\/([^/]+)\/(.+)$/.exec(rel)
			if (worktreeMatch) {
				this._onDidChangeWorktree.fire({
					uri,
					worktreeDirName: worktreeMatch[1],
					relativePath: worktreeMatch[2],
					deleted: kind === 'delete',
				})
			}
			return
		}

		const evt: PrimarySaveEvent = { uri, relativePath: rel }
		if (kind === 'delete') {
			this._onDidDeletePrimary.fire(evt)
		} else {
			this._onDidSavePrimary.fire(evt)
		}
	}
}

function relativePathFrom(root: vscode.Uri, target: vscode.Uri): string | undefined {
	const base = root.fsPath
	const p = target.fsPath
	if (!p.startsWith(base)) {
		return undefined
	}
	let rel = p.slice(base.length)
	if (rel.startsWith('/') || rel.startsWith('\\')) {
		rel = rel.slice(1)
	}
	return rel.replaceAll('\\', '/')
}
