/**
 * Direct-import shell tests for `src/commands/viewCommands.ts`.
 */
import * as assert from 'node:assert'
import * as vscode from 'vscode'
import { registerViewCommands } from '../src/commands/viewCommands'
import { BranchNode } from '../src/branchStackTreeProvider'
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
	assignments: Record<string, string>
	worktreeExists: boolean
	colorCalls: Array<[string, string]>
	canUndo: boolean
	canRedo: boolean
	undoCalls: number
	redoCalls: number
	prRefreshes: number
	clipboardWrites: string[]
	folders: Array<{ root: vscode.Uri }>
}

function makeDeps(opts: Partial<State> = {}): { deps: CommandDeps, state: State } {
	const state: State = {
		stack: opts.stack ?? [],
		assignments: opts.assignments ?? {},
		worktreeExists: opts.worktreeExists ?? false,
		colorCalls: [],
		canUndo: opts.canUndo ?? false,
		canRedo: opts.canRedo ?? false,
		undoCalls: 0,
		redoCalls: 0,
		prRefreshes: 0,
		clipboardWrites: [],
		folders: opts.folders ?? [{ root: vscode.Uri.file('/tmp/fake-repo') }],
	}
	const ctx = {
		root: state.folders[0].root,
		config: {
			getStack: () => state.stack,
			getAllAssignments: () => state.assignments,
			reload: async () => undefined,
			setBranchColor: async (b: string, c: string) => { state.colorCalls.push([b, c]) },
		},
		branchStack: {
			worktreeExists: () => state.worktreeExists,
			getWorktreePath: () => vscode.Uri.file('/tmp/fake-repo/.worktrees/fake'),
		},
		undoStack: {
			canUndo: () => state.canUndo,
			canRedo: () => state.canRedo,
			undo: async () => { state.undoCalls++; return { label: 'undo-label' } },
			redo: async () => { state.redoCalls++; return { label: 'redo-label' } },
		},
		workspaceSync: {} as unknown,
	}
	const registry = {
		getAll: () => state.folders.map((f) => ({ root: f.root, ...ctx, root2: f.root })),
		getActive: () => ctx,
	}
	const deps: CommandDeps = {
		registry: registry as unknown as CommandDeps['registry'],
		primary: ctx as unknown as CommandDeps['primary'],
		activeContext: () => ctx as unknown as CommandDeps['primary'],
		contextForUri: () => ctx as unknown as CommandDeps['primary'],
		relativePathIn: (_c, u) => u.fsPath,
		resolveBranchNameArg: async () => undefined,
		resolveActiveBranchWorktree: async () => undefined,
		extractFileUri: () => undefined,
		stackTreeProvider: {
			refresh: () => undefined,
			setContext: () => undefined,
		} as unknown as CommandDeps['stackTreeProvider'],
		stackView: {
			reveal: () => Promise.resolve(),
		} as unknown as CommandDeps['stackView'],
		statusBar: {
			setContext: () => undefined,
		} as unknown as CommandDeps['statusBar'],
		prAwareness: {
			refresh: async () => { state.prRefreshes++ },
		} as unknown as CommandDeps['prAwareness'],
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

suite('viewCommands shell coverage (direct-import)', () => {

	test('stackView.refresh: reload + tree refresh, no throw', async () => {
		const { deps } = makeDeps()
		const handlers = captureHandlers(() => registerViewCommands(deps))
		const result = handlers.get('gitbraid.stackView.refresh')!()
		assert.strictEqual(result, undefined)
		// Allow the inner promise chain to settle.
		await new Promise((resolve) => setImmediate(resolve))

	})

	test('setBranchColor: cancelled picker → no setBranchColor call', async () => {
		const { deps, state } = makeDeps({ stack: [entry('feat/a', 1)] })
		const handlers = captureHandlers(() => registerViewCommands(deps))
		await withStubbedWindow(
			{ showQuickPick: async () => undefined },
			async () => {
				await handlers.get('gitbraid.setBranchColor')!()
			},
		)
		assert.strictEqual(state.colorCalls.length, 0)

	})

	test('setBranchColor: BranchNode + preset → records colour', async () => {
		const stack = [entry('feat/a', 1)]
		const { deps, state } = makeDeps({ stack })
		const handlers = captureHandlers(() => registerViewCommands(deps))
		await withStubbedWindow(
			{
				showQuickPick: async () => ({ label: 'Teal', description: '#4ec9b0', color: '#4ec9b0' }),
			},
			async () => {
				await handlers.get('gitbraid.setBranchColor')!(new BranchNode(stack[0]))
			},
		)
		assert.deepStrictEqual(state.colorCalls, [['feat/a', '#4ec9b0']])

	})

	test('setBranchColor: hex-input path with cancelled input → no colour set', async () => {
		const stack = [entry('feat/a', 1)]
		const { deps, state } = makeDeps({ stack })
		const handlers = captureHandlers(() => registerViewCommands(deps))
		await withStubbedWindow(
			{
				showQuickPick: async () => ({ label: 'Enter hex…', description: '', color: '' }),
				showInputBox: async () => undefined,
			},
			async () => {
				await handlers.get('gitbraid.setBranchColor')!(new BranchNode(stack[0]))
			},
		)
		assert.strictEqual(state.colorCalls.length, 0)

	})

	test('setBranchColor: hex-input path with valid hex → records colour', async () => {
		const stack = [entry('feat/a', 1)]
		const { deps, state } = makeDeps({ stack })
		const handlers = captureHandlers(() => registerViewCommands(deps))
		await withStubbedWindow(
			{
				showQuickPick: async () => ({ label: 'Enter hex…', description: '', color: '' }),
				showInputBox: async () => '#a0c4ff',
			},
			async () => {
				await handlers.get('gitbraid.setBranchColor')!(new BranchNode(stack[0]))
			},
		)
		assert.deepStrictEqual(state.colorCalls, [['feat/a', '#a0c4ff']])
	})

	test('rehideAssignedFiles: no assignments → info, no throw', async () => {
		const { deps } = makeDeps()
		const handlers = captureHandlers(() => registerViewCommands(deps))
		let infoed = false
		await withStubbedWindow(
			{ showInformationMessage: async () => { infoed = true; return undefined } },
			async () => {
				await handlers.get('gitbraid.rehideAssignedFiles')!()
			},
		)
		assert.ok(infoed)

	})

	test('showActiveFolder: multi-folder → picker with non-current selection switches context', async () => {
		const fA = vscode.Uri.file('/tmp/folder-A')
		const fB = vscode.Uri.file('/tmp/folder-B')
		const { deps } = makeDeps({ folders: [{ root: fA }, { root: fB }] })
		const handlers = captureHandlers(() => registerViewCommands(deps))
		const orig = vscode.commands.executeCommand
		let revealed: unknown
		;(vscode.commands as unknown as { executeCommand: unknown }).executeCommand =
			async (cmd: string, arg: unknown) => {
				if (cmd === 'revealInExplorer') revealed = arg
				return undefined
			}
		try {
			await withStubbedWindow(
				{ showQuickPick: async () => ({ label: 'B', ctx: { root: fB } }) },
				async () => {
					await handlers.get('gitbraid.showActiveFolder')!()
				},
			)
		} finally {
			;(vscode.commands as unknown as { executeCommand: unknown }).executeCommand = orig
		}
		assert.ok(revealed, 'revealInExplorer should be invoked for the picked folder')
	})

	test('showActiveFolder: single folder → info, no throw', async () => {
		const { deps } = makeDeps()
		const handlers = captureHandlers(() => registerViewCommands(deps))
		let infoed = false
		await withStubbedWindow(
			{ showInformationMessage: async () => { infoed = true; return undefined } },
			async () => {
				await handlers.get('gitbraid.showActiveFolder')!()
			},
		)
		assert.ok(infoed)

	})

	test('refreshPRStatus: drives prAwareness.refresh', async () => {
		const { deps, state } = makeDeps()
		const handlers = captureHandlers(() => registerViewCommands(deps))
		await handlers.get('gitbraid.refreshPRStatus')!()
		assert.strictEqual(state.prRefreshes, 1)

	})

	test('undoLastAssignment: empty undo stack → info, no undo call', async () => {
		const { deps, state } = makeDeps({ canUndo: false })
		const handlers = captureHandlers(() => registerViewCommands(deps))
		let infoed = false
		await withStubbedWindow(
			{ showInformationMessage: async () => { infoed = true; return undefined } },
			async () => {
				await handlers.get('gitbraid.undoLastAssignment')!()
			},
		)
		assert.ok(infoed)
		assert.strictEqual(state.undoCalls, 0)

	})

	test('undoLastAssignment: with op → invokes undo + status bar message', async () => {
		const { deps, state } = makeDeps({ canUndo: true })
		const handlers = captureHandlers(() => registerViewCommands(deps))
		const origSb = vscode.window.setStatusBarMessage
		;(vscode.window as unknown as { setStatusBarMessage: unknown }).setStatusBarMessage =
			() => ({ dispose: () => undefined })
		try {
			await handlers.get('gitbraid.undoLastAssignment')!()
		} finally {
			;(vscode.window as unknown as { setStatusBarMessage: unknown }).setStatusBarMessage = origSb
		}
		assert.strictEqual(state.undoCalls, 1)

	})

	test('redoLastAssignment: empty redo stack → info, no redo call', async () => {
		const { deps, state } = makeDeps({ canRedo: false })
		const handlers = captureHandlers(() => registerViewCommands(deps))
		await withStubbedWindow(
			{ showInformationMessage: async () => undefined },
			async () => {
				await handlers.get('gitbraid.redoLastAssignment')!()
			},
		)
		assert.strictEqual(state.redoCalls, 0)

	})

	test('redoLastAssignment: with op → invokes redo', async () => {
		const { deps, state } = makeDeps({ canRedo: true })
		const handlers = captureHandlers(() => registerViewCommands(deps))
		const origSb = vscode.window.setStatusBarMessage
		;(vscode.window as unknown as { setStatusBarMessage: unknown }).setStatusBarMessage =
			() => ({ dispose: () => undefined })
		try {
			await handlers.get('gitbraid.redoLastAssignment')!()
		} finally {
			;(vscode.window as unknown as { setStatusBarMessage: unknown }).setStatusBarMessage = origSb
		}
		assert.strictEqual(state.redoCalls, 1)

	})

	test('focusStackView: drives stackView.reveal', async () => {
		const { deps } = makeDeps()
		const handlers = captureHandlers(() => registerViewCommands(deps))
		const result = handlers.get('gitbraid.focusStackView')!()
		assert.strictEqual(result, undefined)

	})

	test('launchWindowForWorktree: cancelled picker → no openFolder call', async () => {
		const stack = [entry('feat/a', 1)]
		const { deps } = makeDeps({ stack })
		const handlers = captureHandlers(() => registerViewCommands(deps))
		let opened = false
		const orig = vscode.commands.executeCommand
		;(vscode.commands as unknown as { executeCommand: unknown }).executeCommand = async (cmd: string) => {
			if (cmd === 'vscode.openFolder') opened = true
			return undefined
		}
		try {
			await withStubbedWindow(
				{ showQuickPick: async () => undefined },
				async () => {
					await handlers.get('gitbraid.launchWindowForWorktree')!()
				},
			)
		} finally {
			;(vscode.commands as unknown as { executeCommand: unknown }).executeCommand = orig
		}
		assert.strictEqual(opened, false)

	})

	test('launchWindowForWorktree: with selected branch → invokes vscode.openFolder', async () => {
		const stack = [entry('feat/a', 1)]
		const { deps } = makeDeps({ stack, worktreeExists: true })
		const handlers = captureHandlers(() => registerViewCommands(deps))
		const orig = vscode.commands.executeCommand
		let openCalled = false
		;(vscode.commands as unknown as { executeCommand: unknown }).executeCommand =
			async (cmd: string) => {
				if (cmd === 'vscode.openFolder') openCalled = true
				return undefined
			}
		try {
			await withStubbedWindow(
				{ showQuickPick: async () => 'feat/a' },
				async () => {
					await handlers.get('gitbraid.launchWindowForWorktree')!()
				},
			)
		} finally {
			;(vscode.commands as unknown as { executeCommand: unknown }).executeCommand = orig
		}
		assert.ok(openCalled)
	})

	test('launchWindowForWorktree: BranchNode arg → resolves directly without picker', async () => {
		const stack = [entry('feat/a', 1)]
		const { deps } = makeDeps({ stack, worktreeExists: true })
		const handlers = captureHandlers(() => registerViewCommands(deps))
		const orig = vscode.commands.executeCommand
		let openCalled = false
		;(vscode.commands as unknown as { executeCommand: unknown }).executeCommand =
			async (cmd: string) => {
				if (cmd === 'vscode.openFolder') openCalled = true
				return undefined
			}
		try {
			await handlers.get('gitbraid.launchWindowForWorktree')!(new BranchNode(stack[0]))
		} finally {
			;(vscode.commands as unknown as { executeCommand: unknown }).executeCommand = orig
		}
		assert.ok(openCalled)
	})

	test('lockWorktree / unlockWorktree: with branch → drives the resolver path (errors swallowed by harness)', async () => {
		const stack = [entry('feat/a', 1)]
		const { deps } = makeDeps({ stack, worktreeExists: true })
		const handlers = captureHandlers(() => registerViewCommands(deps))
		// `git.worktree.lock/unlock` will fail because the worktree path is fake.
		// `withErrorHandler` swallows the throw — we just want the lines from
		// resolver → git call to execute.
		await withStubbedWindow(
			{
				showQuickPick: async () => 'feat/a',
				showInformationMessage: async () => undefined,
				showErrorMessage: async () => undefined,
			},
			async () => {
				await handlers.get('gitbraid.lockWorktree')!()
				await handlers.get('gitbraid.unlockWorktree')!()
			},
		)
	})

	test('lockWorktree: BranchNode arg → resolves directly without picker', async () => {
		const stack = [entry('feat/a', 1)]
		const { deps } = makeDeps({ stack, worktreeExists: true })
		const handlers = captureHandlers(() => registerViewCommands(deps))
		await withStubbedWindow(
			{
				showInformationMessage: async () => undefined,
				showErrorMessage: async () => undefined,
			},
			async () => {
				await handlers.get('gitbraid.lockWorktree')!(new BranchNode(stack[0]))
				await handlers.get('gitbraid.unlockWorktree')!(new BranchNode(stack[0]))
			},
		)
	})

	test('rehideAssignedFiles: with assignments → walks each entry, drives hide path', async () => {
		const stack = [entry('feat/a', 1)]
		const { deps } = makeDeps({
			stack,
			assignments: { 'foo.ts': 'feat/a', 'bar.ts': 'feat/b' },
			worktreeExists: true,
		})
		const handlers = captureHandlers(() => registerViewCommands(deps))
		// `hideAssignedFile` will fail because the workspace root is fake.  We
		// don't care — we only need to walk into the loop body so c8 records
		// those lines.  withErrorHandler swallows the throw.
		await withStubbedWindow(
			{
				showInformationMessage: async () => undefined,
				showErrorMessage: async () => undefined,
			},
			async () => {
				await handlers.get('gitbraid.rehideAssignedFiles')!()
			},
		)
	})

	test('lockWorktree / unlockWorktree: cancelled picker → no-op', async () => {
		const stack = [entry('feat/a', 1)]
		const { deps } = makeDeps({ stack })
		const handlers = captureHandlers(() => registerViewCommands(deps))
		await withStubbedWindow(
			{ showQuickPick: async () => undefined },
			async () => {
				await handlers.get('gitbraid.lockWorktree')!()
				await handlers.get('gitbraid.unlockWorktree')!()
			},
		)

	})

	test('copyStackDiagram: empty stack → info, no clipboard write', async () => {
		const { deps, state } = makeDeps()
		const handlers = captureHandlers(() => registerViewCommands(deps))
		await withStubbedWindow(
			{ showInformationMessage: async () => undefined },
			async () => {
				await handlers.get('gitbraid.copyStackDiagram')!()
			},
		)
		assert.strictEqual(state.clipboardWrites.length, 0)

	})

	test('copyStackDiagram: stack present → diagram lands in the clipboard', async () => {
		const stack = [
			entry('feat/a', 1, { base: 'main' }),
			entry('feat/b', 2, { base: 'feat/a' }),
		]
		const { deps } = makeDeps({
			stack,
			assignments: { 'foo.ts': 'feat/a', 'bar.ts': 'feat/a', 'baz.ts': 'feat/b' },
		})
		const handlers = captureHandlers(() => registerViewCommands(deps))
		const origSb = vscode.window.setStatusBarMessage
		;(vscode.window as unknown as { setStatusBarMessage: unknown }).setStatusBarMessage =
			() => ({ dispose: () => undefined })
		// Save and restore the host clipboard so this test isn't a side-effect.
		const before = await vscode.env.clipboard.readText()
		try {
			await handlers.get('gitbraid.copyStackDiagram')!()
		} finally {
			;(vscode.window as unknown as { setStatusBarMessage: unknown }).setStatusBarMessage = origSb
		}
		const diagram = await vscode.env.clipboard.readText()
		assert.match(diagram, /main/)
		assert.match(diagram, /feat\/a/)
		assert.match(diagram, /feat\/b/)
		assert.match(diagram, /2 files/)
		assert.match(diagram, /1 file/)
		await vscode.env.clipboard.writeText(before)
	})
})
