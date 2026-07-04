import * as assert from 'node:assert'
import * as vscode from 'vscode'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { ConfigService } from '../src/configService'
import { PrReviewCommentsProvider } from '../src/prReviewCommentsProvider'
import type { PRAwareness, BranchPRInfo } from '../src/prAwareness'
import { FakeGitRunner } from './helpers/fakeGitRunner'

function wsRoot(): vscode.Uri {
	return vscode.workspace.workspaceFolders![0].uri
}

function cleanup(): void {
	try { fs.rmSync(path.join(wsRoot().fsPath, '.worktrees'), { recursive: true, force: true }) } catch { /* ignore */ }
}

class FakeSecretStorage implements vscode.SecretStorage {
	private readonly _store = new Map<string, string>()
	readonly onDidChange = (() => ({ dispose: () => { /* */ } })) as unknown as vscode.Event<vscode.SecretStorageChangeEvent>
	async get(key: string): Promise<string | undefined> { return this._store.get(key) }
	async store(key: string, value: string): Promise<void> { this._store.set(key, value) }
	async delete(key: string): Promise<void> { this._store.delete(key) }
}

/** Minimal duck-typed PRAwareness fake — only `getForBranch` is used by the provider. */
function fakePrAwareness(byBranch: Record<string, BranchPRInfo>): PRAwareness {
	return {
		getForBranch: (branch: string) => byBranch[branch],
	} as unknown as PRAwareness
}

class FetchStub {
	calls: string[] = []
	private _origFetch: typeof fetch | undefined
	constructor(private readonly _respond: (url: string) => unknown) {}
	install(): void {
		this._origFetch = globalThis.fetch
		globalThis.fetch = (async (url: RequestInfo | URL) => {
			const u = typeof url === 'string' ? url : url.toString()
			this.calls.push(u)
			const body = this._respond(u)
			const text = JSON.stringify(body)
			return {
				ok: true,
				status: 200,
				statusText: 'OK',
				text: () => Promise.resolve(text),
				json: () => Promise.resolve(body),
				headers: { get: () => null },
			} as unknown as Response
		}) as typeof fetch
	}
	uninstall(): void {
		if (this._origFetch) globalThis.fetch = this._origFetch
	}
}

function threadsFor(provider: PrReviewCommentsProvider, fsPath: string): vscode.CommentThread[] {
	return (provider as unknown as { _threadsByFile: Map<string, vscode.CommentThread[]> })
		._threadsByFile.get(fsPath) ?? []
}

suite('PrReviewCommentsProvider', () => {
	let config: ConfigService
	let secrets: FakeSecretStorage
	let runner: FakeGitRunner
	let provider: PrReviewCommentsProvider

	setup(async () => {
		cleanup()
		config = new ConfigService()
		await config.load(wsRoot())
		secrets = new FakeSecretStorage()
		runner = new FakeGitRunner()
		runner.fixture('config --get remote.origin.url', { stdout: 'https://github.com/foo/bar.git\n' })
	})

	teardown(async () => {
		provider.dispose()
		cleanup()
		await vscode.workspace.getConfiguration('gitbraid').update(
			'showPrReviewComments', undefined, vscode.ConfigurationTarget.Workspace,
		)
	})

	test('no threads for a file with no branch assignment', async () => {
		provider = new PrReviewCommentsProvider(config, fakePrAwareness({}), secrets, wsRoot(), runner)
		const uri = vscode.Uri.joinPath(wsRoot(), 'src/unassigned.ts')
		await provider.refreshForFile(uri)
		assert.deepStrictEqual(threadsFor(provider, uri.fsPath), [])
	})

	test('no threads when the branch has no known PR', async () => {
		await config.addBranch({ name: 'feature/a', base: 'main', color: '#abc' })
		await config.setAssignment('src/foo.ts', 'feature/a')
		provider = new PrReviewCommentsProvider(config, fakePrAwareness({}), secrets, wsRoot(), runner)
		const uri = vscode.Uri.joinPath(wsRoot(), 'src/foo.ts')
		await provider.refreshForFile(uri)
		assert.deepStrictEqual(threadsFor(provider, uri.fsPath), [])
	})

	test('creates one comment thread per commented line, grouped by line', async () => {
		await config.addBranch({ name: 'feature/a', base: 'main', color: '#abc' })
		await config.setAssignment('src/foo.ts', 'feature/a')
		await secrets.store('gitbraid.githubToken', 'gh-token')
		const prAwareness = fakePrAwareness({
			'feature/a': { branch: 'feature/a', state: 'open', number: 7, title: 't' },
		})
		const fetchStub = new FetchStub(() => ([
			{ path: 'src/foo.ts', line: 10, body: 'nit: rename this', user: { login: 'alice' } },
			{ path: 'src/foo.ts', line: 10, body: 'also, add a test', user: { login: 'bob' } },
			{ path: 'src/foo.ts', line: 20, body: 'looks good', user: { login: 'alice' } },
			{ path: 'src/other.ts', line: 5, body: 'unrelated file', user: { login: 'carol' } },
		]))
		fetchStub.install()
		try {
			provider = new PrReviewCommentsProvider(config, prAwareness, secrets, wsRoot(), runner)
			const uri = vscode.Uri.joinPath(wsRoot(), 'src/foo.ts')
			await provider.refreshForFile(uri)
			const threads = threadsFor(provider, uri.fsPath)
			assert.strictEqual(threads.length, 2, 'one thread for line 10 (2 comments), one for line 20')
			const line10 = threads.find((t) => t.range.start.line === 9)!
			assert.strictEqual(line10.comments.length, 2)
			assert.strictEqual(line10.label, '2 PR review comments')
			const line20 = threads.find((t) => t.range.start.line === 19)!
			assert.strictEqual(line20.comments.length, 1)
			assert.strictEqual(line20.label, 'PR review comment')
		} finally {
			fetchStub.uninstall()
		}
	})

	test('respects gitbraid.showPrReviewComments = false', async () => {
		await config.addBranch({ name: 'feature/a', base: 'main', color: '#abc' })
		await config.setAssignment('src/foo.ts', 'feature/a')
		await secrets.store('gitbraid.githubToken', 'gh-token')
		await vscode.workspace.getConfiguration('gitbraid').update(
			'showPrReviewComments', false, vscode.ConfigurationTarget.Workspace,
		)
		const prAwareness = fakePrAwareness({
			'feature/a': { branch: 'feature/a', state: 'open', number: 7, title: 't' },
		})
		const fetchStub = new FetchStub(() => ([{ path: 'src/foo.ts', line: 10, body: 'x', user: { login: 'alice' } }]))
		fetchStub.install()
		try {
			provider = new PrReviewCommentsProvider(config, prAwareness, secrets, wsRoot(), runner)
			const uri = vscode.Uri.joinPath(wsRoot(), 'src/foo.ts')
			await provider.refreshForFile(uri)
			assert.deepStrictEqual(threadsFor(provider, uri.fsPath), [])
			assert.strictEqual(fetchStub.calls.length, 0, 'should not even fetch when disabled')
		} finally {
			fetchStub.uninstall()
		}
	})

	test('hints once when the remote is a known non-GitHub host', async () => {
		runner.reset()
		runner.fixture('config --get remote.origin.url', { stdout: 'https://gitlab.com/group/proj.git\n' })
		await config.addBranch({ name: 'feature/a', base: 'main', color: '#abc' })
		await config.setAssignment('src/foo.ts', 'feature/a')
		await config.setAssignment('src/bar.ts', 'feature/a')
		await secrets.store('gitbraid.githubToken', 'gh-token')
		const prAwareness = fakePrAwareness({
			'feature/a': { branch: 'feature/a', state: 'open', number: 7, title: 't' },
		})
		const win = vscode.window as unknown as { showInformationMessage: (...args: unknown[]) => Promise<unknown> }
		const origInfo = win.showInformationMessage
		let hintCount = 0
		win.showInformationMessage = async (msg: string) => { if (msg.includes('only support GitHub')) hintCount++; return undefined }
		try {
			provider = new PrReviewCommentsProvider(config, prAwareness, secrets, wsRoot(), runner)
			await provider.refreshForFile(vscode.Uri.joinPath(wsRoot(), 'src/foo.ts'))
			await provider.refreshForFile(vscode.Uri.joinPath(wsRoot(), 'src/bar.ts'))
			assert.strictEqual(hintCount, 1, 'should hint exactly once per session, not once per file')
		} finally {
			win.showInformationMessage = origInfo
		}
	})

	test('does not hint when there is simply no token stored', async () => {
		runner.reset()
		runner.fixture('config --get remote.origin.url', { stdout: 'https://gitlab.com/group/proj.git\n' })
		await config.addBranch({ name: 'feature/a', base: 'main', color: '#abc' })
		await config.setAssignment('src/foo.ts', 'feature/a')
		const prAwareness = fakePrAwareness({
			'feature/a': { branch: 'feature/a', state: 'open', number: 7, title: 't' },
		})
		const win = vscode.window as unknown as { showInformationMessage: (...args: unknown[]) => Promise<unknown> }
		const origInfo = win.showInformationMessage
		let hintCount = 0
		win.showInformationMessage = async () => { hintCount++; return undefined }
		try {
			provider = new PrReviewCommentsProvider(config, prAwareness, secrets, wsRoot(), runner)
			await provider.refreshForFile(vscode.Uri.joinPath(wsRoot(), 'src/foo.ts'))
			assert.strictEqual(hintCount, 0, 'no token means we bail before ever checking the remote host')
		} finally {
			win.showInformationMessage = origInfo
		}
	})

	test('caches comments per PR across files sharing the same branch', async () => {
		await config.addBranch({ name: 'feature/a', base: 'main', color: '#abc' })
		await config.setAssignment('src/foo.ts', 'feature/a')
		await config.setAssignment('src/bar.ts', 'feature/a')
		await secrets.store('gitbraid.githubToken', 'gh-token')
		const prAwareness = fakePrAwareness({
			'feature/a': { branch: 'feature/a', state: 'open', number: 7, title: 't' },
		})
		const fetchStub = new FetchStub(() => ([{ path: 'src/foo.ts', line: 1, body: 'x', user: { login: 'a' } }]))
		fetchStub.install()
		try {
			provider = new PrReviewCommentsProvider(config, prAwareness, secrets, wsRoot(), runner)
			await provider.refreshForFile(vscode.Uri.joinPath(wsRoot(), 'src/foo.ts'))
			await provider.refreshForFile(vscode.Uri.joinPath(wsRoot(), 'src/bar.ts'))
			assert.strictEqual(fetchStub.calls.length, 1, 'second file on the same PR should reuse the cached fetch')
		} finally {
			fetchStub.uninstall()
		}
	})
})
