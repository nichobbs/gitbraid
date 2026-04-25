import * as assert from 'node:assert'
import * as vscode from 'vscode'
import {
	GitHubOctokitAdapter,
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
	status?: number
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
		const status = matched?.status ?? (matched ? 200 : 404)
		const responseBody = matched ? matched.respond({ url: u, method, body }) : { error: 'no setup' }
		const text = JSON.stringify(responseBody)
		const recorded: MockResponse = { url: u, method, headers, body, ok: status >= 200 && status < 300, status, text: async () => text, json: async () => responseBody }
		this.calls.push(recorded)
		return {
			ok: recorded.ok,
			status: recorded.status,
			statusText: recorded.ok ? 'OK' : 'NOT_FOUND',
			text: () => Promise.resolve(text),
			json: () => Promise.resolve(responseBody),
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
		adapter = new GitHubOctokitAdapter(secrets, runner)
	})

	teardown(() => recorder.uninstall())

	test('detect: succeeds when token present and origin is github', async () => {
		assert.strictEqual(await adapter.detect('/tmp'), true)
	})

	test('detect: false when no token', async () => {
		await secrets.delete('gitbraid.githubToken')
		assert.strictEqual(await adapter.detect('/tmp'), false)
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
		adapter = new GitLabAdapter(secrets, runner)
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
		adapter = new BitbucketAdapter(secrets, runner)
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
		adapter = new AzureDevOpsAdapter(secrets, runner)
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
