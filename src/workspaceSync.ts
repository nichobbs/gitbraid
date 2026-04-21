import * as vscode from 'vscode'
import * as path from 'path'
import { log } from './channelLogger'
import { SyncError } from './errors'
import { ConfigService } from './configService'
import { worktreePath } from './branchStackService'

const DEBOUNCE_MS = 200

/**
 * Watches the workspace for file saves and copies modified files to the
 * owning branch's worktree.
 *
 * - **Assigned** files are copied to their branch worktree on every save.
 * - **Floating** files (no assignment) are tracked in `_floatingDirty` for
 *   warning purposes, but are not blocked.
 *
 * A `_syncing` flag prevents re-entrant triggers from the file-system watcher
 * picking up the writes we make to the worktrees.
 */
export class WorkspaceSync implements vscode.Disposable {

	private static _instance: WorkspaceSync | undefined

	private _workspaceRoot: vscode.Uri | undefined
	private _syncing = false
	private readonly _floatingDirty = new Set<string>()
	private readonly _disposables: vscode.Disposable[] = []

	/** Pending debounce timer handles keyed by workspace-relative path. */
	private readonly _pending = new Map<string, ReturnType<typeof setTimeout>>()

	private readonly _onDidSyncFile = new vscode.EventEmitter<{ relativePath: string; branch: string }>()
	readonly onDidSyncFile: vscode.Event<{ relativePath: string; branch: string }> = this._onDidSyncFile.event

	private readonly _onDidFloatFile = new vscode.EventEmitter<{ relativePath: string }>()
	readonly onDidFloatFile: vscode.Event<{ relativePath: string }> = this._onDidFloatFile.event

	private constructor(private readonly _config: ConfigService) {}

	static getInstance(config?: ConfigService): WorkspaceSync {
		if (!WorkspaceSync._instance) {
			if (!config) {
				config = ConfigService.getInstance()
			}
			WorkspaceSync._instance = new WorkspaceSync(config)
		}
		return WorkspaceSync._instance
	}

	/** Reset the singleton — for use in tests only. */
	static resetInstance(): void {
		WorkspaceSync._instance?.dispose()
		WorkspaceSync._instance = undefined
	}

	dispose(): void {
		// Cancel all pending debounces
		for (const timer of this._pending.values()) {
			clearTimeout(timer)
		}
		this._pending.clear()
		this._onDidSyncFile.dispose()
		this._onDidFloatFile.dispose()
		for (const d of this._disposables) {
			d.dispose()
		}
	}

	// ─── Initialisation ──────────────────────────────────────────────────────

	/**
	 * Begin watching the workspace. Call once at extension activation.
	 */
	init(workspaceRoot: vscode.Uri): void {
		this._workspaceRoot = workspaceRoot

		// Watch all files in workspace (excluding .worktrees itself)
		const watcher = vscode.workspace.createFileSystemWatcher(
			new vscode.RelativePattern(workspaceRoot, '**/*'),
			false, // create
			false, // change
			false  // delete
		)

		this._disposables.push(
			watcher,
			watcher.onDidChange((uri) => this._onChanged(uri)),
			watcher.onDidCreate((uri) => this._onChanged(uri)),
			watcher.onDidDelete((uri) => this._onDeleted(uri)),
			this._config.onDidChangeAssignment(async (ev) => {
				if (ev.branch && ev.relativePath) {
					const uri = vscode.Uri.joinPath(workspaceRoot, ev.relativePath)
					await this._syncFile(ev.relativePath, uri, ev.branch)
				}
			})
		)

		log.info('WorkspaceSync: watching ' + workspaceRoot.fsPath)
	}

	// ─── Queries ─────────────────────────────────────────────────────────────

	/** Returns true if the file currently has unsaved floating status. */
	isFloating(relativePath: string): boolean {
		return this._floatingDirty.has(normalisePath(relativePath))
	}

	/** Returns a snapshot of all currently floating dirty paths. */
	getFloatingDirty(): ReadonlyArray<string> {
		return [...this._floatingDirty]
	}

	// ─── Private event handlers ───────────────────────────────────────────────

	private _onChanged(uri: vscode.Uri): void {
		if (!this._workspaceRoot) {
			return
		}
		const rel = this._relativePath(uri)
		if (!rel || rel.startsWith('.worktrees/') || rel.startsWith('.git/')) {
			return
		}
		// A sync is in progress — re-queue so this save isn't silently dropped
		if (this._syncing) {
			setTimeout(() => this._onChanged(uri), DEBOUNCE_MS)
			return
		}

		// Debounce rapid saves
		const existing = this._pending.get(rel)
		if (existing) {
			clearTimeout(existing)
		}
		const timer = setTimeout(() => {
			this._pending.delete(rel)
			void this._handleSave(rel, uri)
		}, DEBOUNCE_MS)
		this._pending.set(rel, timer)
	}

	private _onDeleted(uri: vscode.Uri): void {
		if (!this._workspaceRoot || this._syncing) {
			return
		}
		const rel = this._relativePath(uri)
		if (!rel || rel.startsWith('.worktrees/') || rel.startsWith('.git/')) {
			return
		}
		const branch = this._config.getAssignment(rel)
		if (!branch) {
			this._floatingDirty.delete(normalisePath(rel))
			return
		}
		void this._propagateDeletion(rel, branch)
	}

	private async _handleSave(relativePath: string, uri: vscode.Uri): Promise<void> {
		const branch = this._config.getAssignment(relativePath)
		if (!branch) {
			const key = normalisePath(relativePath)
			this._floatingDirty.add(key)
			this._onDidFloatFile.fire({ relativePath: key })
			return
		}
		this._floatingDirty.delete(normalisePath(relativePath))
		await this._syncFile(relativePath, uri, branch)
	}

	private async _syncFile(relativePath: string, uri: vscode.Uri, branch: string): Promise<void> {
		if (!this._workspaceRoot) {
			return
		}
		// Clear floating status — file is now assigned to a branch
		this._floatingDirty.delete(normalisePath(relativePath))
		const wtPath = worktreePath(this._workspaceRoot, branch)
		const destUri = vscode.Uri.joinPath(wtPath, relativePath)

		let content: Uint8Array
		try {
			content = await vscode.workspace.fs.readFile(uri)
		} catch {
			// File may have been deleted between event and read — skip
			return
		}

		// Ensure dest directory exists
		const destDir = vscode.Uri.file(path.dirname(destUri.fsPath))
		try {
			await vscode.workspace.fs.createDirectory(destDir)
		} catch {
			// Directory may already exist
		}

		this._syncing = true
		try {
			await vscode.workspace.fs.writeFile(destUri, content)
			log.info(`WorkspaceSync: synced ${relativePath} → ${branch}`)
			this._onDidSyncFile.fire({ relativePath: normalisePath(relativePath), branch })
		} catch (e: unknown) {
			const msg = e instanceof Error ? e.message : JSON.stringify(e)
			throw new SyncError(`Failed to sync "${relativePath}" to branch "${branch}": ${msg}`)
		} finally {
			this._syncing = false
		}
	}

	private async _propagateDeletion(relativePath: string, branch: string): Promise<void> {
		if (!this._workspaceRoot) {
			return
		}
		const wtPath = worktreePath(this._workspaceRoot, branch)
		const destUri = vscode.Uri.joinPath(wtPath, relativePath)

		this._syncing = true
		try {
			await vscode.workspace.fs.delete(destUri, { useTrash: false })
			log.info(`WorkspaceSync: deleted ${relativePath} from ${branch}`)
		} catch {
			// File may not exist in worktree — not an error
		} finally {
			this._syncing = false
		}
	}

	private _relativePath(uri: vscode.Uri): string | undefined {
		if (!this._workspaceRoot) {
			return undefined
		}
		const rel = path.relative(this._workspaceRoot.fsPath, uri.fsPath)
		if (rel.startsWith('..')) {
			// Outside workspace
			return undefined
		}
		return rel.replaceAll(path.sep, '/')
	}
}

function normalisePath(p: string): string {
	return p.replaceAll('\\', '/')
}
