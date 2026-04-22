import * as assert from 'node:assert'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as vscode from 'vscode'
import { ConfigService } from '../src/configService'
import { BranchStackService } from '../src/branchStackService'
import { WorkspaceSync } from '../src/workspaceSync'
import { GitBraidApi } from '../src/gitBraidApi'
import { git } from '../src/gitFunctions'

function wsRoot(): vscode.Uri {
	return vscode.workspace.workspaceFolders![0].uri
}

function cleanup() {
	try { fs.rmSync(path.join(wsRoot().fsPath, '.worktrees'), { recursive: true }) } catch {}
	try { fs.rmSync(path.join(wsRoot().fsPath, '.gitignore')) } catch {}
}

suite('GitBraidApi', function () {
	this.timeout(15_000)

	let config: ConfigService
	let branchStack: BranchStackService
	let sync: WorkspaceSync
	let api: GitBraidApi

	suiteSetup(async () => {
		await git.init()
		try { await git.add(undefined, '.gitkeep') } catch {}
		try { await git.commit('initial commit', '--no-gpg-sign') } catch {}
	})

	setup(async () => {
		cleanup()
		ConfigService.resetInstance()
		BranchStackService.resetInstance()
		WorkspaceSync.resetInstance()
		config = ConfigService.getInstance()
		await config.load(wsRoot())
		branchStack = BranchStackService.getInstance(config)
		sync = WorkspaceSync.getInstance(config)
		api = new GitBraidApi(config, branchStack, sync, wsRoot())
	})

	teardown(() => {
		sync.dispose()
		cleanup()
		BranchStackService.resetInstance()
		ConfigService.resetInstance()
		WorkspaceSync.resetInstance()
	})

	// ── Stack management ─────────────────────────────────────────────────────

	test('getStack: returns empty array initially', () => {
		assert.deepStrictEqual(api.getStack(), [])
	})

	test('getStack: returns branches after addBranch to config', async () => {
		await config.addBranch({ name: 'feature/docs', color: '#fff', base: 'main' })
		const stack = api.getStack()
		assert.strictEqual(stack.length, 1)
		assert.strictEqual(stack[0].name, 'feature/docs')
	})

	test('addBranch: throws BranchStackError if not initialised', async () => {
		await assert.rejects(
			() => api.addBranch('feature/docs', 'main'),
		)
	})

	test('removeBranch: throws BranchStackError if not initialised', async () => {
		await assert.rejects(
			() => api.removeBranch('feature/docs'),
		)
	})

	// ── File assignment ──────────────────────────────────────────────────────

	test('getAssignment: returns undefined for unassigned path', () => {
		assert.strictEqual(api.getAssignment('src/foo.ts'), undefined)
	})

	test('assignFile: assigns file to branch and getAssignment returns it', async () => {
		await config.addBranch({ name: 'feature/docs', color: '#fff', base: 'main' })
		await api.assignFile('src/foo.ts', 'feature/docs')
		assert.strictEqual(api.getAssignment('src/foo.ts'), 'feature/docs')
	})

	test('assignHunk: delegates to config without throwing', async () => {
		await config.addBranch({ name: 'feature/docs', color: '#fff', base: 'main' })
		await assert.doesNotReject(() => api.assignHunk('src/foo.ts', 0, 'feature/docs'))
	})

	test('unassignFile: removes assignment', async () => {
		await config.addBranch({ name: 'feature/docs', color: '#fff', base: 'main' })
		await api.assignFile('src/foo.ts', 'feature/docs')
		await api.unassignFile('src/foo.ts')
		assert.strictEqual(api.getAssignment('src/foo.ts'), undefined)
	})

	// ── Floating files ───────────────────────────────────────────────────────

	test('getFloatingFiles: returns empty array initially', () => {
		const files = api.getFloatingFiles()
		assert.ok(Array.isArray(files))
		assert.strictEqual(files.length, 0)
	})

	// ── Status queries ───────────────────────────────────────────────────────

	test('getBranchStatus: returns zeros for nonexistent worktree', async () => {
		const status = await api.getBranchStatus('feature/docs')
		assert.strictEqual(status.branch, 'feature/docs')
		assert.strictEqual(status.staged, 0)
		assert.strictEqual(status.unstaged, 0)
		assert.strictEqual(status.untracked, 0)
		assert.strictEqual(status.floating, 0)
	})

	test('getStackStatus: returns empty branches for empty stack', async () => {
		const status = await api.getStackStatus()
		assert.deepStrictEqual(status.branches, [])
		assert.strictEqual(status.totalFloating, 0)
	})

	test('getStackStatus: returns status for each branch in stack', async () => {
		await config.addBranch({ name: 'feature/docs', color: '#fff', base: 'main' })
		const status = await api.getStackStatus()
		assert.strictEqual(status.branches.length, 1)
		assert.strictEqual(status.branches[0].branch, 'feature/docs')
	})

	// ── Actions ──────────────────────────────────────────────────────────────

	test('commitBranch: throws for nonexistent branch worktree', async () => {
		await assert.rejects(
			() => api.commitBranch('nonexistent-branch', 'test commit'),
		)
	})

	test('commitBranch: with stageAll option throws for nonexistent worktree', async () => {
		await assert.rejects(
			() => api.commitBranch('nonexistent-branch', 'test', { stageAll: true }),
		)
	})

	test('stageBranch: throws for nonexistent worktree (no files arg)', async () => {
		await assert.rejects(
			() => api.stageBranch('nonexistent-branch'),
		)
	})

	test('stageBranch: throws for nonexistent worktree (with files list)', async () => {
		await assert.rejects(
			() => api.stageBranch('nonexistent-branch', ['src/foo.ts']),
		)
	})

	// ── Events ───────────────────────────────────────────────────────────────

	test('onDidChangeAssignment: is an event function', () => {
		assert.ok(typeof api.onDidChangeAssignment === 'function')
	})

	test('onDidChangeStack: is an event function', () => {
		assert.ok(typeof api.onDidChangeStack === 'function')
	})

})
