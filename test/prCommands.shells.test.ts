/**
 * Direct-import shell tests for `src/commands/prCommands.ts`.
 *
 * These cover the early-exit code paths only (empty stack, dismissed
 * resolver, missing worktree, no PR adapter, etc.).  The "happy path" of
 * actually submitting a stack lives in `submitStackService.test.ts` and
 * doesn't need to be re-exercised here.
 */
import * as assert from 'node:assert'
import * as vscode from 'vscode'
import { registerPrCommands } from '../src/commands/prCommands'
import type { CommandDeps } from '../src/commands/types'
import type { BranchStackEntry } from '../src/configTypes'

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

function entry(name: string, order: number, extra: Partial<BranchStackEntry> = {}): BranchStackEntry {
	return { name, order, color: '#fff', base: 'main', ...extra }
}

function makeDeps(opts: {
	stack?: BranchStackEntry[]
	resolveBranchNameArg?: CommandDeps['resolveBranchNameArg']
	prAdapterName?: string
} = {}): { deps: CommandDeps, secrets: vscode.SecretStorage } {
	const ctx = {
		root: vscode.Uri.file('/tmp/fake-repo'),
		config: {
			getStack: () => opts.stack ?? [],
			getBranch: (n: string) => (opts.stack ?? []).find((e) => e.name === n),
			getAssignment: () => undefined,
			getAllAssignments: () => ({}),
			setSingleCommit: async () => undefined,
		},
		branchStack: {
			worktreeExists: () => false,
			getWorktreePath: () => vscode.Uri.file('/tmp/fake-repo/.worktrees/fake'),
		},
		buildSubmitStackService: async () => ({ submit: async () => [] }),
		getPRAdapter: async () => ({ name: opts.prAdapterName ?? 'none', getPR: async () => undefined }),
		invalidatePRAdapter: () => undefined,
	}
	const registry = {
		getAll: () => [ctx],
	}
	const deps: CommandDeps = {
		registry: registry as unknown as CommandDeps['registry'],
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
		prAwareness: {
			refresh: async () => undefined,
			getForBranch: () => undefined,
		} as unknown as CommandDeps['prAwareness'],
		overlayDiagnostics: undefined as unknown as CommandDeps['overlayDiagnostics'],
	}
	const stored = new Map<string, string>()
	const secrets = {
		get: async (k: string) => stored.get(k),
		store: async (k: string, v: string) => { stored.set(k, v) },
		delete: async (k: string) => { stored.delete(k) },
		onDidChange: () => ({ dispose: () => undefined }),
	} as unknown as vscode.SecretStorage
	return { deps, secrets }
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

suite('prCommands shell coverage (direct-import)', () => {

	test('submitStack: empty stack → info, no throw', async () => {
		const { deps, secrets } = makeDeps()
		const handlers = captureHandlers(() => registerPrCommands(deps, secrets))
		let infoed = false
		await withStubbedWindow(
			{ showInformationMessage: async () => { infoed = true; return undefined } },
			async () => {
				await handlers.get('gitbraid.submitStack')!()
			},
		)
		assert.ok(infoed)
	})

	test('openStackedPR: cancelled resolver → no-op (no openExternal call)', async () => {
		const { deps, secrets } = makeDeps()
		const handlers = captureHandlers(() => registerPrCommands(deps, secrets))
		let opened = false
		const orig = vscode.env.openExternal
		;(vscode.env as unknown as { openExternal: unknown }).openExternal = async () => { opened = true; return true }
		try {
			await handlers.get('gitbraid.openStackedPR')!()
		} finally {
			;(vscode.env as unknown as { openExternal: unknown }).openExternal = orig
		}
		assert.strictEqual(opened, false)
	})

	test('openStackedPR: branch with no PR → info, no throw', async () => {
		const stack = [entry('feat/a', 1)]
		const { deps, secrets } = makeDeps({ stack })
		const handlers = captureHandlers(() => registerPrCommands(deps, secrets))
		let infoed = false
		await withStubbedWindow(
			{ showInformationMessage: async () => { infoed = true; return undefined } },
			async () => {
				await handlers.get('gitbraid.openStackedPR')!('feat/a')
			},
		)
		assert.ok(infoed)
	})

	test('absorbHunks: no editor → info, no throw', async () => {
		const { deps, secrets } = makeDeps()
		const handlers = captureHandlers(() => registerPrCommands(deps, secrets))
		let infoed = false
		await withStubbedWindow(
			{ showInformationMessage: async () => { infoed = true; return undefined } },
			async () => {
				await handlers.get('gitbraid.absorbHunks')!()
			},
		)
		assert.ok(infoed)
	})

	test('mergeStack: empty stack → info, no throw', async () => {
		const { deps, secrets } = makeDeps()
		const handlers = captureHandlers(() => registerPrCommands(deps, secrets))
		let infoed = false
		await withStubbedWindow(
			{ showInformationMessage: async () => { infoed = true; return undefined } },
			async () => {
				await handlers.get('gitbraid.mergeStack')!()
			},
		)
		assert.ok(infoed)
	})

	test('mergeStack: stack present but no PR host configured → warning', async () => {
		const stack = [entry('feat/a', 1)]
		const { deps, secrets } = makeDeps({ stack, prAdapterName: 'none' })
		const handlers = captureHandlers(() => registerPrCommands(deps, secrets))
		let warned = false
		await withStubbedWindow(
			{ showWarningMessage: async () => { warned = true; return undefined } },
			async () => {
				await handlers.get('gitbraid.mergeStack')!()
			},
		)
		assert.ok(warned)
	})

	test('toggleSingleCommitMode: cancelled resolver → no-op', async () => {
		const { deps, secrets } = makeDeps()
		const handlers = captureHandlers(() => registerPrCommands(deps, secrets))
		await handlers.get('gitbraid.toggleSingleCommitMode')!()
	})

	test('toggleSingleCommitMode: unknown branch → no-op', async () => {
		const { deps, secrets } = makeDeps({ stack: [], resolveBranchNameArg: async () => 'ghost' })
		const handlers = captureHandlers(() => registerPrCommands(deps, secrets))
		await handlers.get('gitbraid.toggleSingleCommitMode')!()
	})

	test('toggleSingleCommitMode: with branch → flips and shows info', async () => {
		const stack = [entry('feat/a', 1, { singleCommit: false })]
		const { deps, secrets } = makeDeps({ stack })
		const handlers = captureHandlers(() => registerPrCommands(deps, secrets))
		let infoed = false
		await withStubbedWindow(
			{ showInformationMessage: async () => { infoed = true; return undefined } },
			async () => {
				await handlers.get('gitbraid.toggleSingleCommitMode')!('feat/a')
			},
		)
		assert.ok(infoed)
	})

	test('setGithubToken: cancelled host picker → no-op', async () => {
		const { deps, secrets } = makeDeps()
		const handlers = captureHandlers(() => registerPrCommands(deps, secrets))
		await withStubbedWindow(
			{ showQuickPick: async () => undefined },
			async () => {
				await handlers.get('gitbraid.setGithubToken')!()
			},
		)
	})

	test('setGithubToken: cancelled token input → no-op', async () => {
		const { deps, secrets } = makeDeps()
		const handlers = captureHandlers(() => registerPrCommands(deps, secrets))
		await withStubbedWindow(
			{
				showQuickPick: async () => ({ id: 'github', label: 'GitHub', description: 'foo' }),
				showInputBox: async () => undefined,
			},
			async () => {
				await handlers.get('gitbraid.setGithubToken')!()
			},
		)
	})

	test('setGithubToken: empty token clears existing secret', async () => {
		const { deps, secrets } = makeDeps()
		await secrets.store('gitbraid.githubToken', 'old-value')
		const handlers = captureHandlers(() => registerPrCommands(deps, secrets))
		await withStubbedWindow(
			{
				showQuickPick: async () => ({ id: 'github', label: 'GitHub', description: 'foo' }),
				showInputBox: async () => '',
				showInformationMessage: async () => undefined,
			},
			async () => {
				await handlers.get('gitbraid.setGithubToken')!()
			},
		)
		assert.strictEqual(await secrets.get('gitbraid.githubToken'), undefined)
	})

	test('setGithubToken: stores token for selected host', async () => {
		const { deps, secrets } = makeDeps()
		const handlers = captureHandlers(() => registerPrCommands(deps, secrets))
		await withStubbedWindow(
			{
				showQuickPick: async () => ({ id: 'gitlab', label: 'GitLab', description: 'foo' }),
				showInputBox: async () => 'glpat-xyz',
				showInformationMessage: async () => undefined,
			},
			async () => {
				await handlers.get('gitbraid.setGithubToken')!()
			},
		)
		assert.strictEqual(await secrets.get('gitbraid.gitlabToken'), 'glpat-xyz')
	})

	test('showUndoLog: runs without throwing on empty log', async () => {
		const { deps, secrets } = makeDeps()
		const handlers = captureHandlers(() => registerPrCommands(deps, secrets))
		await withStubbedWindow(
			{ showInformationMessage: async () => undefined, showQuickPick: async () => undefined },
			async () => {
				await handlers.get('gitbraid.showUndoLog')!()
			},
		)
	})
})
