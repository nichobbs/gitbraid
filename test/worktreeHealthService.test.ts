import * as assert from 'node:assert'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as vscode from 'vscode'
import { ConfigService } from '../src/configService'
import { BranchStackService } from '../src/branchStackService'
import { WorktreeHealthService } from '../src/worktreeHealthService'
import { FakeGitRunner } from './helpers/fakeGitRunner'

function wsRoot(): vscode.Uri {
	return vscode.workspace.workspaceFolders![0].uri
}

function cleanup(): void {
	try { fs.rmSync(path.join(wsRoot().fsPath, '.worktrees'), { recursive: true, force: true }) } catch { /* */ }
}

async function tick(): Promise<void> {
	// Wait two microtask turns: one for the scheduled refresh, one for the
	// async `Promise.allSettled` it kicks off.
	await Promise.resolve()
	await Promise.resolve()
	await new Promise((r) => setTimeout(r, 10))
}

suite('WorktreeHealthService', function () {
	this.timeout(10_000)

	let config: ConfigService
	let branchStack: BranchStackService
	let runner: FakeGitRunner

	setup(async () => {
		cleanup()
		ConfigService.resetInstance()
		BranchStackService.resetInstance()
		config = new ConfigService()
		await config.load(wsRoot())
		branchStack = BranchStackService.getInstance(config)
		runner = new FakeGitRunner()
	})

	teardown(() => {
		cleanup()
		BranchStackService.resetInstance()
		ConfigService.resetInstance()
	})

	test('refresh: populates ahead/behind/dirty/rebasing for each branch', async () => {
		await config.addBranch({ name: 'feat/a', base: 'main', color: '#fff' })
		await config.addBranch({ name: 'feat/b', base: 'feat/a', color: '#fff' })
		runner.fixture('rev-list --count main..feat/a', { stdout: '3\n' })
		runner.fixture('rev-list --count feat/a..main', { stdout: '0\n' })
		runner.fixture('rev-list --count feat/a..feat/b', { stdout: '1\n' })
		runner.fixture('rev-list --count feat/b..feat/a', { stdout: '0\n' })
		runner.fixture('status --porcelain -z', { stdout: '' })
		const svc = new WorktreeHealthService(config, branchStack, wsRoot(), runner)
		await svc.refresh()
		const a = svc.getHealth('feat/a')
		assert.ok(a)
		assert.strictEqual(a!.aheadCount, 3)
		assert.strictEqual(a!.behindCount, 0)
		assert.strictEqual(a!.dirty, false)
		assert.strictEqual(a!.rebasing, false)
		const b = svc.getHealth('feat/b')
		assert.strictEqual(b?.aheadCount, 1)
		svc.dispose()
	})

	test('refresh: dirty=true when status output is non-empty', async () => {
		await config.addBranch({ name: 'feat/a', base: 'main', color: '#fff' })
		runner.fixture('rev-list --count', { stdout: '0\n' })
		runner.fixture('status --porcelain -z', { stdout: ' M file.ts\0' })
		const svc = new WorktreeHealthService(config, branchStack, wsRoot(), runner)
		await svc.refresh()
		assert.strictEqual(svc.getHealth('feat/a')?.dirty, true)
		svc.dispose()
	})

	test('refresh: failed rev-list defaults to 0', async () => {
		await config.addBranch({ name: 'feat/a', base: 'main', color: '#fff' })
		// rev-list returns exitCode 128 with no fixture; counts default to 0.
		runner.fixture('status --porcelain -z', { stdout: '' })
		const svc = new WorktreeHealthService(config, branchStack, wsRoot(), runner)
		await svc.refresh()
		const a = svc.getHealth('feat/a')
		assert.strictEqual(a?.aheadCount, 0)
		assert.strictEqual(a?.behindCount, 0)
		svc.dispose()
	})

	test('getHealth: undefined for unknown branch', async () => {
		const svc = new WorktreeHealthService(config, branchStack, wsRoot(), runner)
		assert.strictEqual(svc.getHealth('feat/nope'), undefined)
		svc.dispose()
	})

	test('onDidChange fires after refresh completes', async () => {
		await config.addBranch({ name: 'feat/a', base: 'main', color: '#fff' })
		runner.fixture('rev-list --count', { stdout: '0\n' })
		runner.fixture('status --porcelain -z', { stdout: '' })
		const svc = new WorktreeHealthService(config, branchStack, wsRoot(), runner)
		let fires = 0
		const sub = svc.onDidChange(() => { fires++ })
		await svc.refresh()
		assert.ok(fires >= 1)
		sub.dispose()
		svc.dispose()
	})

	test('config stack change schedules a refresh automatically', async () => {
		runner.fixture('rev-list --count', { stdout: '0\n' })
		runner.fixture('status --porcelain -z', { stdout: '' })
		const svc = new WorktreeHealthService(config, branchStack, wsRoot(), runner)
		await tick()  // wait for the scheduled refresh from constructor
		await config.addBranch({ name: 'feat/a', base: 'main', color: '#fff' })
		await tick()
		await tick()
		const a = svc.getHealth('feat/a')
		// We expect _some_ data eventually — refresh ran asynchronously.
		assert.ok(a, 'health should be populated after stack change')
		svc.dispose()
	})
})
