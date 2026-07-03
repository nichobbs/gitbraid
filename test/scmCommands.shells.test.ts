/**
 * Direct-import shell tests for `src/commands/scmCommands.ts`.
 */
import * as assert from 'node:assert'
import * as vscode from 'vscode'
import { registerScmCommands } from '../src/commands/scmCommands'
import { setDefaultGitRunnerForTest } from '../src/gitRunner'
import { FakeGitRunner } from './helpers/fakeGitRunner'
import type { CommandDeps } from '../src/commands/types'

type Handler = (...args: unknown[]) => unknown

function captureHandlers(register: () => vscode.Disposable[]): Map<string, Handler> {
	const handlers = new Map<string, Handler>()
	const orig = vscode.commands.registerCommand.bind(vscode.commands)
	;(vscode.commands as unknown as { registerCommand: unknown }).registerCommand =
		(cmd: string, cb: Handler) => {
			handlers.set(cmd, cb)
			return { dispose: () => { /* no-op */ } } as vscode.Disposable
		}
	try { register() } finally {
		;(vscode.commands as unknown as { registerCommand: unknown }).registerCommand = orig
	}
	return handlers
}

interface ScmCalls {
	commitBranch: string[]
	commitAndPush: string[]
	commitAndSync: string[]
	pushBranch: string[]
	pullBranch: string[]
	syncBranch: string[]
	stashBranch: string[]
	stageFile: string[]
	unstageFile: string[]
	stageAll: string[]
	unstageAll: string[]
	refreshAll: number
	getBranchForGroup: string | undefined
	getBranchForInputBox: string | undefined
}

function makeDeps(opts: {
	resolveBranchNameArg?: CommandDeps['resolveBranchNameArg']
	worktreeExists?: boolean
	getBranchForGroup?: string | undefined
	getBranchForInputBox?: string | undefined
} = {}): { deps: CommandDeps, calls: ScmCalls } {
	const calls: ScmCalls = {
		commitBranch: [], commitAndPush: [], commitAndSync: [],
		pushBranch: [], pullBranch: [], syncBranch: [], stashBranch: [],
		stageFile: [], unstageFile: [], stageAll: [], unstageAll: [],
		refreshAll: 0,
		getBranchForGroup: opts.getBranchForGroup,
		getBranchForInputBox: opts.getBranchForInputBox,
	}
	const ctx = {
		root: vscode.Uri.file('/tmp/fake-repo'),
		scmManager: {
			commitBranch: async (n: string) => { calls.commitBranch.push(n) },
			commitAndPush: async (n: string) => { calls.commitAndPush.push(n) },
			commitAndSync: async (n: string) => { calls.commitAndSync.push(n) },
			pushBranch: async (n: string) => { calls.pushBranch.push(n) },
			pullBranch: async (n: string) => { calls.pullBranch.push(n) },
			syncBranch: async (n: string) => { calls.syncBranch.push(n) },
			stashBranch: async (n: string) => { calls.stashBranch.push(n) },
			stageFile: async (path: string) => { calls.stageFile.push(path) },
			unstageFile: async (path: string) => { calls.unstageFile.push(path) },
			stageAll: async (n: string) => { calls.stageAll.push(n) },
			unstageAll: async (n: string) => { calls.unstageAll.push(n) },
			refreshAll: async () => { calls.refreshAll++ },
			getBranchForGroup: () => calls.getBranchForGroup,
			getBranchForInputBox: () => calls.getBranchForInputBox,
			setInputBoxValue: () => undefined,
		},
		branchStack: {
			worktreeExists: () => opts.worktreeExists ?? false,
			getWorktreePath: () => vscode.Uri.file('/tmp/fake-repo/.worktrees/fake'),
		},
	}
	const deps: CommandDeps = {
		registry: undefined as unknown as CommandDeps['registry'],
		primary: ctx as unknown as CommandDeps['primary'],
		activeContext: () => ctx as unknown as CommandDeps['primary'],
		contextForUri: () => ctx as unknown as CommandDeps['primary'],
		relativePathIn: (_c, u) => u.fsPath,
		resolveBranchNameArg: opts.resolveBranchNameArg ?? (async () => undefined),
		resolveActiveBranchWorktree: async () => undefined,
		extractFileUri: () => undefined,
		stackTreeProvider: undefined as unknown as CommandDeps['stackTreeProvider'],
		stackView: undefined as unknown as CommandDeps['stackView'],
		statusBar: undefined as unknown as CommandDeps['statusBar'],
		prAwareness: undefined as unknown as CommandDeps['prAwareness'],
		overlayDiagnostics: undefined as unknown as CommandDeps['overlayDiagnostics'],
	}
	return { deps, calls }
}

async function withStubbedWindow(
	stubs: Partial<Record<string, (...args: unknown[]) => Promise<unknown>>>,
	fn: () => Promise<void>,
): Promise<void> {
	const win = vscode.window as unknown as Record<string, unknown>
	const originals: Record<string, unknown> = {}
	for (const [key, value] of Object.entries(stubs)) {
		originals[key] = win[key]
		win[key] = value
	}
	try { await fn() } finally {
		for (const [key, value] of Object.entries(originals)) win[key] = value
	}
}

suite('scmCommands shell coverage (direct-import)', () => {

	test('commitBranch: string arg → drives manager.commitBranch with that name', async () => {
		const { deps, calls } = makeDeps()
		const handlers = captureHandlers(() => registerScmCommands(deps))
		await handlers.get('gitbraid.scm.commitBranch')!('feat/a')
		assert.deepStrictEqual(calls.commitBranch, ['feat/a'])
	})

	test('commitBranch: BranchNode-like arg → extracts name from .entry', async () => {
		const { deps, calls } = makeDeps()
		const handlers = captureHandlers(() => registerScmCommands(deps))
		await handlers.get('gitbraid.scm.commitBranch')!({ entry: { name: 'feat/b' } })
		assert.deepStrictEqual(calls.commitBranch, ['feat/b'])
	})

	test('commitFromInputBox: SourceControlInputBox arg → resolves branch via manager', async () => {
		const { deps, calls } = makeDeps({ getBranchForInputBox: 'feat/c' })
		const handlers = captureHandlers(() => registerScmCommands(deps))
		// Pass a plain object with a `value` key — the shell tests `'value' in arg`.
		await handlers.get('gitbraid.scm.commitFromInputBox')!({ value: 'msg' })
		assert.deepStrictEqual(calls.commitBranch, ['feat/c'])
	})

	test('commitFromInputBox: no input box, no resolver result → bails', async () => {
		const { deps, calls } = makeDeps()
		const handlers = captureHandlers(() => registerScmCommands(deps))
		await handlers.get('gitbraid.scm.commitFromInputBox')!()
		assert.deepStrictEqual(calls.commitBranch, [])
	})

	test('commitAndPush / commitAndSync: cancelled resolver → no-op', async () => {
		const { deps, calls } = makeDeps()
		const handlers = captureHandlers(() => registerScmCommands(deps))
		await handlers.get('gitbraid.scm.commitAndPush')!()
		await handlers.get('gitbraid.scm.commitAndSync')!()
		assert.deepStrictEqual(calls.commitAndPush, [])
		assert.deepStrictEqual(calls.commitAndSync, [])
	})

	test('commitAndPush / commitAndSync: with resolved branch → drives manager', async () => {
		const { deps, calls } = makeDeps({ resolveBranchNameArg: async () => 'feat/a' })
		const handlers = captureHandlers(() => registerScmCommands(deps))
		await handlers.get('gitbraid.scm.commitAndPush')!()
		await handlers.get('gitbraid.scm.commitAndSync')!()
		assert.deepStrictEqual(calls.commitAndPush, ['feat/a'])
		assert.deepStrictEqual(calls.commitAndSync, ['feat/a'])
	})

	test('refreshAll: drives manager.refreshAll', async () => {
		const { deps, calls } = makeDeps()
		const handlers = captureHandlers(() => registerScmCommands(deps))
		await handlers.get('gitbraid.scm.refreshAll')!()
		assert.strictEqual(calls.refreshAll, 1)
	})

	test('pushBranch / pullBranch / syncBranch / stashBranch: cancelled resolver → no-op', async () => {
		const { deps, calls } = makeDeps()
		const handlers = captureHandlers(() => registerScmCommands(deps))
		await handlers.get('gitbraid.scm.pushBranch')!()
		await handlers.get('gitbraid.scm.pullBranch')!()
		await handlers.get('gitbraid.scm.syncBranch')!()
		await handlers.get('gitbraid.scm.stashBranch')!()
		assert.deepStrictEqual(calls.pushBranch, [])
		assert.deepStrictEqual(calls.pullBranch, [])
		assert.deepStrictEqual(calls.syncBranch, [])
		assert.deepStrictEqual(calls.stashBranch, [])
	})

	test('pushBranch / pullBranch / syncBranch / stashBranch: with resolved branch → drives manager', async () => {
		const { deps, calls } = makeDeps({ resolveBranchNameArg: async () => 'feat/a' })
		const handlers = captureHandlers(() => registerScmCommands(deps))
		await handlers.get('gitbraid.scm.pushBranch')!()
		await handlers.get('gitbraid.scm.pullBranch')!()
		await handlers.get('gitbraid.scm.syncBranch')!()
		await handlers.get('gitbraid.scm.stashBranch')!()
		assert.deepStrictEqual(calls.pushBranch, ['feat/a'])
		assert.deepStrictEqual(calls.pullBranch, ['feat/a'])
		assert.deepStrictEqual(calls.syncBranch, ['feat/a'])
		assert.deepStrictEqual(calls.stashBranch, ['feat/a'])
	})

	test('stageFile / unstageFile: no resourceUri → no-op', async () => {
		const { deps, calls } = makeDeps()
		const handlers = captureHandlers(() => registerScmCommands(deps))
		await handlers.get('gitbraid.scm.stageFile')!()
		await handlers.get('gitbraid.scm.unstageFile')!()
		await handlers.get('gitbraid.scm.stageFile')!({})
		await handlers.get('gitbraid.scm.unstageFile')!({})
		assert.deepStrictEqual(calls.stageFile, [])
		assert.deepStrictEqual(calls.unstageFile, [])
	})

	test('stageFile / unstageFile: with resourceUri → drives manager', async () => {
		const { deps, calls } = makeDeps()
		const handlers = captureHandlers(() => registerScmCommands(deps))
		const uri = vscode.Uri.file('/tmp/foo.ts')
		await handlers.get('gitbraid.scm.stageFile')!({ resourceUri: uri })
		await handlers.get('gitbraid.scm.unstageFile')!({ resourceUri: uri })
		assert.deepStrictEqual(calls.stageFile, [uri.fsPath])
		assert.deepStrictEqual(calls.unstageFile, [uri.fsPath])
	})

	test('stageAll / unstageAll: cancelled resolver → no-op', async () => {
		const { deps, calls } = makeDeps()
		const handlers = captureHandlers(() => registerScmCommands(deps))
		await handlers.get('gitbraid.scm.stageAll')!()
		await handlers.get('gitbraid.scm.unstageAll')!()
		assert.deepStrictEqual(calls.stageAll, [])
		assert.deepStrictEqual(calls.unstageAll, [])
	})

	test('stageAll / unstageAll: with resolved branch → drives manager', async () => {
		const { deps, calls } = makeDeps({ resolveBranchNameArg: async () => 'feat/a' })
		const handlers = captureHandlers(() => registerScmCommands(deps))
		await handlers.get('gitbraid.scm.stageAll')!()
		await handlers.get('gitbraid.scm.unstageAll')!()
		assert.deepStrictEqual(calls.stageAll, ['feat/a'])
		assert.deepStrictEqual(calls.unstageAll, ['feat/a'])
	})

	test('stageAllGroup / unstageAllGroup: no group → no-op', async () => {
		const { deps, calls } = makeDeps()
		const handlers = captureHandlers(() => registerScmCommands(deps))
		await handlers.get('gitbraid.scm.stageAllGroup')!()
		await handlers.get('gitbraid.scm.unstageAllGroup')!()
		await handlers.get('gitbraid.scm.stageAllGroup')!('not-an-object')
		await handlers.get('gitbraid.scm.unstageAllGroup')!('not-an-object')
		assert.deepStrictEqual(calls.stageAll, [])
		assert.deepStrictEqual(calls.unstageAll, [])
	})

	test('stageAllGroup / unstageAllGroup: group with no resolved branch → no-op', async () => {
		const { deps, calls } = makeDeps()
		const handlers = captureHandlers(() => registerScmCommands(deps))
		await handlers.get('gitbraid.scm.stageAllGroup')!({})
		await handlers.get('gitbraid.scm.unstageAllGroup')!({})
		assert.deepStrictEqual(calls.stageAll, [])
		assert.deepStrictEqual(calls.unstageAll, [])
	})

	test('stageAllGroup / unstageAllGroup: with resolved branch from group → drives manager', async () => {
		const { deps, calls } = makeDeps({ getBranchForGroup: 'feat/a' })
		const handlers = captureHandlers(() => registerScmCommands(deps))
		await handlers.get('gitbraid.scm.stageAllGroup')!({})
		await handlers.get('gitbraid.scm.unstageAllGroup')!({})
		assert.deepStrictEqual(calls.stageAll, ['feat/a'])
		assert.deepStrictEqual(calls.unstageAll, ['feat/a'])
	})

	test('generateCommitMessage: cancelled resolver → no-op', async () => {
		const { deps } = makeDeps()
		const handlers = captureHandlers(() => registerScmCommands(deps))
		await handlers.get('gitbraid.scm.generateCommitMessage')!()
	})

	test('generateCommitMessage: no worktree for branch → warning', async () => {
		const { deps } = makeDeps({
			resolveBranchNameArg: async () => 'feat/a',
			worktreeExists: false,
		})
		const handlers = captureHandlers(() => registerScmCommands(deps))
		let warned = false
		await withStubbedWindow(
			{ showWarningMessage: async () => { warned = true; return undefined } },
			async () => {
				await handlers.get('gitbraid.scm.generateCommitMessage')!()
			},
		)
		assert.ok(warned)
	})

	test('generateCommitMessage: no staged or unstaged changes → info, no LM call', async () => {
		const { deps } = makeDeps({ resolveBranchNameArg: async () => 'feat/a', worktreeExists: true })
		const runner = new FakeGitRunner()
		runner.fixture('diff --cached', { stdout: '' })
		runner.fixture('diff', { stdout: '' })
		setDefaultGitRunnerForTest(runner)
		let selectCalled = false
		const origSelect = vscode.lm.selectChatModels
		;(vscode.lm as unknown as { selectChatModels: unknown }).selectChatModels = async () => {
			selectCalled = true
			return []
		}
		try {
			const handlers = captureHandlers(() => registerScmCommands(deps))
			let infoMsg: string | undefined
			await withStubbedWindow(
				{ showInformationMessage: async (msg: string) => { infoMsg = msg; return undefined } },
				async () => {
					await handlers.get('gitbraid.scm.generateCommitMessage')!()
				},
			)
			assert.match(infoMsg ?? '', /No changes in "feat\/a"/)
			assert.strictEqual(selectCalled, false, 'must bail before ever checking for a language model')
		} finally {
			setDefaultGitRunnerForTest(undefined)
			;(vscode.lm as unknown as { selectChatModels: unknown }).selectChatModels = origSelect
		}
	})

	test('generateCommitMessage: no language model available → warning', async () => {
		const { deps } = makeDeps({ resolveBranchNameArg: async () => 'feat/a', worktreeExists: true })
		const runner = new FakeGitRunner()
		runner.fixture('diff --cached', { stdout: '+staged change\n' })
		setDefaultGitRunnerForTest(runner)
		const origSelect = vscode.lm.selectChatModels
		;(vscode.lm as unknown as { selectChatModels: unknown }).selectChatModels = async () => []
		try {
			const handlers = captureHandlers(() => registerScmCommands(deps))
			let warnMsg: string | undefined
			await withStubbedWindow(
				{ showWarningMessage: async (msg: string) => { warnMsg = msg; return undefined } },
				async () => {
					await handlers.get('gitbraid.scm.generateCommitMessage')!()
				},
			)
			assert.match(warnMsg ?? '', /No language model available/)
		} finally {
			setDefaultGitRunnerForTest(undefined)
			;(vscode.lm as unknown as { selectChatModels: unknown }).selectChatModels = origSelect
		}
	})

	test('generateCommitMessage: falls back to the unstaged diff when nothing is staged', async () => {
		const { deps } = makeDeps({ resolveBranchNameArg: async () => 'feat/a', worktreeExists: true })
		const runner = new FakeGitRunner()
		runner.fixture('diff --cached', { stdout: '' })
		runner.fixture('diff', { stdout: '+unstaged change\n' })
		setDefaultGitRunnerForTest(runner)
		let sentDiff: string | undefined
		const origSelect = vscode.lm.selectChatModels
		;(vscode.lm as unknown as { selectChatModels: unknown }).selectChatModels = async () => ([{
			sendRequest: async (messages: Array<{ content?: unknown }>) => {
				sentDiff = JSON.stringify(messages)
				return { text: (async function* () { yield 'chore: update' })() }
			},
		}] as unknown as vscode.LanguageModelChat[])
		try {
			const handlers = captureHandlers(() => registerScmCommands(deps))
			await handlers.get('gitbraid.scm.generateCommitMessage')!()
			assert.ok(sentDiff?.includes('unstaged change'))
		} finally {
			setDefaultGitRunnerForTest(undefined)
			;(vscode.lm as unknown as { selectChatModels: unknown }).selectChatModels = origSelect
		}
	})

	test('generateCommitMessage: full success path streams the response into the branch\'s input box', async () => {
		const { deps } = makeDeps({ resolveBranchNameArg: async () => 'feat/a', worktreeExists: true })
		const runner = new FakeGitRunner()
		runner.fixture('diff --cached', { stdout: '+staged change\n' })
		setDefaultGitRunnerForTest(runner)

		const origSelect = vscode.lm.selectChatModels
		;(vscode.lm as unknown as { selectChatModels: unknown }).selectChatModels = async () => ([{
			sendRequest: async () => ({
				text: (async function* () { yield 'feat: '; yield 'add the thing' })(),
			}),
		}] as unknown as vscode.LanguageModelChat[])

		let setValueArgs: [string, string] | undefined
		const ctx = deps.activeContext() as unknown as { scmManager: Record<string, unknown> }
		ctx.scmManager.setInputBoxValue = (branch: string, msg: string) => { setValueArgs = [branch, msg] }

		try {
			const handlers = captureHandlers(() => registerScmCommands(deps))
			await handlers.get('gitbraid.scm.generateCommitMessage')!()
			assert.deepStrictEqual(setValueArgs, ['feat/a', 'feat: add the thing'])
		} finally {
			setDefaultGitRunnerForTest(undefined)
			;(vscode.lm as unknown as { selectChatModels: unknown }).selectChatModels = origSelect
		}
	})
})
