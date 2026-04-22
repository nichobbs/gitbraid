import * as vscode from 'vscode'
import { log } from './channelLogger'

// ─── Types ────────────────────────────────────────────────────────────────────

export type PRState = 'open' | 'draft' | 'merged' | 'closed'

export interface BranchPRInfo {
	branch: string
	state: PRState
	/** PR number — for tooltip and for constructing URLs. */
	number: number
	/** Display title — rendered in the tooltip, not the label. */
	title: string
	/** Web URL — used as the click-through action when the user Ctrl+clicks. */
	url?: string
}

/**
 * Minimal pull-request awareness powered by `GitHub.vscode-pull-request-github`.
 *
 * The GH extension's API is not officially stable; we code defensively and
 * fall back to "no decorations" whenever the shape we expect isn't present
 * at runtime.  The honest contract to users is "if GitHub's extension is
 * installed and active, you'll see PR status; otherwise, nothing changes".
 *
 * Feature-gated on `gitbraid.prDecorationsEnabled` (default true).  Refresh
 * strategy is a light poll — the GH extension emits its own change events
 * but we can't rely on those existing across versions, so a 60s poll plus
 * an explicit `refresh()` method covers both cases cheaply.
 */
export class PRAwareness implements vscode.Disposable {

	private static readonly GH_EXTENSION_ID = 'GitHub.vscode-pull-request-github'
	private static readonly POLL_INTERVAL_MS = 60_000

	private _timer: ReturnType<typeof setInterval> | undefined
	private _cache = new Map<string, BranchPRInfo>()
	private _enabled = true

	private readonly _onDidChange = new vscode.EventEmitter<void>()
	readonly onDidChange: vscode.Event<void> = this._onDidChange.event

	private readonly _disposables: vscode.Disposable[] = []

	constructor() {
		this._applyEnabledFromSettings()
		this._disposables.push(
			vscode.workspace.onDidChangeConfiguration((e) => {
				if (e.affectsConfiguration('gitbraid.prDecorationsEnabled')) {
					this._applyEnabledFromSettings()
				}
			}),
		)
	}

	// ── Lifecycle ─────────────────────────────────────────────────────────────

	/**
	 * Start polling.  No-op if the setting is disabled or the GitHub PR
	 * extension isn't installed.
	 */
	start(): void {
		if (!this._enabled) return
		this._stop()
		void this.refresh()
		this._timer = setInterval(() => { void this.refresh() }, PRAwareness.POLL_INTERVAL_MS)
	}

	dispose(): void {
		this._stop()
		this._onDidChange.dispose()
		for (const d of this._disposables) {
			d.dispose()
		}
	}

	private _stop(): void {
		if (this._timer) {
			clearInterval(this._timer)
			this._timer = undefined
		}
	}

	// ── API ───────────────────────────────────────────────────────────────────

	/** Look up the cached PR info for a branch.  Undefined if none is known. */
	getForBranch(branch: string): BranchPRInfo | undefined {
		return this._cache.get(branch)
	}

	/** Force a re-query.  Safe to call when disabled — resolves to a no-op. */
	async refresh(): Promise<void> {
		if (!this._enabled) {
			if (this._cache.size > 0) {
				this._cache.clear()
				this._onDidChange.fire()
			}
			return
		}
		const fetched = await this._queryAll()
		if (!fetched) return
		// Replace the cache atomically and fire one change event regardless of
		// delta — the tree provider rebuilds whole nodes anyway.
		this._cache = fetched
		this._onDidChange.fire()
	}

	// ── Defensive API adapter ────────────────────────────────────────────────

	private _applyEnabledFromSettings(): void {
		const previously = this._enabled
		this._enabled = vscode.workspace.getConfiguration('gitbraid').get<boolean>('prDecorationsEnabled', true)
		if (previously !== this._enabled) {
			if (this._enabled) {
				this.start()
			} else {
				this._stop()
				if (this._cache.size > 0) {
					this._cache.clear()
					this._onDidChange.fire()
				}
			}
		}
	}

	/**
	 * Pull the list of known PRs from the GitHub extension.  Returns
	 * `undefined` if the extension isn't installed / active / exposing the
	 * API we expect — callers should treat that as "no change".
	 */
	private async _queryAll(): Promise<Map<string, BranchPRInfo> | undefined> {
		const gh = vscode.extensions.getExtension(PRAwareness.GH_EXTENSION_ID)
		if (!gh) {
			return undefined
		}
		try {
			if (!gh.isActive) {
				await gh.activate()
			}
		} catch (e) {
			log.debug('PRAwareness: GH extension failed to activate: ' + (e instanceof Error ? e.message : String(e)))
			return undefined
		}

		// The GH extension's API shape varies between versions.  We try two
		// known patterns before giving up:
		//
		//   (a) v1 — `getAPI(1)` returns an object with a `repositories`
		//            array whose entries expose a `pullRequestModel` or
		//            similar with per-branch lookup.
		//   (b) v0 — the plain `exports` object exposes
		//            `getPullRequestsForRepository(...)` or `pullRequests`.
		//
		// When neither is present we return undefined and decorations stay
		// off; this is always a soft failure.
		type ApiCandidate = Record<string, unknown>
		const api: ApiCandidate = (gh.exports ?? {}) as ApiCandidate
		try {
			const getAPI = api.getAPI as ((v: number) => unknown) | undefined
			if (typeof getAPI === 'function') {
				const v1 = getAPI(1) as ApiCandidate
				const repos = this._findArray(v1, ['repositories'])
				if (repos) {
					return this._collectFromRepos(repos)
				}
			}
			// Path (b): direct exports.
			const direct = this._findArray(api, ['pullRequests'])
			if (direct) {
				return this._flatten(direct)
			}
		} catch (e) {
			log.debug('PRAwareness: query failed — ' + (e instanceof Error ? e.message : String(e)))
		}
		return undefined
	}

	private _findArray(obj: Record<string, unknown> | undefined, keys: string[]): unknown[] | undefined {
		if (!obj) return undefined
		for (const k of keys) {
			const v = obj[k]
			if (Array.isArray(v)) return v
		}
		return undefined
	}

	private async _collectFromRepos(repos: unknown[]): Promise<Map<string, BranchPRInfo>> {
		const result = new Map<string, BranchPRInfo>()
		for (const repo of repos) {
			if (typeof repo !== 'object' || repo === null) continue
			const r = repo as Record<string, unknown>
			// Try each of the known shapes in turn.  Each branch yields a
			// best-effort PRInfo; malformed entries are skipped.
			const candidates = [
				r.pullRequests,
				r.pullRequestModel,
				r.activePullRequests,
			].filter((v): v is unknown[] => Array.isArray(v)).flat()
			for (const entry of this._flatten(candidates).values()) {
				result.set(entry.branch, entry)
			}
		}
		return result
	}

	private _flatten(list: unknown[]): Map<string, BranchPRInfo> {
		const m = new Map<string, BranchPRInfo>()
		for (const e of list) {
			if (typeof e !== 'object' || e === null) continue
			const pr = e as Record<string, unknown>
			const head = pr.head as Record<string, unknown> | undefined
			const branch = typeof head?.ref === 'string' ? head.ref
				: typeof pr.headRef === 'string' ? pr.headRef
				: typeof pr.branch === 'string' ? pr.branch
				: undefined
			if (!branch) continue

			const state = coerceState(pr.state, pr.isDraft, pr.merged)
			const number = typeof pr.number === 'number' ? pr.number
				: typeof pr.id === 'number' ? pr.id : 0
			const title = typeof pr.title === 'string' ? pr.title : '(untitled PR)'
			const url = typeof pr.url === 'string' ? pr.url
				: typeof pr.html_url === 'string' ? pr.html_url : undefined

			m.set(branch, { branch, state, number, title, url })
		}
		return m
	}
}

function coerceState(state: unknown, isDraft: unknown, merged: unknown): PRState {
	if (merged === true) return 'merged'
	if (typeof state === 'string') {
		const lower = state.toLowerCase()
		if (lower === 'closed' || lower === 'merged') return lower === 'merged' ? 'merged' : 'closed'
	}
	if (isDraft === true) return 'draft'
	return 'open'
}

// ─── Decoration helpers (used by BranchStackTreeProvider) ────────────────────

/** Codicon name for a given PR state. */
export function codiconForState(state: PRState): string {
	switch (state) {
		case 'open':   return 'git-pull-request'
		case 'draft':  return 'git-pull-request-draft'
		case 'merged': return 'git-merge'
		case 'closed': return 'git-pull-request-closed'
	}
}

/** Human label for the tooltip. */
export function stateLabel(state: PRState): string {
	switch (state) {
		case 'open':   return 'Open PR'
		case 'draft':  return 'Draft PR'
		case 'merged': return 'Merged PR'
		case 'closed': return 'Closed PR'
	}
}
