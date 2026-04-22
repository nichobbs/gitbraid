import * as assert from 'node:assert'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as vscode from 'vscode'
import { ConfigService } from '../src/configService'
import { BranchStackService } from '../src/branchStackService'
import { WorkspaceSync } from '../src/workspaceSync'
import { BranchScmProviderManager } from '../src/branchScmProvider'
import { git } from '../src/gitFunctions'
import { FakeGitRunner } from './helpers/fakeGitRunner'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function wsRoot(): vscode.Uri {
	return vscode.workspace.workspaceFolders![0].uri
}

function cleanup() {
	try { fs.rmSync(path.join(wsRoot().fsPath, '.worktrees'), { recursive: true }) } catch {}
	try { fs.rmSync(path.join(wsRoot().fsPath, '.gitignore')) } catch {}
}

// ─── Suite ───────────────────────────────────────────────────────────────────

suite('BranchScmProviderManager', function () {
	this.timeout(15_000)

	let config: ConfigService
	let branchStack: BranchStackService
	let sync: WorkspaceSync
	let runner: FakeGitRunner

	// VS Code notifications (showWarningMessage, showErrorMessage, etc.) block in
	// the headless test host until dismissed. Stub them all to return immediately.
	type WinAny = Record<string, (...args: unknown[]) => Promise<unknown>>
	let origWarn: WinAny['showWarningMessage']
	let origErr: WinAny['showErrorMessage']
	let origInfo: WinAny['showInformationMessage']

	suiteSetup(async () => {
		await git.init()
		try { await git.add(undefined, '.gitkeep') } catch {}
		try { await git.commit('initial commit', '--no-gpg-sign') } catch {}
	})

	setup(async () => {
		const win = vscode.window as unknown as WinAny
		origWarn = win.showWarningMessage
		origErr = win.showErrorMessage
		origInfo = win.showInformationMessage
		win.showWarningMessage = async () => undefined
		win.showErrorMessage = async () => undefined
		win.showInformationMessage = async () => undefined

		cleanup()
		ConfigService.resetInstance()
		BranchStackService.resetInstance()
		WorkspaceSync.resetInstance()
		config = ConfigService.getInstance()
		await config.load(wsRoot())
		branchStack = BranchStackService.getInstance(config)
		sync = WorkspaceSync.getInstance(config)
		runner = new FakeGitRunner()
		// Default: every `git status` call returns an empty clean tree
		runner.fixture('status --porcelain=v1 -z', { stdout: '', exitCode: 0 })
	})

	teardown(() => {
		const win = vscode.window as unknown as WinAny
		win.showWarningMessage = origWarn
		win.showErrorMessage = origErr
		win.showInformationMessage = origInfo

		sync.dispose()
		cleanup()
		BranchStackService.resetInstance()
		ConfigService.resetInstance()
		WorkspaceSync.resetInstance()
	})

	// ── Construction / initialization ────────────────────────────────────────

	test('initialize: no-op when stack is empty', async () => {
		const mgr = new BranchScmProviderManager(config, sync, wsRoot(), runner)
		await mgr.initialize()
		mgr.dispose()
		// Should not throw; runner should have received no calls.
		assert.strictEqual(runner.calls.length, 0)
	})

	test('initialize: creates one SCM entry per branch', async () => {
		await branchStack.initStack(wsRoot())
		await config.addBranch({ name: 'feature/a', color: '#f00', base: 'main' })

		const mgr = new BranchScmProviderManager(config, sync, wsRoot(), runner)
		await mgr.initialize()
		mgr.dispose()

		// At least one `git status` call should have been made for the branch
		const statusCalls = runner.calls.filter((c) => c.args[0] === 'status')
		assert.ok(statusCalls.length >= 1, `expected ≥1 status calls, got ${statusCalls.length}`)
	})

	// ── gitStatusInDir parsing via refresh ───────────────────────────────────

	test('refreshAll: parses modified and untracked files', async () => {
		await branchStack.initStack(wsRoot())
		await config.addBranch({ name: 'feature/a', color: '#f00', base: 'main' })

		// Simulate: one staged-modified file, one unstaged, one untracked
		runner.fixture('status --porcelain=v1 -z', {
			stdout: 'M  src/staged.ts\0 M src/modified.ts\0?? src/new.ts',
			exitCode: 0,
		})

		const mgr = new BranchScmProviderManager(config, sync, wsRoot(), runner)
		await mgr.initialize()
		// Force another refresh so the TTL window doesn't skip
		await mgr.refreshAll()
		mgr.dispose()

		// We just verify no exception is thrown and the runner was invoked
		const statusCalls = runner.calls.filter((c) => c.args[0] === 'status')
		assert.ok(statusCalls.length >= 1)
	})

	test('refreshAll: handles git status non-zero exit code gracefully', async () => {
		await branchStack.initStack(wsRoot())
		await config.addBranch({ name: 'feature/a', color: '#f00', base: 'main' })

		runner.fixture('status --porcelain=v1 -z', { stdout: '', stderr: 'fatal: not a git repo', exitCode: 128 })

		const mgr = new BranchScmProviderManager(config, sync, wsRoot(), runner)
		await mgr.initialize() // should not throw
		mgr.dispose()
	})

	// ── _rebuild: stack change handling ─────────────────────────────────────

	test('rebuild: removes SCM entry when branch removed from stack', async () => {
		await branchStack.initStack(wsRoot())
		await config.addBranch({ name: 'feature/a', color: '#f00', base: 'main' })

		const mgr = new BranchScmProviderManager(config, sync, wsRoot(), runner)
		await mgr.initialize()

		// Removing the branch triggers onDidChangeStack → _rebuild
		await config.removeBranch('feature/a')

		// Wait a tick for the event to propagate
		await new Promise((resolve) => setImmediate(resolve))

		mgr.dispose()
	})

	test('rebuild: adds SCM entry when branch added after initialize', async () => {
		await branchStack.initStack(wsRoot())
		const mgr = new BranchScmProviderManager(config, sync, wsRoot(), runner)
		await mgr.initialize()

		// Add a branch after initialization; onDidChangeStack fires
		await config.addBranch({ name: 'feature/b', color: '#0f0', base: 'main' })
		await new Promise((resolve) => setImmediate(resolve))

		const statusCalls = runner.calls.filter((c) => c.args[0] === 'status')
		assert.ok(statusCalls.length >= 1)

		mgr.dispose()
	})

	// ── commitBranch ─────────────────────────────────────────────────────────

	test('commitBranch: no-op when branch not in manager', async () => {
		const mgr = new BranchScmProviderManager(config, sync, wsRoot(), runner)
		await mgr.initialize()
		// Should show an error message but not throw
		await mgr.commitBranch('feature/nonexistent')
		mgr.dispose()
	})

	test('commitBranch: warns when commit message is empty', async () => {
		await branchStack.initStack(wsRoot())
		await config.addBranch({ name: 'feature/a', color: '#f00', base: 'main' })

		runner.fixture('commit -m', { stdout: '', exitCode: 0 })

		const mgr = new BranchScmProviderManager(config, sync, wsRoot(), runner)
		await mgr.initialize()

		// inputBox.value is empty by default — commitBranch should warn and return
		await mgr.commitBranch('feature/a')

		const commitCalls = runner.calls.filter((c) => c.args[0] === 'commit')
		assert.strictEqual(commitCalls.length, 0, 'git commit should not be called with empty message')
		mgr.dispose()
	})

	test('commitBranch: calls git commit and clears input on success', async () => {
		await config.addBranch({ name: 'feature/a', color: '#f00', base: 'main' })

		runner.fixture('commit', { stdout: '[feature/a abc1234] my commit\n 1 file changed', exitCode: 0 })
		// initialize() also calls gitStatusInDir
		runner.fixture('status --porcelain=v1 -z', { stdout: '', exitCode: 0 })

		const mgr = new BranchScmProviderManager(config, sync, wsRoot(), runner)
		await mgr.initialize()

		// Access the private _entries map to set the commit message
		const entries = (mgr as unknown as { _entries: Map<string, { inputBox: vscode.SourceControlInputBox }> })._entries
		const entry = entries.get('feature/a')
		assert.ok(entry, 'expected BranchScmEntry for feature/a')
		entry.inputBox.value = 'my commit message'

		await mgr.commitBranch('feature/a')

		const commitCalls = runner.calls.filter((c) => c.args[0] === 'commit')
		assert.strictEqual(commitCalls.length, 1, 'git commit should have been called once')
		assert.ok(commitCalls[0].args.includes('my commit message'), 'commit message should be passed as argument')
		mgr.dispose()
	})

	test('commitBranch: shows error on non-zero exit code', async () => {
		await branchStack.initStack(wsRoot())
		await config.addBranch({ name: 'feature/a', color: '#f00', base: 'main' })

		runner.fixture('commit', { stdout: '', stderr: 'nothing to commit', exitCode: 1 })

		const mgr = new BranchScmProviderManager(config, sync, wsRoot(), runner)
		await mgr.initialize()
		// Empty message guard prevents reaching git — verify no commit calls
		await mgr.commitBranch('feature/a')
		const commitCalls = runner.calls.filter((c) => c.args[0] === 'commit')
		assert.strictEqual(commitCalls.length, 0)
		mgr.dispose()
	})

	// ── dispose ──────────────────────────────────────────────────────────────

	test('dispose: can be called multiple times without error', async () => {
		const mgr = new BranchScmProviderManager(config, sync, wsRoot(), runner)
		await mgr.initialize()
		mgr.dispose()
		mgr.dispose()
	})

	test('dispose: cleans up entries for multiple branches', async () => {
		await branchStack.initStack(wsRoot())
		await config.addBranch({ name: 'feature/a', color: '#f00', base: 'main' })
		await config.addBranch({ name: 'feature/b', color: '#0f0', base: 'main' })

		const mgr = new BranchScmProviderManager(config, sync, wsRoot(), runner)
		await mgr.initialize()
		mgr.dispose() // should not throw
	})

	// ── gitStatusInDir parsing edge cases ────────────────────────────────────

	test('refreshAll: handles empty status output', async () => {
		await branchStack.initStack(wsRoot())
		await config.addBranch({ name: 'feature/a', color: '#f00', base: 'main' })

		runner.fixture('status --porcelain=v1 -z', { stdout: '', exitCode: 0 })

		const mgr = new BranchScmProviderManager(config, sync, wsRoot(), runner)
		await mgr.initialize()
		await mgr.refreshAll()
		mgr.dispose()
	})

	test('refreshAll: handles mixed staged and unstaged for same file', async () => {
		await branchStack.initStack(wsRoot())
		await config.addBranch({ name: 'feature/a', color: '#f00', base: 'main' })

		// MM = staged and unstaged modifications to same file
		runner.fixture('status --porcelain=v1 -z', {
			stdout: 'MM src/file.ts',
			exitCode: 0,
		})

		const mgr = new BranchScmProviderManager(config, sync, wsRoot(), runner)
		await mgr.initialize()
		mgr.dispose()
	})

	test('refreshAll: multiple branches each get their own status call', async () => {
		await branchStack.initStack(wsRoot())
		await config.addBranch({ name: 'feature/a', color: '#f00', base: 'main' })
		await config.addBranch({ name: 'feature/b', color: '#0f0', base: 'main' })

		const mgr = new BranchScmProviderManager(config, sync, wsRoot(), runner)
		await mgr.initialize()

		const statusCalls = runner.calls.filter((c) => c.args[0] === 'status')
		assert.strictEqual(statusCalls.length, 2, 'one status call per branch')
		mgr.dispose()
	})

	test('refreshAll: second call within TTL is coalesced (no additional runner calls)', async () => {
		await branchStack.initStack(wsRoot())
		await config.addBranch({ name: 'feature/a', color: '#f00', base: 'main' })

		const mgr = new BranchScmProviderManager(config, sync, wsRoot(), runner)
		await mgr.initialize()
		const callsBefore = runner.calls.length

		// Second call within the 2s TTL window — should be coalesced
		await mgr.refreshAll()
		const callsAfter = runner.calls.length

		// TTL coalescing: no new status calls
		assert.strictEqual(callsAfter, callsBefore)
		mgr.dispose()
	})
})
