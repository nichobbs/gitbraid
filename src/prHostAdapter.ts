import * as vscode from 'vscode'
import { log } from './channelLogger'
import { IGitRunner, getDefaultGitRunner } from './gitRunner'

// ─── Types ───────────────────────────────────────────────────────────────────

/** Canonical PR lifecycle state we expose upwards to UI and commands. */
export type PRState = 'open' | 'draft' | 'merged' | 'closed'

/** CI/checks rollup surfaced next to each PR in the tree view. */
export type ChecksStatus = 'pending' | 'success' | 'failure'

/**
 * Provider-agnostic view of a pull/merge request.  Populated by adapters from
 * GitHub, the vscode.github-pullrequests extension, or an Octokit fallback.
 */
export interface PRMetadata {
	number: number
	url: string
	state: PRState
	base: string
	head: string
	title: string
	body: string
	checksStatus?: ChecksStatus
}

/** Fields any adapter accepts when creating or updating a PR. */
export interface CreatePRInput {
	head: string
	base: string
	title: string
	body: string
	/** Open the PR as draft.  Defaults to false. */
	draft?: boolean
}

/** Per-repo adapter the command layer uses to submit + refresh PRs. */
export interface PRHostAdapter {
	/** Human-readable name — shown in the output channel for diagnostics. */
	readonly name: string
	/** Does this adapter know how to talk to this repo? */
	detect(repoRoot: string): Promise<boolean>
	/** Look up a PR for a branch.  Undefined if none exists on the host. */
	getPR(branch: string): Promise<PRMetadata | undefined>
	/** Create a PR.  Adapters that can't create PRs should throw. */
	createPR(input: CreatePRInput): Promise<PRMetadata>
	/** Partially update a PR. */
	updatePR(prNumber: number, patch: Partial<CreatePRInput>): Promise<PRMetadata>
	/** List the PRs the host considers open, keyed by head branch. */
	listOpen(): Promise<PRMetadata[]>
}

// ─── NullAdapter ─────────────────────────────────────────────────────────────

/**
 * Used when no real provider is available — every call resolves with a
 * "not supported" message rather than silently no-opping.  `detect()` returns
 * true so it can serve as a terminal fallback when the caller has already
 * filtered out better candidates.
 */
export class NullPRHostAdapter implements PRHostAdapter {
	readonly name = 'none'
	async detect(): Promise<boolean> { return true }
	async getPR(): Promise<PRMetadata | undefined> { return undefined }
	async createPR(): Promise<PRMetadata> {
		throw new Error('GitBraid: no PR host is configured for this repository.')
	}
	async updatePR(): Promise<PRMetadata> {
		throw new Error('GitBraid: no PR host is configured for this repository.')
	}
	async listOpen(): Promise<PRMetadata[]> { return [] }
}

// ─── GitHubVSCodeAdapter ─────────────────────────────────────────────────────

/**
 * Thin wrapper around the `GitHub.vscode-pull-request-github` extension.  Its
 * exported API is not officially stable, so we defensively probe for the
 * shapes we expect.  Anything we can't read is reported via
 * `detect()` returning false, which lets `pickAdapter` fall back to
 * GitHubOctokitAdapter or NullPRHostAdapter.
 *
 * We deliberately only implement `getPR`/`listOpen` via the extension and
 * route mutation (create/update) through the extension's command contributions
 * — the API does not expose stable create/update methods across versions.
 */
export class GitHubVSCodeAdapter implements PRHostAdapter {

	private static readonly EXTENSION_ID = 'GitHub.vscode-pull-request-github'

	readonly name = 'github-vscode'

	async detect(_repoRoot: string): Promise<boolean> {
		const ext = vscode.extensions.getExtension(GitHubVSCodeAdapter.EXTENSION_ID)
		if (!ext) return false
		if (!ext.isActive) {
			try { await ext.activate() } catch { return false }
		}
		return true
	}

	async listOpen(): Promise<PRMetadata[]> {
		const api = await this._api()
		if (!api) return []
		try {
			const repos = this._readArray(api, 'repositories') ?? []
			const out: PRMetadata[] = []
			for (const repo of repos) {
				if (typeof repo !== 'object' || repo === null) continue
				const r = repo as Record<string, unknown>
				const candidates = [r.pullRequests, r.activePullRequests, r.pullRequestModel]
					.filter((v): v is unknown[] => Array.isArray(v)).flat()
				for (const raw of candidates) {
					const pr = coercePullRequest(raw)
					if (pr) out.push(pr)
				}
			}
			return out
		} catch (e) {
			log.debug('GitHubVSCodeAdapter.listOpen: ' + errMsg(e))
			return []
		}
	}

	async getPR(branch: string): Promise<PRMetadata | undefined> {
		const all = await this.listOpen()
		return all.find((p) => p.head === branch)
	}

	async createPR(input: CreatePRInput): Promise<PRMetadata> {
		// The vscode-pull-request-github extension does not expose a stable
		// programmatic create API.  We delegate to its well-known command.
		// Failure here bubbles up to the user with the command's own UX.
		await vscode.commands.executeCommand('pr.create', {
			baseBranch: input.base,
			headBranch: input.head,
			title: input.title,
			body: input.body,
			draft: input.draft === true,
		})
		const refreshed = await this.getPR(input.head)
		if (!refreshed) {
			throw new Error(
				`GitBraid: the GitHub PR extension did not report a PR for "${input.head}" ` +
				`after creation.  Try Reloading VS Code and re-running Submit Stack.`,
			)
		}
		return refreshed
	}

	async updatePR(prNumber: number, patch: Partial<CreatePRInput>): Promise<PRMetadata> {
		// No stable programmatic edit API; fall back to open-in-editor.
		await vscode.commands.executeCommand('pr.openDescription', prNumber)
		const match = (await this.listOpen()).find((p) => p.number === prNumber)
		if (!match) {
			throw new Error(`GitBraid: PR #${String(prNumber)} was not visible after update.`)
		}
		log.info(`GitHubVSCodeAdapter.updatePR: opened PR #${String(prNumber)} for user to apply patch ${JSON.stringify(patch)}`)
		return match
	}

	private async _api(): Promise<Record<string, unknown> | undefined> {
		const ext = vscode.extensions.getExtension(GitHubVSCodeAdapter.EXTENSION_ID)
		if (!ext) return undefined
		try {
			if (!ext.isActive) await ext.activate()
		} catch (e) {
			log.debug('GitHubVSCodeAdapter: activate failed: ' + errMsg(e))
			return undefined
		}
		const exp = (ext.exports ?? {}) as Record<string, unknown>
		const getAPI = exp.getAPI as ((v: number) => unknown) | undefined
		if (typeof getAPI === 'function') {
			try {
				return (getAPI(1) ?? {}) as Record<string, unknown>
			} catch (e) {
				log.debug('GitHubVSCodeAdapter.getAPI(1) failed: ' + errMsg(e))
			}
		}
		return exp
	}

	private _readArray(obj: Record<string, unknown>, key: string): unknown[] | undefined {
		const v = obj[key]
		return Array.isArray(v) ? v : undefined
	}
}

// ─── GitHubOctokitAdapter (fallback; token-driven) ───────────────────────────

/**
 * REST/GraphQL fallback used when the vscode-pull-request-github extension is
 * not installed.  The token is read from `SecretStorage` under
 * `gitbraid.githubToken`.  Implementation is deliberately minimal — only the
 * endpoints `submitStack` needs are wired.  Network calls go through the
 * global `fetch`, which is available in the VS Code extension host on
 * Node 18+.
 */
export class GitHubOctokitAdapter implements PRHostAdapter {
	readonly name = 'github-octokit'

	constructor(
		private readonly _secrets: vscode.SecretStorage,
		private readonly _runner: IGitRunner = getDefaultGitRunner(),
	) {}

	async detect(repoRoot: string): Promise<boolean> {
		const token = await this._token()
		if (!token) return false
		const slug = await this._repoSlug(repoRoot)
		return slug !== undefined
	}

	async getPR(branch: string): Promise<PRMetadata | undefined> {
		const all = await this.listOpen()
		return all.find((p) => p.head === branch)
	}

	async listOpen(): Promise<PRMetadata[]> {
		const { owner, repo, token } = await this._ctx()
		const res = await fetchJson<unknown[]>(
			`https://api.github.com/repos/${owner}/${repo}/pulls?state=open&per_page=100`,
			{ token },
		)
		if (!Array.isArray(res)) return []
		const out: PRMetadata[] = []
		for (const raw of res) {
			const pr = coercePullRequest(raw)
			if (pr) out.push(pr)
		}
		return out
	}

	async createPR(input: CreatePRInput): Promise<PRMetadata> {
		const { owner, repo, token } = await this._ctx()
		const body = {
			title: input.title,
			head: input.head,
			base: input.base,
			body: input.body,
			draft: input.draft === true,
		}
		const res = await fetchJson<unknown>(
			`https://api.github.com/repos/${owner}/${repo}/pulls`,
			{ method: 'POST', token, body },
		)
		const pr = coercePullRequest(res)
		if (!pr) throw new Error('GitHub: createPR returned an unrecognised payload.')
		return pr
	}

	async updatePR(prNumber: number, patch: Partial<CreatePRInput>): Promise<PRMetadata> {
		const { owner, repo, token } = await this._ctx()
		const body: Record<string, unknown> = {}
		if (patch.title !== undefined) body.title = patch.title
		if (patch.body !== undefined) body.body = patch.body
		if (patch.base !== undefined) body.base = patch.base
		const res = await fetchJson<unknown>(
			`https://api.github.com/repos/${owner}/${repo}/pulls/${String(prNumber)}`,
			{ method: 'PATCH', token, body },
		)
		const pr = coercePullRequest(res)
		if (!pr) throw new Error('GitHub: updatePR returned an unrecognised payload.')
		return pr
	}

	private async _ctx(): Promise<{ owner: string, repo: string, token: string }> {
		const token = await this._token()
		if (!token) throw new Error('GitBraid: no GitHub token in secret storage (gitbraid.githubToken).')
		const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
		if (!root) throw new Error('GitBraid: no workspace folder — cannot determine GitHub repo.')
		const slug = await this._repoSlug(root)
		if (!slug) throw new Error('GitBraid: this workspace has no github.com remote.')
		return { ...slug, token }
	}

	private async _token(): Promise<string | undefined> {
		try {
			return await this._secrets.get('gitbraid.githubToken')
		} catch {
			return undefined
		}
	}

	private async _repoSlug(repoRoot: string): Promise<{ owner: string, repo: string } | undefined> {
		const r = await this._runner.run(['config', '--get', 'remote.origin.url'], { cwd: repoRoot })
		if (r.exitCode !== 0) return undefined
		return parseGithubSlug(r.stdout.trim())
	}
}

// ─── Stacked-body rendering ──────────────────────────────────────────────────

const STACK_BLOCK_START = '<!-- gitbraid:stack-start -->'
const STACK_BLOCK_END = '<!-- gitbraid:stack-end -->'
const DO_NOT_TOUCH = '<!-- gitbraid:no-touch -->'

export interface StackBodyEntry {
	name: string
	prNumber?: number
}

/**
 * Build the block GitBraid injects into each PR body so readers can follow
 * the stack without leaving GitHub.  The block is idempotent: writing it
 * twice produces the same string and is safe to diff.  Callers identify the
 * "current" branch via `currentBranch`, which highlights that row.
 */
export function renderStackBlock(entries: StackBodyEntry[], currentBranch: string): string {
	const lines: string[] = [STACK_BLOCK_START, 'Stacked PRs (bottom first):']
	for (let i = 0; i < entries.length; i++) {
		const e = entries[i]
		const pr = e.prNumber ? `#${String(e.prNumber)} ` : ''
		const marker = e.name === currentBranch ? '  ← you are here' : ''
		lines.push(`${String(i + 1)}. ${pr}${e.name}${marker}`)
	}
	lines.push(STACK_BLOCK_END)
	return lines.join('\n')
}

/**
 * Merge a generated stack block into an existing PR body.  Replaces any
 * existing block between the sentinels; otherwise prepends.  Honours
 * `DO_NOT_TOUCH` at the top of the body — if present we return the body
 * unchanged so users can opt out of GitBraid's body edits.
 */
export function mergeStackBlock(existingBody: string, block: string): string {
	if (existingBody.trimStart().startsWith(DO_NOT_TOUCH)) {
		return existingBody
	}
	const start = existingBody.indexOf(STACK_BLOCK_START)
	const end = existingBody.indexOf(STACK_BLOCK_END)
	if (start !== -1 && end !== -1 && end > start) {
		const before = existingBody.slice(0, start)
		const after = existingBody.slice(end + STACK_BLOCK_END.length)
		return (before + block + after).replace(/\n{3,}/g, '\n\n').trim() + '\n'
	}
	const joiner = existingBody.trim().length > 0 ? '\n\n' : ''
	return block + joiner + existingBody
}

// ─── Adapter selection ───────────────────────────────────────────────────────

/**
 * Pick the best adapter for `repoRoot`.  Preference order:
 *   1. The user-pinned `gitbraid.prHost` setting when it is not `auto`.
 *   2. GitHubVSCodeAdapter (uses existing extension auth).
 *   3. GitHubOctokitAdapter (PAT from SecretStorage).
 *   4. NullPRHostAdapter.
 */
export async function pickAdapter(
	repoRoot: string,
	secrets: vscode.SecretStorage,
): Promise<PRHostAdapter> {
	const setting = vscode.workspace.getConfiguration('gitbraid').get<string>('prHost', 'auto')
	if (setting === 'none') return new NullPRHostAdapter()

	if (setting === 'github' || setting === 'auto') {
		const vs = new GitHubVSCodeAdapter()
		if (await vs.detect(repoRoot)) return vs
		const oct = new GitHubOctokitAdapter(secrets)
		if (await oct.detect(repoRoot)) return oct
	}
	return new NullPRHostAdapter()
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function coercePullRequest(raw: unknown): PRMetadata | undefined {
	if (typeof raw !== 'object' || raw === null) return undefined
	const r = raw as Record<string, unknown>

	const head = r.head as Record<string, unknown> | undefined
	const base = r.base as Record<string, unknown> | undefined
	const headRef = typeof head?.ref === 'string' ? head.ref
		: typeof r.headRef === 'string' ? r.headRef
		: typeof r.branch === 'string' ? r.branch : undefined
	const baseRef = typeof base?.ref === 'string' ? base.ref
		: typeof r.baseRef === 'string' ? r.baseRef : ''
	if (!headRef) return undefined

	const number = typeof r.number === 'number' ? r.number
		: typeof r.id === 'number' ? r.id : 0
	if (number === 0) return undefined
	const title = typeof r.title === 'string' ? r.title : '(untitled)'
	const body = typeof r.body === 'string' ? r.body : ''
	const url = typeof r.html_url === 'string' ? r.html_url
		: typeof r.url === 'string' ? r.url : ''

	const merged = r.merged === true || typeof r.merged_at === 'string'
	const isDraft = r.isDraft === true || r.draft === true
	const rawState = typeof r.state === 'string' ? r.state.toLowerCase() : ''

	let state: PRState
	if (merged) state = 'merged'
	else if (rawState === 'closed') state = 'closed'
	else if (isDraft) state = 'draft'
	else state = 'open'

	return { number, url, state, base: baseRef, head: headRef, title, body }
}

export function parseGithubSlug(remoteUrl: string): { owner: string, repo: string } | undefined {
	if (!remoteUrl) return undefined
	// ssh: git@github.com:owner/repo(.git)?
	const ssh = /^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/i.exec(remoteUrl)
	if (ssh) return { owner: ssh[1], repo: ssh[2] }
	// https: https://github.com/owner/repo(.git)?
	const https = /^https?:\/\/(?:[^@]+@)?github\.com\/([^/]+)\/(.+?)(?:\.git)?\/?$/i.exec(remoteUrl)
	if (https) return { owner: https[1], repo: https[2] }
	return undefined
}

interface FetchOptions {
	method?: string
	token?: string
	body?: unknown
}

async function fetchJson<T>(url: string, opts: FetchOptions = {}): Promise<T> {
	const headers: Record<string, string> = {
		'Accept': 'application/vnd.github+json',
		'User-Agent': 'gitbraid',
	}
	if (opts.token) headers['Authorization'] = 'Bearer ' + opts.token
	if (opts.body !== undefined) headers['Content-Type'] = 'application/json'

	const res = await fetch(url, {
		method: opts.method ?? 'GET',
		headers,
		body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
	})
	if (!res.ok) {
		const txt = await res.text().catch(() => '')
		throw new Error(`GitHub ${String(res.status)} ${res.statusText}: ${txt.slice(0, 500)}`)
	}
	return (await res.json()) as T
}

function errMsg(e: unknown): string {
	return e instanceof Error ? e.message : String(e)
}
