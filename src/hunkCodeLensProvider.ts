import * as vscode from 'vscode'
import { log } from './channelLogger'
import { ConfigService } from './configService'
import { DiffEngine, DiffHunk } from './diffEngine'

// ─── HunkCodeLensProvider ──────────────────────────────────────────────────────

/**
 * Provides CodeLens annotations above each diff hunk in workspace files so
 * the user can assign individual hunks to specific branches without leaving
 * the editor.
 *
 * Registration:
 * ```ts
 * vscode.languages.registerCodeLensProvider(
 *   { scheme: 'file', pattern: '**' },
 *   new HunkCodeLensProvider(diffEngine, configService),
 * )
 * ```
 */
export class HunkCodeLensProvider implements vscode.CodeLensProvider, vscode.Disposable {

	private readonly _onDidChangeCodeLenses = new vscode.EventEmitter<void>()
	readonly onDidChangeCodeLenses: vscode.Event<void> = this._onDidChangeCodeLenses.event

	/** Cache: file fsPath → { version, hunks } — invalidated on each save. */
	private readonly _cache = new Map<string, { version: number; hunks: DiffHunk[] }>()

	private readonly _disposables: vscode.Disposable[] = []

	constructor(
		private readonly _diffEngine: DiffEngine,
		private readonly _config: ConfigService,
	) {
		// Refresh lenses when assignments change, or when a document is saved
		this._disposables.push(
			this._onDidChangeCodeLenses,
			this._config.onDidChangeAssignment(() => {
				this._onDidChangeCodeLenses.fire()
			}),
			vscode.workspace.onDidSaveTextDocument((doc) => {
				this._cache.delete(doc.uri.fsPath)
				this._onDidChangeCodeLenses.fire()
			}),
		)
	}

	// ── CodeLensProvider ───────────────────────────────────────────────────────

	async provideCodeLenses(
		document: vscode.TextDocument,
		_token: vscode.CancellationToken,
	): Promise<vscode.CodeLens[]> {
		// Skip virtual documents and files inside worktree directories (.worktrees/)
		if (document.uri.scheme !== 'file') {
			return []
		}
		if (document.uri.fsPath.includes('.worktrees')) {
			return []
		}

		const wsFolder = vscode.workspace.getWorkspaceFolder(document.uri)
		if (!wsFolder) {
			return []
		}

		const hunks = await this._getHunks(document, wsFolder.uri.fsPath)
		if (hunks.length === 0) {
			return []
		}

		const relativePath = vscode.workspace.asRelativePath(document.uri, false)
		const hunkAssignments = this._config.getHunkAssignments(relativePath)

		return hunks.map((hunk) => {
			const assignedBranch = hunkAssignments?.get(hunk.index)
			const title = assignedBranch
				? `$(git-branch) Hunk → ${assignedBranch}`
				: '$(git-commit) Assign hunk to branch…'
			const range = new vscode.Range(
				Math.max(hunk.startLine - 1, 0),
				0,
				Math.max(hunk.startLine - 1, 0),
				0,
			)
			return new vscode.CodeLens(range, {
				title,
				command: 'gitbraid.assignHunk',
				arguments: [document.uri, hunk.index],
				tooltip: `Lines ${String(hunk.startLine)}–${String(hunk.endLine)}: ${assignedBranch ?? 'unassigned'}`,
			})
		})
	}

	resolveCodeLens(codeLens: vscode.CodeLens, _token: vscode.CancellationToken): vscode.CodeLens {
		return codeLens
	}

	// ── Disposal ───────────────────────────────────────────────────────────────

	dispose() {
		for (const d of this._disposables) {
			d.dispose()
		}
		this._cache.clear()
	}

	// ── Private helpers ────────────────────────────────────────────────────────

	private async _getHunks(
		document: vscode.TextDocument,
		wsRoot: string,
	): Promise<DiffHunk[]> {
		const cached = this._cache.get(document.uri.fsPath)
		if (cached && cached.version === document.version) {
			return cached.hunks
		}
		const relativePath = vscode.workspace.asRelativePath(document.uri, false)
		const hunks = await this._diffEngine.getHunksForFile(wsRoot, relativePath)
		this._cache.set(document.uri.fsPath, { version: document.version, hunks })
		log.info(`HunkCodeLensProvider: ${hunks.length} hunks for ${relativePath}`)
		return hunks
	}
}

// ─── OverlayDiagnostics ────────────────────────────────────────────────────────

/**
 * Maintains a `vscode.DiagnosticCollection` that surfaces hunk-overlap
 * warnings in the Problems panel.
 *
 * An overlap occurs when two hunks in the same file are assigned to different
 * branches and their line ranges intersect.
 */
export class OverlayDiagnostics implements vscode.Disposable {

	private readonly _collection =
		vscode.languages.createDiagnosticCollection('gitbraid')

	private readonly _disposables: vscode.Disposable[] = []

	constructor(
		private readonly _diffEngine: DiffEngine,
		private readonly _config: ConfigService,
	) {
		this._disposables.push(
			this._collection,
			this._config.onDidChangeAssignment(() => {
				void this._refreshAll()
			}),
		)
	}

	// ── Public API ─────────────────────────────────────────────────────────────

	/**
	 * Refresh overlap diagnostics for a specific file URI.
	 */
	async refreshForUri(uri: vscode.Uri): Promise<void> {
		const wsFolder = vscode.workspace.getWorkspaceFolder(uri)
		if (!wsFolder) {
			return
		}
		const relativePath = vscode.workspace.asRelativePath(uri, false)
		const hunkAssignments = this._config.getHunkAssignments(relativePath)
		if (!hunkAssignments || hunkAssignments.size === 0) {
			this._collection.delete(uri)
			return
		}

		const hunks = await this._diffEngine.getHunksForFile(wsFolder.uri.fsPath, relativePath)
		const { HunkRouter } = await import('./hunkRouter')
		const router = new HunkRouter(this._diffEngine)
		const overlaps = router.detectOverlaps(hunks, hunkAssignments)

		if (overlaps.length === 0) {
			this._collection.delete(uri)
			return
		}

		const diagnostics: vscode.Diagnostic[] = overlaps.map((o) => {
			const hunkA = hunks[o.hunkA]
			const line = hunkA ? Math.max(hunkA.startLine - 1, 0) : 0
			const range = new vscode.Range(line, 0, line, 0)
			const diag = new vscode.Diagnostic(
				range,
				`Hunk ${String(o.hunkA)} and hunk ${String(o.hunkB)} are assigned to different branches but overlap on line ${String(line + 1)}.`,
				vscode.DiagnosticSeverity.Warning,
			)
			diag.source = 'gitbraid'
			return diag
		})

		this._collection.set(uri, diagnostics)
	}

	// ── Disposal ───────────────────────────────────────────────────────────────

	dispose() {
		for (const d of this._disposables) {
			d.dispose()
		}
	}

	// ── Private helpers ────────────────────────────────────────────────────────

	private async _refreshAll(): Promise<void> {
		// Refresh for every file that has a hunk assignment stored in config
		for (const relativePath of this._config.getHunkAssignedFiles()) {
			const uris = await vscode.workspace.findFiles(relativePath, undefined, 1)
			if (uris.length > 0) {
				await this.refreshForUri(uris[0])
			}
		}
	}
}
