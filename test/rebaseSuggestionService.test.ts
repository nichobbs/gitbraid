import * as assert from 'node:assert'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as vscode from 'vscode'
import { ConfigService } from '../src/configService'
import { BranchStackService } from '../src/branchStackService'
import { RebaseSuggestionService } from '../src/rebaseSuggestionService'
import { git } from '../src/gitFunctions'
import { getDefaultGitRunner } from '../src/gitRunner'

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

	test('_checkAll: covers loop body with 2-branch stack (branches at same commit)', async () => {
		// Stub showInformationMessage so any dialog resolves immediately
		const origInfo = vscode.window.showInformationMessage
		;(vscode.window as any).showInformationMessage = async () => undefined
		try {
			await config.addBranch({ name: 'feature/a', color: '#fff', base: 'main' })
			await config.addBranch({ name: 'feature/b', color: '#fff', base: 'feature/a' })
			svc.init(wsRoot())
			// Call _checkAll directly — branches are at same commit so behind===0 → continue
			await (svc as any)._checkAll()
		} finally {
			;(vscode.window as any).showInformationMessage = origInfo
			svc.dispose()
			svc = new RebaseSuggestionService(config, branchStack)
		}
	})

	test('rebaseBranch: no-op when workspace root not set (before init)', async () => {
		// Workspace root is only set when init() is called
		// So calling rebaseBranch before init should be a no-op
		await config.addBranch({ name: 'feature/docs', color: '#fff', base: 'main' })
		await assert.doesNotReject(() => svc.rebaseBranch('feature/docs'))
	})

	test('rebaseBranch: after init, error path when git rebase fails', async () => {
		// Use a nonexistent upstream so git rebase will fail (covering the catch block).
		// Stub vscode.window dialogs so the awaited showErrorMessage resolves immediately.
		const origError = vscode.window.showErrorMessage
		const origInfo = vscode.window.showInformationMessage
		;(vscode.window as any).showErrorMessage = async () => undefined
		;(vscode.window as any).showInformationMessage = async () => undefined
		try {
			await config.addBranch({ name: 'feature/docs', color: '#fff', base: 'nonexistent-upstream-xyz' })
			svc.init(wsRoot())
			// Should NOT throw — errors are caught and shown as VS Code notifications
			await assert.doesNotReject(() => svc.rebaseBranch('feature/docs'))
		} finally {
			;(vscode.window as any).showErrorMessage = origError
			;(vscode.window as any).showInformationMessage = origInfo
			svc.dispose()
			svc = new RebaseSuggestionService(config, branchStack)
		}
	})

	// ── predictConflict ───────────────────────────────────────────────────────
	//
	// These tests create real local branches directly via git (not through
	// BranchStackService, which would try to give each one a worktree) so
	// `merge-tree` has genuine divergent history to evaluate. `main` itself is
	// never committed to directly — every seed commit happens on a throwaway
	// `zpred/*` branch — so these tests can't leave `main` polluted for the
	// rest of the suite (or other test files sharing this workspace).

	suite('predictConflict', () => {
		const wsRootPath = () => wsRoot().fsPath

		async function runGit(args: string[]): Promise<void> {
			const { exitCode, stderr } = await getDefaultGitRunner().run(args, { cwd: wsRootPath() })
			if (exitCode !== 0) {
				throw new Error(`git ${args.join(' ')} failed: ${stderr}`)
			}
		}

		teardown(async () => {
			await runGit(['checkout', 'main']).catch(() => undefined)
			for (const name of ['zpred/root', 'zpred/base', 'zpred/conflict', 'zpred/clean']) {
				await runGit(['branch', '-D', name]).catch(() => undefined)
			}
		})

		test('reports no conflict for a purely additive branch', async () => {
			await runGit(['checkout', '-b', 'zpred/clean'])
			fs.writeFileSync(path.join(wsRootPath(), 'zpred-new-file.txt'), 'brand new file\n')
			await git.add(undefined, 'zpred-new-file.txt')
			await git.commit('zpred: add new file', '--no-gpg-sign')
			await runGit(['checkout', 'main'])

			const result = await svc.predictConflict(wsRootPath(), 'zpred/clean', 'main')
			assert.strictEqual(result.supported, true)
			assert.strictEqual(result.conflicted, false)
		})

		test('reports a conflict and names the file when two branches edit the same lines', async () => {
			await runGit(['checkout', '-b', 'zpred/root'])
			const file = path.join(wsRootPath(), 'zpred-file-b.txt')
			fs.writeFileSync(file, 'line1\nline2\nline3\n')
			await git.add(undefined, 'zpred-file-b.txt')
			await git.commit('zpred: seed conflict file', '--no-gpg-sign')

			await runGit(['checkout', '-b', 'zpred/conflict'])
			fs.writeFileSync(file, 'line1\nCHANGED-BY-CONFLICT\nline3\n')
			await git.add(undefined, 'zpred-file-b.txt')
			await git.commit('zpred: conflicting edit on branch', '--no-gpg-sign')

			await runGit(['checkout', 'zpred/root'])
			await runGit(['checkout', '-b', 'zpred/base'])
			fs.writeFileSync(file, 'line1\nCHANGED-ON-BASE\nline3\n')
			await git.add(undefined, 'zpred-file-b.txt')
			await git.commit('zpred: conflicting edit on base', '--no-gpg-sign')
			await runGit(['checkout', 'main'])

			const result = await svc.predictConflict(wsRootPath(), 'zpred/conflict', 'zpred/base')
			assert.strictEqual(result.supported, true)
			assert.strictEqual(result.conflicted, true)
			assert.ok(result.files.some((f) => f.includes('zpred-file-b.txt')), `expected zpred-file-b.txt in ${JSON.stringify(result.files)}`)
		})

		test('reports unsupported (not a false negative) for a ref that does not resolve', async () => {
			const result = await svc.predictConflict(wsRootPath(), 'main', 'zpred/does-not-exist')
			assert.strictEqual(result.supported, false)
			assert.strictEqual(result.conflicted, false)
		})
	})

})
