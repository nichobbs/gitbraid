/**
 * Hunk decoration provider — plan 11.
 *
 * Paints coloured gutter bars and background tints on each text editor whose
 * file has attributed hunks.  One `TextEditorDecorationType` is created per
 * branch colour; they are re-used across files and re-created whenever the
 * stack changes colours.
 *
 * Solid bar  → committed hunk (the change is on the branch's HEAD).
 * Dashed bar → uncommitted/dirty hunk (change exists only in the worktree).
 *
 * The provider listens to:
 *  - `ParallelWorkspaceService.onDidChange`  — attribution recomputed
 *  - `vscode.window.onDidChangeActiveTextEditor` — new file opened
 *  - `vscode.workspace.onDidChangeConfiguration` for `gitbraid.showSuppressedHunks`
 *
 * To keep the class cheap to construct, decoration types are created lazily on
 * the first call to `refresh()`.
 */

import * as vscode from 'vscode'
import type { BranchStackEntry } from './configTypes'
import type { ConfigService } from './configService'
import type { ParallelWorkspaceService } from './parallelWorkspaceService'

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Convert a CSS hex colour (e.g. `#4CAF50`) to an rgba() string with the given alpha. */
function hexToRgba(hex: string, alpha: number): string {
	const h = hex.replace('#', '')
	const r = Number.parseInt(h.slice(0, 2), 16)
	const g = Number.parseInt(h.slice(2, 4), 16)
	const b = Number.parseInt(h.slice(4, 6), 16)
	return `rgba(${String(r)},${String(g)},${String(b)},${String(alpha)})`
}

/** Build a `vscode.DecorationRenderOptions` for a branch colour. */
function makeDecorationOptions(
	color: string,
	committed: boolean,
): vscode.DecorationRenderOptions {
	const rgba = hexToRgba(color, committed ? 0.2 : 0.1)
	const gutterColor = committed ? color : `${color}88`
	return {
		// Gutter icon is a thin coloured bar rendered via CSS borders.
		gutterIconPath: _makeGutterSvg(gutterColor, committed),
		gutterIconSize: 'auto',
		overviewRulerColor: color,
		overviewRulerLane: vscode.OverviewRulerLane.Right,
		isWholeLine: true,
		rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
		// VS Code 1.82+ accepts `backgroundColor` as a CSS string (rgba).
		// @ts-expect-error — string is valid at runtime since VS Code 1.82
		backgroundColor: rgba,
	}
}

/** Create a tiny inline SVG URI for the gutter bar. */
function _makeGutterSvg(color: string, solid: boolean): vscode.Uri {
	const dash = solid ? '' : 'stroke-dasharray="4,2"'
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="4" height="100%"><line x1="2" y1="0" x2="2" y2="100%" stroke="${color}" stroke-width="3" ${dash}/></svg>`
	return vscode.Uri.parse(`data:image/svg+xml;utf8,${encodeURIComponent(svg)}`)
}

// ─── Provider ─────────────────────────────────────────────────────────────────

/**
 * Key used to look up decoration type pairs: `${branch}:committed` or
 * `${branch}:uncommitted`.
 */
type DecoKey = `${string}:committed` | `${string}:uncommitted`

export class HunkDecorationProvider implements vscode.Disposable {
	private readonly _disposables: vscode.Disposable[] = []

	/** Maps `${branch}:committed` and `${branch}:uncommitted` to their types. */
	private readonly _decoTypes = new Map<DecoKey, vscode.TextEditorDecorationType>()

	constructor(
		private readonly _config: ConfigService,
		private readonly _pws: ParallelWorkspaceService,
	) {
		this._disposables.push(
			_pws.onDidChange(() => { this._refreshAll() }),
			vscode.window.onDidChangeActiveTextEditor((e) => {
				if (e) this._refreshEditor(e)
			}),
			vscode.workspace.onDidChangeConfiguration((e) => {
				if (e.affectsConfiguration('gitbraid.showSuppressedHunks')) {
					this._refreshAll()
				}
			}),
		)
	}

	dispose(): void {
		this._clearDecoTypes()
		for (const d of this._disposables) d.dispose()
	}

	// ── Public ─────────────────────────────────────────────────────────────────

	/** Force-refresh all visible text editors. */
	refreshAll(): void { this._refreshAll() }

	// ── Private ────────────────────────────────────────────────────────────────

	private _refreshAll(): void {
		// Rebuild decoration types (colours may have changed).
		this._clearDecoTypes()
		this._buildDecoTypes()
		for (const editor of vscode.window.visibleTextEditors) {
			this._refreshEditor(editor)
		}
	}

	private _refreshEditor(editor: vscode.TextEditor): void {
		const wsFolder = vscode.workspace.getWorkspaceFolder(editor.document.uri)
		if (!wsFolder) return

		const relPath = vscode.workspace.asRelativePath(editor.document.uri, false)
		const attribution = this._pws.attributionFor(relPath)

		// Build a map: decoKey → range[]
		const rangeMap = new Map<DecoKey, vscode.Range[]>()

		for (const hunk of attribution) {
			const key: DecoKey = `${hunk.branch}:${hunk.committed ? 'committed' : 'uncommitted'}`
			const list = rangeMap.get(key) ?? []
			// Line numbers in AttributedHunk are 1-based; VS Code ranges are 0-based.
			list.push(new vscode.Range(hunk.startLine - 1, 0, hunk.endLine - 1, 0))
			rangeMap.set(key, list)
		}

		// Apply decorations; clear any key not in the current attribution.
		for (const [key, decoType] of this._decoTypes) {
			const ranges = rangeMap.get(key) ?? []
			editor.setDecorations(decoType, ranges)
		}
	}

	private _buildDecoTypes(): void {
		const stack = this._config.getStack()
		for (const entry of stack) {
			this._getOrCreateDecoType(entry, true)
			this._getOrCreateDecoType(entry, false)
		}
	}

	private _getOrCreateDecoType(
		entry: BranchStackEntry,
		committed: boolean,
	): vscode.TextEditorDecorationType {
		const key: DecoKey = `${entry.name}:${committed ? 'committed' : 'uncommitted'}`
		const existing = this._decoTypes.get(key)
		if (existing) return existing
		const color = entry.color ?? '#888888'
		const deco = vscode.window.createTextEditorDecorationType(
			makeDecorationOptions(color, committed),
		)
		// Intentionally NOT added to _disposables — _clearDecoTypes() owns disposal.
		this._decoTypes.set(key, deco)
		return deco
	}

	private _clearDecoTypes(): void {
		for (const [, deco] of this._decoTypes) deco.dispose()
		this._decoTypes.clear()
	}
}
