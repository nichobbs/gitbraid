import * as assert from 'node:assert'
import * as vscode from 'vscode'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { ConfigService } from '../src/configService'
import { WorkspaceSync } from '../src/workspaceSync'
import { buildSnapshot } from '../src/dashboardSnapshot'
import { FakeGitRunner } from './helpers/fakeGitRunner'

function wsRoot(): vscode.Uri {
	return vscode.workspace.workspaceFolders![0].uri
}

function cleanup(): void {
	try { fs.rmSync(path.join(wsRoot().fsPath, '.worktrees'), { recursive: true, force: true }) } catch { /* ignore */ }
}

suite('dashboardSnapshot', () => {

	let config: ConfigService
	let sync: WorkspaceSync

	setup(async () => {
		cleanup()
		config = new ConfigService()
		await config.load(wsRoot())
		sync = new WorkspaceSync(config)
	})

	teardown(() => { cleanup() })

	test('buildSnapshot: empty stack → empty branches, no adapter', async () => {
		const snap = await buildSnapshot({
			config,
			sync,
			workspaceRootFsPath: wsRoot().fsPath,
			worktreeDirOf: () => undefined,
			runner: new FakeGitRunner(),
		})
		assert.deepStrictEqual(snap.branches, [])
		assert.strictEqual(snap.banners.floatingCount, 0)
	})

	test('buildSnapshot: populates assignedFilesCount per branch', async () => {
		await config.addBranch({ name: 'feat/a', base: 'main', color: '#abc' })
		await config.addBranch({ name: 'feat/b', base: 'main', color: '#abc' })
		await config.setAssignment('src/a1.ts', 'feat/a')
		await config.setAssignment('src/a2.ts', 'feat/a')
		await config.setAssignment('src/b1.ts', 'feat/b')

		const runner = new FakeGitRunner()
		const snap = await buildSnapshot({
			config,
			sync,
			workspaceRootFsPath: wsRoot().fsPath,
			worktreeDirOf: () => undefined,
			runner,
		})
		const byName = new Map(snap.branches.map((b) => [b.name, b]))
		assert.strictEqual(byName.get('feat/a')?.assignedFilesCount, 2)
		assert.strictEqual(byName.get('feat/b')?.assignedFilesCount, 1)
	})

	test('buildSnapshot: singleCommit flag flows through', async () => {
		await config.addBranch({ name: 'feat/a', base: 'main', color: '#abc', singleCommit: true })
		await config.addBranch({ name: 'feat/b', base: 'main', color: '#abc' })
		const snap = await buildSnapshot({
			config,
			sync,
			workspaceRootFsPath: wsRoot().fsPath,
			worktreeDirOf: () => undefined,
			runner: new FakeGitRunner(),
		})
		const byName = new Map(snap.branches.map((b) => [b.name, b]))
		assert.strictEqual(byName.get('feat/a')?.singleCommit, true)
		assert.strictEqual(byName.get('feat/b')?.singleCommit, false)
	})

	test('buildSnapshot: currentBranch marks exactly that row', async () => {
		await config.addBranch({ name: 'feat/a', base: 'main', color: '#abc' })
		await config.addBranch({ name: 'feat/b', base: 'main', color: '#abc' })
		const snap = await buildSnapshot({
			config,
			sync,
			workspaceRootFsPath: wsRoot().fsPath,
			worktreeDirOf: () => undefined,
			runner: new FakeGitRunner(),
			currentBranch: 'feat/b',
		})
		const byName = new Map(snap.branches.map((b) => [b.name, b]))
		assert.strictEqual(byName.get('feat/a')?.isCurrent, false)
		assert.strictEqual(byName.get('feat/b')?.isCurrent, true)
	})

	test('buildSnapshot: ahead/behind derived via rev-list when a worktree exists', async () => {
		await config.addBranch({ name: 'feat/a', base: 'main', color: '#abc' })
		const runner = new FakeGitRunner()
		runner.fixture('rev-list --count main..feat/a', { stdout: '3\n' })
		runner.fixture('rev-list --count feat/a..main', { stdout: '1\n' })

		const snap = await buildSnapshot({
			config,
			sync,
			workspaceRootFsPath: wsRoot().fsPath,
			worktreeDirOf: () => '/wt/feat-a',
			runner,
		})
		const b = snap.branches[0]
		assert.strictEqual(b.aheadCount, 3)
		assert.strictEqual(b.behindCount, 1)
	})

	test('buildSnapshot: ahead/behind undefined when worktree is missing', async () => {
		await config.addBranch({ name: 'feat/a', base: 'main', color: '#abc' })
		const snap = await buildSnapshot({
			config,
			sync,
			workspaceRootFsPath: wsRoot().fsPath,
			worktreeDirOf: () => undefined,
			runner: new FakeGitRunner(),
		})
		assert.strictEqual(snap.branches[0].aheadCount, undefined)
		assert.strictEqual(snap.branches[0].behindCount, undefined)
	})

	test('buildSnapshot: scratch branches are filtered out', async () => {
		await config.addBranch({ name: 'feat/a', base: 'main', color: '#abc' })
		await config.addBranch({ name: 'scratch/x', base: 'main', color: '#abc', scratch: true })
		const snap = await buildSnapshot({
			config,
			sync,
			workspaceRootFsPath: wsRoot().fsPath,
			worktreeDirOf: () => undefined,
			runner: new FakeGitRunner(),
		})
		assert.deepStrictEqual(snap.branches.map((b) => b.name), ['feat/a'])
	})

	test('buildSnapshot: workspaceName is the final path segment', async () => {
		const snap = await buildSnapshot({
			config,
			sync,
			workspaceRootFsPath: '/abs/path/to/my-project',
			worktreeDirOf: () => undefined,
			runner: new FakeGitRunner(),
		})
		assert.strictEqual(snap.workspaceName, 'my-project')
	})

	test('buildSnapshot: adapter flows through when provided', async () => {
		const snap = await buildSnapshot({
			config,
			sync,
			workspaceRootFsPath: wsRoot().fsPath,
			worktreeDirOf: () => undefined,
			runner: new FakeGitRunner(),
			adapter: { name: 'GitHubOctokitAdapter', label: 'GitHub (Octokit)' },
		})
		assert.deepStrictEqual(snap.adapter, { name: 'GitHubOctokitAdapter', label: 'GitHub (Octokit)' })
	})
})
