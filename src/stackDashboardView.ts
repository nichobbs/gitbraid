import * as vscode from 'vscode'
import { log } from './channelLogger'
import { FolderRegistry } from './folderRegistry'
import { FolderContext } from './folderContext'
import { PRAwareness } from './prAwareness'
import { buildSnapshot, ChecksStatus } from './dashboardSnapshot'
import { git } from './gitFunctions'
import { worktreePath } from './branchStackService'
import { DashboardRequest, parseRequest } from './dashboardMessages'
import { defaultDashboardDeps, handleDashboardRequest } from './commands/dashboardCommands'

/**
 * Plan 02 — the stacked-PR dashboard webview.
 *
 * Renders the active folder's branch stack as a vertical list with each
 * branch's PR status and a small action row.  The webview posts messages
 * back to the extension host to run commands:
 *
 *   { cmd: 'submit' }
 *   { cmd: 'openPr', branch }
 *   { cmd: 'switch', branch }
 *   { cmd: 'rebase', branch }
 *
 * The rendering pipeline is split so `buildDashboardHtml` can be called
 * without a real webview (used in unit tests).
 *
 * Wave A (2026-04-25) extended the rendering with: current-branch
 * marker, assigned-files count, ahead/behind commit badges, single-
 * commit icon, floating-files banner, checks-status pill, and an
 * adapter-identity strip at the bottom of the view.  See
 * `docs/plans/02-pr-stack-visualisation.md`.
 */

export interface DashboardBranchRow {
	name: string
	base: string
	order: number
	color: string
	scratch?: boolean
	prNumber?: number
	prState?: 'open' | 'draft' | 'merged' | 'closed'
	prTitle?: string
	prUrl?: string
	behindCount?: number

	// ── Wave A additions (all optional, all surface gracefully) ─────────
	isCurrent?: boolean
	assignedFilesCount?: number
	singleCommit?: boolean
	aheadCount?: number
	checksStatus?: ChecksStatus

	// ── Follow-up: review + checks detail (populated only when the PR
	// host adapter is configured; otherwise the drawer is hidden). ─────
	reviewState?: 'approved' | 'changesRequested' | 'commented' | 'pending'
	reviewCount?: number
	checksDetail?: ReadonlyArray<{ name: string; state: ChecksStatus; url?: string }>

	// ── Wave C drill-down (optional; sections hide when absent/empty) ──
	commits?: ReadonlyArray<{ shortSha: string, subject: string, sha: string }>
	assignedFiles?: readonly string[]

	// ── Follow-up: PR-body preview of the rendered stack block. ─────────
	stackBlockPreview?: string
}

export interface DashboardBanners {
	floatingCount?: number
}

export interface DashboardAdapter {
	label: string
}

export interface DashboardData {
	workspaceName: string
	branches: DashboardBranchRow[]
	banners?: DashboardBanners
	adapter?: DashboardAdapter
}

export class StackDashboardView implements vscode.WebviewViewProvider, vscode.Disposable {
	static readonly viewType = 'gitbraid.stackDashboard'

	private _view: vscode.WebviewView | undefined
	private readonly _disposables: vscode.Disposable[] = []

	constructor(
		private readonly _registry: FolderRegistry,
		private readonly _prAwareness: PRAwareness,
		private readonly _extensionUri: vscode.Uri,
	) {
		this._disposables.push(
			this._prAwareness.onDidChange(() => this.refresh()),
			this._registry.onDidChangeFolders(() => this.refresh()),
		)
		// Rewire per-folder events whenever the set of folders changes.
		this._wireFolderEvents()
	}

	resolveWebviewView(view: vscode.WebviewView): void {
		this._view = view
		view.webview.options = {
			enableScripts: true,
			localResourceRoots: [this._extensionUri],
		}
		view.webview.onDidReceiveMessage((msg) => { void this._handleMessage(msg) }, undefined, this._disposables)
		this.refresh()
	}

	refresh(): void {
		void this._refreshAsync()
	}

	private async _refreshAsync(): Promise<void> {
		if (!this._view) return
		const data = await this._collect()
		// `_view` may have been disposed between the await and now.
		if (!this._view) return
		this._view.webview.html = buildDashboardHtml(data, this._view.webview.cspSource)
	}

	dispose(): void {
		for (const d of this._disposables) d.dispose()
	}

	private _wireFolderEvents(): void {
		const wire = (ctx: FolderContext) => {
			this._disposables.push(
				ctx.config.onDidChangeStack(() => this.refresh()),
				ctx.config.onDidChangeAssignment(() => this.refresh()),
			)
		}
		for (const ctx of this._registry.getAll()) wire(ctx)
		this._disposables.push(this._registry.onDidChangeFolders((e) => {
			for (const ctx of e.added) wire(ctx)
		}))
	}

	private async _collect(): Promise<DashboardData> {
		const ctx = this._registry.getActive() ?? this._registry.getAll()[0]
		if (!ctx) {
			return { workspaceName: 'no folder', branches: [] }
		}
		let currentBranch: string | undefined
		try {
			const raw = await git.branch(ctx.root)
			currentBranch = typeof raw === 'string' && raw.length > 0 ? raw.trim() : undefined
		} catch { /* best effort */ }

		const adapter = await ctx.getPRAdapter().catch(() => undefined)
		const adapterLabel = adapter ? describeAdapter(adapter.name) : 'None'

		const snapshot = await buildSnapshot({
			config: ctx.config,
			sync: ctx.workspaceSync,
			prAwareness: this._prAwareness,
			workspaceRootFsPath: ctx.root.fsPath,
			worktreeDirOf: (b) =>
				ctx.branchStack.worktreeExists(b)
					? worktreePath(ctx.root, b).fsPath
					: undefined,
			currentBranch,
			adapter: { name: adapter?.name ?? 'none', label: adapterLabel },
			loadCommits: (branch, base, worktreeDir) =>
				ctx.commitList.listCommits(worktreeDir, branch, base),
			loadPrDetail: adapter && adapter.name !== 'none'
				? async (branch) => {
					const pr = await adapter.getPR(branch)
					if (!pr) return undefined
					return {
						reviewState: pr.reviewState,
						reviewCount: pr.reviewCount,
						checksDetail: pr.checksDetail,
					}
				}
				: undefined,
		})

		return {
			workspaceName: snapshot.workspaceName,
			branches: snapshot.branches.map((b) => ({
				name: b.name,
				base: b.base,
				order: b.order,
				color: b.color,
				scratch: b.scratch,
				prNumber: b.prNumber,
				prState: b.prState,
				prTitle: b.prTitle,
				prUrl: b.prUrl,
				behindCount: b.behindCount,
				isCurrent: b.isCurrent,
				assignedFilesCount: b.assignedFilesCount,
				singleCommit: b.singleCommit,
				aheadCount: b.aheadCount,
				checksStatus: b.checksStatus,
				reviewState: b.reviewState,
				reviewCount: b.reviewCount,
				checksDetail: b.checksDetail,
				commits: b.commits?.map((c) => ({
					shortSha: c.shortSha, subject: c.subject, sha: c.sha,
				})),
				assignedFiles: b.assignedFiles,
				stackBlockPreview: b.stackBlockPreview,
			})),
			banners: { floatingCount: snapshot.banners.floatingCount },
			adapter: snapshot.adapter ? { label: snapshot.adapter.label } : undefined,
		}
	}

	private async _handleMessage(msg: unknown): Promise<void> {
		// Accept both the Wave B typed contract (`{ kind, ... }`) and the
		// original `{ cmd, branch }` shape so older webview builds still
		// route correctly.  Falls through to `handleDashboardRequest` after
		// normalising.
		const req = parseRequest(msg) ?? parseLegacyCmd(msg)
		if (!req) {
			log.warn(`StackDashboardView: unparseable message — ${JSON.stringify(msg)}`)
			return
		}
		try {
			await handleDashboardRequest(req, defaultDashboardDeps())
		} catch (e) {
			log.error(`StackDashboardView._handleMessage: ${e instanceof Error ? e.message : String(e)}`)
		}
	}
}

/**
 * Back-compat shim for the original `{ cmd: 'submit' | 'openPr' | ... }`
 * webview messages.  Maps to the typed request union so both paths
 * funnel through the same dispatcher.
 */
function parseLegacyCmd(msg: unknown): DashboardRequest | undefined {
	if (typeof msg !== 'object' || msg === null) return undefined
	const m = msg as Record<string, unknown>
	const cmd = typeof m.cmd === 'string' ? m.cmd : undefined
	const branch = typeof m.branch === 'string' ? m.branch : undefined
	switch (cmd) {
		case 'submit':  return { kind: 'submit' }
		case 'refresh': return { kind: 'refresh' }
		case 'openPr':  return branch ? { kind: 'openPr', branch } : undefined
		case 'rebase':  return branch ? { kind: 'rebase', branch } : undefined
		case 'switch':  return branch ? { kind: 'switchBranch', branch } : undefined
		default: return undefined
	}
}

// ─── HTML rendering (exported for tests) ─────────────────────────────────────

export function buildDashboardHtml(data: DashboardData, cspSource = "'self'"): string {
	const safe = escapeHtml
	const nonce = simpleNonce()
	const floating = data.banners?.floatingCount ?? 0

	const banner = floating > 0
		? `<div class="banner floating" data-testid="floating-banner">
			<span class="icon">$(warning)</span>
			<span>${String(floating)} floating file${floating === 1 ? '' : 's'} — not assigned to any branch.</span>
		</div>`
		: ''

	const rows = data.branches.length === 0
		? `<p class="empty">Stack is empty. Run <code>gitbraid.addStackBranch</code> to get started.</p>`
		: data.branches.map((b, i) => buildBranchRowHtml(b, i, data.branches.length)).join('\n')

	const adapterStrip = data.adapter
		? `<footer class="adapter" data-testid="adapter-strip">PR host: ${safe(data.adapter.label)}</footer>`
		: ''

	return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
	body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); margin: 0; padding: 12px; }
	.header { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 8px; }
	.header h2 { font-size: 13px; font-weight: 600; margin: 0; }
	.toolbar button { font-size: 11px; padding: 2px 8px; }
	.banner { display: flex; gap: 6px; align-items: center; padding: 6px 8px; margin-bottom: 8px; border-radius: 3px; font-size: 11px; }
	.banner.floating { background: var(--vscode-inputValidation-warningBackground); color: var(--vscode-inputValidation-warningForeground); border: 1px solid var(--vscode-inputValidation-warningBorder); }
	ul.stack { list-style: none; padding: 0; margin: 0; }
	li.row { display: flex; align-items: stretch; margin-bottom: 8px; }
	.connector { width: 12px; border-left: 2px solid var(--vscode-panel-border); margin-right: 8px; }
	.connector.first { border-top: none; }
	.node { flex: 1; border: 1px solid var(--vscode-panel-border); border-left-width: 4px; padding: 6px 8px; border-radius: 3px; background: var(--vscode-sideBar-background); }
	.node.current-branch { box-shadow: 0 0 0 1px var(--vscode-focusBorder); }
	.title { display: flex; justify-content: space-between; font-weight: 600; font-size: 12px; }
	.title .branch { display: inline-flex; align-items: center; gap: 4px; }
	.title .base { color: var(--vscode-descriptionForeground); font-weight: normal; }
	.current { color: var(--vscode-charts-green); }
	.singleCommit { color: var(--vscode-charts-purple); font-size: 14px; line-height: 1; }
	.meta { font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 2px; display: flex; gap: 6px; flex-wrap: wrap; }
	.meta .pr { padding: 0 4px; border-radius: 2px; }
	.meta .files { padding: 0 4px; }
	.meta .aheadBehind { font-family: var(--vscode-editor-font-family); }
	.state-open { color: var(--vscode-charts-green); }
	.state-draft { color: var(--vscode-charts-yellow); }
	.state-merged { color: var(--vscode-charts-purple); }
	.state-closed { color: var(--vscode-charts-red); }
	.checks { padding: 0 4px; border-radius: 2px; font-weight: 600; }
	.checks-success { color: var(--vscode-testing-iconPassed, var(--vscode-charts-green)); }
	.checks-pending { color: var(--vscode-testing-iconQueued, var(--vscode-charts-yellow)); }
	.checks-failure { color: var(--vscode-testing-iconFailed, var(--vscode-charts-red)); }
	.actions { margin-top: 4px; display: flex; gap: 4px; align-items: center; }
	.actions button { font-size: 11px; padding: 1px 6px; }
	.actions button.more { margin-left: auto; padding: 1px 7px; font-weight: bold; }
	.toolbar input#search { font-size: 11px; padding: 2px 6px; margin-right: 4px; min-width: 100px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 2px; }
	details.drawer { margin-top: 6px; font-size: 11px; }
	details.drawer summary { cursor: pointer; user-select: none; color: var(--vscode-descriptionForeground); }
	details.drawer summary .count { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); border-radius: 8px; padding: 0 6px; font-size: 10px; margin-left: 4px; }
	details.drawer ul.drawer-list { list-style: none; padding: 2px 0 0 8px; margin: 0; max-height: 160px; overflow-y: auto; }
	details.drawer li { padding: 1px 0; }
	details.drawer li button.commit { background: transparent; color: inherit; border: 0; padding: 0; text-align: left; cursor: pointer; font: inherit; }
	details.drawer li button.commit:hover { text-decoration: underline; }
	details.drawer code { font-family: var(--vscode-editor-font-family); font-size: 11px; }
	details.drawer pre.body-preview { font-family: var(--vscode-editor-font-family); font-size: 11px; white-space: pre-wrap; margin: 4px 0 0 8px; padding: 6px 8px; background: var(--vscode-textBlockQuote-background, rgba(127,127,127,0.08)); border-left: 2px solid var(--vscode-textBlockQuote-border, var(--vscode-panel-border)); border-radius: 2px; max-height: 200px; overflow-y: auto; }
	details.drawer .reviews-body { padding: 2px 0 0 8px; }
	details.drawer .review-state { font-weight: 600; padding: 2px 0; }
	details.drawer .review-approved { color: var(--vscode-charts-green); }
	details.drawer .review-changesRequested { color: var(--vscode-charts-red); }
	details.drawer .review-commented { color: var(--vscode-charts-yellow); }
	details.drawer .review-pending { color: var(--vscode-descriptionForeground); }
	details.drawer ul.checks-list { padding: 2px 0 0 4px; }
	details.drawer .check-icon { display: inline-block; width: 1.25em; text-align: center; }
	details.drawer .check-success .check-icon { color: var(--vscode-testing-iconPassed, var(--vscode-charts-green)); }
	details.drawer .check-failure .check-icon { color: var(--vscode-testing-iconFailed, var(--vscode-charts-red)); }
	details.drawer .check-pending .check-icon { color: var(--vscode-testing-iconQueued, var(--vscode-charts-yellow)); }
	.empty { color: var(--vscode-descriptionForeground); font-size: 12px; }
	footer.adapter { margin-top: 10px; padding-top: 6px; border-top: 1px solid var(--vscode-panel-border); font-size: 10px; color: var(--vscode-descriptionForeground); }
	#menu { position: fixed; display: none; background: var(--vscode-menu-background); color: var(--vscode-menu-foreground); border: 1px solid var(--vscode-menu-border, var(--vscode-panel-border)); box-shadow: 0 2px 8px rgba(0,0,0,0.3); border-radius: 2px; padding: 2px 0; z-index: 100; min-width: 180px; font-size: 12px; }
	#menu[aria-hidden="false"] { display: block; }
	#menu button { display: block; width: 100%; text-align: left; background: transparent; color: inherit; border: 0; padding: 4px 10px; cursor: pointer; font-size: inherit; }
	#menu button:hover, #menu button:focus { background: var(--vscode-menu-selectionBackground); color: var(--vscode-menu-selectionForeground); outline: none; }
	#menu hr { border: 0; border-top: 1px solid var(--vscode-menu-separatorBackground, var(--vscode-panel-border)); margin: 4px 0; }
</style>
</head>
<body>
	<div class="header">
		<h2>Stack — ${safe(data.workspaceName)}</h2>
		<div class="toolbar">
			<input type="search" id="search" placeholder="Filter…" aria-label="Filter branches" data-testid="search-input" />
			<button data-kind="addBranch"      title="Add a branch to the stack">Add</button>
			<button data-kind="refresh"        title="Refresh PR status">Refresh</button>
			<button data-kind="submit"         title="Submit / update stacked PRs">Submit</button>
			<button data-kind="mergeStack"     title="Drive the stack through the merge queue">Merge</button>
			<button data-kind="saveCheckpoint" title="Save a stack checkpoint">Checkpoint</button>
			<button data-kind="showUndoLog"    title="Show / replay the undo log">Undo…</button>
		</div>
	</div>
	${banner}
	<ul class="stack">
		${rows}
	</ul>
	${adapterStrip}
	<div id="menu" role="menu" aria-hidden="true"></div>
	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi()
		const menu = document.getElementById('menu')
		const searchInput = document.getElementById('search')

		// ── State persistence (Wave C) ────────────────────────────────
		// Shape: { query: string, openDrawers: Record<stateKey, boolean> }
		let state = vscode.getState() || { query: '', openDrawers: {} }
		function saveState() { vscode.setState(state) }

		function applyFilter() {
			const q = (state.query || '').toLowerCase().trim()
			const rows = document.querySelectorAll('li.row')
			for (const row of rows) {
				const hay = row.dataset.search || ''
				row.style.display = !q || hay.includes(q) ? '' : 'none'
			}
		}

		function restoreDrawers() {
			const drawers = document.querySelectorAll('details.drawer[data-state-key]')
			for (const d of drawers) {
				const key = d.dataset.stateKey
				if (!key) continue
				const open = state.openDrawers && state.openDrawers[key]
				if (open) d.setAttribute('open', 'open')
			}
		}

		function post(req) { vscode.postMessage(req) }

		function closeMenu() {
			menu.setAttribute('aria-hidden', 'true')
			menu.dataset.branch = ''
			menu.innerHTML = ''
		}

		function openMenu(button) {
			const branch = button.dataset.moreBranch
			const prUrl = button.dataset.branchPrUrl || ''
			if (!branch) return
			menu.dataset.branch = branch
			menu.innerHTML = [
				{ kind: 'switchBranch',        label: 'Switch to this branch' },
				{ kind: 'commit',              label: 'Commit…' },
				{ kind: 'pushBranch',          label: 'Push' },
				{ sep: true },
				{ kind: 'moveBranchUp',        label: 'Move up' },
				{ kind: 'moveBranchDown',      label: 'Move down' },
				{ sep: true },
				{ kind: 'absorbHunks',         label: 'Absorb hunks…' },
				{ kind: 'routeHunks',          label: 'Route hunks…' },
				{ kind: 'toggleSingleCommit',  label: 'Toggle single-commit mode' },
				{ kind: 'setCommitTemplate',   label: 'Set commit template…' },
				{ sep: true },
				{ kind: 'openWorktree',        label: 'Open worktree in new window' },
				{ kind: 'copyBranchName',      label: 'Copy branch name' },
				{ kind: 'copyPrUrl',           label: 'Copy PR URL', disabled: !prUrl, extra: { url: prUrl } },
				{ sep: true },
				{ kind: 'removeBranch',        label: 'Remove from stack…' },
			].map((item) => {
				if (item.sep) return '<hr>'
				const disabled = item.disabled ? 'disabled' : ''
				const extra = item.extra ? ' data-extra=\\'' + JSON.stringify(item.extra).replace(/'/g, '&#39;') + '\\'' : ''
				return '<button role="menuitem" data-kind="' + item.kind + '" data-menu-branch="' + branch + '"' + extra + ' ' + disabled + '>' + item.label + '</button>'
			}).join('')
			const r = button.getBoundingClientRect()
			const mw = 200
			const left = Math.min(window.innerWidth - mw - 8, r.right - mw)
			menu.style.left = Math.max(8, left) + 'px'
			menu.style.top = (r.bottom + 4) + 'px'
			menu.setAttribute('aria-hidden', 'false')
		}

		document.body.addEventListener('click', (e) => {
			const target = e.target
			if (!target || target.nodeType !== 1) return

			if (target.classList && target.classList.contains('more')) {
				openMenu(target)
				e.stopPropagation()
				return
			}

			if (menu.contains(target) && target.dataset && target.dataset.kind) {
				const kind = target.dataset.kind
				const branch = target.dataset.menuBranch
				let req = branch ? { kind: kind, branch: branch } : { kind: kind }
				try {
					if (target.dataset.extra) {
						const extra = JSON.parse(target.dataset.extra)
						req = Object.assign(req, extra)
					}
				} catch { /* ignore */ }
				post(req)
				closeMenu()
				return
			}

			if (menu.getAttribute('aria-hidden') === 'false' && !menu.contains(target)) {
				closeMenu()
			}

			const el = target.closest('[data-kind]')
			if (!el) return
			const kind = el.dataset.kind
			const branch = el.dataset.branch
			post(branch ? { kind: kind, branch: branch } : { kind: kind })
		})

		window.addEventListener('keydown', (e) => {
			if (e.key === 'Escape' && menu.getAttribute('aria-hidden') === 'false') {
				closeMenu()
			}
		})

		// ── Search (Wave C) ────────────────────────────────────────────
		if (searchInput) {
			searchInput.value = state.query || ''
			searchInput.addEventListener('input', () => {
				state.query = searchInput.value
				applyFilter()
				saveState()
			})
		}

		// ── Drawer persistence (Wave C) ────────────────────────────────
		document.body.addEventListener('toggle', (e) => {
			const target = e.target
			if (!target || target.tagName !== 'DETAILS') return
			const key = target.dataset.stateKey
			if (!key) return
			state.openDrawers = state.openDrawers || {}
			state.openDrawers[key] = target.hasAttribute('open')
			saveState()
		}, true)

		// Initial restore — run after DOM settles so <details> elements
		// exist before we flip them open.
		restoreDrawers()
		applyFilter()

		// Delta-patch path — swap a single row's markup in place without
		// a full re-hydrate so the user's scroll/focus state survives.
		window.addEventListener('message', (ev) => {
			const msg = ev.data
			if (!msg || typeof msg !== 'object') return
			if (msg.kind === 'patchRow' && typeof msg.branchName === 'string' && typeof msg.html === 'string') {
				const target = document.querySelector('li.row[data-branch="' + CSS.escape(msg.branchName) + '"]')
				if (!target) return
				const tpl = document.createElement('template')
				tpl.innerHTML = msg.html.trim()
				const next = tpl.content.firstElementChild
				if (next) {
					target.replaceWith(next)
					restoreDrawers()
					applyFilter()
				}
			}
		})
	</script>
</body>
</html>`
}

// ─── Delta patching (Wave B) ────────────────────────────────────────────────

/**
 * Wave B host-side delta helper: compose the `<li class="row">` markup
 * for a single branch so the provider can push it as a patch message
 * without re-rendering the whole HTML.
 *
 * Kept in-module (rather than re-using `buildDashboardHtml`) so the row
 * markup stays consistent across full-render and patched-render paths.
 */
export function buildBranchRowHtml(b: DashboardBranchRow, i: number, total: number): string {
	const safe = escapeHtml
	const pr = b.prNumber ? `#${String(b.prNumber)}` : '—'
	const state = b.prState ?? 'no PR'
	const stateClass = b.prState ?? 'none'
	const currentMarker = b.isCurrent
		? `<span class="current" title="Currently checked out" data-testid="current-marker">●</span>`
		: ''
	const singleCommitIcon = b.singleCommit
		? `<span class="singleCommit" title="Single-commit mode" data-testid="single-commit-icon">⦿</span>`
		: ''
	const filesCount = (b.assignedFilesCount ?? 0) > 0
		? `<span class="files" data-testid="files-count" title="${String(b.assignedFilesCount)} file(s) assigned">📄 ${String(b.assignedFilesCount)}</span>`
		: ''
	const aheadBehind = formatAheadBehind(b.aheadCount, b.behindCount)
	const checksPill = b.checksStatus
		? `<span class="checks checks-${safe(b.checksStatus)}" data-testid="checks-${safe(b.checksStatus)}" title="Checks: ${safe(b.checksStatus)}">${checksGlyph(b.checksStatus)}</span>`
		: ''

	const commitsSection = (b.commits && b.commits.length > 0)
		? `<details class="drawer commits" data-testid="commits-drawer-${safe(b.name)}" data-state-key="commits:${safe(b.name)}">
			<summary>Commits <span class="count">${String(b.commits.length)}</span></summary>
			<ul class="drawer-list">
				${b.commits.map((c) => `<li><button class="commit" data-kind="openCommit" data-sha="${safe(c.sha)}" data-branch="${safe(b.name)}" title="${safe(c.sha)}"><code>${safe(c.shortSha)}</code> ${safe(c.subject)}</button></li>`).join('')}
			</ul>
		</details>`
		: ''

	const filesSection = (b.assignedFiles && b.assignedFiles.length > 0)
		? `<details class="drawer files" data-testid="files-drawer-${safe(b.name)}" data-state-key="files:${safe(b.name)}">
			<summary>Files <span class="count">${String(b.assignedFiles.length)}</span></summary>
			<ul class="drawer-list">
				${b.assignedFiles.map((f) => `<li><code>${safe(f)}</code></li>`).join('')}
			</ul>
		</details>`
		: ''

	// PR-body preview: shows the rendered `<!-- gitbraid:stack-start -->`
	// block that `submitStack` would inject.  Hidden when there's nothing
	// to preview (single-branch stack or missing preview data).
	const bodyPreviewSection = (b.stackBlockPreview && b.stackBlockPreview.trim().length > 0)
		? `<details class="drawer body" data-testid="body-drawer-${safe(b.name)}" data-state-key="body:${safe(b.name)}">
			<summary>PR body preview</summary>
			<pre class="body-preview">${safe(b.stackBlockPreview)}</pre>
		</details>`
		: ''

	// Reviews & checks drawer — rendered only when the PR host adapter
	// supplied detail.  Each check row links out to its external URL
	// when the host provides one.
	const reviewsChecksSection = (b.reviewState || b.reviewCount || (b.checksDetail && b.checksDetail.length > 0))
		? `<details class="drawer reviews" data-testid="reviews-drawer-${safe(b.name)}" data-state-key="reviews:${safe(b.name)}">
			<summary>Reviews &amp; checks${b.reviewCount ? ` <span class="count">${String(b.reviewCount)}</span>` : ''}</summary>
			<div class="reviews-body">
				${b.reviewState ? `<div class="review-state review-${safe(b.reviewState)}" data-testid="review-state-${safe(b.reviewState)}">${reviewStateGlyph(b.reviewState)} ${safe(b.reviewState)}</div>` : ''}
				${b.checksDetail && b.checksDetail.length > 0
					? `<ul class="drawer-list checks-list">
						${b.checksDetail.map((c) => `<li class="check check-${safe(c.state)}"><span class="check-icon">${checksGlyph(c.state)}</span> <code>${safe(c.name)}</code>${c.url ? ` <a href="${safe(c.url)}">open</a>` : ''}</li>`).join('')}
					</ul>`
					: ''}
			</div>
		</details>`
		: ''

	return `<li class="row" data-branch="${safe(b.name)}" data-search="${safe(b.name.toLowerCase())}${b.prTitle ? ' ' + safe(b.prTitle.toLowerCase()) : ''}${b.prNumber ? ' #' + String(b.prNumber) : ''}">
	<div class="${connectorClass(i, total)}"></div>
	<div class="node ${b.isCurrent ? 'current-branch' : ''}" style="border-color:${safe(b.color)}">
		<div class="title">
			<span class="branch">${currentMarker}${safe(b.name)}${singleCommitIcon}</span>
			<span class="base">→ ${safe(b.base)}</span>
		</div>
		<div class="meta">
			<span class="pr state-${safe(stateClass)}">${safe(pr)} · ${safe(state)}</span>
			${checksPill}
			${aheadBehind}
			${filesCount}
			${b.prTitle ? `<span class="prtitle">${safe(b.prTitle)}</span>` : ''}
		</div>
		<div class="actions">
			<button data-kind="openPr" data-branch="${safe(b.name)}" ${b.prNumber ? '' : 'disabled'}>Open PR</button>
			<button data-kind="rebase" data-branch="${safe(b.name)}">Rebase</button>
			<button data-kind="commit" data-branch="${safe(b.name)}" title="Commit to this branch">Commit</button>
			<button class="more" data-testid="row-menu-button-${safe(b.name)}" data-more-branch="${safe(b.name)}" data-branch-pr-url="${safe(b.prUrl ?? '')}" aria-haspopup="menu" aria-label="More actions for ${safe(b.name)}">⋯</button>
		</div>
		${commitsSection}
		${filesSection}
		${reviewsChecksSection}
		${bodyPreviewSection}
	</div>
</li>`
}

function reviewStateGlyph(state: 'approved' | 'changesRequested' | 'commented' | 'pending'): string {
	switch (state) {
		case 'approved':         return '✓'
		case 'changesRequested': return '✗'
		case 'commented':        return '💬'
		case 'pending':          return '⌛'
	}
}

function connectorClass(i: number, total: number): string {
	const parts: string[] = ['connector']
	if (i === 0) parts.push('first')
	if (i === total - 1) parts.push('last')
	return parts.join(' ')
}

function formatAheadBehind(ahead: number | undefined, behind: number | undefined): string {
	const parts: string[] = []
	if (ahead !== undefined && ahead > 0) parts.push(`↑${String(ahead)}`)
	if (behind !== undefined && behind > 0) parts.push(`↓${String(behind)}`)
	if (parts.length === 0) return ''
	return `<span class="aheadBehind" data-testid="ahead-behind" title="ahead / behind parent">${parts.join(' ')}</span>`
}

function checksGlyph(s: 'pending' | 'success' | 'failure'): string {
	switch (s) {
		case 'success': return '✓'
		case 'failure': return '✗'
		case 'pending': return '⌛'
	}
}

function describeAdapter(name: string): string {
	if (name === 'none') return 'None'
	if (name.toLowerCase().includes('octokit')) return 'GitHub (Octokit)'
	if (name.toLowerCase().includes('vscode')) return 'GitHub (VS Code)'
	return name
}

function escapeHtml(s: string): string {
	return s.replace(/[&<>"']/g, (c) => {
		switch (c) {
			case '&': return '&amp;'
			case '<': return '&lt;'
			case '>': return '&gt;'
			case '"': return '&quot;'
			default: return '&#39;'
		}
	})
}

function simpleNonce(): string {
	// 128 bits from Math.random is not crypto-grade but a webview nonce just
	// needs to be unguessable by a page that can't read our HTML anyway.
	const bits = [0, 1, 2, 3].map(() => Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0'))
	return bits.join('')
}
