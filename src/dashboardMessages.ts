/**
 * Plan 02 Wave B — typed message contract shared between the dashboard
 * provider (extension host) and the webview script.
 *
 * The webview serialises the message as JSON via `acquireVsCodeApi()
 * .postMessage(...)`.  The host parses it back into a `DashboardRequest`
 * via {@link parseRequest}, which is strict: unknown `kind` values or
 * missing required fields return `undefined` so the dispatcher can
 * log-and-ignore without throwing.
 */

/** A request posted from the webview to the extension host. */
export type DashboardRequest =
	| { kind: 'refresh' }
	| { kind: 'submit' }
	| { kind: 'mergeStack' }
	| { kind: 'addBranch' }
	| { kind: 'assignFloating' }
	| { kind: 'saveCheckpoint' }
	| { kind: 'showUndoLog' }
	| { kind: 'openPr';              branch: string }
	| { kind: 'rebase';              branch: string }
	| { kind: 'switchBranch';        branch: string }
	| { kind: 'moveBranchUp';        branch: string }
	| { kind: 'moveBranchDown';      branch: string }
	| { kind: 'removeBranch';        branch: string }
	| { kind: 'commit';              branch: string }
	| { kind: 'pushBranch';          branch: string }
	| { kind: 'absorbHunks';         branch: string }
	| { kind: 'routeHunks';          branch: string }
	| { kind: 'toggleSingleCommit';  branch: string }
	| { kind: 'setCommitTemplate';   branch: string }
	| { kind: 'copyBranchName';      branch: string }
	| { kind: 'copyPrUrl';           branch: string; url: string }
	| { kind: 'openWorktree';        branch: string }

/** Allowed kinds — single source of truth for parsing + action registry. */
export const DASHBOARD_REQUEST_KINDS = [
	'refresh', 'submit', 'mergeStack', 'addBranch', 'assignFloating',
	'saveCheckpoint', 'showUndoLog',
	'openPr', 'rebase', 'switchBranch', 'moveBranchUp', 'moveBranchDown',
	'removeBranch', 'commit', 'pushBranch', 'absorbHunks', 'routeHunks',
	'toggleSingleCommit', 'setCommitTemplate', 'copyBranchName',
	'copyPrUrl', 'openWorktree',
] as const

export type DashboardRequestKind = (typeof DASHBOARD_REQUEST_KINDS)[number]

/** Kinds that require a `branch` string (everything except stack-wide ones). */
const BRANCH_KINDS = new Set<DashboardRequestKind>([
	'openPr', 'rebase', 'switchBranch', 'moveBranchUp', 'moveBranchDown',
	'removeBranch', 'commit', 'pushBranch', 'absorbHunks', 'routeHunks',
	'toggleSingleCommit', 'setCommitTemplate', 'copyBranchName',
	'copyPrUrl', 'openWorktree',
])

/**
 * Coerce an arbitrary message payload (from `webview.onDidReceiveMessage`)
 * into a typed {@link DashboardRequest}.  Returns `undefined` on any
 * structural mismatch — callers log-and-ignore.
 */
export function parseRequest(raw: unknown): DashboardRequest | undefined {
	if (typeof raw !== 'object' || raw === null) return undefined
	const r = raw as Record<string, unknown>
	const kind = typeof r.kind === 'string' ? r.kind as DashboardRequestKind : undefined
	if (!kind || !DASHBOARD_REQUEST_KINDS.includes(kind)) return undefined

	if (BRANCH_KINDS.has(kind)) {
		const branch = typeof r.branch === 'string' ? r.branch : undefined
		if (!branch) return undefined
		if (kind === 'copyPrUrl') {
			const url = typeof r.url === 'string' ? r.url : undefined
			if (!url) return undefined
			return { kind: 'copyPrUrl', branch, url }
		}
		// TypeScript can't narrow a union via a Set membership check, so we
		// cast through to the concrete shape.  All branch kinds share
		// `{ kind, branch }`; only `copyPrUrl` has extra fields (handled above).
		return { kind, branch } as DashboardRequest
	}
	// Stack-wide messages have no `branch`.
	return { kind } as DashboardRequest
}

// ─── Host → webview messages ────────────────────────────────────────────────

/** Server-pushed messages consumed by the webview script. */
export type DashboardPush =
	/** Full re-render — legacy path, replaced by patchRow where possible. */
	| { kind: 'hydrate'; html: string }
	/** Patch a single branch row; `branchName` selects the <li> to replace. */
	| { kind: 'patchRow'; branchName: string; html: string }
	/** Streaming progress strip (shown at the top of the view). */
	| { kind: 'progress'; message: string; done: number; total: number }
	/** Dismiss the progress strip. */
	| { kind: 'progressDone' }
