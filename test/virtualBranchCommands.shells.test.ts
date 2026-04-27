/**
 * Direct-import shell tests for `src/commands/virtualBranchCommands.ts`.
 */
import * as assert from 'node:assert'
import * as vscode from 'vscode'
import { registerVirtualBranchCommands } from '../src/commands/virtualBranchCommands'
import { BranchNode, VirtualBranchNode } from '../src/branchStackTreeProvider'
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

interface State {
	stack: BranchStackEntry[]
	addCalls: Array<[string, string, string | undefined, { virtual?: boolean } | undefined]>
	materialiseCalls: string[]
	removeCalls: Array<[string, boolean | undefined]>
	virtualFiles: string[]
}

function makeDeps(opts: { stack?: BranchStackEntry[], virtualFiles?: string[] } = {}): {
	deps: CommandDeps
	state: State
} {
	const state: State = {
		stack: opts.stack ?? [],
		addCalls: [],
		materialiseCalls: [],
		removeCalls: [],
		virtualFiles: opts.virtualFiles ?? [],
	}
	const ctx = {
		root: vscode.Uri.file('/tmp/fake-repo'),
		config: {
			getStack: () => state.stack,
			getBranch: (n: string) => state.stack.find((e) => e.name === n),
		},
		branchStack: {
			addBranchToStack: async (
				name: string, base: string, color?: string,
				options?: { virtual?: boolean },
			) => {
				state.addCalls.push([name, base, color, options])
				state.stack.push(entry(name, state.stack.length + 1, {
					base, virtual: options?.virtual,
				}))
			},
			materialiseBranch: async (n: string) => { state.materialiseCalls.push(n) },
			removeBranchFromStack: async (n: string, force?: boolean) => {
				state.removeCalls.push([n, force])
			},
		},
		virtualStore: {
			listFiles: () => state.virtualFiles,
		},
	}
	const deps: CommandDeps = {
		registry: undefined as unknown as CommandDeps['registry'],
		primary: ctx as unknown as CommandDeps['primary'],
		activeContext: () => ctx as unknown as CommandDeps['primary'],
		contextForUri: () => ctx as unknown as CommandDeps['primary'],
		relativePathIn: (_c, u) => u.fsPath,
		resolveBranchNameArg: async () => undefined,
		resolveActiveBranchWorktree: async () => undefined,
		extractFileUri: () => undefined,
		stackTreeProvider: undefined as unknown as CommandDeps['stackTreeProvider'],
		stackView: undefined as unknown as CommandDeps['stackView'],
		statusBar: undefined as unknown as CommandDeps['statusBar'],
		prAwareness: undefined as unknown as CommandDeps['prAwareness'],
		overlayDiagnostics: undefined as unknown as CommandDeps['overlayDiagnostics'],
	}
	return { deps, state }
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

suite('virtualBranchCommands shell coverage (direct-import)', () => {

	test('addVirtualBranch: cancelled name input → no addCall', async () => {
		const { deps, state } = makeDeps()
		const handlers = captureHandlers(() => registerVirtualBranchCommands(deps))
		await withStubbedWindow(
			{ showInputBox: async () => undefined },
			async () => {
				await handlers.get('gitbraid.addVirtualBranch')!()
			},
		)
		assert.strictEqual(state.addCalls.length, 0)
	})

	test('addVirtualBranch: cancelled base picker → no addCall', async () => {
		const { deps, state } = makeDeps()
		const handlers = captureHandlers(() => registerVirtualBranchCommands(deps))
		await withStubbedWindow(
			{
				showInputBox: async () => 'feat/virt',
				showQuickPick: async () => undefined,
			},
			async () => {
				await handlers.get('gitbraid.addVirtualBranch')!()
			},
		)
		assert.strictEqual(state.addCalls.length, 0)
	})

	test('addVirtualBranch: happy path → adds with virtual:true flag', async () => {
		const { deps, state } = makeDeps()
		const handlers = captureHandlers(() => registerVirtualBranchCommands(deps))
		await withStubbedWindow(
			{
				showInputBox: async () => 'feat/virt',
				showQuickPick: async () => 'main',
				showInformationMessage: async () => undefined,
			},
			async () => {
				await handlers.get('gitbraid.addVirtualBranch')!()
			},
		)
		assert.strictEqual(state.addCalls.length, 1)
		const [name, base, _color, opts] = state.addCalls[0]
		assert.strictEqual(name, 'feat/virt')
		assert.strictEqual(base, 'main')
		assert.deepStrictEqual(opts, { virtual: true })
	})

	test('materialiseVirtualBranch: empty stack → info, no materialise call', async () => {
		const { deps, state } = makeDeps()
		const handlers = captureHandlers(() => registerVirtualBranchCommands(deps))
		await withStubbedWindow(
			{ showInformationMessage: async () => undefined },
			async () => {
				await handlers.get('gitbraid.materialiseVirtualBranch')!()
			},
		)
		assert.strictEqual(state.materialiseCalls.length, 0)
	})

	test('materialiseVirtualBranch: non-virtual branch name → error, no call', async () => {
		const stack = [entry('feat/a', 1, { virtual: false })]
		const { deps, state } = makeDeps({ stack })
		const handlers = captureHandlers(() => registerVirtualBranchCommands(deps))
		await withStubbedWindow(
			{ showErrorMessage: async () => undefined },
			async () => {
				await handlers.get('gitbraid.materialiseVirtualBranch')!('feat/a')
			},
		)
		assert.strictEqual(state.materialiseCalls.length, 0)
	})

	test('materialiseVirtualBranch: unknown branch name → error, no call', async () => {
		const { deps, state } = makeDeps()
		const handlers = captureHandlers(() => registerVirtualBranchCommands(deps))
		await withStubbedWindow(
			{ showErrorMessage: async () => undefined },
			async () => {
				await handlers.get('gitbraid.materialiseVirtualBranch')!('ghost')
			},
		)
		assert.strictEqual(state.materialiseCalls.length, 0)
	})

	test('materialiseVirtualBranch: single virtual branch → auto-selects + materialises', async () => {
		const stack = [entry('feat/v', 1, { virtual: true })]
		const { deps, state } = makeDeps({ stack })
		const handlers = captureHandlers(() => registerVirtualBranchCommands(deps))
		await withStubbedWindow(
			{ showInformationMessage: async () => undefined },
			async () => {
				await handlers.get('gitbraid.materialiseVirtualBranch')!()
			},
		)
		assert.deepStrictEqual(state.materialiseCalls, ['feat/v'])
	})

	test('materialiseVirtualBranch: multiple virtuals → picker selection drives call', async () => {
		const stack = [
			entry('feat/v1', 1, { virtual: true }),
			entry('feat/v2', 2, { virtual: true }),
		]
		const { deps, state } = makeDeps({ stack })
		const handlers = captureHandlers(() => registerVirtualBranchCommands(deps))
		await withStubbedWindow(
			{
				showQuickPick: async () => 'feat/v2',
				showInformationMessage: async () => undefined,
			},
			async () => {
				await handlers.get('gitbraid.materialiseVirtualBranch')!()
			},
		)
		assert.deepStrictEqual(state.materialiseCalls, ['feat/v2'])
	})

	test('materialiseVirtualBranch: VirtualBranchNode arg → resolves from .entry.name', async () => {
		const stack = [entry('feat/v', 1, { virtual: true })]
		const { deps, state } = makeDeps({ stack })
		const handlers = captureHandlers(() => registerVirtualBranchCommands(deps))
		await withStubbedWindow(
			{ showInformationMessage: async () => undefined },
			async () => {
				await handlers.get('gitbraid.materialiseVirtualBranch')!(new VirtualBranchNode(stack[0]))
			},
		)
		assert.deepStrictEqual(state.materialiseCalls, ['feat/v'])
	})

	test('materialiseVirtualBranch: BranchNode arg → resolves from .entry.name', async () => {
		const stack = [entry('feat/v', 1, { virtual: true })]
		const { deps, state } = makeDeps({ stack })
		const handlers = captureHandlers(() => registerVirtualBranchCommands(deps))
		await withStubbedWindow(
			{ showInformationMessage: async () => undefined },
			async () => {
				await handlers.get('gitbraid.materialiseVirtualBranch')!(new BranchNode(stack[0]))
			},
		)
		assert.deepStrictEqual(state.materialiseCalls, ['feat/v'])
	})

	test('discardVirtualBranch: empty stack → info, no remove call', async () => {
		const { deps, state } = makeDeps()
		const handlers = captureHandlers(() => registerVirtualBranchCommands(deps))
		await withStubbedWindow(
			{ showInformationMessage: async () => undefined },
			async () => {
				await handlers.get('gitbraid.discardVirtualBranch')!()
			},
		)
		assert.strictEqual(state.removeCalls.length, 0)
	})

	test('discardVirtualBranch: non-virtual branch name → error, no call', async () => {
		const stack = [entry('feat/a', 1)]
		const { deps, state } = makeDeps({ stack })
		const handlers = captureHandlers(() => registerVirtualBranchCommands(deps))
		await withStubbedWindow(
			{ showErrorMessage: async () => undefined },
			async () => {
				await handlers.get('gitbraid.discardVirtualBranch')!('feat/a')
			},
		)
		assert.strictEqual(state.removeCalls.length, 0)
	})

	test('discardVirtualBranch: dismissed confirm → no remove call', async () => {
		const stack = [entry('feat/v', 1, { virtual: true })]
		const { deps, state } = makeDeps({ stack, virtualFiles: ['foo.ts'] })
		const handlers = captureHandlers(() => registerVirtualBranchCommands(deps))
		await withStubbedWindow(
			{ showWarningMessage: async () => undefined },
			async () => {
				await handlers.get('gitbraid.discardVirtualBranch')!('feat/v')
			},
		)
		assert.strictEqual(state.removeCalls.length, 0)
	})

	test('discardVirtualBranch: confirmed → drives removeBranchFromStack with force=true', async () => {
		const stack = [entry('feat/v', 1, { virtual: true })]
		const { deps, state } = makeDeps({ stack })
		const handlers = captureHandlers(() => registerVirtualBranchCommands(deps))
		await withStubbedWindow(
			{
				showWarningMessage: async () => 'Discard',
				showInformationMessage: async () => undefined,
			},
			async () => {
				await handlers.get('gitbraid.discardVirtualBranch')!('feat/v')
			},
		)
		assert.deepStrictEqual(state.removeCalls, [['feat/v', true]])
	})
})
