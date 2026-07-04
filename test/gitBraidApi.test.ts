import * as assert from 'node:assert'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as vscode from 'vscode'
import { ConfigService } from '../src/configService'
import { BranchStackService } from '../src/branchStackService'
import { WorkspaceSync } from '../src/workspaceSync'
import { VirtualBranchStore } from '../src/virtualBranchStore'
import { GitBraidApi } from '../src/gitBraidApi'
import { git } from '../src/gitFunctions'
import { BranchStackError } from '../src/errors'
import { FakeGitRunner } from './helpers/fakeGitRunner'
import type { HunkRouter } from '../src/hunkRouter'
import type { RouteFileResult } from '../src/hunkRouter'

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

// ─── Suite: virtual branches via the API ─────────────────────────────────────

suite('GitBraidApi — virtual branches', function () {
	this.timeout(15_000)

	let config: ConfigService
	let store: VirtualBranchStore
	let branchStack: BranchStackService
	let sync: WorkspaceSync
	let api: GitBraidApi

	suiteSetup(async () => {
		await git.init()
		try { await git.add(undefined, '.gitkeep') } catch { /* ignore */ }
		try { await git.commit('initial commit', '--no-gpg-sign') } catch { /* ignore */ }
	})

	setup(async () => {
		cleanup()
		ConfigService.resetInstance()
		BranchStackService.resetInstance()
		WorkspaceSync.resetInstance()
		config = ConfigService.getInstance()
		await config.load(wsRoot())
		store = new VirtualBranchStore()
		await store.load(wsRoot(), config.getVirtualBranches())
		branchStack = new BranchStackService(config, store)
		await branchStack.initStack(wsRoot())
		sync = WorkspaceSync.getInstance(config)
		api = new GitBraidApi(config, branchStack, sync, wsRoot())
	})

	teardown(async () => {
		sync.dispose()
		store.dispose()
		cleanup()
		BranchStackService.resetInstance()
		ConfigService.resetInstance()
		WorkspaceSync.resetInstance()
	})

	test('addBranch({virtual:true}): records a virtual entry with no worktree', async () => {
		await api.addBranch('feature/v-api', 'main', { virtual: true })
		const entry = api.getStack().find((e) => e.name === 'feature/v-api')
		assert.strictEqual(entry?.virtual, true)
		assert.strictEqual(branchStack.worktreeExists('feature/v-api'), false)
	})

	test('getVirtualBranches: lists only virtual entries', async () => {
		await api.addBranch('feature/v-api', 'main', { virtual: true })
		await api.addBranch('feature/real-api', 'main')
		const virtuals = api.getVirtualBranches()
		assert.deepStrictEqual(virtuals, ['feature/v-api'])
	})

	test('materialiseBranch: promotes a virtual branch to a worktree', async () => {
		await api.addBranch('feature/v-promote', 'main', { virtual: true })
		await store.writeFile('feature/v-promote', 'src/promoted.ts', Buffer.from('ok\n'))

		await api.materialiseBranch('feature/v-promote')

		const wtDir = branchStack.getWorktreePath('feature/v-promote').fsPath
		assert.strictEqual(branchStack.worktreeExists('feature/v-promote'), true)
		assert.strictEqual(fs.readFileSync(path.join(wtDir, 'src/promoted.ts'), 'utf-8'), 'ok\n')
		assert.notStrictEqual(config.getBranch('feature/v-promote')?.virtual, true)
		assert.deepStrictEqual(api.getVirtualBranches(), [])
	})

	test('materialiseBranch: rejects a non-virtual branch with BranchStackError', async () => {
		await api.addBranch('feature/real-api', 'main')
		await assert.rejects(() => api.materialiseBranch('feature/real-api'), BranchStackError)
	})

	test('materialiseBranch: rejects an unknown branch with BranchStackError', async () => {
		await assert.rejects(() => api.materialiseBranch('no-such-branch'), BranchStackError)
	})

})

// ─── Suite: action methods against a fake runner (success + failure paths) ──
//
// The suites above use the real default git runner, which only exercises
// the "nonexistent worktree" failure path. `worktreePath()` just builds a
// path string — it never touches disk — so these methods work fine against
// a fake worktree dir once the runner itself is injected, letting us cover
// the success paths (and richer failure paths) without real worktrees.

suite('GitBraidApi — actions (fake runner)', function () {
	this.timeout(15_000)

	let config: ConfigService
	let branchStack: BranchStackService
	let sync: WorkspaceSync
	let runner: FakeGitRunner
	let api: GitBraidApi

	suiteSetup(async () => {
		await git.init()
		try { await git.add(undefined, '.gitkeep') } catch { /* ignore */ }
		try { await git.commit('initial commit', '--no-gpg-sign') } catch { /* ignore */ }
	})

	setup(async () => {
		cleanup()
		ConfigService.resetInstance()
		BranchStackService.resetInstance()
		WorkspaceSync.resetInstance()
		config = ConfigService.getInstance()
		await config.load(wsRoot())
		branchStack = BranchStackService.getInstance(config)
		await branchStack.initStack(wsRoot())
		sync = WorkspaceSync.getInstance(config)
		runner = new FakeGitRunner()
		api = new GitBraidApi(config, branchStack, sync, wsRoot(), runner)
	})

	teardown(() => {
		sync.dispose()
		cleanup()
		BranchStackService.resetInstance()
		ConfigService.resetInstance()
		WorkspaceSync.resetInstance()
	})

	// ── commitBranch ─────────────────────────────────────────────────────────

	test('commitBranch: success', async () => {
		runner.fixture('commit -m test commit', { exitCode: 0 })
		await assert.doesNotReject(() => api.commitBranch('feature/x', 'test commit'))
		const call = runner.calls.find((c) => c.args[0] === 'commit')
		assert.deepStrictEqual(call?.args, ['commit', '-m', 'test commit'])
	})

	test('commitBranch: noGpgSign adds the flag before -m', async () => {
		runner.fixture('commit --no-gpg-sign -m test', { exitCode: 0 })
		await api.commitBranch('feature/x', 'test', { noGpgSign: true })
		const call = runner.calls.find((c) => c.args[0] === 'commit')
		assert.deepStrictEqual(call?.args, ['commit', '--no-gpg-sign', '-m', 'test'])
	})

	test('commitBranch: stageAll stages first, then commits', async () => {
		runner.fixture('add -u', { exitCode: 0 })
		runner.fixture('commit -m test', { exitCode: 0 })
		await api.commitBranch('feature/x', 'test', { stageAll: true })
		assert.ok(runner.calls.some((c) => c.args.join(' ') === 'add -u'))
		assert.ok(runner.calls.some((c) => c.args.join(' ') === 'commit -m test'))
	})

	test('commitBranch: stageAll failure throws before attempting the commit', async () => {
		runner.fixture('add -u', { exitCode: 1, stderr: 'add failed' })
		await assert.rejects(
			() => api.commitBranch('feature/x', 'test', { stageAll: true }),
			/git add -u failed/,
		)
		assert.ok(!runner.calls.some((c) => c.args[0] === 'commit'), 'must not attempt commit after add -u fails')
	})

	test('commitBranch: non-zero exit throws GitError with stderr', async () => {
		runner.fixture('commit -m test', { exitCode: 1, stderr: 'nothing to commit' })
		await assert.rejects(() => api.commitBranch('feature/x', 'test'), /nothing to commit/)
	})

	// ── stageBranch ──────────────────────────────────────────────────────────

	test('stageBranch: no files → git add -u', async () => {
		runner.fixture('add -u', { exitCode: 0 })
		await api.stageBranch('feature/x')
		assert.ok(runner.calls.some((c) => c.args.join(' ') === 'add -u'))
	})

	test('stageBranch: with files → git add -- <files>', async () => {
		runner.fixture('add -- src/a.ts src/b.ts', { exitCode: 0 })
		await api.stageBranch('feature/x', ['src/a.ts', 'src/b.ts'])
		const call = runner.calls.find((c) => c.args[0] === 'add')
		assert.deepStrictEqual(call?.args, ['add', '--', 'src/a.ts', 'src/b.ts'])
	})

	test('stageBranch: refuses a path starting with "-" without calling the runner', async () => {
		await assert.rejects(
			() => api.stageBranch('feature/x', ['-evil-flag']),
			/Refusing to stage path/,
		)
		assert.strictEqual(runner.calls.length, 0)
	})

	test('stageBranch: failure (files list) throws GitError', async () => {
		runner.fixture('add -- src/a.ts', { exitCode: 1, stderr: 'boom' })
		await assert.rejects(() => api.stageBranch('feature/x', ['src/a.ts']), /boom/)
	})

	test('stageBranch: failure (no files) throws GitError', async () => {
		runner.fixture('add -u', { exitCode: 1, stderr: 'boom' })
		await assert.rejects(() => api.stageBranch('feature/x'), /boom/)
	})

	// ── pullBranch / syncBranch ──────────────────────────────────────────────

	test('pullBranch: success', async () => {
		runner.fixture('pull --rebase', { exitCode: 0 })
		await assert.doesNotReject(() => api.pullBranch('feature/x'))
	})

	test('pullBranch: failure throws GitError', async () => {
		runner.fixture('pull --rebase', { exitCode: 1, stderr: 'conflict' })
		await assert.rejects(() => api.pullBranch('feature/x'), /Pull "feature\/x" failed/)
	})

	test('syncBranch: pull + push both succeed', async () => {
		runner.fixture('pull --rebase', { exitCode: 0 })
		runner.fixture('push', { exitCode: 0 })
		await assert.doesNotReject(() => api.syncBranch('feature/x'))
	})

	test('syncBranch: push has no upstream → retries with --set-upstream and succeeds', async () => {
		// FakeGitRunner matches fixtures in registration order via prefix
		// (key === prefix || key.startsWith(prefix + ' ')) — the more specific
		// "push --set-upstream ..." fixture must be registered before the bare
		// "push" one, or the bare fixture (a prefix of the specific command
		// too) would shadow it and match both real calls.
		runner.fixture('pull --rebase', { exitCode: 0 })
		runner.fixture('push --set-upstream origin feature/x', { exitCode: 0 })
		runner.fixture('push', { exitCode: 1, stderr: 'fatal: the current branch feature/x has no upstream branch' })
		await assert.doesNotReject(() => api.syncBranch('feature/x'))
		assert.ok(runner.calls.some((c) => c.args.join(' ') === 'push --set-upstream origin feature/x'))
	})

	test('syncBranch: no-upstream retry also fails → throws', async () => {
		runner.fixture('pull --rebase', { exitCode: 0 })
		runner.fixture('push --set-upstream origin feature/x', { exitCode: 1, stderr: 'still no dice' })
		runner.fixture('push', { exitCode: 1, stderr: 'no upstream' })
		await assert.rejects(() => api.syncBranch('feature/x'), /still no dice/)
	})

	test('syncBranch: push fails for an unrelated reason → throws without retrying', async () => {
		runner.fixture('pull --rebase', { exitCode: 0 })
		runner.fixture('push', { exitCode: 1, stderr: 'rejected (non-fast-forward)' })
		await assert.rejects(() => api.syncBranch('feature/x'), /non-fast-forward/)
		assert.strictEqual(
			runner.calls.some((c) => c.args.includes('--set-upstream')), false,
			'must not retry with --set-upstream for a non-upstream-related failure',
		)
	})

	test('syncBranch: pull failure short-circuits before any push attempt', async () => {
		runner.fixture('pull --rebase', { exitCode: 1, stderr: 'pull conflict' })
		await assert.rejects(() => api.syncBranch('feature/x'), /pull conflict/)
		assert.strictEqual(runner.calls.some((c) => c.args[0] === 'push'), false)
	})

	// ── rebaseBranch ─────────────────────────────────────────────────────────

	test('rebaseBranch: branch not in stack → throws', async () => {
		await assert.rejects(() => api.rebaseBranch('no-such-branch'), /not in the stack/)
	})

	test('rebaseBranch: success', async () => {
		await api.addBranch('feature/x', 'main')
		runner.fixture('rebase --autostash main', { exitCode: 0 })
		await assert.doesNotReject(() => api.rebaseBranch('feature/x'))
		assert.ok(runner.calls.some((c) => c.args.join(' ') === 'rebase --autostash main'))
	})

	test('rebaseBranch: failure throws GitError', async () => {
		await api.addBranch('feature/x', 'main')
		runner.fixture('rebase --autostash main', { exitCode: 1, stderr: 'conflict' })
		await assert.rejects(() => api.rebaseBranch('feature/x'), /Rebase "feature\/x" onto "main" failed/)
	})

	// ── reorderStack ─────────────────────────────────────────────────────────

	test('reorderStack: delegates to BranchStackService', async () => {
		await api.addBranch('feature/a', 'main')
		await api.addBranch('feature/b', 'feature/a')
		await api.reorderStack(['feature/b', 'feature/a'])
		const names = api.getStack().map((e) => e.name)
		assert.deepStrictEqual(names, ['feature/b', 'feature/a'])
	})

	// ── routeHunks ───────────────────────────────────────────────────────────

	test('routeHunks: no assignments → {routed: 0, skipped: 0}, no router call', async () => {
		const result = await api.routeHunks('src/foo.ts')
		assert.deepStrictEqual(result, { routed: 0, skipped: 0 })
	})

	test('routeHunks: full success clears every hunk assignment for the file', async () => {
		await api.addBranch('feature/a', 'main')
		await config.setHunkAssignment('src/foo.ts', 0, 'feature/a')
		await config.setHunkAssignment('src/foo.ts', 1, 'feature/a')
		const fakeRouter = {
			routeFile: async (): Promise<RouteFileResult> => ({ ok: true, appliedIndices: [0, 1], failedIndices: [] }),
		} as unknown as HunkRouter
		const apiWithFakeRouter = new GitBraidApi(config, branchStack, sync, wsRoot(), runner, fakeRouter)

		const result = await apiWithFakeRouter.routeHunks('src/foo.ts')
		assert.deepStrictEqual(result, { routed: 2, skipped: 0 })
		assert.strictEqual(config.getHunkAssignments('src/foo.ts'), undefined, 'all hunk assignments must be cleared')
	})

	test('routeHunks: partial failure only clears the applied indices', async () => {
		await api.addBranch('feature/a', 'main')
		await api.addBranch('feature/b', 'main')
		await config.setHunkAssignment('src/foo.ts', 0, 'feature/a')
		await config.setHunkAssignment('src/foo.ts', 1, 'feature/b')
		const fakeRouter = {
			routeFile: async (): Promise<RouteFileResult> => ({ ok: false, appliedIndices: [0], failedIndices: [1] }),
		} as unknown as HunkRouter
		const apiWithFakeRouter = new GitBraidApi(config, branchStack, sync, wsRoot(), runner, fakeRouter)

		const result = await apiWithFakeRouter.routeHunks('src/foo.ts')
		assert.deepStrictEqual(result, { routed: 1, skipped: 1 })
		const remaining = config.getHunkAssignments('src/foo.ts')
		assert.strictEqual(remaining?.size, 1, 'the failed hunk must remain assigned so a retry does not re-apply it')
		assert.strictEqual(remaining?.get(1), 'feature/b')
	})

	// ── Events ───────────────────────────────────────────────────────────────

	test('onDidSyncFile: is an event function', () => {
		assert.ok(typeof api.onDidSyncFile === 'function')
	})

	test('onDidFloatFile: is an event function', () => {
		assert.ok(typeof api.onDidFloatFile === 'function')
	})
})
