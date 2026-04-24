import * as assert from 'node:assert'
import * as vscode from 'vscode'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { ConfigService } from '../src/configService'
import { BranchStackService } from '../src/branchStackService'
import { SubmitStackService } from '../src/submitStackService'
import {
	PRHostAdapter,
	PRMetadata,
	CreatePRInput,
} from '../src/prHostAdapter'
import { FakeGitRunner } from './helpers/fakeGitRunner'

function wsRoot(): vscode.Uri {
	return vscode.workspace.workspaceFolders![0].uri
}

function cleanup(): void {
	try { fs.rmSync(path.join(wsRoot().fsPath, '.worktrees'), { recursive: true, force: true }) } catch { /* ignore */ }
}

/**
 * In-memory PR host for unit testing submit logic without touching GitHub.
 * Records every call so assertions can inspect the invocation sequence.
 */
class FakeAdapter implements PRHostAdapter {
	readonly name = 'fake'
	readonly createCalls: CreatePRInput[] = []
	readonly updateCalls: Array<{ number: number, patch: Partial<CreatePRInput> }> = []
	readonly prs = new Map<string, PRMetadata>()
	private _nextNumber = 100

	async detect(): Promise<boolean> { return true }

	async listOpen(): Promise<PRMetadata[]> { return [...this.prs.values()] }

	async getPR(branch: string): Promise<PRMetadata | undefined> { return this.prs.get(branch) }

	async createPR(input: CreatePRInput): Promise<PRMetadata> {
		this.createCalls.push({ ...input })
		const number = this._nextNumber++
		const pr: PRMetadata = {
			number,
			url: `https://example/pulls/${String(number)}`,
			state: input.draft ? 'draft' : 'open',
			base: input.base,
			head: input.head,
			title: input.title,
			body: input.body,
		}
		this.prs.set(input.head, pr)
		return pr
	}

	async updatePR(number: number, patch: Partial<CreatePRInput>): Promise<PRMetadata> {
		this.updateCalls.push({ number, patch: { ...patch } })
		for (const [, pr] of this.prs) {
			if (pr.number === number) {
				if (patch.base !== undefined) pr.base = patch.base
				if (patch.title !== undefined) pr.title = patch.title
				if (patch.body !== undefined) pr.body = patch.body
				return pr
			}
		}
		throw new Error('PR not found: ' + String(number))
	}
}

/**
 * Stand-in for BranchStackService.worktreeExists — SubmitStackService only
 * consults that method, so an object with the right shape works for tests.
 */
class FakeBranchStack {
	constructor(private readonly _existing: Set<string>) {}
	worktreeExists(branch: string): boolean { return this._existing.has(branch) }
}

suite('SubmitStackService', () => {
	let config: ConfigService
	let runner: FakeGitRunner
	let adapter: FakeAdapter

	setup(async () => {
		cleanup()
		ConfigService.resetInstance()
		BranchStackService.resetInstance()
		config = new ConfigService()
		await config.load(wsRoot())
		runner = new FakeGitRunner()
		adapter = new FakeAdapter()
	})

	teardown(() => {
		cleanup()
	})

	test('creates one PR per branch with correctly nested bases', async () => {
		await config.addBranch({ name: 'feature/a', base: 'main', color: '#abc' })
		await config.addBranch({ name: 'feature/b', base: 'feature/a', color: '#abc' })
		await config.addBranch({ name: 'feature/c', base: 'feature/b', color: '#abc' })

		// Pretend all three worktrees exist on disk so submit tries to push each.
		const bs = new FakeBranchStack(new Set(['feature/a', 'feature/b', 'feature/c'])) as unknown as BranchStackService

		// Every push succeeds.
		for (const b of ['feature/a', 'feature/b', 'feature/c']) {
			runner.fixture(`push -u origin ${b}`, { stdout: '' })
		}

		const svc = new SubmitStackService(config, bs, wsRoot(), adapter, runner)
		const results = await svc.submit({ skipBodyRewrite: true })

		assert.strictEqual(results.length, 3)
		assert.deepStrictEqual(
			adapter.createCalls.map((c) => `${c.head}->${c.base}`),
			['feature/a->main', 'feature/b->feature/a', 'feature/c->feature/b'],
		)
		for (const r of results) {
			assert.strictEqual(r.ok, true)
			assert.strictEqual(r.action, 'pushed+created')
			assert.ok(r.prNumber)
		}
		// prNumber cached on config.
		assert.ok(config.getBranch('feature/a')?.prNumber)
	})

	test('repoints an existing PR when its parent changed', async () => {
		await config.addBranch({ name: 'feature/a', base: 'main', color: '#abc' })
		// Seed the adapter with an existing PR whose base doesn't match the config.
		adapter.prs.set('feature/a', {
			number: 7,
			url: 'u',
			state: 'open',
			base: 'develop',
			head: 'feature/a',
			title: 't',
			body: '',
		})
		const bs = new FakeBranchStack(new Set(['feature/a'])) as unknown as BranchStackService
		runner.fixture('push -u origin feature/a', { stdout: '' })

		const svc = new SubmitStackService(config, bs, wsRoot(), adapter, runner)
		const results = await svc.submit({ skipBodyRewrite: true })

		assert.strictEqual(results[0].action, 'pushed+updated')
		assert.deepStrictEqual(adapter.updateCalls[0], { number: 7, patch: { base: 'main' } })
		assert.strictEqual(adapter.createCalls.length, 0)
	})

	test('records failure when push fails and never calls the adapter', async () => {
		await config.addBranch({ name: 'feature/a', base: 'main', color: '#abc' })
		const bs = new FakeBranchStack(new Set(['feature/a'])) as unknown as BranchStackService
		runner.fixture('push -u origin feature/a', { exitCode: 1, stderr: 'rejected\n' })

		const svc = new SubmitStackService(config, bs, wsRoot(), adapter, runner)
		const results = await svc.submit({ skipBodyRewrite: true })

		assert.strictEqual(results.length, 1)
		assert.strictEqual(results[0].ok, false)
		assert.strictEqual(results[0].action, 'failed')
		assert.ok(results[0].message?.includes('rejected'))
		assert.strictEqual(adapter.createCalls.length, 0)
	})

	test('skips branches without a worktree', async () => {
		await config.addBranch({ name: 'feature/a', base: 'main', color: '#abc' })
		const bs = new FakeBranchStack(new Set([])) as unknown as BranchStackService
		const svc = new SubmitStackService(config, bs, wsRoot(), adapter, runner)
		const results = await svc.submit({ skipBodyRewrite: true })
		assert.strictEqual(results[0].action, 'skipped')
		assert.strictEqual(adapter.createCalls.length, 0)
	})

	test('rewrites PR bodies with the stacked-PR block when submit succeeds', async () => {
		await config.addBranch({ name: 'feature/a', base: 'main', color: '#abc' })
		await config.addBranch({ name: 'feature/b', base: 'feature/a', color: '#abc' })
		const bs = new FakeBranchStack(new Set(['feature/a', 'feature/b'])) as unknown as BranchStackService
		runner.fixture('push -u origin feature/a', { stdout: '' })
		runner.fixture('push -u origin feature/b', { stdout: '' })

		const svc = new SubmitStackService(config, bs, wsRoot(), adapter, runner)
		await svc.submit({})

		// Each PR body now carries a stack block.
		const aBody = adapter.prs.get('feature/a')!.body
		const bBody = adapter.prs.get('feature/b')!.body
		assert.ok(aBody.includes('<!-- gitbraid:stack-start -->'))
		assert.ok(bBody.includes('<!-- gitbraid:stack-start -->'))
		assert.ok(aBody.includes('feature/a'))
		assert.ok(aBody.includes('feature/b'))
		// Only A's block marks A as current, B's block marks B.
		assert.ok(aBody.includes('feature/a  ← you are here'))
		assert.ok(bBody.includes('feature/b  ← you are here'))
	})
})

