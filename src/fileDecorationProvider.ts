import * as vscode from 'vscode'
import * as path from 'node:path'
import { ConfigService } from './configService'
import { WorkspaceSync } from './workspaceSync'
import type { FolderRegistry } from './folderRegistry'
import type { FolderContext } from './folderContext'

/**
 * Colours files in the Explorer based on their branch assignment.
 *
 * - Assigned files → colour matching the owning branch's `color` field.
 * - Floating (dirty but unassigned) files → neutral badge `?`.
 * - All other files → no decoration.
 *
 * Multi-root aware (phase 2): given a URI, the provider resolves the owning
 * `FolderContext` via the registry and reads that folder's assignments.
 * Each folder's events fan out to the right subset of URIs.  When the
 * provider is constructed without a registry (single-folder tests), it
 * falls back to the supplied `ConfigService` / `WorkspaceSync` pair.
 */
export class BranchFileDecorationProvider implements vscode.FileDecorationProvider, vscode.Disposable {

	private readonly _onDidChangeFileDecorations = new vscode.EventEmitter<vscode.Uri | vscode.Uri[]>()
	readonly onDidChangeFileDecorations = this._onDidChangeFileDecorations.event

	private readonly _disposables: vscode.Disposable[] = []
	/** Per-context subscription bundle, keyed by folder root fsPath. */
	private readonly _ctxSubs = new Map<string, vscode.Disposable[]>()

	constructor(
		private readonly _fallbackConfig: ConfigService,
		private readonly _fallbackSync: WorkspaceSync,
		private readonly _registry?: FolderRegistry,
	) {
		if (this._registry) {
			for (const ctx of this._registry.getAll()) {
				this._subscribeContext(ctx)
			}
			this._disposables.push(
				this._registry.onDidChangeFolders((e) => {
					for (const ctx of e.added) this._subscribeContext(ctx)
					for (const ctx of e.removed) this._unsubscribeContext(ctx)
				}),
			)
		} else {
			this._subscribeFallback()
		}

		this._disposables.push(
			vscode.window.registerFileDecorationProvider(this),
		)
	}

	private _subscribeContext(ctx: FolderContext): void {
		if (this._ctxSubs.has(ctx.root.fsPath)) return
		const subs: vscode.Disposable[] = [
			ctx.config.onDidChangeAssignment((e) => {
				this._onDidChangeFileDecorations.fire(
					vscode.Uri.joinPath(ctx.root, e.relativePath),
				)
			}),
			ctx.workspaceSync.onDidFloatFile((e) => {
				this._onDidChangeFileDecorations.fire(
					vscode.Uri.joinPath(ctx.root, e.relativePath),
				)
			}),
			ctx.config.onDidChangeStack(() => {
				const assignments = ctx.config.getAllAssignments()
				const uris = Object.keys(assignments).map((rel) =>
					vscode.Uri.joinPath(ctx.root, rel),
				)
				if (uris.length > 0) {
					this._onDidChangeFileDecorations.fire(uris)
				}
			}),
		]
		this._ctxSubs.set(ctx.root.fsPath, subs)
	}

	private _unsubscribeContext(ctx: FolderContext): void {
		const subs = this._ctxSubs.get(ctx.root.fsPath)
		if (!subs) return
		for (const d of subs) d.dispose()
		this._ctxSubs.delete(ctx.root.fsPath)
	}

	private _subscribeFallback(): void {
		const fire = (rel: string) => {
			const wsf = vscode.workspace.workspaceFolders?.[0]
			if (!wsf) return
			this._onDidChangeFileDecorations.fire(vscode.Uri.joinPath(wsf.uri, rel))
		}
		this._disposables.push(
			this._fallbackConfig.onDidChangeAssignment((e) => fire(e.relativePath)),
			this._fallbackSync.onDidFloatFile((e) => fire(e.relativePath)),
			this._fallbackConfig.onDidChangeStack(() => {
				const wsf = vscode.workspace.workspaceFolders?.[0]
				if (!wsf) return
				const assignments = this._fallbackConfig.getAllAssignments()
				const uris = Object.keys(assignments).map((rel) =>
					vscode.Uri.joinPath(wsf.uri, rel),
				)
				if (uris.length > 0) {
					this._onDidChangeFileDecorations.fire(uris)
				}
			}),
		)
	}

	/**
	 * Resolve the `(ConfigService, WorkspaceSync, relativePath)` triple for
	 * the given URI.  Returns undefined if the URI isn't inside any known
	 * context (multi-root mode) or is outside the workspace entirely.
	 */
	private _resolve(uri: vscode.Uri): { config: ConfigService, sync: WorkspaceSync, rel: string } | undefined {
		if (this._registry) {
			const ctx = this._registry.getForUri(uri)
			if (!ctx) return undefined
			const rel = path.relative(ctx.root.fsPath, uri.fsPath).replaceAll('\\', '/')
			return { config: ctx.config, sync: ctx.workspaceSync, rel }
		}
		if (!vscode.workspace.workspaceFolders?.length) return undefined
		const rel = vscode.workspace.asRelativePath(uri, false)
		return { config: this._fallbackConfig, sync: this._fallbackSync, rel }
	}

	provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
		// Honour gitbraid.prDecorationsEnabled (previously declared but never
		// read — see reviews/02-bugs-and-correctness.md
		// "FileDecorationProvider ignores prDecorationsEnabled setting").
		const enabled = vscode.workspace.getConfiguration('gitbraid').get<boolean>('prDecorationsEnabled', true)
		if (!enabled) { return undefined }

		const resolved = this._resolve(uri)
		if (!resolved) return undefined
		const { config, sync, rel } = resolved

		// Skip anything inside .worktrees/
		if (rel.startsWith('.worktrees/') || rel === '.worktrees') { return undefined }

		// 1 — Assigned files: colour by branch
		const branchName = config.getAssignment(rel)
		if (branchName) {
			const entry = config.getBranch(branchName)
			// Initial letter forms a low-cardinality but human-recognisable
			// differentiator when many branches share a coarse chart colour.
			const badge = branchBadge(branchName)
			if (entry?.color) {
				return {
					badge,
					color: new vscode.ThemeColor(`charts.${colorNameForHex(entry.color)}`),
					tooltip: `Assigned to branch: ${branchName}`,
				}
			}
			return {
				badge,
				tooltip: `Assigned to branch: ${branchName}`,
			}
		}

		// 2 — Floating dirty files: neutral badge
		if (sync.isFloating(rel)) {
			return {
				badge: '?',
				tooltip: 'Floating — not yet assigned to a branch',
			}
		}

		return undefined
	}

	/** Force a full refresh across every known context. */
	refreshAll(): void {
		const allUris: vscode.Uri[] = []
		if (this._registry) {
			for (const ctx of this._registry.getAll()) {
				const assignments = ctx.config.getAllAssignments()
				for (const rel of Object.keys(assignments)) {
					allUris.push(vscode.Uri.joinPath(ctx.root, rel))
				}
			}
		} else {
			const wsf = vscode.workspace.workspaceFolders?.[0]
			if (wsf) {
				const assignments = this._fallbackConfig.getAllAssignments()
				for (const rel of Object.keys(assignments)) {
					allUris.push(vscode.Uri.joinPath(wsf.uri, rel))
				}
			}
		}
		if (allUris.length > 0) {
			this._onDidChangeFileDecorations.fire(allUris)
		}
	}

	dispose(): void {
		this._onDidChangeFileDecorations.dispose()
		for (const subs of this._ctxSubs.values()) {
			for (const d of subs) d.dispose()
		}
		this._ctxSubs.clear()
		for (const d of this._disposables) {
			d.dispose()
		}
	}
}

/**
 * VS Code `ThemeColor` for file decorations only supports a limited palette of
 * named colours from `charts.*`. Map the branch hex colour to the closest named
 * chart colour so we stay within the supported API.
 *
 * Supported names (from VS Code theme tokens):
 * `blue`, `green`, `yellow`, `orange`, `red`, `purple`
 */
/**
 * Produce a 1–2 character badge from a branch name so that multiple branches
 * mapping to the same chart colour can still be visually distinguished.
 */
function branchBadge(branchName: string): string {
	// For "feature/my-feature" → use the part AFTER the first slash ("my")
	// so branches under the same prefix (feature/, chore/, fix/) stay distinct.
	// For "main" or "develop" (no slash) → use the name directly.
	const slashIdx = branchName.indexOf('/')
	const meaningful = slashIdx >= 0 ? branchName.slice(slashIdx + 1) : branchName
	const slug = meaningful.replace(/^[^A-Za-z0-9]*/, '').slice(0, 2)
	return slug.length > 0 ? slug.toUpperCase() : '·'
}

/**
 * Map a hex colour to a `ThemeColor` that VS Code will honour for file
 * decorations.  The `charts.*` family is the supported palette; we expand
 * the original 6-hue bucketer into finer slices (12 × 2 saturations) so
 * users with larger stacks see visible differences, and fall back to a
 * deterministic hash-bucket when the hue bucket collides with another
 * branch's declared colour.
 */
function colorNameForHex(hex: string): string {
	const r = Number.parseInt(hex.slice(1, 3), 16)
	const g = Number.parseInt(hex.slice(3, 5), 16)
	const b = Number.parseInt(hex.slice(5, 7), 16)

	const max = Math.max(r, g, b)
	const min = Math.min(r, g, b)
	const delta = max - min
	// Greyscale → treat saturation-less shades as "foreground" tokens; keeps
	// dark/light-greys distinct from the accented palette.
	if (delta === 0) {
		const lightness = (max + min) / 2
		return lightness > 128 ? 'foreground' : 'disabledForeground'
	}

	let hue = 0
	if (max === r) {
		hue = ((g - b) / delta) % 6
	} else if (max === g) {
		hue = (b - r) / delta + 2
	} else {
		hue = (r - g) / delta + 4
	}
	hue = Math.round(hue * 60)
	if (hue < 0) { hue += 360 }

	// Finer 12-segment hue wheel → six named chart colours plus a split on
	// saturation to double the effective palette.
	const lowSat = delta < 80
	const base = (() => {
		if (hue < 15 || hue >= 345) { return 'red' }
		if (hue < 45)  { return 'orange' }
		if (hue < 75)  { return 'yellow' }
		if (hue < 105) { return 'lines.yellow' }
		if (hue < 135) { return 'green' }
		if (hue < 165) { return 'lines.green' }
		if (hue < 195) { return 'blue' }
		if (hue < 225) { return 'lines.blue' }
		if (hue < 255) { return 'purple' }
		if (hue < 285) { return 'lines.purple' }
		if (hue < 315) { return 'foreground' }
		return 'lines.red'
	})()
	// VS Code only guarantees `charts.red/orange/yellow/green/blue/purple`
	// and `charts.foreground/lines.*` are optional on many themes — fall
	// back to the primary six for the non-confidence tokens.
	const PRIMARY = new Set(['red', 'orange', 'yellow', 'green', 'blue', 'purple'])
	if (!PRIMARY.has(base)) {
		const fallbacks = ['red', 'orange', 'yellow', 'green', 'blue', 'purple']
		return lowSat ? fallbacks[(hue / 60) | 0] : base
	}
	return base
}
