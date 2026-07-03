import * as assert from 'node:assert'
import * as vscode from 'vscode'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { ConfigService } from '../src/configService'
import { BranchStackService, worktreePath } from '../src/branchStackService'
import { RebaseSuggestionService } from '../src/rebaseSuggestionService'
import { StackCommands } from '../src/stackCommands'
import { FakeGitRunner } from './helpers/fakeGitRunner'

// Drives StackCommands through a FakeGitRunner so the test doesn't need a
// real git remote.  The BranchStackService singleton is used only for its
// `worktreeExists(name)` check — we pre-create the worktree directories
// directly so `fs.existsSync` returns true without an actual `git worktree
// add` round-trip.

function wsRoot(): vscode.Uri {
	return vscode.workspace.workspaceFolders![0].uri
}

function ensureDir(p: string): void {
	fs.mkdirSync(p, { recursive: true })
}

function cleanup(): void {
	try { fs.rmSync(path.join(wsRoot().fsPath, '.worktrees'), { recursive: true, force: true }) } catch { /* ignore */ }
}

suite('StackCommands (T67)', () => {
	let config: ConfigService
	let branchStack: BranchStackService
	let rebaseSvc: RebaseSuggestionService
	let runner: FakeGitRunner
	let cmds: StackCommands

	// VS Code notifications block in the headless test host until dismissed.
	type WinAny = Record<string, (...args: unknown[]) => Promise<unknown>>
	let origWarn: WinAny['showWarningMessage']
	let origErr: WinAny['showErrorMessage']
	let origInfo: WinAny['showInformationMessage']

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
		config = ConfigService.getInstance()
		await config.load(wsRoot())
		branchStack = BranchStackService.getInstance(config)
		// No real initStack — the cheap path: pre-register worktree dirs.
		runner = new FakeGitRunner()
		rebaseSvc = new RebaseSuggestionService(config, branchStack, runner)
		cmds = new StackCommands(config, branchStack, rebaseSvc, wsRoot(), runner)
	})

	teardown(async () => {
		const win = vscode.window as unknown as WinAny
		win.showWarningMessage = origWarn
		win.showErrorMessage = origErr
		win.showInformationMessage = origInfo

		cleanup()
		BranchStackService.resetInstance()
		ConfigService.resetInstance()
	})

	test('pushStack: empty stack → early return, runner untouched', async () => {
		const results = await cmds.pushStack()
		assert.deepStrictEqual(results, [])
		assert.strictEqual(runner.calls.length, 0)
	})

	test('pushStack: runs `push -u origin <branch>` for each branch with a worktree', async () => {
		await config.addBranch({ name: 'feature/a', base: 'main', color: '#4ec9b0' })
		await config.addBranch({ name: 'feature/b', base: 'feature/a', color: '#c586c0' })
		// Make the worktree dirs exist so `worktreeExists(...)` returns true.
		ensureDir(worktreePath(wsRoot(), 'feature/a').fsPath)
		ensureDir(worktreePath(wsRoot(), 'feature/b').fsPath)

		runner.fixture('push -u', { stdout: 'OK', exitCode: 0 })

		const results = await cmds.pushStack()
		assert.strictEqual(results.length, 2)
		assert.ok(results.every((r) => r.ok), `expected all ok, got ${JSON.stringify(results)}`)

		const pushCalls = runner.calls.filter((c) => c.args[0] === 'push')
		assert.strictEqual(pushCalls.length, 2)
		for (const c of pushCalls) {
			// argv: ['push', '-u', 'origin', '<branch>']
			assert.strictEqual(c.args[0], 'push')
			assert.strictEqual(c.args[1], '-u')
			assert.strictEqual(c.args[2], 'origin')
			assert.ok(['feature/a', 'feature/b'].includes(c.args[3]))
		}
	})

	test('pushStack: skips branches with no worktree', async () => {
		await config.addBranch({ name: 'feature/missing', base: 'main', color: '#4ec9b0' })
		// Do NOT create the worktree dir.
		runner.fixture('push -u', { exitCode: 0 })

		const results = await cmds.pushStack()
		assert.strictEqual(results.length, 1)
		assert.strictEqual(results[0].ok, true)
		assert.match(results[0].message ?? '', /skipped/)
		assert.strictEqual(runner.calls.length, 0, 'no git calls for skipped branches')
	})

	test('pushStack: non-zero git exit surfaces as a failed result', async () => {
		await config.addBranch({ name: 'feature/fail', base: 'main', color: '#4ec9b0' })
		ensureDir(worktreePath(wsRoot(), 'feature/fail').fsPath)
		runner.fixture('push -u', { stderr: 'rejected (non-fast-forward)', exitCode: 1 })

		const results = await cmds.pushStack()
		assert.strictEqual(results.length, 1)
		assert.strictEqual(results[0].ok, false)
		assert.match(results[0].message ?? '', /non-fast-forward/)
	})

	test('pushStack: --force-with-lease only added when upstream exists', async () => {
		await config.addBranch({ name: 'feature/new', base: 'main', color: '#4ec9b0' })
		ensureDir(worktreePath(wsRoot(), 'feature/new').fsPath)
		// No tracking ref yet → rev-parse exits non-zero.
		runner.fixture('rev-parse --abbrev-ref', { stderr: 'no upstream', exitCode: 128 })
		runner.fixture('push -u', { exitCode: 0 })

		await cmds.pushStack({ forceWithLease: true })
		const pushCall = runner.calls.find((c) => c.args[0] === 'push')
		assert.ok(pushCall, 'expected a push call')
		assert.ok(
			!pushCall!.args.includes('--force-with-lease'),
			'should omit --force-with-lease when there is no upstream',
		)
	})

	test('syncStack: dirty worktree is auto-stashed and rebased', async () => {
		await config.addBranch({ name: 'feature/dirty', base: 'main', color: '#4ec9b0' })
		ensureDir(worktreePath(wsRoot(), 'feature/dirty').fsPath)
		runner.fixture('fetch', { exitCode: 0 })
		// --autostash lets git handle the stash; no pre-flight status check needed.
		runner.fixture('rebase --autostash', { exitCode: 0 })

		const results = await cmds.syncStack()
		const dirty = results.find((r) => r.branch === 'feature/dirty')
		assert.ok(dirty, 'expected a result for feature/dirty')
		assert.strictEqual(dirty!.ok, true)
		// Rebase must have been called with --autostash, not skipped.
		assert.ok(
			runner.calls.some((c) => c.args[0] === 'rebase' && c.args.includes('--autostash')),
			'rebase --autostash must run instead of skipping the dirty worktree',
		)
	})

	test('syncStack: fetch failure short-circuits the whole run', async () => {
		await config.addBranch({ name: 'feature/x', base: 'main', color: '#4ec9b0' })
		ensureDir(worktreePath(wsRoot(), 'feature/x').fsPath)
		runner.fixture('fetch', { stderr: 'fatal: unable to access', exitCode: 1 })

		const results = await cmds.syncStack()
		assert.strictEqual(results.length, 1)
		assert.match(results[0].branch, /origin/)
		assert.strictEqual(results[0].ok, false)
	})

	// ── syncStack: predicted-conflict pre-pass ───────────────────────────────

	test('syncStack: a predicted conflict warns up front and aborts the whole run when declined', async () => {
		await config.addBranch({ name: 'feature/dirty', base: 'main', color: '#4ec9b0' })
		ensureDir(worktreePath(wsRoot(), 'feature/dirty').fsPath)
		runner.fixture('fetch', { exitCode: 0 })
		runner.fixture('rev-parse --verify', { exitCode: 0 })
		runner.fixture('merge-tree --write-tree', {
			exitCode: 1,
			stdout: 'sometreeoid\nAuto-merging f.txt\nCONFLICT (content): Merge conflict in f.txt\n',
		})
		runner.fixture('rebase --autostash', { exitCode: 0 })

		const win = vscode.window as unknown as { showWarningMessage: (...args: unknown[]) => Promise<unknown> }
		const origWarnLocal = win.showWarningMessage
		let warned = false
		win.showWarningMessage = async () => { warned = true; return undefined /* user declines */ }
		try {
			const results = await cmds.syncStack()
			assert.ok(warned, 'should have warned about the predicted conflict')
			assert.strictEqual(results.length, 1)
			assert.strictEqual(results[0].branch, '(sync)')
			assert.strictEqual(results[0].ok, false)
			assert.match(results[0].message ?? '', /predicted conflicts/)
			assert.ok(
				!runner.calls.some((c) => c.args[0] === 'rebase'),
				'no rebase should run once the user declines',
			)
		} finally {
			win.showWarningMessage = origWarnLocal
		}
	})

	test('syncStack: proceeds with the rebase when the user continues past a predicted conflict', async () => {
		await config.addBranch({ name: 'feature/dirty', base: 'main', color: '#4ec9b0' })
		ensureDir(worktreePath(wsRoot(), 'feature/dirty').fsPath)
		runner.fixture('fetch', { exitCode: 0 })
		runner.fixture('rev-parse --verify', { exitCode: 0 })
		runner.fixture('merge-tree --write-tree', {
			exitCode: 1,
			stdout: 'sometreeoid\nAuto-merging f.txt\nCONFLICT (content): Merge conflict in f.txt\n',
		})
		runner.fixture('rebase --autostash', { exitCode: 0 })

		const win = vscode.window as unknown as { showWarningMessage: (...args: unknown[]) => Promise<unknown> }
		const origWarnLocal = win.showWarningMessage
		win.showWarningMessage = async () => 'Continue Anyway'
		try {
			const results = await cmds.syncStack()
			const dirty = results.find((r) => r.branch === 'feature/dirty')
			assert.ok(dirty, 'expected a result for feature/dirty')
			assert.strictEqual(dirty!.ok, true)
			assert.ok(
				runner.calls.some((c) => c.args[0] === 'rebase' && c.args.includes('--autostash')),
				'rebase should run once the user continues anyway',
			)
		} finally {
			win.showWarningMessage = origWarnLocal
		}
	})
})
