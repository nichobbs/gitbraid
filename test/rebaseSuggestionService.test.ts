import * as assert from 'node:assert'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as vscode from 'vscode'
import { ConfigService } from '../src/configService'
import { BranchStackService } from '../src/branchStackService'
import { RebaseSuggestionService } from '../src/rebaseSuggestionService'
import { git } from '../src/gitFunctions'

function wsRoot(): vscode.Uri {
	return vscode.workspace.workspaceFolders![0].uri
}

function cleanup() {
	try { fs.rmSync(path.join(wsRoot().fsPath, '.worktrees'), { recursive: true }) } catch {}
	try { fs.rmSync(path.join(wsRoot().fsPath, '.gitignore')) } catch {}
}

suite('RebaseSuggestionService', function () {
	this.timeout(15_000)

	let config: ConfigService
	let branchStack: BranchStackService
	let svc: RebaseSuggestionService

	suiteSetup(async () => {
		await git.init()
		try { await git.add(undefined, '.gitkeep') } catch {}
		try { await git.commit('initial commit', '--no-gpg-sign') } catch {}
	})

	setup(async () => {
		cleanup()
		ConfigService.resetInstance()
		BranchStackService.resetInstance()
		config = ConfigService.getInstance()
		await config.load(wsRoot())
		branchStack = BranchStackService.getInstance(config)
		svc = new RebaseSuggestionService(config, branchStack)
	})

	teardown(async () => {
		svc.dispose()
		cleanup()
		BranchStackService.resetInstance()
		ConfigService.resetInstance()
	})

	// ── getCommitsBehind ──────────────────────────────────────────────────────

	test('getCommitsBehind: returns 0 when branches are equal (HEAD vs HEAD)', async () => {
		const wsRootPath = wsRoot().fsPath
		const result = await svc.getCommitsBehind(wsRootPath, 'HEAD', 'HEAD')
		// HEAD vs HEAD — 0 commits behind
		assert.strictEqual(result, 0)
	})

	test('getCommitsBehind: returns undefined for nonexistent branches', async () => {
		const wsRootPath = wsRoot().fsPath
		const result = await svc.getCommitsBehind(wsRootPath, 'nonexistent-branch-x', 'nonexistent-branch-y')
		assert.strictEqual(result, undefined)
	})

	test('getCommitsBehind: returns a number or undefined for valid refs', async () => {
		const wsRootPath = wsRoot().fsPath
		const result = await svc.getCommitsBehind(wsRootPath, 'main', 'main')
		assert.ok(result === undefined || typeof result === 'number')
	})

	// ── dispose ───────────────────────────────────────────────────────────────

	test('dispose: can be called multiple times without throwing', () => {
		svc.dispose()
		assert.doesNotThrow(() => svc.dispose())
	})

	// ── init ──────────────────────────────────────────────────────────────────

	test('init: can be called and disposed without error', () => {
		svc.init(wsRoot())
		assert.doesNotThrow(() => svc.dispose())
		// Re-create for teardown
		svc = new RebaseSuggestionService(config, branchStack)
	})

	// ── rebaseBranch ──────────────────────────────────────────────────────────

	test('rebaseBranch: no-op for branch not in config', async () => {
		// Should not throw even if branch is not in the config
		await assert.doesNotReject(() => svc.rebaseBranch('nonexistent-branch'))
	})

	test('rebaseBranch: no-op when workspace root not set (before init)', async () => {
		// Workspace root is only set when init() is called
		// So calling rebaseBranch before init should be a no-op
		await config.addBranch({ name: 'feature/docs', color: '#fff', base: 'main' })
		await assert.doesNotReject(() => svc.rebaseBranch('feature/docs'))
	})

})
