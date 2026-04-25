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

/** Snapshot of a PR's merge-queue membership for the dashboard + status bar. */
export interface QueueStatus {
	inQueue: boolean
	/** 1-based position within the queue; undefined when `inQueue` is false. */
	position?: number
	/** `state` on the PR's most recent check suite, if the host exposes it. */
	checksStatus?: ChecksStatus
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
	// ── Merge-queue (Plan 05) ───────────────────────────────────────────────
	/**
	 * Add `prNumber` to the host's merge queue.  Adapters that don't support
	 * merge queues should throw a user-visible error rather than silently
	 * succeeding.  Returns the 1-based queue position after enqueue.
	 */
	enqueue(prNumber: number): Promise<{ position: number }>
	/** Remove `prNumber` from the merge queue. */
	dequeue(prNumber: number): Promise<void>
	/** Snapshot queue membership for the PR. */
	queueStatus(prNumber: number): Promise<QueueStatus>
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
	async enqueue(): Promise<{ position: number }> {
		throw new Error('GitBraid: no PR host is configured — cannot enqueue.')
	}
	async dequeue(): Promise<void> {
		throw new Error('GitBraid: no PR host is configured — cannot dequeue.')
	}
	async queueStatus(): Promise<QueueStatus> { return { inQueue: false } }
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

	async enqueue(_prNumber: number): Promise<{ position: number }> {
		// The PR extension doesn't expose the merge-queue GraphQL mutation
		// programmatically, so direct the user to the GitHub UI.  Once
		// `GitHubOctokitAdapter` is available (token stored), switch to it —
		// `pickAdapter` does that automatically on `invalidatePRAdapter`.
		throw new Error(
			'GitBraid: the GitHub Pull Requests extension does not expose the merge queue. ' +
			'Store a token via "GitBraid: Set GitHub Token…" so the Octokit adapter can enqueue.',
		)
	}

	async dequeue(_prNumber: number): Promise<void> {
		throw new Error('GitBraid: the GitHub Pull Requests extension cannot dequeue — use a stored token.')
	}

	async queueStatus(_prNumber: number): Promise<QueueStatus> {
		return { inQueue: false }
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

	/**
	 * Add the PR to GitHub Merge Queue via GraphQL.  There is no REST endpoint
	 * for `enqueuePullRequest`, so we issue a GraphQL mutation.  We need the
	 * PR's node id (GraphQL-typed), which we fetch first.
	 */
	async enqueue(prNumber: number): Promise<{ position: number }> {
		const { token } = await this._ctx()
		const nodeId = await this._prNodeId(prNumber)
		const mutation = `mutation($pr: ID!) {
			enqueuePullRequest(input: { pullRequestId: $pr }) {
				mergeQueueEntry { position }
			}
		}`
		const res = await graphql<{ enqueuePullRequest: { mergeQueueEntry: { position: number } | null } }>(
			token, mutation, { pr: nodeId },
		)
		const position = res.enqueuePullRequest.mergeQueueEntry?.position ?? 0
		return { position }
	}

	async dequeue(prNumber: number): Promise<void> {
		const { token } = await this._ctx()
		const nodeId = await this._prNodeId(prNumber)
		const mutation = `mutation($pr: ID!) {
			dequeuePullRequest(input: { pullRequestId: $pr }) { clientMutationId }
		}`
		await graphql<unknown>(token, mutation, { pr: nodeId })
	}

	async queueStatus(prNumber: number): Promise<QueueStatus> {
		const { token } = await this._ctx()
		const nodeId = await this._prNodeId(prNumber)
		const query = `query($pr: ID!) {
			node(id: $pr) {
				... on PullRequest {
					isInMergeQueue
					mergeQueueEntry { position }
					commits(last: 1) {
						nodes { commit { statusCheckRollup { state } } }
					}
				}
			}
		}`
		try {
			const res = await graphql<{ node: {
				isInMergeQueue?: boolean,
				mergeQueueEntry?: { position: number } | null,
				commits?: { nodes?: Array<{ commit?: { statusCheckRollup?: { state?: string } | null } }> },
			} | null }>(token, query, { pr: nodeId })
			const node = res.node ?? {}
			const inQueue = node.isInMergeQueue === true
			const position = node.mergeQueueEntry?.position
			const rawState = node.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state
			const checksStatus = coerceChecksState(rawState)
			return { inQueue, position, checksStatus }
		} catch (e) {
			log.warn('GitHubOctokitAdapter.queueStatus: ' + errMsg(e))
			return { inQueue: false }
		}
	}

	private async _prNodeId(prNumber: number): Promise<string> {
		const { owner, repo, token } = await this._ctx()
		const res = await fetchJson<{ node_id?: string }>(
			`https://api.github.com/repos/${owner}/${repo}/pulls/${String(prNumber)}`,
			{ token },
		)
		if (!res.node_id) throw new Error(`GitBraid: PR #${String(prNumber)} has no node_id.`)
		return res.node_id
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

// ─── GitLabAdapter ───────────────────────────────────────────────────────────

/**
 * REST v4 adapter for gitlab.com and self-hosted GitLab instances.  The token
 * is a Personal Access Token with the `api` scope, stored under
 * `gitbraid.gitlabToken` in SecretStorage.  `detect()` succeeds iff a token is
 * present and the origin remote is a gitlab.* URL we recognise.
 *
 * `enqueue` uses GitLab Merge Trains when the project supports them; otherwise
 * we fall back to "merge when pipeline succeeds", which is the closest native
 * approximation to a merge queue on non-Ultimate tiers.  Either way we return
 * a position of 1 — GitLab does not expose the queue index in its API.
 */
export class GitLabAdapter implements PRHostAdapter {
	readonly name = 'gitlab'

	constructor(
		private readonly _secrets: vscode.SecretStorage,
		private readonly _runner: IGitRunner = getDefaultGitRunner(),
	) {}

	async detect(repoRoot: string): Promise<boolean> {
		const token = await this._token()
		if (!token) return false
		const slug = await this._slug(repoRoot)
		return slug !== undefined
	}

	async getPR(branch: string): Promise<PRMetadata | undefined> {
		const { projectId, host, token } = await this._ctx()
		const res = await fetchJson<unknown[]>(
			`${host}/api/v4/projects/${encodeURIComponent(projectId)}/merge_requests?state=opened&source_branch=${encodeURIComponent(branch)}`,
			{ token, authScheme: 'PRIVATE-TOKEN' },
		)
		if (!Array.isArray(res) || res.length === 0) return undefined
		return coerceGitlabMergeRequest(res[0])
	}

	async listOpen(): Promise<PRMetadata[]> {
		const { projectId, host, token } = await this._ctx()
		const res = await fetchJson<unknown[]>(
			`${host}/api/v4/projects/${encodeURIComponent(projectId)}/merge_requests?state=opened&per_page=100`,
			{ token, authScheme: 'PRIVATE-TOKEN' },
		)
		if (!Array.isArray(res)) return []
		const out: PRMetadata[] = []
		for (const raw of res) {
			const mr = coerceGitlabMergeRequest(raw)
			if (mr) out.push(mr)
		}
		return out
	}

	async createPR(input: CreatePRInput): Promise<PRMetadata> {
		const { projectId, host, token } = await this._ctx()
		const body = {
			source_branch: input.head,
			target_branch: input.base,
			title: input.draft === true ? `Draft: ${input.title}` : input.title,
			description: input.body,
		}
		const res = await fetchJson<unknown>(
			`${host}/api/v4/projects/${encodeURIComponent(projectId)}/merge_requests`,
			{ method: 'POST', token, authScheme: 'PRIVATE-TOKEN', body },
		)
		const mr = coerceGitlabMergeRequest(res)
		if (!mr) throw new Error('GitLab: createPR returned an unrecognised payload.')
		return mr
	}

	async updatePR(prNumber: number, patch: Partial<CreatePRInput>): Promise<PRMetadata> {
		const { projectId, host, token } = await this._ctx()
		const body: Record<string, unknown> = {}
		if (patch.title !== undefined) body.title = patch.title
		if (patch.body !== undefined) body.description = patch.body
		if (patch.base !== undefined) body.target_branch = patch.base
		const res = await fetchJson<unknown>(
			`${host}/api/v4/projects/${encodeURIComponent(projectId)}/merge_requests/${String(prNumber)}`,
			{ method: 'PUT', token, authScheme: 'PRIVATE-TOKEN', body },
		)
		const mr = coerceGitlabMergeRequest(res)
		if (!mr) throw new Error('GitLab: updatePR returned an unrecognised payload.')
		return mr
	}

	async enqueue(prNumber: number): Promise<{ position: number }> {
		const { projectId, host, token } = await this._ctx()
		// `merge_when_pipeline_succeeds` is the closest native-queue
		// approximation available on every GitLab tier; Merge Trains is an
		// Ultimate-only feature surfaced via the same endpoint when enabled.
		await fetchJson<unknown>(
			`${host}/api/v4/projects/${encodeURIComponent(projectId)}/merge_requests/${String(prNumber)}/merge`,
			{
				method: 'PUT',
				token,
				authScheme: 'PRIVATE-TOKEN',
				body: { merge_when_pipeline_succeeds: true },
			},
		)
		return { position: 1 }
	}

	async dequeue(prNumber: number): Promise<void> {
		const { projectId, host, token } = await this._ctx()
		await fetchJson<unknown>(
			`${host}/api/v4/projects/${encodeURIComponent(projectId)}/merge_requests/${String(prNumber)}/cancel_merge_when_pipeline_succeeds`,
			{ method: 'POST', token, authScheme: 'PRIVATE-TOKEN' },
		)
	}

	async queueStatus(prNumber: number): Promise<QueueStatus> {
		const { projectId, host, token } = await this._ctx()
		try {
			const res = await fetchJson<{
				merge_when_pipeline_succeeds?: boolean,
				merge_status?: string,
				state?: string,
				head_pipeline?: { status?: string } | null,
			}>(
				`${host}/api/v4/projects/${encodeURIComponent(projectId)}/merge_requests/${String(prNumber)}`,
				{ token, authScheme: 'PRIVATE-TOKEN' },
			)
			const inQueue = res.merge_when_pipeline_succeeds === true && res.state === 'opened'
			const checksStatus = coerceGitlabPipelineStatus(res.head_pipeline?.status)
			return { inQueue, position: inQueue ? 1 : undefined, checksStatus }
		} catch (e) {
			log.warn('GitLabAdapter.queueStatus: ' + errMsg(e))
			return { inQueue: false }
		}
	}

	private async _ctx(): Promise<{ projectId: string, host: string, token: string }> {
		const token = await this._token()
		if (!token) throw new Error('GitBraid: no GitLab token in secret storage (gitbraid.gitlabToken).')
		const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
		if (!root) throw new Error('GitBraid: no workspace folder — cannot determine GitLab project.')
		const slug = await this._slug(root)
		if (!slug) throw new Error('GitBraid: this workspace has no gitlab remote.')
		return { ...slug, token }
	}

	private async _token(): Promise<string | undefined> {
		try {
			return await this._secrets.get('gitbraid.gitlabToken')
		} catch {
			return undefined
		}
	}

	private async _slug(repoRoot: string): Promise<{ projectId: string, host: string } | undefined> {
		const r = await this._runner.run(['config', '--get', 'remote.origin.url'], { cwd: repoRoot })
		if (r.exitCode !== 0) return undefined
		return parseGitlabSlug(r.stdout.trim())
	}
}

// ─── BitbucketAdapter ────────────────────────────────────────────────────────

/**
 * Bitbucket Cloud REST v2 adapter.  Authenticates with HTTP Basic using a
 * `username:app-password` pair stored as a single string under
 * `gitbraid.bitbucketToken` (the user types them separated by `:` when setting
 * the token).  Bitbucket Cloud has no native merge queue, so `enqueue` throws
 * a user-visible error that explains the limitation rather than pretending
 * success.
 */
export class BitbucketAdapter implements PRHostAdapter {
	readonly name = 'bitbucket'

	constructor(
		private readonly _secrets: vscode.SecretStorage,
		private readonly _runner: IGitRunner = getDefaultGitRunner(),
	) {}

	async detect(repoRoot: string): Promise<boolean> {
		const token = await this._token()
		if (!token) return false
		const slug = await this._slug(repoRoot)
		return slug !== undefined
	}

	async getPR(branch: string): Promise<PRMetadata | undefined> {
		const all = await this.listOpen()
		return all.find((p) => p.head === branch)
	}

	async listOpen(): Promise<PRMetadata[]> {
		const { workspace, repo, token } = await this._ctx()
		const res = await fetchJson<{ values?: unknown[] }>(
			`https://api.bitbucket.org/2.0/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(repo)}/pullrequests?state=OPEN&pagelen=50`,
			{ token, authScheme: 'Basic' },
		)
		const values = Array.isArray(res.values) ? res.values : []
		const out: PRMetadata[] = []
		for (const raw of values) {
			const pr = coerceBitbucketPullRequest(raw)
			if (pr) out.push(pr)
		}
		return out
	}

	async createPR(input: CreatePRInput): Promise<PRMetadata> {
		const { workspace, repo, token } = await this._ctx()
		const body = {
			title: input.title,
			description: input.body,
			source: { branch: { name: input.head } },
			destination: { branch: { name: input.base } },
			// Bitbucket has no "draft" flag on Cloud; prefix the title as a
			// convention so reviewers can see it, matching how we handle
			// GitLab without Premium features.
			...(input.draft === true ? { title: `Draft: ${input.title}` } : {}),
		}
		const res = await fetchJson<unknown>(
			`https://api.bitbucket.org/2.0/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(repo)}/pullrequests`,
			{ method: 'POST', token, authScheme: 'Basic', body },
		)
		const pr = coerceBitbucketPullRequest(res)
		if (!pr) throw new Error('Bitbucket: createPR returned an unrecognised payload.')
		return pr
	}

	async updatePR(prNumber: number, patch: Partial<CreatePRInput>): Promise<PRMetadata> {
		const { workspace, repo, token } = await this._ctx()
		const body: Record<string, unknown> = {}
		if (patch.title !== undefined) body.title = patch.title
		if (patch.body !== undefined) body.description = patch.body
		if (patch.base !== undefined) body.destination = { branch: { name: patch.base } }
		const res = await fetchJson<unknown>(
			`https://api.bitbucket.org/2.0/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(repo)}/pullrequests/${String(prNumber)}`,
			{ method: 'PUT', token, authScheme: 'Basic', body },
		)
		const pr = coerceBitbucketPullRequest(res)
		if (!pr) throw new Error('Bitbucket: updatePR returned an unrecognised payload.')
		return pr
	}

	async enqueue(_prNumber: number): Promise<{ position: number }> {
		throw new Error(
			'GitBraid: Bitbucket Cloud does not expose a merge queue API. ' +
			'Merge the PR manually or enable auto-merge in the Bitbucket UI.',
		)
	}

	async dequeue(_prNumber: number): Promise<void> {
		throw new Error('GitBraid: Bitbucket Cloud has no merge queue to dequeue from.')
	}

	async queueStatus(_prNumber: number): Promise<QueueStatus> {
		return { inQueue: false }
	}

	private async _ctx(): Promise<{ workspace: string, repo: string, token: string }> {
		const token = await this._token()
		if (!token) throw new Error('GitBraid: no Bitbucket token in secret storage (gitbraid.bitbucketToken).')
		const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
		if (!root) throw new Error('GitBraid: no workspace folder — cannot determine Bitbucket repo.')
		const slug = await this._slug(root)
		if (!slug) throw new Error('GitBraid: this workspace has no bitbucket.org remote.')
		return { ...slug, token }
	}

	private async _token(): Promise<string | undefined> {
		try {
			return await this._secrets.get('gitbraid.bitbucketToken')
		} catch {
			return undefined
		}
	}

	private async _slug(repoRoot: string): Promise<{ workspace: string, repo: string } | undefined> {
		const r = await this._runner.run(['config', '--get', 'remote.origin.url'], { cwd: repoRoot })
		if (r.exitCode !== 0) return undefined
		return parseBitbucketSlug(r.stdout.trim())
	}
}

// ─── AzureDevOpsAdapter ──────────────────────────────────────────────────────

/**
 * Azure DevOps Services REST v7.1 adapter.  Authenticates with a Personal
 * Access Token stored under `gitbraid.azureDevOpsToken`.  ADO PATs are used
 * via HTTP Basic with an empty username (`:<PAT>`) — the adapter prepends
 * the colon internally so the user stores just the raw PAT.
 *
 * Remote URL support: modern `dev.azure.com/<org>/<project>/_git/<repo>`,
 * legacy `<org>.visualstudio.com/<project>/_git/<repo>`, and SSH v3
 * (`git@ssh.dev.azure.com:v3/<org>/<project>/<repo>`).
 *
 * Azure DevOps has no native "merge queue" concept.  The closest analogue
 * is the auto-complete flag, which instructs ADO to merge once branch
 * policies pass — but that is not a queue and exposes no position.  We
 * therefore throw a clear error from `enqueue`, matching the Bitbucket
 * adapter.  A dedicated "Auto-complete stack" command can be added later
 * if the demand is there.
 */
export class AzureDevOpsAdapter implements PRHostAdapter {
	readonly name = 'azure-devops'

	constructor(
		private readonly _secrets: vscode.SecretStorage,
		private readonly _runner: IGitRunner = getDefaultGitRunner(),
	) {}

	async detect(repoRoot: string): Promise<boolean> {
		const token = await this._token()
		if (!token) return false
		const slug = await this._slug(repoRoot)
		return slug !== undefined
	}

	async getPR(branch: string): Promise<PRMetadata | undefined> {
		const all = await this.listOpen()
		return all.find((p) => p.head === branch)
	}

	async listOpen(): Promise<PRMetadata[]> {
		const { baseUrl, project, repo, token } = await this._ctx()
		const res = await fetchJson<{ value?: unknown[] }>(
			`${baseUrl}/${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(repo)}/pullrequests?searchCriteria.status=active&api-version=7.1`,
			{ token, authScheme: 'Basic' },
		)
		const values = Array.isArray(res.value) ? res.value : []
		const out: PRMetadata[] = []
		for (const raw of values) {
			const pr = coerceAzureDevOpsPullRequest(raw)
			if (pr) out.push(pr)
		}
		return out
	}

	async createPR(input: CreatePRInput): Promise<PRMetadata> {
		const { baseUrl, project, repo, token } = await this._ctx()
		const body = {
			sourceRefName: _toFullRef(input.head),
			targetRefName: _toFullRef(input.base),
			title: input.title,
			description: input.body,
			isDraft: input.draft === true,
		}
		const res = await fetchJson<unknown>(
			`${baseUrl}/${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(repo)}/pullrequests?api-version=7.1`,
			{ method: 'POST', token, authScheme: 'Basic', body },
		)
		const pr = coerceAzureDevOpsPullRequest(res)
		if (!pr) throw new Error('Azure DevOps: createPR returned an unrecognised payload.')
		return pr
	}

	async updatePR(prNumber: number, patch: Partial<CreatePRInput>): Promise<PRMetadata> {
		const { baseUrl, project, repo, token } = await this._ctx()
		const body: Record<string, unknown> = {}
		if (patch.title !== undefined) body.title = patch.title
		if (patch.body !== undefined) body.description = patch.body
		if (patch.base !== undefined) body.targetRefName = _toFullRef(patch.base)
		const res = await fetchJson<unknown>(
			`${baseUrl}/${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(repo)}/pullrequests/${String(prNumber)}?api-version=7.1`,
			{ method: 'PATCH', token, authScheme: 'Basic', body },
		)
		const pr = coerceAzureDevOpsPullRequest(res)
		if (!pr) throw new Error('Azure DevOps: updatePR returned an unrecognised payload.')
		return pr
	}

	async enqueue(_prNumber: number): Promise<{ position: number }> {
		throw new Error(
			'GitBraid: Azure DevOps has no native merge queue API. ' +
			'Enable auto-complete on the PR in the Azure DevOps UI, or merge the stack manually.',
		)
	}

	async dequeue(_prNumber: number): Promise<void> {
		throw new Error('GitBraid: Azure DevOps has no merge queue to dequeue from.')
	}

	async queueStatus(_prNumber: number): Promise<QueueStatus> {
		return { inQueue: false }
	}

	private async _ctx(): Promise<{ baseUrl: string, org: string, project: string, repo: string, token: string }> {
		const raw = await this._token()
		if (!raw) throw new Error('GitBraid: no Azure DevOps token in secret storage (gitbraid.azureDevOpsToken).')
		// ADO PAT auth is HTTP Basic with an empty username; prepend the
		// separator so the shared `Basic` branch of `fetchJson` base64-encodes
		// `:<PAT>` as required.
		const token = ':' + raw
		const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
		if (!root) throw new Error('GitBraid: no workspace folder — cannot determine Azure DevOps repo.')
		const slug = await this._slug(root)
		if (!slug) throw new Error('GitBraid: this workspace has no Azure DevOps remote.')
		const baseUrl = slug.host === 'dev.azure.com'
			? `https://dev.azure.com/${encodeURIComponent(slug.org)}`
			: `https://${encodeURIComponent(slug.org)}.visualstudio.com`
		return { baseUrl, org: slug.org, project: slug.project, repo: slug.repo, token }
	}

	private async _token(): Promise<string | undefined> {
		try {
			return await this._secrets.get('gitbraid.azureDevOpsToken')
		} catch {
			return undefined
		}
	}

	private async _slug(repoRoot: string): Promise<AzureDevOpsSlug | undefined> {
		const r = await this._runner.run(['config', '--get', 'remote.origin.url'], { cwd: repoRoot })
		if (r.exitCode !== 0) return undefined
		return parseAzureDevOpsSlug(r.stdout.trim())
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
 *
 * Output is normalised so the function is idempotent: both the
 * prepend-and-replace paths produce content with at most one blank line
 * between sections and a single trailing newline.
 */
export function mergeStackBlock(existingBody: string, block: string): string {
	if (existingBody.trimStart().startsWith(DO_NOT_TOUCH)) {
		return existingBody
	}
	const start = existingBody.indexOf(STACK_BLOCK_START)
	const end = existingBody.indexOf(STACK_BLOCK_END)
	let raw: string
	if (start !== -1 && end !== -1 && end > start) {
		const before = existingBody.slice(0, start)
		const after = existingBody.slice(end + STACK_BLOCK_END.length)
		raw = before + block + after
	} else {
		const joiner = existingBody.trim().length > 0 ? '\n\n' : ''
		raw = block + joiner + existingBody
	}
	return raw.replace(/\n{3,}/g, '\n\n').replace(/\n+$/, '') + '\n'
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

	if (setting === 'gitlab') {
		const gl = new GitLabAdapter(secrets)
		if (await gl.detect(repoRoot)) return gl
		return new NullPRHostAdapter()
	}
	if (setting === 'bitbucket') {
		const bb = new BitbucketAdapter(secrets)
		if (await bb.detect(repoRoot)) return bb
		return new NullPRHostAdapter()
	}
	if (setting === 'azure') {
		const ado = new AzureDevOpsAdapter(secrets)
		if (await ado.detect(repoRoot)) return ado
		return new NullPRHostAdapter()
	}
	if (setting === 'github') {
		const vs = new GitHubVSCodeAdapter()
		if (await vs.detect(repoRoot)) return vs
		const oct = new GitHubOctokitAdapter(secrets)
		if (await oct.detect(repoRoot)) return oct
		return new NullPRHostAdapter()
	}

	// `auto` — dispatch by origin URL so a GitLab repo doesn't pointlessly try
	// the GitHub extension first.  Fall back to trying everything if the
	// origin doesn't match a known host (self-hosted / ssh configs we haven't
	// seen will still go through each adapter's own `detect`).
	const host = await _detectRemoteHost(repoRoot)
	if (host === 'gitlab') {
		const gl = new GitLabAdapter(secrets)
		if (await gl.detect(repoRoot)) return gl
	}
	if (host === 'bitbucket') {
		const bb = new BitbucketAdapter(secrets)
		if (await bb.detect(repoRoot)) return bb
	}
	if (host === 'azure') {
		const ado = new AzureDevOpsAdapter(secrets)
		if (await ado.detect(repoRoot)) return ado
	}
	if (host === 'github' || host === undefined) {
		const vs = new GitHubVSCodeAdapter()
		if (await vs.detect(repoRoot)) return vs
		const oct = new GitHubOctokitAdapter(secrets)
		if (await oct.detect(repoRoot)) return oct
	}
	return new NullPRHostAdapter()
}

async function _detectRemoteHost(repoRoot: string): Promise<'github' | 'gitlab' | 'bitbucket' | 'azure' | undefined> {
	try {
		const r = await getDefaultGitRunner().run(['config', '--get', 'remote.origin.url'], { cwd: repoRoot })
		if (r.exitCode !== 0) return undefined
		const url = r.stdout.trim().toLowerCase()
		if (url.includes('github.com')) return 'github'
		if (url.includes('gitlab')) return 'gitlab'
		if (url.includes('bitbucket.org')) return 'bitbucket'
		if (url.includes('dev.azure.com') || url.includes('visualstudio.com')) return 'azure'
	} catch {
		// fall through
	}
	return undefined
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

/**
 * Parse a GitLab remote into the pieces the REST API needs.  Supports both
 * gitlab.com and self-hosted instances, plus groups-with-subgroups paths
 * (`group/subgroup/project`) that GitLab nests deeply.  Projects can be
 * addressed by the url-encoded full path, which is what we return in
 * `projectId`.
 */
export function parseGitlabSlug(remoteUrl: string): { projectId: string, host: string } | undefined {
	if (!remoteUrl) return undefined
	// ssh: git@<host>:path/to/repo(.git)?
	const ssh = /^git@([^:]+):(.+?)(?:\.git)?$/i.exec(remoteUrl)
	if (ssh && /gitlab/i.test(ssh[1])) {
		return { projectId: ssh[2], host: 'https://' + ssh[1] }
	}
	// https: https://<host>/path/to/repo(.git)?
	const https = /^https?:\/\/(?:[^@]+@)?([^/]+)\/(.+?)(?:\.git)?\/?$/i.exec(remoteUrl)
	if (https && /gitlab/i.test(https[1])) {
		return { projectId: https[2], host: 'https://' + https[1] }
	}
	return undefined
}

/**
 * Parse a Bitbucket Cloud remote.  Only bitbucket.org is supported — Server /
 * Data Center deployments speak a different REST dialect and would need their
 * own adapter.
 */
export function parseBitbucketSlug(remoteUrl: string): { workspace: string, repo: string } | undefined {
	if (!remoteUrl) return undefined
	const ssh = /^git@bitbucket\.org:([^/]+)\/(.+?)(?:\.git)?$/i.exec(remoteUrl)
	if (ssh) return { workspace: ssh[1], repo: ssh[2] }
	const https = /^https?:\/\/(?:[^@]+@)?bitbucket\.org\/([^/]+)\/(.+?)(?:\.git)?\/?$/i.exec(remoteUrl)
	if (https) return { workspace: https[1], repo: https[2] }
	return undefined
}

/**
 * Identifies an Azure DevOps repo.  `host` is `'dev.azure.com'` for the
 * modern URL scheme and `'visualstudio.com'` for legacy tenants; the
 * adapter switches base URL on that flag because the two hostings differ
 * in path shape.
 */
export interface AzureDevOpsSlug {
	org: string
	project: string
	repo: string
	host: 'dev.azure.com' | 'visualstudio.com'
}

/**
 * Parse an Azure DevOps remote URL into org / project / repo.  Supports:
 *   - modern https: https://dev.azure.com/<org>/<project>/_git/<repo>(.git)?
 *   - with user:   https://<org>@dev.azure.com/<org>/<project>/_git/<repo>
 *   - legacy https: https://<org>.visualstudio.com/<project>/_git/<repo>
 *   - ssh v3:       git@ssh.dev.azure.com:v3/<org>/<project>/<repo>
 *
 * Project and repo names allow spaces in ADO; they arrive URL-encoded in
 * https remotes (e.g. `My%20Project`) and unencoded in ssh remotes.  We
 * decode to a consistent internal form and let `_ctx` re-encode for the
 * API call.
 */
export function parseAzureDevOpsSlug(remoteUrl: string): AzureDevOpsSlug | undefined {
	if (!remoteUrl) return undefined
	// ssh v3: git@ssh.dev.azure.com:v3/<org>/<project>/<repo>
	const ssh = /^git@ssh\.dev\.azure\.com:v3\/([^/]+)\/([^/]+)\/(.+?)(?:\.git)?$/i.exec(remoteUrl)
	if (ssh) {
		return {
			org: decodeURIComponent(ssh[1]),
			project: decodeURIComponent(ssh[2]),
			repo: decodeURIComponent(ssh[3]),
			host: 'dev.azure.com',
		}
	}
	// modern https: https://[user@]dev.azure.com/<org>/<project>/_git/<repo>
	const modern = /^https?:\/\/(?:[^@]+@)?dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/(.+?)(?:\.git)?\/?$/i.exec(remoteUrl)
	if (modern) {
		return {
			org: decodeURIComponent(modern[1]),
			project: decodeURIComponent(modern[2]),
			repo: decodeURIComponent(modern[3]),
			host: 'dev.azure.com',
		}
	}
	// legacy https: https://<org>.visualstudio.com/<project>/_git/<repo>
	const legacy = /^https?:\/\/(?:[^@]+@)?([^./]+)\.visualstudio\.com\/([^/]+)\/_git\/(.+?)(?:\.git)?\/?$/i.exec(remoteUrl)
	if (legacy) {
		return {
			org: decodeURIComponent(legacy[1]),
			project: decodeURIComponent(legacy[2]),
			repo: decodeURIComponent(legacy[3]),
			host: 'visualstudio.com',
		}
	}
	return undefined
}

function _toFullRef(branch: string): string {
	return branch.startsWith('refs/') ? branch : 'refs/heads/' + branch
}

function coerceAzureDevOpsPullRequest(raw: unknown): PRMetadata | undefined {
	if (typeof raw !== 'object' || raw === null) return undefined
	const r = raw as Record<string, unknown>
	const number = typeof r.pullRequestId === 'number' ? r.pullRequestId : undefined
	const sourceRef = typeof r.sourceRefName === 'string' ? r.sourceRefName : undefined
	const targetRef = typeof r.targetRefName === 'string' ? r.targetRefName : ''
	if (number === undefined || !sourceRef) return undefined
	const headRef = sourceRef.replace(/^refs\/heads\//, '')
	const baseRef = targetRef.replace(/^refs\/heads\//, '')
	const title = typeof r.title === 'string' ? r.title : '(untitled)'
	const body = typeof r.description === 'string' ? r.description : ''
	// ADO doesn't return a browser URL on the PR object directly; construct
	// one from the `repository.webUrl` when available, falling back to the
	// `_links.web` href if present.
	const links = r._links as Record<string, unknown> | undefined
	const webLink = links?.web as Record<string, unknown> | undefined
	const url = typeof webLink?.href === 'string' ? webLink.href
		: typeof r.url === 'string' ? r.url
		: ''
	const isDraft = r.isDraft === true
	const rawStatus = typeof r.status === 'string' ? r.status.toLowerCase() : ''
	let state: PRState
	if (rawStatus === 'completed') state = 'merged'
	else if (rawStatus === 'abandoned') state = 'closed'
	else if (isDraft) state = 'draft'
	else state = 'open'
	return { number, url, state, base: baseRef, head: headRef, title, body }
}

function coerceGitlabMergeRequest(raw: unknown): PRMetadata | undefined {
	if (typeof raw !== 'object' || raw === null) return undefined
	const r = raw as Record<string, unknown>
	const number = typeof r.iid === 'number' ? r.iid : undefined
	const headRef = typeof r.source_branch === 'string' ? r.source_branch : undefined
	const baseRef = typeof r.target_branch === 'string' ? r.target_branch : ''
	if (number === undefined || !headRef) return undefined
	const title = typeof r.title === 'string' ? r.title : '(untitled)'
	const body = typeof r.description === 'string' ? r.description : ''
	const url = typeof r.web_url === 'string' ? r.web_url : ''
	const rawState = typeof r.state === 'string' ? r.state.toLowerCase() : ''
	// GitLab marks drafts by title prefix, not a flag — honour both the
	// classic `WIP:` and the modern `Draft:` marker.
	const isDraft = /^\s*(draft|wip)\s*:/i.test(title)
	let state: PRState
	if (rawState === 'merged') state = 'merged'
	else if (rawState === 'closed') state = 'closed'
	else if (isDraft) state = 'draft'
	else state = 'open'
	return { number, url, state, base: baseRef, head: headRef, title, body }
}

function coerceGitlabPipelineStatus(status: string | undefined): ChecksStatus | undefined {
	if (!status) return undefined
	switch (status.toLowerCase()) {
		case 'success':   return 'success'
		case 'failed':    return 'failure'
		case 'canceled':  return 'failure'
		case 'pending':   return 'pending'
		case 'running':   return 'pending'
		case 'created':   return 'pending'
		default:          return undefined
	}
}

function coerceBitbucketPullRequest(raw: unknown): PRMetadata | undefined {
	if (typeof raw !== 'object' || raw === null) return undefined
	const r = raw as Record<string, unknown>
	const number = typeof r.id === 'number' ? r.id : undefined
	const source = r.source as Record<string, unknown> | undefined
	const destination = r.destination as Record<string, unknown> | undefined
	const srcBranch = source?.branch as Record<string, unknown> | undefined
	const dstBranch = destination?.branch as Record<string, unknown> | undefined
	const headRef = typeof srcBranch?.name === 'string' ? srcBranch.name : undefined
	const baseRef = typeof dstBranch?.name === 'string' ? dstBranch.name : ''
	if (number === undefined || !headRef) return undefined
	const title = typeof r.title === 'string' ? r.title : '(untitled)'
	const body = typeof r.description === 'string' ? r.description : ''
	const links = r.links as Record<string, unknown> | undefined
	const htmlLink = links?.html as Record<string, unknown> | undefined
	const url = typeof htmlLink?.href === 'string' ? htmlLink.href : ''
	const rawState = typeof r.state === 'string' ? r.state.toUpperCase() : ''
	const isDraft = /^\s*draft\s*:/i.test(title)
	let state: PRState
	if (rawState === 'MERGED') state = 'merged'
	else if (rawState === 'DECLINED' || rawState === 'SUPERSEDED') state = 'closed'
	else if (isDraft) state = 'draft'
	else state = 'open'
	return { number, url, state, base: baseRef, head: headRef, title, body }
}

interface FetchOptions {
	method?: string
	token?: string
	body?: unknown
	/**
	 * How to send the token.  GitHub uses `Bearer`, GitLab expects the
	 * `PRIVATE-TOKEN` header, Bitbucket wants HTTP Basic (and the token value
	 * itself should be `username:app_password`).  Defaults to `Bearer` so the
	 * existing GitHub call sites don't have to change.
	 */
	authScheme?: 'Bearer' | 'PRIVATE-TOKEN' | 'Basic'
}

async function graphql<T>(
	token: string,
	query: string,
	variables: Record<string, unknown>,
): Promise<T> {
	type GraphqlResponse<R> = { data?: R, errors?: Array<{ message: string }> }
	const res = await fetchJson<GraphqlResponse<T>>(
		'https://api.github.com/graphql',
		{ method: 'POST', token, body: { query, variables } },
	)
	if (res.errors && res.errors.length > 0) {
		throw new Error('GitHub GraphQL: ' + res.errors.map((e) => e.message).join('; '))
	}
	if (!res.data) throw new Error('GitHub GraphQL: empty data')
	return res.data
}

function coerceChecksState(state: string | undefined): ChecksStatus | undefined {
	if (!state) return undefined
	switch (state.toUpperCase()) {
		case 'SUCCESS':  return 'success'
		case 'FAILURE':  return 'failure'
		case 'ERROR':    return 'failure'
		case 'PENDING':  return 'pending'
		case 'EXPECTED': return 'pending'
		default:         return undefined
	}
}

async function fetchJson<T>(url: string, opts: FetchOptions = {}): Promise<T> {
	const headers: Record<string, string> = {
		'Accept': 'application/json',
		'User-Agent': 'gitbraid',
	}
	const scheme = opts.authScheme ?? 'Bearer'
	if (opts.token) {
		switch (scheme) {
			case 'Bearer':
				headers['Authorization'] = 'Bearer ' + opts.token
				// Keep the GitHub-specific accept header on the default path so
				// the v3 REST shape doesn't drift to v4 on calls we haven't
				// migrated to GraphQL.
				headers['Accept'] = 'application/vnd.github+json'
				break
			case 'PRIVATE-TOKEN':
				headers['PRIVATE-TOKEN'] = opts.token
				break
			case 'Basic':
				// Node's `btoa` is available on v16+.  The token is already
				// `username:app_password`, so we base64 it verbatim.
				headers['Authorization'] = 'Basic ' + Buffer.from(opts.token, 'utf-8').toString('base64')
				break
		}
	}
	if (opts.body !== undefined) headers['Content-Type'] = 'application/json'

	const res = await fetch(url, {
		method: opts.method ?? 'GET',
		headers,
		body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
	})
	if (!res.ok) {
		const txt = await res.text().catch(() => '')
		throw new Error(`${new URL(url).host} ${String(res.status)} ${res.statusText}: ${txt.slice(0, 500)}`)
	}
	return (await res.json()) as T
}

function errMsg(e: unknown): string {
	return e instanceof Error ? e.message : String(e)
}
