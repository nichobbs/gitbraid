import * as vscode from 'vscode'
import { log } from './channelLogger'
import { FolderRegistry } from './folderRegistry'
import { FolderContext } from './folderContext'
import { PRAwareness } from './prAwareness'
import { BranchStackEntry } from './configTypes'

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
}

export interface DashboardData {
	workspaceName: string
	branches: DashboardBranchRow[]
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
		if (!this._view) return
		const data = this._collect()
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

	private _collect(): DashboardData {
		const ctx = this._registry.getActive() ?? this._registry.getAll()[0]
		if (!ctx) {
			return { workspaceName: 'no folder', branches: [] }
		}
		const entries = ctx.config.getStack().filter((e) => !e.scratch)
		const sorted = [...entries].sort((a, b) => a.order - b.order)
		const rows: DashboardBranchRow[] = sorted.map((e: BranchStackEntry) => {
			const pr = this._prAwareness.getForBranch(e.name)
			return {
				name: e.name,
				base: e.base,
				order: e.order,
				color: e.color,
				prNumber: pr?.number ?? e.prNumber,
				prState: pr?.state,
				prTitle: pr?.title,
				prUrl: pr?.url,
			}
		})
		return {
			workspaceName: ctx.root.fsPath.split(/[\\/]/).filter(Boolean).pop() ?? 'workspace',
			branches: rows,
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

	const rows = data.branches.length === 0
		? `<p class="empty">Stack is empty. Run <code>gitbraid.addStackBranch</code> to get started.</p>`
		: data.branches.map((b, i) => {
			const pr = b.prNumber ? `#${String(b.prNumber)}` : '—'
			const state = b.prState ?? 'no PR'
			const stateClass = b.prState ?? 'none'
			return `
				<li class="row">
					<div class="connector ${i === 0 ? 'first' : ''} ${i === data.branches.length - 1 ? 'last' : ''}"></div>
					<div class="node" style="border-color:${safe(b.color)}">
						<div class="title">
							<span class="branch">${safe(b.name)}</span>
							<span class="base">→ ${safe(b.base)}</span>
						</div>
						<div class="meta">
							<span class="pr state-${safe(stateClass)}">${safe(pr)} · ${safe(state)}</span>
							${b.prTitle ? `<span class="prtitle">${safe(b.prTitle)}</span>` : ''}
						</div>
						<div class="actions">
							<button data-cmd="openPr" data-branch="${safe(b.name)}" ${b.prNumber ? '' : 'disabled'}>Open PR</button>
							<button data-cmd="rebase" data-branch="${safe(b.name)}">Rebase</button>
						</div>
					</div>
				</li>`
		}).join('\n')

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
	ul.stack { list-style: none; padding: 0; margin: 0; }
	li.row { display: flex; align-items: stretch; margin-bottom: 8px; }
	.connector { width: 12px; border-left: 2px solid var(--vscode-panel-border); margin-right: 8px; }
	.connector.first { border-top: none; }
	.node { flex: 1; border: 1px solid var(--vscode-panel-border); border-left-width: 4px; padding: 6px 8px; border-radius: 3px; background: var(--vscode-sideBar-background); }
	.title { display: flex; justify-content: space-between; font-weight: 600; font-size: 12px; }
	.title .base { color: var(--vscode-descriptionForeground); font-weight: normal; }
	.meta { font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 2px; display: flex; gap: 6px; }
	.meta .pr { padding: 0 4px; border-radius: 2px; }
	.state-open { color: var(--vscode-charts-green); }
	.state-draft { color: var(--vscode-charts-yellow); }
	.state-merged { color: var(--vscode-charts-purple); }
	.state-closed { color: var(--vscode-charts-red); }
	.actions { margin-top: 4px; display: flex; gap: 4px; }
	.actions button { font-size: 11px; padding: 1px 6px; }
	.empty { color: var(--vscode-descriptionForeground); font-size: 12px; }
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
	<ul class="stack">
		${rows}
	</ul>
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
