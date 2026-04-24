import * as vscode from 'vscode'
import { log } from './channelLogger'
import { FolderRegistry } from './folderRegistry'
import { FolderContext } from './folderContext'
import { PRAwareness } from './prAwareness'
import { buildSnapshot, ChecksStatus } from './dashboardSnapshot'
import { git } from './gitFunctions'
import { worktreePath } from './branchStackService'

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
			})),
			banners: { floatingCount: snapshot.banners.floatingCount },
			adapter: snapshot.adapter ? { label: snapshot.adapter.label } : undefined,
		}
	}

	private async _handleMessage(msg: unknown): Promise<void> {
		if (typeof msg !== 'object' || msg === null) return
		const m = msg as Record<string, unknown>
		const cmd = typeof m.cmd === 'string' ? m.cmd : undefined
		const branch = typeof m.branch === 'string' ? m.branch : undefined
		try {
			switch (cmd) {
				case 'submit':
					await vscode.commands.executeCommand('gitbraid.submitStack')
					return
				case 'openPr':
					if (branch) await vscode.commands.executeCommand('gitbraid.openStackedPR', branch)
					return
				case 'rebase':
					if (branch) await vscode.commands.executeCommand('gitbraid.rebaseBranch', branch)
					return
				case 'refresh':
					await vscode.commands.executeCommand('gitbraid.refreshPRStatus')
					return
				default:
					log.warn(`StackDashboardView: unknown cmd=${String(cmd)}`)
			}
		} catch (e) {
			log.error(`StackDashboardView._handleMessage: ${e instanceof Error ? e.message : String(e)}`)
		}
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
		: data.branches.map((b, i) => {
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

			return `
				<li class="row" data-branch="${safe(b.name)}">
					<div class="connector ${i === 0 ? 'first' : ''} ${i === data.branches.length - 1 ? 'last' : ''}"></div>
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
							<button data-cmd="openPr" data-branch="${safe(b.name)}" ${b.prNumber ? '' : 'disabled'}>Open PR</button>
							<button data-cmd="rebase" data-branch="${safe(b.name)}">Rebase</button>
						</div>
					</div>
				</li>`
		}).join('\n')

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
	.actions { margin-top: 4px; display: flex; gap: 4px; }
	.actions button { font-size: 11px; padding: 1px 6px; }
	.empty { color: var(--vscode-descriptionForeground); font-size: 12px; }
	footer.adapter { margin-top: 10px; padding-top: 6px; border-top: 1px solid var(--vscode-panel-border); font-size: 10px; color: var(--vscode-descriptionForeground); }
</style>
</head>
<body>
	<div class="header">
		<h2>Stack — ${safe(data.workspaceName)}</h2>
		<div class="toolbar">
			<button data-cmd="refresh">Refresh</button>
			<button data-cmd="submit">Submit</button>
		</div>
	</div>
	${banner}
	<ul class="stack">
		${rows}
	</ul>
	${adapterStrip}
	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi()
		document.body.addEventListener('click', (e) => {
			const el = e.target.closest('[data-cmd]')
			if (!el) return
			vscode.postMessage({ cmd: el.dataset.cmd, branch: el.dataset.branch })
		})
	</script>
</body>
</html>`
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
