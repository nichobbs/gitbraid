import * as vscode from 'vscode'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { log } from './channelLogger'
import { FolderContext } from './folderContext'

/**
 * Shape of the event emitted when the registry's folder set changes.
 * Mirrors {@link vscode.WorkspaceFoldersChangeEvent} but uses
 * {@link FolderContext} instances so subscribers don't have to re-query.
 */
export interface FolderChangeEvent {
	added: FolderContext[]
	removed: FolderContext[]
}

/**
 * Tracks `FolderContext` instances, one per workspace folder that looks
 * like a git repository (has a `.git/` directory or file).  Subscribes to
 * `vscode.workspace.onDidChangeWorkspaceFolders` and maintains the set
 * automatically.
 *
 * Resolution helpers:
 *
 * - {@link getForUri} — the folder that contains the given URI.
 * - {@link getActive} — the folder containing the active editor's file,
 *   or the first (and only) folder when the workspace is single-root.
 * - {@link getAll} — every eligible folder, in workspace-declaration order.
 *
 * ## Why not just use `vscode.workspace.workspaceFolders[0]` directly?
 *
 * Multi-root workspaces have no notion of a "primary" folder in VS Code's
 * model.  Commands want "the folder the user's currently looking at",
 * which is the active editor's folder — not necessarily folder zero.
 * {@link getActive} encodes that heuristic in one place so command
 * handlers don't re-derive it.  See `src/multiRoot.md` (if present) for
 * the rationale.
 */
export class FolderRegistry implements vscode.Disposable {

	private readonly _contexts = new Map<string, FolderContext>()
	private readonly _disposables: vscode.Disposable[] = []

	private readonly _onDidChange = new vscode.EventEmitter<FolderChangeEvent>()
	readonly onDidChangeFolders: vscode.Event<FolderChangeEvent> = this._onDidChange.event

	constructor() {
		this._disposables.push(
			vscode.workspace.onDidChangeWorkspaceFolders((e) => this._applyChange(e)),
			this._onDidChange,
		)
	}

	// ── Initial bring-up ──────────────────────────────────────────────────────

	/**
	 * Create and initialise a `FolderContext` for every eligible workspace
	 * folder.  Returns the contexts in workspace-declaration order.
	 *
	 * Non-git folders are skipped with a `log.debug` line.  Folders whose
	 * initialisation throws are logged and skipped — one bad folder must
	 * not prevent the others from activating.
	 */
	async initializeAll(): Promise<FolderContext[]> {
		const folders = vscode.workspace.workspaceFolders ?? []
		const created: FolderContext[] = []
		for (const folder of folders) {
			const ctx = await this._addFolder(folder.uri)
			if (ctx) created.push(ctx)
		}
		return created
	}

	/** Create a folder context without initialising it — tests only. */
	createUninitialised(uri: vscode.Uri): FolderContext {
		const ctx = new FolderContext(uri)
		this._contexts.set(uri.fsPath, ctx)
		return ctx
	}

	// ── Queries ──────────────────────────────────────────────────────────────

	getForUri(uri: vscode.Uri): FolderContext | undefined {
		// Prefer an exact folder-root match, then a longest-prefix match.
		// The latter handles files inside subdirectories of a workspace
		// folder — the common case.
		let best: { ctx: FolderContext, len: number } | undefined
		for (const ctx of this._contexts.values()) {
			const baseWithSep = ensureTrailingSep(ctx.root.fsPath)
			if (uri.fsPath === ctx.root.fsPath || uri.fsPath.startsWith(baseWithSep)) {
				if (!best || ctx.root.fsPath.length > best.len) {
					best = { ctx, len: ctx.root.fsPath.length }
				}
			}
		}
		return best?.ctx
	}

	/**
	 * Resolve the folder the user is "currently looking at".  Heuristic:
	 *
	 * 1. Active text editor's containing folder, if any and a known context.
	 * 2. Visible editor's containing folder (handles the case where focus
	 *    is on a non-text editor — a diff view, say).
	 * 3. Single registered folder, if the workspace has exactly one.
	 * 4. `undefined` — caller decides whether to prompt or refuse.
	 */
	getActive(): FolderContext | undefined {
		const active = vscode.window.activeTextEditor
		if (active) {
			const ctx = this.getForUri(active.document.uri)
			if (ctx) return ctx
		}
		for (const editor of vscode.window.visibleTextEditors) {
			const ctx = this.getForUri(editor.document.uri)
			if (ctx) return ctx
		}
		if (this._contexts.size === 1) {
			return this._contexts.values().next().value
		}
		return undefined
	}

	/**
	 * Prompt the user to pick a folder when {@link getActive} can't
	 * disambiguate.  Returns `undefined` if the user cancels.
	 */
	async pickActive(placeHolder = 'Select a workspace folder'): Promise<FolderContext | undefined> {
		const guess = this.getActive()
		if (guess) return guess
		const all = this.getAll()
		if (all.length === 0) return undefined
		if (all.length === 1) return all[0]
		const picked = await vscode.window.showQuickPick(
			all.map((ctx) => ({
				label: path.basename(ctx.root.fsPath),
				description: ctx.root.fsPath,
				ctx,
			})),
			{ placeHolder },
		)
		return picked?.ctx
	}

	getAll(): FolderContext[] {
		const folders = vscode.workspace.workspaceFolders ?? []
		const out: FolderContext[] = []
		for (const folder of folders) {
			const ctx = this._contexts.get(folder.uri.fsPath)
			if (ctx) out.push(ctx)
		}
		return out
	}

	/** Convenience — number of tracked contexts. */
	get size(): number { return this._contexts.size }

	// ── Lifecycle ────────────────────────────────────────────────────────────

	dispose(): void {
		for (const ctx of this._contexts.values()) {
			ctx.dispose()
		}
		this._contexts.clear()
		for (const d of this._disposables) {
			d.dispose()
		}
	}

	private async _applyChange(e: vscode.WorkspaceFoldersChangeEvent): Promise<void> {
		const added: FolderContext[] = []
		for (const folder of e.added) {
			const ctx = await this._addFolder(folder.uri)
			if (ctx) added.push(ctx)
		}
		const removed: FolderContext[] = []
		for (const folder of e.removed) {
			const ctx = this._contexts.get(folder.uri.fsPath)
			if (ctx) {
				ctx.dispose()
				this._contexts.delete(folder.uri.fsPath)
				removed.push(ctx)
			}
		}
		if (added.length > 0 || removed.length > 0) {
			this._onDidChange.fire({ added, removed })
		}
	}

	private async _addFolder(uri: vscode.Uri): Promise<FolderContext | undefined> {
		if (this._contexts.has(uri.fsPath)) {
			return this._contexts.get(uri.fsPath)
		}
		if (!isGitRepo(uri)) {
			log.debug(`FolderRegistry: skipping non-git folder ${uri.fsPath}`)
			return undefined
		}
		const ctx = new FolderContext(uri)
		try {
			await ctx.initialize()
		} catch (e) {
			log.error(`FolderRegistry: failed to initialise ${uri.fsPath}: ${e instanceof Error ? e.message : String(e)}`)
			ctx.dispose()
			return undefined
		}
		this._contexts.set(uri.fsPath, ctx)
		return ctx
	}
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function ensureTrailingSep(p: string): string {
	return p.endsWith(path.sep) ? p : p + path.sep
}

/**
 * Lightweight "is this a git repo?" check.  A `.git` entry (file or dir)
 * at the folder root is enough — we don't need to validate the contents
 * since subsequent git commands will fail visibly if it's corrupt.
 */
function isGitRepo(uri: vscode.Uri): boolean {
	try {
		fs.statSync(path.join(uri.fsPath, '.git'))
		return true
	} catch {
		return false
	}
}
