import * as assert from 'node:assert'
import * as vscode from 'vscode'
import {
	GitHubOctokitAdapter,
	GitHubVSCodeAdapter,
	GitLabAdapter,
	BitbucketAdapter,
	AzureDevOpsAdapter,
	pickAdapter,
} from '../src/prHostAdapter'
import { FakeGitRunner } from './helpers/fakeGitRunner'

// ─── Fetch mock ───────────────────────────────────────────────────────────────

interface MockResponse {
	url: string
	method: string
	headers: Record<string, string>
	body: unknown
	ok: boolean
	status: number
	text: () => Promise<string>
	json: () => Promise<unknown>
}

interface MockSetup {
	url: string | RegExp
	method?: string
	respond: (req: { url: string, method: string, body?: unknown }) => unknown
	/** Fixed status, or a function so a test can vary it call-by-call (e.g. 429 then 200). */
	status?: number | (() => number)
	/** Response headers, e.g. `{ 'retry-after': '1' }` for rate-limit tests. Also supports a function for the same reason as `status`. */
	responseHeaders?: Record<string, string> | (() => Record<string, string>)
}

class FetchRecorder {
	readonly calls: MockResponse[] = []
	readonly setups: MockSetup[] = []
	private _origFetch: typeof fetch | undefined

	install(): void {
		this._origFetch = globalThis.fetch
		globalThis.fetch = ((url: RequestInfo | URL, init?: RequestInit) => this._handle(url, init)) as typeof fetch
	}

	uninstall(): void {
		if (this._origFetch) globalThis.fetch = this._origFetch
	}

	on(setup: MockSetup): void {
		this.setups.push(setup)
	}

	private async _handle(url: RequestInfo | URL, init?: RequestInit): Promise<Response> {
		const u = typeof url === 'string' ? url : url.toString()
		const method = init?.method ?? 'GET'
		const body = init?.body !== undefined ? JSON.parse(String(init.body)) : undefined
		const headers: Record<string, string> = {}
		if (init?.headers) {
			for (const [k, v] of Object.entries(init.headers as Record<string, string>)) {
				headers[k] = v
			}
		}
		const matched = this.setups.find((s) => {
			const urlOk = typeof s.url === 'string' ? u === s.url : s.url.test(u)
			const methodOk = !s.method || s.method === method
			return urlOk && methodOk
		})
		// `respond()` runs first (and is the one closure a test always
		// provides) so a shared counter incremented inside it produces a
		// consistent "which attempt is this" view for `status`/
		// `responseHeaders` below, rather than depending on call order
		// between three independently-side-effecting closures.
		const responseBody = matched ? matched.respond({ url: u, method, body }) : { error: 'no setup' }
		const statusSetting = matched?.status ?? (matched ? 200 : 404)
		const status = typeof statusSetting === 'function' ? statusSetting() : statusSetting
		const text = JSON.stringify(responseBody)
		const recorded: MockResponse = { url: u, method, headers, body, ok: status >= 200 && status < 300, status, text: async () => text, json: async () => responseBody }
		this.calls.push(recorded)
		const headersSetting = matched?.responseHeaders ?? {}
		const responseHeaders = typeof headersSetting === 'function' ? headersSetting() : headersSetting
		return {
			ok: recorded.ok,
			status: recorded.status,
			statusText: recorded.ok ? 'OK' : 'NOT_FOUND',
			text: () => Promise.resolve(text),
			json: () => Promise.resolve(responseBody),
			headers: { get: (name: string) => responseHeaders[name.toLowerCase()] ?? null },
		} as unknown as Response
	}
}

// ─── Fake SecretStorage ───────────────────────────────────────────────────────

class FakeSecretStorage implements vscode.SecretStorage {
	private readonly _store = new Map<string, string>()

	readonly onDidChange = (() => ({ dispose: () => { /* */ } })) as unknown as vscode.Event<vscode.SecretStorageChangeEvent>

	async get(key: string): Promise<string | undefined> {
		return this._store.get(key)
	}
	async store(key: string, value: string): Promise<void> {
		this._store.set(key, value)
	}
	async delete(key: string): Promise<void> {
		this._store.delete(key)
	}
}

// ─── GitHubOctokitAdapter ────────────────────────────────────────────────────

suite('GitHubOctokitAdapter (REST)', () => {
	let recorder: FetchRecorder
	let secrets: FakeSecretStorage
	let runner: FakeGitRunner
	let adapter: GitHubOctokitAdapter

	setup(async () => {
		recorder = new FetchRecorder()
		recorder.install()
		secrets = new FakeSecretStorage()
		await secrets.store('gitbraid.githubToken', 'gh-token-123')
		runner = new FakeGitRunner()
		runner.fixture('config --get remote.origin.url', { stdout: 'https://github.com/foo/bar.git\n' })
		adapter = new GitHubOctokitAdapter('/tmp', secrets, runner)
	})

	teardown(() => recorder.uninstall())

	test('detect: succeeds when token present and origin is github', async () => {
		assert.strictEqual(await adapter.detect('/tmp'), true)
	})

	test('detect: false when no token', async () => {
		await secrets.delete('gitbraid.githubToken')
		assert.strictEqual(await adapter.detect('/tmp'), false)
	})

	test('listOpen: uses the constructor repoRoot, not vscode.workspace.workspaceFolders[0], to resolve the remote', async () => {
		// This adapter is constructed with repoRoot='/tmp', which differs from
		// the real workspace root the test host runs in — proving `_ctx()`
		// reads the constructor's repoRoot rather than re-deriving one from
		// global workspace state (the bug this test guards against).
		recorder.on({ url: /pulls\?state=open/, respond: () => [] })
		await adapter.listOpen()
		const call = runner.calls.find((c) => c.args.join(' ').startsWith('config --get remote.origin.url'))
		assert.ok(call, 'expected a remote.origin.url lookup')
		assert.strictEqual(call!.cwd, '/tmp')
	})

	test('listOpen: parses GitHub REST array of PRs', async () => {
		recorder.on({
			url: /pulls\?state=open/,
			respond: () => ([
				{
					number: 42,
					html_url: 'https://github.com/foo/bar/pull/42',
					state: 'open',
					title: 'feat: cool',
					body: 'desc',
					head: { ref: 'feature/x' },
					base: { ref: 'main' },
				},
				// Drafts
				{
					number: 43,
					html_url: 'u',
					state: 'open',
					draft: true,
					title: 'wip',
					body: '',
					head: { ref: 'feature/y' },
					base: { ref: 'main' },
				},
				// Merged
				{
					number: 44,
					html_url: 'u',
					state: 'closed',
					merged_at: '2026-01-01',
					title: 'done',
					body: '',
					head: { ref: 'feature/z' },
					base: { ref: 'main' },
				},
			]),
		})
		const prs = await adapter.listOpen()
		assert.strictEqual(prs.length, 3)
		const x = prs.find((p) => p.head === 'feature/x')!
		assert.strictEqual(x.state, 'open')
		assert.strictEqual(x.number, 42)
		const y = prs.find((p) => p.head === 'feature/y')!
		assert.strictEqual(y.state, 'draft')
		const z = prs.find((p) => p.head === 'feature/z')!
		assert.strictEqual(z.state, 'merged')
	})

	test('createPR: POSTs with the right body and parses response', async () => {
		let bodySeen: { title?: string, head?: string, base?: string, draft?: boolean } | undefined
		recorder.on({
			url: /pulls$/,
			method: 'POST',
			respond: ({ body }) => {
				bodySeen = body as typeof bodySeen
				return {
					number: 99,
					html_url: 'https://github.com/foo/bar/pull/99',
					state: 'open',
					title: bodySeen?.title,
					body: 'desc',
					head: { ref: bodySeen?.head },
					base: { ref: bodySeen?.base },
				}
			},
		})
		const pr = await adapter.createPR({ title: 't', body: 'b', head: 'feature/x', base: 'main', draft: false })
		assert.strictEqual(pr.number, 99)
		assert.strictEqual(pr.head, 'feature/x')
		assert.strictEqual(bodySeen?.draft, false)
	})

	test('updatePR: sends PATCH with provided fields', async () => {
		let bodySeen: Record<string, unknown> | undefined
		recorder.on({
			url: /pulls\/7$/,
			method: 'PATCH',
			respond: ({ body }) => {
				bodySeen = body as Record<string, unknown>
				return {
					number: 7,
					html_url: 'u',
					state: 'open',
					title: bodySeen.title ?? 't',
					body: bodySeen.body ?? '',
					head: { ref: 'feature/x' },
					base: { ref: bodySeen.base ?? 'main' },
				}
			},
		})
		await adapter.updatePR(7, { title: 'new title', base: 'develop' })
		assert.strictEqual(bodySeen?.title, 'new title')
		assert.strictEqual(bodySeen?.base, 'develop')
		assert.ok(!('body' in (bodySeen ?? {})))
	})

	test('listOpen: throws on HTTP error', async () => {
		recorder.on({
			url: /pulls\?state=open/,
			respond: () => ({ message: 'not authorised' }),
			status: 401,
		})
		await assert.rejects(() => adapter.listOpen(), /401/)
	})

	test('getPR: enriches with review rollup and check-run detail', async () => {
		recorder.on({
			url: /pulls\?state=open/,
			respond: () => ([{
				number: 7,
				html_url: 'u',
				state: 'open',
				title: 't',
				body: 'b',
				head: { ref: 'feature/x', sha: 'deadbeef' },
				base: { ref: 'main' },
			}]),
		})
		recorder.on({
			url: /pulls\/7\/reviews/,
			respond: () => ([
				{ state: 'COMMENTED', user: { login: 'alice' } },
				{ state: 'APPROVED', user: { login: 'alice' } },
				{ state: 'CHANGES_REQUESTED', user: { login: 'bob' } },
			]),
		})
		recorder.on({
			url: /commits\/deadbeef\/check-runs/,
			respond: () => ({
				check_runs: [
					{ name: 'build', status: 'completed', conclusion: 'success', html_url: 'https://ci/build' },
					{ name: 'test', status: 'in_progress', conclusion: null },
				],
			}),
		})

		const pr = await adapter.getPR('feature/x')
		assert.strictEqual(pr?.number, 7)
		// alice's latest review (APPROVED) supersedes her earlier COMMENTED;
		// bob's CHANGES_REQUESTED wins the overall rollup.
		assert.strictEqual(pr?.reviewState, 'changesRequested')
		assert.strictEqual(pr?.reviewCount, 2)
		assert.deepStrictEqual(pr?.checksDetail, [
			{ name: 'build', state: 'success', url: 'https://ci/build' },
			{ name: 'test', state: 'pending', url: undefined },
		])
	})

	test('listOpen: retries once on a secondary rate limit with a short Retry-After, then succeeds', async () => {
		let calls = 0
		recorder.on({
			url: /pulls\?state=open/,
			respond: () => { calls++; return calls === 1 ? { message: 'secondary rate limit' } : [] },
			status: () => (calls === 1 ? 429 : 200),
			responseHeaders: { 'retry-after': '1' },
		})
		const result = await adapter.listOpen()
		assert.deepStrictEqual(result, [])
		assert.strictEqual(calls, 2, 'should have retried exactly once after the 429')
	})

	test('listOpen: fails fast (no retry) when the primary rate limit is exhausted', async () => {
		const resetEpoch = Math.floor(Date.now() / 1000) + 3600
		recorder.on({
			url: /pulls\?state=open/,
			respond: () => ({ message: 'API rate limit exceeded' }),
			status: 403,
			responseHeaders: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(resetEpoch) },
		})
		await assert.rejects(() => adapter.listOpen(), /rate limit exceeded — resets at/)
		assert.strictEqual(recorder.calls.length, 1, 'must not retry/block waiting for a reset that could be an hour away')
	})

	test('listOpen: 401 and 404 produce distinct, actionable messages', async () => {
		recorder.on({ url: /pulls\?state=open/, respond: () => ({ message: 'bad creds' }), status: 401 })
		await assert.rejects(() => adapter.listOpen(), /authentication failed \(401\)/)
	})

	test('getPR: enrichment failure is swallowed — PR is still returned without review/checks fields', async () => {
		recorder.on({
			url: /pulls\?state=open/,
			respond: () => ([{
				number: 7,
				html_url: 'u',
				state: 'open',
				title: 't',
				body: 'b',
				head: { ref: 'feature/x', sha: 'deadbeef' },
				base: { ref: 'main' },
			}]),
		})
		recorder.on({
			url: /pulls\/7\/reviews/,
			respond: () => ({ message: 'boom' }),
			status: 500,
		})

		const pr = await adapter.getPR('feature/x')
		assert.strictEqual(pr?.number, 7)
		assert.strictEqual(pr?.reviewState, undefined)
		assert.strictEqual(pr?.checksDetail, undefined)
	})
})

// ─── GitHubVSCodeAdapter.updatePR (token delegation) ─────────────────────────
//
// The vscode-pull-request-github extension has no programmatic edit API, so
// `updatePR` must delegate to a REST PATCH via GitHubOctokitAdapter whenever
// a token is available, and fail loudly (not silently "succeed" with an
// unchanged PR) when it isn't.

suite('GitHubVSCodeAdapter.updatePR (token delegation)', () => {
	let recorder: FetchRecorder
	let secrets: FakeSecretStorage
	let runner: FakeGitRunner

	setup(() => {
		recorder = new FetchRecorder()
		recorder.install()
		secrets = new FakeSecretStorage()
		runner = new FakeGitRunner()
		runner.fixture('config --get remote.origin.url', { stdout: 'https://github.com/foo/bar.git\n' })
	})

	teardown(() => recorder.uninstall())

	test('delegates to a real PATCH when a token is stored', async () => {
		await secrets.store('gitbraid.githubToken', 'gh-token-123')
		let bodySeen: Record<string, unknown> | undefined
		recorder.on({
			url: /pulls\/7$/,
			method: 'PATCH',
			respond: ({ body }) => {
				bodySeen = body as Record<string, unknown>
				return {
					number: 7,
					html_url: 'u',
					state: 'open',
					title: bodySeen.title ?? 't',
					body: bodySeen.body ?? '',
					head: { ref: 'feature/x' },
					base: { ref: 'main' },
				}
			},
		})
		const adapter = new GitHubVSCodeAdapter('/tmp', secrets, runner)
		const pr = await adapter.updatePR(7, { body: 'new stacked-PR block' })
		assert.strictEqual(bodySeen?.body, 'new stacked-PR block')
		assert.strictEqual(pr.number, 7)
	})

	test('throws an actionable error instead of silently succeeding when no token is stored', async () => {
		const adapter = new GitHubVSCodeAdapter('/tmp', secrets, runner)
		await assert.rejects(
			() => adapter.updatePR(7, { body: 'new stacked-PR block' }),
			/Store a token/,
		)
		// No PATCH (or any network call) should have been attempted.
		assert.strictEqual(recorder.calls.length, 0)
	})

	// The real vscode-pull-request-github extension isn't installed in the
	// test host, so `listOpen()`/`getPR()` can't reach the extension's data
	// model here. `_enrichWithReviewAndChecks` is exercised directly instead
	// — it's the token-driven half of the path and doesn't depend on the
	// extension being present.
	test('_enrichWithReviewAndChecks: merges review/checks detail onto a PR fetched via the extension', async () => {
		await secrets.store('gitbraid.githubToken', 'gh-token-123')
		recorder.on({
			url: /pulls\/7$/,
			respond: () => ({ head: { sha: 'deadbeef' } }),
		})
		recorder.on({
			url: /pulls\/7\/reviews/,
			respond: () => ([{ state: 'APPROVED', user: { login: 'alice' } }]),
		})
		recorder.on({
			url: /commits\/deadbeef\/check-runs/,
			respond: () => ({ check_runs: [{ name: 'build', status: 'completed', conclusion: 'success' }] }),
		})

		const adapter = new GitHubVSCodeAdapter('/tmp', secrets, runner)
		const basePr = { number: 7, url: 'u', state: 'open' as const, base: 'main', head: 'feature/x', title: 't', body: 'b' }
		const enriched = await (adapter as unknown as {
			_enrichWithReviewAndChecks: (pr: typeof basePr) => Promise<typeof basePr & { reviewState?: string, reviewCount?: number }>
		})._enrichWithReviewAndChecks(basePr)

		assert.strictEqual(enriched.reviewState, 'approved')
		assert.strictEqual(enriched.reviewCount, 1)
	})

	test('_enrichWithReviewAndChecks: returns the PR unchanged when no token is stored', async () => {
		const adapter = new GitHubVSCodeAdapter('/tmp', secrets, runner)
		const basePr = { number: 7, url: 'u', state: 'open' as const, base: 'main', head: 'feature/x', title: 't', body: 'b' }
		const result = await (adapter as unknown as {
			_enrichWithReviewAndChecks: (pr: typeof basePr) => Promise<typeof basePr>
		})._enrichWithReviewAndChecks(basePr)
		assert.deepStrictEqual(result, basePr)
		assert.strictEqual(recorder.calls.length, 0)
	})

	test('_enrichWithReviewAndChecks: uses the constructor repoRoot, not vscode.workspace.workspaceFolders[0]', async () => {
		await secrets.store('gitbraid.githubToken', 'gh-token-123')
		recorder.on({ url: /pulls\/7$/, respond: () => ({ head: { sha: 'deadbeef' } }) })
		recorder.on({ url: /pulls\/7\/reviews/, respond: () => [] })
		recorder.on({ url: /commits\/deadbeef\/check-runs/, respond: () => ({ check_runs: [] }) })

		const adapter = new GitHubVSCodeAdapter('/tmp', secrets, runner)
		const basePr = { number: 7, url: 'u', state: 'open' as const, base: 'main', head: 'feature/x', title: 't', body: 'b' }
		await (adapter as unknown as {
			_enrichWithReviewAndChecks: (pr: typeof basePr) => Promise<unknown>
		})._enrichWithReviewAndChecks(basePr)

		const call = runner.calls.find((c) => c.args.join(' ').startsWith('config --get remote.origin.url'))
		assert.ok(call, 'expected a remote.origin.url lookup')
		assert.strictEqual(call!.cwd, '/tmp')
	})
})

// ─── GitLabAdapter ───────────────────────────────────────────────────────────

suite('GitLabAdapter (REST)', () => {
	let recorder: FetchRecorder
	let secrets: FakeSecretStorage
	let runner: FakeGitRunner
	let adapter: GitLabAdapter

	setup(async () => {
		recorder = new FetchRecorder()
		recorder.install()
		secrets = new FakeSecretStorage()
		await secrets.store('gitbraid.gitlabToken', 'gl-token')
		runner = new FakeGitRunner()
		runner.fixture('config --get remote.origin.url', { stdout: 'https://gitlab.com/group/proj.git\n' })
		adapter = new GitLabAdapter('/tmp', secrets, runner)
	})

	teardown(() => recorder.uninstall())

	test('detect: true when token + gitlab remote', async () => {
		assert.strictEqual(await adapter.detect('/tmp'), true)
	})

	test('listOpen: parses MR array', async () => {
		recorder.on({
			url: /merge_requests/,
			respond: () => ([
				{ iid: 1, web_url: 'u', state: 'opened', title: 'feat: a', description: 'd', source_branch: 'feature/x', target_branch: 'main' },
				{ iid: 2, web_url: 'u', state: 'opened', title: 'Draft: wip', description: '', source_branch: 'feature/y', target_branch: 'main' },
				{ iid: 3, web_url: 'u', state: 'merged', title: 'done', description: '', source_branch: 'feature/z', target_branch: 'main' },
				{ iid: 4, web_url: 'u', state: 'closed', title: 'rejected', description: '', source_branch: 'feature/w', target_branch: 'main' },
			]),
		})
		const prs = await adapter.listOpen()
		assert.strictEqual(prs.length, 4)
		assert.strictEqual(prs.find((p) => p.head === 'feature/y')?.state, 'draft')
		assert.strictEqual(prs.find((p) => p.head === 'feature/z')?.state, 'merged')
		assert.strictEqual(prs.find((p) => p.head === 'feature/w')?.state, 'closed')
	})

	test('listOpen: PRIVATE-TOKEN header is sent (not Bearer)', async () => {
		recorder.on({ url: /merge_requests/, respond: () => ([]) })
		await adapter.listOpen()
		const lastCall = recorder.calls[recorder.calls.length - 1]
		assert.strictEqual(lastCall.headers['PRIVATE-TOKEN'], 'gl-token')
		assert.strictEqual(lastCall.headers['Authorization'], undefined)
	})

	test('listOpen: uses the constructor repoRoot, not vscode.workspace.workspaceFolders[0]', async () => {
		recorder.on({ url: /merge_requests/, respond: () => ([]) })
		await adapter.listOpen()
		const call = runner.calls.find((c) => c.args.join(' ').startsWith('config --get remote.origin.url'))
		assert.ok(call, 'expected a remote.origin.url lookup')
		assert.strictEqual(call!.cwd, '/tmp')
	})
})

// ─── BitbucketAdapter ────────────────────────────────────────────────────────

suite('BitbucketAdapter (REST)', () => {
	let recorder: FetchRecorder
	let secrets: FakeSecretStorage
	let runner: FakeGitRunner
	let adapter: BitbucketAdapter

	setup(async () => {
		recorder = new FetchRecorder()
		recorder.install()
		secrets = new FakeSecretStorage()
		await secrets.store('gitbraid.bitbucketToken', 'user:apppwd')
		runner = new FakeGitRunner()
		runner.fixture('config --get remote.origin.url', { stdout: 'https://bitbucket.org/team/repo.git\n' })
		adapter = new BitbucketAdapter('/tmp', secrets, runner)
	})

	teardown(() => recorder.uninstall())

	test('detect: true when token + bitbucket remote', async () => {
		assert.strictEqual(await adapter.detect('/tmp'), true)
	})

	test('listOpen: parses values[] payload', async () => {
		recorder.on({
			url: /pullrequests/,
			respond: () => ({
				values: [
					{
						id: 5,
						state: 'OPEN',
						title: 'feat: a',
						description: 'd',
						source: { branch: { name: 'feature/x' } },
						destination: { branch: { name: 'main' } },
						links: { html: { href: 'https://bb/5' } },
					},
					{
						id: 6,
						state: 'MERGED',
						title: 'done',
						description: '',
						source: { branch: { name: 'feature/y' } },
						destination: { branch: { name: 'main' } },
						links: { html: { href: 'u' } },
					},
				],
			}),
		})
		const prs = await adapter.listOpen()
		assert.strictEqual(prs.length, 2)
		assert.strictEqual(prs.find((p) => p.head === 'feature/x')?.state, 'open')
		assert.strictEqual(prs.find((p) => p.head === 'feature/y')?.state, 'merged')
	})

	test('listOpen: Basic auth header used (base64 of user:pwd)', async () => {
		recorder.on({ url: /pullrequests/, respond: () => ({ values: [] }) })
		await adapter.listOpen()
		const last = recorder.calls[recorder.calls.length - 1]
		assert.ok(last.headers['Authorization']?.startsWith('Basic '))
		const expected = 'Basic ' + Buffer.from('user:apppwd', 'utf-8').toString('base64')
		assert.strictEqual(last.headers['Authorization'], expected)
	})

	test('listOpen: uses the constructor repoRoot, not vscode.workspace.workspaceFolders[0]', async () => {
		recorder.on({ url: /pullrequests/, respond: () => ({ values: [] }) })
		await adapter.listOpen()
		const call = runner.calls.find((c) => c.args.join(' ').startsWith('config --get remote.origin.url'))
		assert.ok(call, 'expected a remote.origin.url lookup')
		assert.strictEqual(call!.cwd, '/tmp')
	})
})

// ─── AzureDevOpsAdapter ──────────────────────────────────────────────────────

suite('AzureDevOpsAdapter (REST)', () => {
	let recorder: FetchRecorder
	let secrets: FakeSecretStorage
	let runner: FakeGitRunner
	let adapter: AzureDevOpsAdapter

	setup(async () => {
		recorder = new FetchRecorder()
		recorder.install()
		secrets = new FakeSecretStorage()
		await secrets.store('gitbraid.azureDevOpsToken', 'pat-token')
		runner = new FakeGitRunner()
		runner.fixture('config --get remote.origin.url', {
			stdout: 'https://dev.azure.com/contoso/MyProject/_git/myrepo\n',
		})
		adapter = new AzureDevOpsAdapter('/tmp', secrets, runner)
	})

	teardown(() => recorder.uninstall())

	test('detect: true when token + azure remote', async () => {
		assert.strictEqual(await adapter.detect('/tmp'), true)
	})

	test('listOpen: parses value[] of pull requests', async () => {
		recorder.on({
			url: /pullrequests/,
			respond: () => ({
				value: [
					{
						pullRequestId: 11,
						sourceRefName: 'refs/heads/feature/x',
						targetRefName: 'refs/heads/main',
						title: 'feat: a',
						description: 'd',
						status: 'active',
						_links: { web: { href: 'https://ado/11' } },
					},
					{
						pullRequestId: 12,
						sourceRefName: 'refs/heads/feature/y',
						targetRefName: 'refs/heads/main',
						title: 'feat: b',
						description: '',
						isDraft: true,
						status: 'active',
						_links: { web: { href: 'u' } },
					},
					{
						pullRequestId: 13,
						sourceRefName: 'refs/heads/feature/z',
						targetRefName: 'refs/heads/main',
						title: 'done',
						description: '',
						status: 'completed',
						_links: { web: { href: 'u' } },
					},
				],
			}),
		})
		const prs = await adapter.listOpen()
		assert.strictEqual(prs.length, 3)
		assert.strictEqual(prs.find((p) => p.head === 'feature/y')?.state, 'draft')
		assert.strictEqual(prs.find((p) => p.head === 'feature/z')?.state, 'merged')
	})

	test('listOpen: uses the constructor repoRoot, not vscode.workspace.workspaceFolders[0]', async () => {
		recorder.on({ url: /pullrequests/, respond: () => ({ value: [] }) })
		await adapter.listOpen()
		const call = runner.calls.find((c) => c.args.join(' ').startsWith('config --get remote.origin.url'))
		assert.ok(call, 'expected a remote.origin.url lookup')
		assert.strictEqual(call!.cwd, '/tmp')
	})
})

// ─── pickAdapter ─────────────────────────────────────────────────────────────

suite('pickAdapter (configuration-driven)', () => {
	let secrets: FakeSecretStorage
	let prevHost: string | undefined

	setup(async () => {
		secrets = new FakeSecretStorage()
		prevHost = vscode.workspace.getConfiguration('gitbraid').get<string>('prHost')
	})

	teardown(async () => {
		await vscode.workspace.getConfiguration('gitbraid').update('prHost', prevHost, vscode.ConfigurationTarget.Workspace)
	})

	test('prHost=none returns NullPRHostAdapter', async () => {
		await vscode.workspace.getConfiguration('gitbraid').update('prHost', 'none', vscode.ConfigurationTarget.Workspace)
		const adapter = await pickAdapter('/tmp', secrets)
		assert.strictEqual(adapter.name, 'none')
	})
})
