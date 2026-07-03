import * as assert from 'node:assert'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as vscode from 'vscode'
import { TmpRepo } from './helpers/tmpRepo'
import { FakeGitRunner } from './helpers/fakeGitRunner'
import { RebaseRecovery } from '../src/rebaseRecovery'

// Drive `RebaseRecovery` against a real temp worktree dir (so
// `isMidRebase`'s fs.existsSync calls see real files) and a fake git runner
// so the `abort` / `continue` invocations don't actually run git.

suite('RebaseRecovery (T70)', () => {
	let repo: TmpRepo
	let recovery: RebaseRecovery
	let runner: FakeGitRunner

	// VS Code notifications block in the headless test host until dismissed.
	type WinAny = Record<string, (...args: unknown[]) => Promise<unknown>>
	let origWarn: WinAny['showWarningMessage']
	let origErr: WinAny['showErrorMessage']
	let origInfo: WinAny['showInformationMessage']

	setup(() => {
		const win = vscode.window as unknown as WinAny
		origWarn = win.showWarningMessage
		origErr = win.showErrorMessage
		origInfo = win.showInformationMessage
		win.showWarningMessage = async () => undefined
		win.showErrorMessage = async () => undefined
		win.showInformationMessage = async () => undefined

		repo = TmpRepo.create('rebase-recovery')
		runner = new FakeGitRunner()
		recovery = new RebaseRecovery(runner)
	})

	teardown(() => {
		const win = vscode.window as unknown as WinAny
		win.showWarningMessage = origWarn
		win.showErrorMessage = origErr
		win.showInformationMessage = origInfo

		recovery.dispose()
		repo.dispose()
	})

	test('inspect: returns undefined when no rebase is in progress', async () => {
		const state = await recovery.inspect(repo.root)
		assert.strictEqual(state, undefined)
	})

	test('inspect: detects a worktree with .git/rebase-merge present', async () => {
		fs.mkdirSync(path.join(repo.root, '.git', 'rebase-merge'), { recursive: true })
		runner.fixture('status --porcelain=v1 -z', {
			stdout: 'UU conflicted.ts\0 M other.ts\0',
			exitCode: 0,
		})
		const state = await recovery.inspect(repo.root)
		assert.ok(state, 'expected a state object')
		assert.strictEqual(state!.worktreeDir, repo.root)
		assert.deepStrictEqual(state!.conflictedFiles, ['conflicted.ts'])
	})

	test('inspect: also detects legacy .git/rebase-apply', async () => {
		fs.mkdirSync(path.join(repo.root, '.git', 'rebase-apply'), { recursive: true })
		runner.fixture('status --porcelain=v1 -z', { stdout: '', exitCode: 0 })
		const state = await recovery.inspect(repo.root)
		assert.ok(state)
	})

	test('inspect: resolves `.git` indirection (worktree add layout)', async () => {
		// Simulate `git worktree add` layout: repo.root/.git is a FILE
		// pointing at repo.root/_real_gitdir/rebase-merge/.
		const dotgit = path.join(repo.root, '.git')
		// Windows CI intermittently holds a handle on a just-`git init`ed
		// `.git` dir (AV scanning / delayed lock release), which rmSync
		// surfaces as EPERM. maxRetries/retryDelay are Node's built-in
		// backoff for exactly this class of transient Windows lock error.
		fs.rmSync(dotgit, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
		const realGitDir = path.join(repo.root, '_real_gitdir')
		fs.mkdirSync(path.join(realGitDir, 'rebase-merge'), { recursive: true })
		fs.writeFileSync(dotgit, `gitdir: ${realGitDir}\n`)
		runner.fixture('status --porcelain=v1 -z', { stdout: '', exitCode: 0 })
		const state = await recovery.inspect(repo.root)
		assert.ok(state, 'must follow .git gitdir indirection')
	})

	test('abort: invokes `git rebase --abort`', async () => {
		runner.fixture('rebase --abort', { exitCode: 0 })
		await recovery.abort(repo.root)
		const call = runner.calls.find((c) => c.args[0] === 'rebase' && c.args[1] === '--abort')
		assert.ok(call, 'expected rebase --abort to have been invoked')
		assert.strictEqual(call!.cwd, repo.root)
	})

	test('continue: refuses when conflicts remain', async () => {
		runner.fixture('status --porcelain=v1 -z', {
			stdout: 'UU still-conflicted.ts\0',
			exitCode: 0,
		})
		await recovery.continue(repo.root)
		const call = runner.calls.find((c) => c.args[0] === 'rebase' && c.args[1] === '--continue')
		assert.strictEqual(call, undefined, 'must not call rebase --continue with conflicts present')
	})

	test('continue: proceeds when no conflicts remain', async () => {
		runner.fixture('status --porcelain=v1 -z', { stdout: '', exitCode: 0 })
		runner.fixture('rebase --continue', { exitCode: 0 })
		await recovery.continue(repo.root)
		const call = runner.calls.find((c) => c.args[0] === 'rebase' && c.args[1] === '--continue')
		assert.ok(call, 'rebase --continue must have been invoked')
	})

	test('conflict regex covers UU AA DD UD DU AU UA', async () => {
		// Synthesise all seven conflict XY codes in porcelain output.
		const entries = ['UU a', 'AA b', 'DD c', 'UD d', 'DU e', 'AU f', 'UA g']
		runner.fixture('status --porcelain=v1 -z', {
			stdout: entries.join('\0') + '\0 M not-conflict.ts\0',
			exitCode: 0,
		})
		fs.mkdirSync(path.join(repo.root, '.git', 'rebase-merge'), { recursive: true })
		const state = await recovery.inspect(repo.root)
		assert.ok(state)
		assert.deepStrictEqual(state!.conflictedFiles.sort(), ['a', 'b', 'c', 'd', 'e', 'f', 'g'])
	})
})
