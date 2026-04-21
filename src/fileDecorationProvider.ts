import * as vscode from 'vscode'
import { ConfigService } from './configService'
import { WorkspaceSync } from './workspaceSync'

/**
 * Colours files in the Explorer based on their branch assignment.
 *
 * - Assigned files → colour matching the owning branch's `color` field.
 * - Floating (dirty but unassigned) files → neutral badge `?`.
 * - All other files → no decoration.
 *
 * Decorations are refreshed automatically when assignments or floating-dirty
 * state changes.
 */
export class BranchFileDecorationProvider implements vscode.FileDecorationProvider, vscode.Disposable {

	private readonly _onDidChangeFileDecorations = new vscode.EventEmitter<vscode.Uri | vscode.Uri[]>()
	readonly onDidChangeFileDecorations = this._onDidChangeFileDecorations.event

	private readonly _disposables: vscode.Disposable[] = []

	constructor(
		private readonly _config: ConfigService,
		private readonly _sync: WorkspaceSync,
	) {
		// Re-fire when any assignment changes
		this._disposables.push(
			_config.onDidChangeAssignment((e) => {
				const wsf = vscode.workspace.workspaceFolders?.[0]
				if (!wsf) { return }
				this._onDidChangeFileDecorations.fire(
					vscode.Uri.joinPath(wsf.uri, e.relativePath)
				)
			}),
			_sync.onDidFloatFile((e) => {
				const wsf = vscode.workspace.workspaceFolders?.[0]
				if (!wsf) { return }
				this._onDidChangeFileDecorations.fire(
					vscode.Uri.joinPath(wsf.uri, e.relativePath)
				)
			}),
			// Refresh all when the stack changes (branch removed → clear colours)
			_config.onDidChangeStack(() => {
				const wsf = vscode.workspace.workspaceFolders?.[0]
				if (!wsf) { return }
				// Fire for all currently assigned URIs so stale colours clear
				const assignments = _config.getAllAssignments()
				const uris = Object.keys(assignments).map((rel) =>
					vscode.Uri.joinPath(wsf.uri, rel)
				)
				if (uris.length > 0) {
					this._onDidChangeFileDecorations.fire(uris)
				}
			}),
			vscode.window.registerFileDecorationProvider(this),
		)
	}

	provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
		if (!vscode.workspace.workspaceFolders?.length) { return undefined }

		// Honour gitbraid.prDecorationsEnabled (previously declared but never
		// read — see reviews/02-bugs-and-correctness.md
		// "FileDecorationProvider ignores prDecorationsEnabled setting").
		const enabled = vscode.workspace.getConfiguration('gitbraid').get<boolean>('prDecorationsEnabled', true)
		if (!enabled) { return undefined }

		const rel = vscode.workspace.asRelativePath(uri, false)

		// Skip anything inside .worktrees/
		if (rel.startsWith('.worktrees/') || rel === '.worktrees') { return undefined }

		// 1 — Assigned files: colour by branch
		const branchName = this._config.getAssignment(rel)
		if (branchName) {
			const entry = this._config.getBranch(branchName)
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
		if (this._sync.isFloating(rel)) {
			return {
				badge: '?',
				tooltip: 'Floating — not yet assigned to a branch',
			}
		}

		return undefined
	}

	/** Force a full refresh of all decorations (e.g. after a stack reorder). */
	refreshAll(): void {
		const wsf = vscode.workspace.workspaceFolders?.[0]
		if (!wsf) { return }
		const assignments = this._config.getAllAssignments()
		const uris = Object.keys(assignments).map((rel) =>
			vscode.Uri.joinPath(wsf.uri, rel)
		)
		if (uris.length > 0) {
			this._onDidChangeFileDecorations.fire(uris)
		}
	}

	dispose(): void {
		this._onDidChangeFileDecorations.dispose()
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
	const slug = branchName.replace(/^[^A-Za-z0-9]*/, '').slice(0, 2)
	return slug.length > 0 ? slug.toUpperCase() : '·'
}

function colorNameForHex(hex: string): string {
	// Parse to RGB
	const r = Number.parseInt(hex.slice(1, 3), 16)
	const g = Number.parseInt(hex.slice(3, 5), 16)
	const b = Number.parseInt(hex.slice(5, 7), 16)

	// Very simple hue-based mapping
	const max = Math.max(r, g, b)
	const min = Math.min(r, g, b)
	const delta = max - min
	if (delta === 0) { return 'blue' }

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

	if (hue < 30)  { return 'red' }
	if (hue < 75)  { return 'orange' }
	if (hue < 150) { return 'yellow' }
	if (hue < 195) { return 'green' }
	if (hue < 255) { return 'blue' }
	if (hue < 315) { return 'purple' }
	return 'red'
}
