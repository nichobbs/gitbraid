import * as assert from 'node:assert'
import * as fs from 'node:fs'
import * as os from 'node:os'
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
		// Simulate `git worktree add` layout: <worktree>/.git is a FILE
		// pointing at a sibling gitdir containing rebase-merge/.
		//
		// `inspect()` only touches the filesystem plus the (faked) git
		// runner, so this doesn't need a real git repo at all. Building it
		// from a plain, never-`git init`-ed temp dir — rather than deleting
		// `repo.root/.git` (a real git-touched directory) and replacing it —
		// sidesteps a Windows CI flake where a just-used `.git` dir can stay
		// briefly locked (AV scanning / delayed handle release) long enough
		// that even fs.rmSync's built-in retry/backoff doesn't outlast it.
		const worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitbraid-rebase-recovery-gitdir-'))
		try {
			const dotgit = path.join(worktreeDir, '.git')
			const realGitDir = path.join(worktreeDir, '_real_gitdir')
			fs.mkdirSync(path.join(realGitDir, 'rebase-merge'), { recursive: true })
			fs.writeFileSync(dotgit, `gitdir: ${realGitDir}\n`)
			runner.fixture('status --porcelain=v1 -z', { stdout: '', exitCode: 0 })
			const state = await recovery.inspect(worktreeDir)
			assert.ok(state, 'must follow .git gitdir indirection')
		} finally {
			try { fs.rmSync(worktreeDir, { recursive: true, force: true }) } catch { /* ignore */ }
		}
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

	// ─── watch ──────────────────────────────────────────────────────────────

	suite('watch', () => {
		test('seeds state immediately for a pre-existing mid-rebase worktree', async () => {
			fs.mkdirSync(path.join(repo.root, '.git', 'rebase-merge'), { recursive: true })
			runner.fixture('status --porcelain=v1 -z', { stdout: 'UU a.ts\0', exitCode: 0 })
			const events: string[] = []
			recovery.onDidChangeState((e) => events.push(e.state))
			const disposable = recovery.watch(repo.root)
			try {
				// `watch()` seeds via a fire-and-forget `_recheck` call — flush microtasks.
				await new Promise((r) => setImmediate(r))
				assert.deepStrictEqual(events, ['in-progress'])
			} finally {
				disposable.dispose()
			}
		})

		test('idle worktree → no event fires on seed', async () => {
			const events: string[] = []
			recovery.onDidChangeState((e) => events.push(e.state))
			const disposable = recovery.watch(repo.root)
			try {
				await new Promise((r) => setImmediate(r))
				assert.deepStrictEqual(events, [])
			} finally {
				disposable.dispose()
			}
		})

		test('returned disposable can be disposed without throwing', () => {
			const disposable = recovery.watch(repo.root)
			assert.doesNotThrow(() => disposable.dispose())
		})
	})

	// ─── abort: failure branch ─────────────────────────────────────────────────

	test('abort: failure surfaces the stderr in an error message', async () => {
		runner.fixture('rebase --abort', { exitCode: 1, stderr: 'not currently rebasing' })
		let errMsg: string | undefined
		;(vscode.window as unknown as WinAny).showErrorMessage = async (msg: string) => { errMsg = msg; return undefined }
		await recovery.abort(repo.root)
		assert.match(errMsg ?? '', /abort failed — not currently rebasing/)
	})

	test('abort: failure with blank stderr falls back to "unknown error"', async () => {
		runner.fixture('rebase --abort', { exitCode: 1, stderr: '' })
		let errMsg: string | undefined
		;(vscode.window as unknown as WinAny).showErrorMessage = async (msg: string) => { errMsg = msg; return undefined }
		await recovery.abort(repo.root)
		assert.match(errMsg ?? '', /abort failed — unknown error/)
	})

	test('continue: failure surfaces the stderr in an error message', async () => {
		runner.fixture('status --porcelain=v1 -z', { stdout: '', exitCode: 0 })
		runner.fixture('rebase --continue', { exitCode: 1, stderr: 'still conflicted' })
		let errMsg: string | undefined
		;(vscode.window as unknown as WinAny).showErrorMessage = async (msg: string) => { errMsg = msg; return undefined }
		await recovery.continue(repo.root)
		assert.match(errMsg ?? '', /continue failed — still conflicted/)
	})

	// ─── openConflicts ──────────────────────────────────────────────────────────

	suite('openConflicts', () => {
		type CmdAny = { executeCommand: (...args: unknown[]) => Promise<unknown> }
		let origExec: CmdAny['executeCommand']
		let origShowDoc: typeof vscode.window.showTextDocument

		setup(() => {
			origExec = (vscode.commands as unknown as CmdAny).executeCommand
			origShowDoc = vscode.window.showTextDocument
		})

		teardown(() => {
			;(vscode.commands as unknown as CmdAny).executeCommand = origExec
			;(vscode.window as unknown as { showTextDocument: unknown }).showTextDocument = origShowDoc
		})

		test('no conflicted files → info message, nothing opened', async () => {
			runner.fixture('status --porcelain=v1 -z', { stdout: '', exitCode: 0 })
			let infoMsg: string | undefined
			;(vscode.window as unknown as WinAny).showInformationMessage = async (msg: string) => { infoMsg = msg; return undefined }
			let execCalled = false
			;(vscode.commands as unknown as CmdAny).executeCommand = async () => { execCalled = true; return undefined }
			await recovery.openConflicts(repo.root)
			assert.match(infoMsg ?? '', /no conflicted files remain/)
			assert.strictEqual(execCalled, false)
		})

		test('opens each conflicted file via the merge editor and reports the count', async () => {
			runner.fixture('status --porcelain=v1 -z', { stdout: 'UU a.ts\0UU b.ts\0', exitCode: 0 })
			const opened: unknown[] = []
			;(vscode.commands as unknown as CmdAny).executeCommand = async (cmd: string, uri: unknown) => {
				opened.push([cmd, uri])
				return undefined
			}
			let infoMsg: string | undefined
			;(vscode.window as unknown as WinAny).showInformationMessage = async (msg: string) => { infoMsg = msg; return undefined }
			await recovery.openConflicts(repo.root)
			assert.strictEqual(opened.length, 2)
			assert.strictEqual((opened[0] as unknown[])[0], 'git.openMergeEditor')
			assert.match(infoMsg ?? '', /Opened 2 conflicted files in the merge editor/)
		})

		test('singular wording when exactly one file is opened', async () => {
			runner.fixture('status --porcelain=v1 -z', { stdout: 'UU a.ts\0', exitCode: 0 })
			;(vscode.commands as unknown as CmdAny).executeCommand = async () => undefined
			let infoMsg: string | undefined
			;(vscode.window as unknown as WinAny).showInformationMessage = async (msg: string) => { infoMsg = msg; return undefined }
			await recovery.openConflicts(repo.root)
			assert.match(infoMsg ?? '', /Opened 1 conflicted file in the merge editor/)
			assert.ok(!infoMsg?.includes('files'), 'must use singular "file", not "files"')
		})

		test('more than 10 conflicted files → opens the first 10 and reports "N of M"', async () => {
			const files = Array.from({ length: 13 }, (_, i) => `UU f${String(i)}.ts`)
			runner.fixture('status --porcelain=v1 -z', { stdout: files.join('\0') + '\0', exitCode: 0 })
			const opened: unknown[] = []
			;(vscode.commands as unknown as CmdAny).executeCommand = async (cmd: string, uri: unknown) => {
				opened.push([cmd, uri]); return undefined
			}
			let infoMsg: string | undefined
			;(vscode.window as unknown as WinAny).showInformationMessage = async (msg: string) => { infoMsg = msg; return undefined }
			await recovery.openConflicts(repo.root)
			assert.strictEqual(opened.length, 10, 'must cap at 10 opens')
			assert.match(infoMsg ?? '', /Opened 10 of 13 conflicted files/)
		})

		test('merge editor unavailable → falls back to showTextDocument', async () => {
			runner.fixture('status --porcelain=v1 -z', { stdout: 'UU a.ts\0', exitCode: 0 })
			;(vscode.commands as unknown as CmdAny).executeCommand = async () => { throw new Error('no merge editor') }
			let shown = false
			;(vscode.window as unknown as { showTextDocument: unknown }).showTextDocument = async () => { shown = true; return undefined as unknown }
			await recovery.openConflicts(repo.root)
			assert.strictEqual(shown, true)
		})

		test('both merge editor and showTextDocument fail → does not throw', async () => {
			runner.fixture('status --porcelain=v1 -z', { stdout: 'UU a.ts\0', exitCode: 0 })
			;(vscode.commands as unknown as CmdAny).executeCommand = async () => { throw new Error('no merge editor') }
			;(vscode.window as unknown as { showTextDocument: unknown }).showTextDocument = async () => { throw new Error('cannot open') }
			await assert.doesNotReject(() => recovery.openConflicts(repo.root))
		})
	})

	// ─── _recheck / _promptRecovery state machine ──────────────────────────────

	suite('_recheck / _promptRecovery (private state machine)', () => {
		function recheck(dir: string): Promise<void> {
			return (recovery as unknown as { _recheck: (d: string) => Promise<void> })._recheck(dir)
		}

		test('idle → in-progress: fires onDidChangeState once and prompts recovery', async () => {
			runner.fixture('status --porcelain=v1 -z', { stdout: 'UU a.ts\0', exitCode: 0 })
			fs.mkdirSync(path.join(repo.root, '.git', 'rebase-merge'), { recursive: true })

			const events: string[] = []
			recovery.onDidChangeState((e) => events.push(e.state))
			let warned = false
			;(vscode.window as unknown as WinAny).showWarningMessage = async () => { warned = true; return undefined }

			await recheck(repo.root)
			assert.deepStrictEqual(events, ['in-progress'])
			// `_recheck` fires the state event synchronously but kicks off
			// `_promptRecovery` fire-and-forget (`void this._promptRecovery(...)`)
			// — flush its internal awaits (list conflicts, then the prompt)
			// before asserting on its side effect.
			await new Promise((r) => setImmediate(r))
			assert.ok(warned, 'expected _promptRecovery to show the recovery prompt')
		})

		test('re-checking while already in-progress does not re-fire the event', async () => {
			runner.fixture('status --porcelain=v1 -z', { stdout: 'UU a.ts\0', exitCode: 0 })
			fs.mkdirSync(path.join(repo.root, '.git', 'rebase-merge'), { recursive: true })
			const events: string[] = []
			recovery.onDidChangeState((e) => events.push(e.state))

			await recheck(repo.root)
			await recheck(repo.root)
			assert.deepStrictEqual(events, ['in-progress'], 'second recheck must be a no-op while still mid-rebase')
		})

		test('in-progress → idle: fires onDidChangeState once the rebase dir is gone', async () => {
			runner.fixture('status --porcelain=v1 -z', { stdout: 'UU a.ts\0', exitCode: 0 })
			const rebaseMergeDir = path.join(repo.root, '.git', 'rebase-merge')
			fs.mkdirSync(rebaseMergeDir, { recursive: true })
			const events: string[] = []
			recovery.onDidChangeState((e) => events.push(e.state))
			await recheck(repo.root)

			fs.rmSync(rebaseMergeDir, { recursive: true, force: true })
			await recheck(repo.root)
			assert.deepStrictEqual(events, ['in-progress', 'idle'])
		})

		function promptRecovery(dir: string): Promise<void> {
			return (recovery as unknown as { _promptRecovery: (d: string) => Promise<void> })._promptRecovery(dir)
		}

		test('no conflicts → runs continue() directly under a progress notification', async () => {
			runner.fixture('status --porcelain=v1 -z', { stdout: '', exitCode: 0 })
			runner.fixture('rebase --continue', { exitCode: 0 })
			await promptRecovery(repo.root)
			const call = runner.calls.find((c) => c.args[0] === 'rebase' && c.args[1] === '--continue')
			assert.ok(call, 'expected rebase --continue to run without prompting')
		})

		test('conflicts present, user dismisses the prompt → no action taken', async () => {
			runner.fixture('status --porcelain=v1 -z', { stdout: 'UU a.ts\0', exitCode: 0 })
			;(vscode.window as unknown as WinAny).showWarningMessage = async () => undefined
			await promptRecovery(repo.root)
			assert.strictEqual(runner.calls.some((c) => c.args[0] === 'rebase'), false)
		})

		test('conflicts present, user picks "Abort" → drives abort()', async () => {
			runner.fixture('status --porcelain=v1 -z', { stdout: 'UU a.ts\0', exitCode: 0 })
			runner.fixture('rebase --abort', { exitCode: 0 })
			;(vscode.window as unknown as WinAny).showWarningMessage = async () => 'Abort'
			await promptRecovery(repo.root)
			assert.ok(runner.calls.some((c) => c.args[0] === 'rebase' && c.args[1] === '--abort'))
		})

		test('conflicts present, user picks "Continue" → drives continue(), which still refuses (conflicts remain)', async () => {
			runner.fixture('status --porcelain=v1 -z', { stdout: 'UU a.ts\0', exitCode: 0 })
			;(vscode.window as unknown as WinAny).showWarningMessage = async () => 'Continue'
			await promptRecovery(repo.root)
			// continue() re-lists conflicts (still present) and refuses to run `rebase --continue`.
			assert.strictEqual(runner.calls.some((c) => c.args[0] === 'rebase' && c.args[1] === '--continue'), false)
		})

		test('conflicts present, user picks "Open Conflicts" → drives openConflicts()', async () => {
			runner.fixture('status --porcelain=v1 -z', { stdout: 'UU a.ts\0', exitCode: 0 })
			;(vscode.window as unknown as WinAny).showWarningMessage = async () => 'Open Conflicts'
			let execCalled = false
			const origExec = (vscode.commands as unknown as { executeCommand: unknown }).executeCommand
			;(vscode.commands as unknown as { executeCommand: (...a: unknown[]) => Promise<unknown> }).executeCommand =
				async () => { execCalled = true; return undefined }
			try {
				await promptRecovery(repo.root)
			} finally {
				;(vscode.commands as unknown as { executeCommand: unknown }).executeCommand = origExec
			}
			assert.ok(execCalled, 'expected openConflicts to invoke git.openMergeEditor')
		})
	})
})
