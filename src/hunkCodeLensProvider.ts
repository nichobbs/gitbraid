import * as vscode from 'vscode'
import * as path from 'path'
import { log } from './channelLogger'
import { ConfigService } from './configService'
import { DiffEngine, DiffHunk } from './diffEngine'
import type { FolderRegistry } from './folderRegistry'
import type { FolderContext } from './folderContext'

// ─── HunkCodeLensProvider ──────────────────────────────────────────────────────

/**
 * Per-URI resolution result — the trio of (folder context, diff engine,
 * config, relative path) a provide-call needs to render lenses for a file.
 * Returned by the registry-aware and fallback paths so downstream code is
 * agnostic to multi-root vs single-root mode.
 */
interface HunkLookup {
	diffEngine: DiffEngine
	config: ConfigService
	workspaceRoot: string
	relativePath: string
}

/**
 * Provides CodeLens annotations above each diff hunk in workspace files so
 * the user can assign individual hunks to specific branches without leaving
 * the editor.
 *
 * Multi-root: in phase 2, the provider takes a `FolderRegistry` and routes
 * each incoming URI to its owning folder.  Lenses for files in non-primary
 * folders now show that folder's assignments (not primary's).  Without a
 * registry, a fallback `(diffEngine, config)` pair services every URI
 * (single-folder tests).
 */
export class HunkCodeLensProvider implements vscode.CodeLensProvider, vscode.Disposable {

	private readonly _onDidChangeCodeLenses = new vscode.EventEmitter<void>()
	readonly onDidChangeCodeLenses: vscode.Event<void> = this._onDidChangeCodeLenses.event

	/**
	 * Cache: file fsPath → { version, hunks } — invalidated on each save.
	 * Bounded via LRU eviction to keep memory in check on users who cycle
	 * through a large codebase (T45).  fsPath is already folder-qualified,
	 * so multi-root doesn't change the cache key shape.
	 */
	private readonly _cache = new Map<string, { version: number; hunks: DiffHunk[] }>()
	/** Soft cap on `_cache` entries; oldest insertion is evicted on overflow. */
	private static readonly _cacheMax = 50

	private readonly _disposables: vscode.Disposable[] = []
	private readonly _ctxSubs = new Map<string, vscode.Disposable[]>()

	/**
	 * Pending debounce handle for coalesced lens-refresh fires.  VS Code calls
	 * `provideCodeLenses` aggressively (per keystroke version bump); spawning
	 * a `git diff` per call was costly — we now wait until the user pauses
	 * typing for a short window before recomputing.  (T45 in the plan.)
	 */
	private _fireDebounce: ReturnType<typeof setTimeout> | undefined

	constructor(
		private readonly _fallbackDiffEngine: DiffEngine,
		private readonly _fallbackConfig: ConfigService,
		private readonly _registry?: FolderRegistry,
	) {
		// Document-lifecycle listeners are universal — save / edit invalidate
		// the cache and fire a refresh regardless of which folder owns the doc.
		this._disposables.push(
			this._onDidChangeCodeLenses,
			vscode.workspace.onDidSaveTextDocument((doc) => {
				this._cache.delete(doc.uri.fsPath)
				this._scheduleFire()
			}),
			vscode.workspace.onDidChangeTextDocument((e) => {
				// Invalidate the version cache so the next provide call sees
				// the updated document, but debounce the fire itself.
				this._cache.delete(e.document.uri.fsPath)
				this._scheduleFire()
			}),
		)

		// Config-change subscriptions: one per folder in registry mode, one
		// overall in fallback mode.  Folder add/remove bookkeeping matches
		// the pattern used by BranchFileDecorationProvider.
		if (this._registry) {
			for (const ctx of this._registry.getAll()) this._subscribeContext(ctx)
			this._disposables.push(
				this._registry.onDidChangeFolders((e) => {
					for (const ctx of e.added) this._subscribeContext(ctx)
					for (const ctx of e.removed) {
						const subs = this._ctxSubs.get(ctx.root.fsPath) ?? []
						for (const d of subs) d.dispose()
						this._ctxSubs.delete(ctx.root.fsPath)
					}
				}),
			)
		} else {
			this._disposables.push(
				this._fallbackConfig.onDidChangeAssignment(() => { this._scheduleFire() }),
			)
		}
	}

	private _subscribeContext(ctx: FolderContext): void {
		this._ctxSubs.set(ctx.root.fsPath, [
			ctx.config.onDidChangeAssignment(() => { this._scheduleFire() }),
		])
	}

	private _scheduleFire(): void {
		if (this._fireDebounce) {
			clearTimeout(this._fireDebounce)
		}
		this._fireDebounce = setTimeout(() => {
			this._fireDebounce = undefined
			this._onDidChangeCodeLenses.fire()
		}, 300)
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
		const lookup = this._resolve(document.uri)
		if (!lookup) {
			return []
		}
		// Containment check (not a substring match) — see reviews/05-ui-and-ux.md
		// "Hunk CodeLens UX": previously `fsPath.includes('.worktrees')` also
		// matched folders like `not.worktrees-backups/`.
		if (!lookup.relativePath || lookup.relativePath.split('/').includes('.worktrees')) {
			return []
		}

		const hunks = await this._getHunks(document, lookup)
		if (hunks.length === 0) {
			return []
		}

		const hunkAssignments = lookup.config.getHunkAssignments(lookup.relativePath)

		const lenses: vscode.CodeLens[] = []
		for (const hunk of hunks) {
			const assignedBranch = hunkAssignments?.get(hunk.index)
			const range = new vscode.Range(
				Math.max(hunk.startLine - 1, 0),
				0,
				Math.max(hunk.startLine - 1, 0),
				0,
			)
			const tooltip = `Lines ${String(hunk.startLine)}–${String(hunk.endLine)}: ${assignedBranch ?? 'unassigned'}`

			if (assignedBranch) {
				// Two lenses: reassign (opens the picker) + unassign (one-click).
				// See reviews/05-ui-and-ux.md "Hunk CodeLens UX".
				lenses.push(new vscode.CodeLens(range, {
					title: `$(git-branch) Hunk → ${assignedBranch}`,
					command: 'gitbraid.assignHunk',
					arguments: [document.uri, hunk.index],
					tooltip,
				}))
				lenses.push(new vscode.CodeLens(range, {
					title: '$(trash) Unassign',
					command: 'gitbraid.unassignHunk',
					arguments: [document.uri, hunk.index],
					tooltip: 'Remove the hunk assignment',
				}))
			} else {
				lenses.push(new vscode.CodeLens(range, {
					title: '$(git-commit) Assign hunk to branch…',
					command: 'gitbraid.assignHunk',
					arguments: [document.uri, hunk.index],
					tooltip,
				}))
			}
		}
		return lenses
	}

	resolveCodeLens(codeLens: vscode.CodeLens, _token: vscode.CancellationToken): vscode.CodeLens {
		return codeLens
	}

	// ── Disposal ───────────────────────────────────────────────────────────────

	dispose() {
		if (this._fireDebounce) {
			clearTimeout(this._fireDebounce)
			this._fireDebounce = undefined
		}
		for (const subs of this._ctxSubs.values()) {
			for (const d of subs) d.dispose()
		}
		this._ctxSubs.clear()
		for (const d of this._disposables) {
			d.dispose()
		}
		this._cache.clear()
	}

	// ── Private helpers ────────────────────────────────────────────────────────

	/**
	 * Map a URI to the (config, diffEngine, workspaceRoot, relativePath)
	 * tuple the provide call needs.  Returns undefined when the URI is
	 * outside every known folder (multi-root) or outside the workspace
	 * (single-folder).
	 */
	private _resolve(uri: vscode.Uri): HunkLookup | undefined {
		if (this._registry) {
			const ctx = this._registry.getForUri(uri)
			if (!ctx) return undefined
			return {
				diffEngine: ctx.diffEngine,
				config: ctx.config,
				workspaceRoot: ctx.root.fsPath,
				relativePath: path.relative(ctx.root.fsPath, uri.fsPath).replaceAll('\\', '/'),
			}
		}
		const wsFolder = vscode.workspace.getWorkspaceFolder(uri)
		if (!wsFolder) return undefined
		return {
			diffEngine: this._fallbackDiffEngine,
			config: this._fallbackConfig,
			workspaceRoot: wsFolder.uri.fsPath,
			relativePath: path.relative(wsFolder.uri.fsPath, uri.fsPath).replaceAll('\\', '/'),
		}
	}

	private async _getHunks(
		document: vscode.TextDocument,
		lookup: HunkLookup,
	): Promise<DiffHunk[]> {
		const key = document.uri.fsPath
		const cached = this._cache.get(key)
		if (cached && cached.version === document.version) {
			// Refresh LRU position on hit.
			this._cache.delete(key)
			this._cache.set(key, cached)
			return cached.hunks
		}
		const hunks = await lookup.diffEngine.getHunksForFile(lookup.workspaceRoot, lookup.relativePath)
		if (this._cache.size >= HunkCodeLensProvider._cacheMax) {
			const oldest = this._cache.keys().next().value
			if (oldest !== undefined) this._cache.delete(oldest)
		}
		this._cache.set(key, { version: document.version, hunks })
		log.debug(`HunkCodeLensProvider: ${hunks.length} hunks for ${lookup.relativePath}`)
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
 *
 * Multi-root aware: when constructed with a `FolderRegistry`, overlap
 * detection runs against the owning folder's config + diff engine per-URI,
 * and `_refreshAll` iterates every folder's hunk-assigned files.
 */
export class OverlayDiagnostics implements vscode.Disposable {

	private readonly _collection =
		vscode.languages.createDiagnosticCollection('gitbraid')

	private readonly _disposables: vscode.Disposable[] = []
	private readonly _ctxSubs = new Map<string, vscode.Disposable[]>()

	constructor(
		private readonly _fallbackDiffEngine: DiffEngine,
		private readonly _fallbackConfig: ConfigService,
		private readonly _registry?: FolderRegistry,
	) {
		this._disposables.push(this._collection)

		if (this._registry) {
			for (const ctx of this._registry.getAll()) this._subscribeContext(ctx)
			this._disposables.push(
				this._registry.onDidChangeFolders((e) => {
					for (const ctx of e.added) this._subscribeContext(ctx)
					for (const ctx of e.removed) {
						const subs = this._ctxSubs.get(ctx.root.fsPath) ?? []
						for (const d of subs) d.dispose()
						this._ctxSubs.delete(ctx.root.fsPath)
					}
				}),
			)
		} else {
			this._disposables.push(
				this._fallbackConfig.onDidChangeAssignment(() => {
					void this._refreshAll()
				}),
			)
		}
	}

	private _subscribeContext(ctx: FolderContext): void {
		this._ctxSubs.set(ctx.root.fsPath, [
			ctx.config.onDidChangeAssignment(() => { void this._refreshAll() }),
		])
	}

	// ── Public API ─────────────────────────────────────────────────────────────

	/**
	 * Refresh overlap diagnostics for a specific file URI.
	 */
	async refreshForUri(uri: vscode.Uri): Promise<void> {
		const lookup = this._resolve(uri)
		if (!lookup) {
			return
		}
		const hunkAssignments = lookup.config.getHunkAssignments(lookup.relativePath)
		if (!hunkAssignments || hunkAssignments.size === 0) {
			this._collection.delete(uri)
			return
		}

		const hunks = await lookup.diffEngine.getHunksForFile(lookup.workspaceRoot, lookup.relativePath)
		const { HunkRouter } = await import('./hunkRouter')
		const router = new HunkRouter(lookup.diffEngine)
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
		for (const subs of this._ctxSubs.values()) {
			for (const d of subs) d.dispose()
		}
		this._ctxSubs.clear()
		for (const d of this._disposables) {
			d.dispose()
		}
	}

	// ── Private helpers ────────────────────────────────────────────────────────

	private _resolve(uri: vscode.Uri): HunkLookup | undefined {
		if (this._registry) {
			const ctx = this._registry.getForUri(uri)
			if (!ctx) return undefined
			return {
				diffEngine: ctx.diffEngine,
				config: ctx.config,
				workspaceRoot: ctx.root.fsPath,
				relativePath: path.relative(ctx.root.fsPath, uri.fsPath).replaceAll('\\', '/'),
			}
		}
		const wsFolder = vscode.workspace.getWorkspaceFolder(uri)
		if (!wsFolder) return undefined
		return {
			diffEngine: this._fallbackDiffEngine,
			config: this._fallbackConfig,
			workspaceRoot: wsFolder.uri.fsPath,
			relativePath: path.relative(wsFolder.uri.fsPath, uri.fsPath).replaceAll('\\', '/'),
		}
	}

	private async _refreshAll(): Promise<void> {
		const contexts: Array<{ root: vscode.Uri, config: ConfigService }> = this._registry
			? this._registry.getAll().map((ctx) => ({ root: ctx.root, config: ctx.config }))
			: (() => {
				const wsf = vscode.workspace.workspaceFolders?.[0]
				return wsf ? [{ root: wsf.uri, config: this._fallbackConfig }] : []
			})()

		for (const { root, config } of contexts) {
			for (const relativePath of config.getHunkAssignedFiles()) {
				const uri = vscode.Uri.joinPath(root, relativePath)
				await this.refreshForUri(uri)
			}
		}
	}
}
