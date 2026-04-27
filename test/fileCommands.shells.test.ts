/**
 * Direct-import shell tests for `src/commands/fileCommands.ts`.
 *
 * Captures the handlers registered by `registerFileCommands(deps)` via a
 * stubbed `vscode.commands.registerCommand` so c8 records line-level
 * coverage on the source module — driving the bundled `dist/extension.js`
 * via `executeCommand` does not.
 */
import * as assert from 'node:assert'
import * as vscode from 'vscode'
import { registerFileCommands } from '../src/commands/fileCommands'
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
	try {
		register()
	} finally {
		;(vscode.commands as unknown as { registerCommand: unknown }).registerCommand = orig
	}
	return handlers
}

interface DepsState {
	stack: BranchStackEntry[]
	assignments: Record<string, string>
	worktreeExists: boolean
	setAssignmentCalls: Array<[string, string]>
	removeAssignmentCalls: string[]
}

function entry(name: string, order: number): BranchStackEntry {
	return { name, order, color: '#fff', base: 'main' }
}

function makeDeps(overrides: Partial<DepsState & {
	extractFileUri: CommandDeps['extractFileUri']
}> = {}): { deps: CommandDeps, state: DepsState } {
	const state: DepsState = {
		stack: overrides.stack ?? [],
		assignments: overrides.assignments ?? {},
		worktreeExists: overrides.worktreeExists ?? false,
		setAssignmentCalls: [],
		removeAssignmentCalls: [],
	}
	const ctx = {
		root: vscode.Uri.file('/tmp/fake-repo'),
		config: {
			getStack: () => state.stack,
			getAllAssignments: () => state.assignments,
			getBranch: (name: string) => state.stack.find((e) => e.name === name),
			getAssignment: (rel: string) => state.assignments[rel],
			setAssignment: async (rel: string, branch: string) => {
				state.setAssignmentCalls.push([rel, branch])
				state.assignments[rel] = branch
			},
			removeAssignment: async (rel: string) => {
				state.removeAssignmentCalls.push(rel)
				delete state.assignments[rel]
			},
		},
		branchStack: {
			worktreeExists: () => state.worktreeExists,
			getWorktreePath: () => vscode.Uri.file('/tmp/fake-repo/.worktrees/fake'),
		},
		undoStack: { push: (_op: unknown) => { /* no-op */ } },
	}
	const deps: CommandDeps = {
		registry: undefined as unknown as CommandDeps['registry'],
		primary: ctx as unknown as CommandDeps['primary'],
		activeContext: () => ctx as unknown as CommandDeps['primary'],
		contextForUri: () => ctx as unknown as CommandDeps['primary'],
		relativePathIn: (_c, u) => u.fsPath.replace(/^\/tmp\/fake-repo\//, ''),
		resolveBranchNameArg: async () => undefined,
		resolveActiveBranchWorktree: async () => undefined,
		extractFileUri: overrides.extractFileUri ?? (() => undefined),
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
	try {
		await fn()
	} finally {
		for (const [key, value] of Object.entries(originals)) {
			win[key] = value
		}
	}
}

suite('fileCommands shell coverage (direct-import)', () => {

	test('assignFile: no editor and no arg → warning, no throw', async () => {
		const { deps } = makeDeps()
		const handlers = captureHandlers(() => registerFileCommands(deps))
		let warned = false
		await withStubbedWindow(
			{ showWarningMessage: async () => { warned = true; return undefined } },
			async () => {
				await handlers.get('gitbraid.assignFile')!()
			},
		)
		assert.ok(warned)
	})

	test('assignFile: empty stack with real file URI → warning', async () => {
		const { deps } = makeDeps()
		const handlers = captureHandlers(() => registerFileCommands(deps))
		// Use a real file so vscode.workspace.fs.stat resolves without us
		// having to monkey-patch its read-only property.
		const fs = await import('node:fs')
		const path = await import('node:path')
		const os = await import('node:os')
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitbraid-fc-shell-'))
		const fakeFile = path.join(dir, 'foo.ts')
		fs.writeFileSync(fakeFile, 'x')
		try {
			let warned = false
			await withStubbedWindow(
				{ showWarningMessage: async () => { warned = true; return undefined } },
				async () => {
					await handlers.get('gitbraid.assignFile')!(vscode.Uri.file(fakeFile))
				},
			)
			assert.ok(warned, 'expected "no branches" warning')
		} finally {
			fs.rmSync(dir, { recursive: true, force: true })
		}
	})

	test('assignFolder: delegates to gitbraid.assignFile', async () => {
		const { deps } = makeDeps()
		const handlers = captureHandlers(() => registerFileCommands(deps))
		// We can't easily intercept executeCommand here, so just check that
		// invocation does not throw — the delegation itself is exercised.
		const orig = vscode.commands.executeCommand
		let delegated = false
		;(vscode.commands as unknown as { executeCommand: unknown }).executeCommand = async (cmd: string) => {
			if (cmd === 'gitbraid.assignFile') delegated = true
		}
		try {
			await handlers.get('gitbraid.assignFolder')!()
		} finally {
			;(vscode.commands as unknown as { executeCommand: unknown }).executeCommand = orig
		}
		assert.ok(delegated, 'assignFolder should delegate to assignFile')
	})

	test('unassignFile: no editor, no arg → warning, no throw', async () => {
		const { deps } = makeDeps()
		const handlers = captureHandlers(() => registerFileCommands(deps))
		let warned = false
		await withStubbedWindow(
			{ showWarningMessage: async () => { warned = true; return undefined } },
			async () => {
				await handlers.get('gitbraid.unassignFile')!()
			},
		)
		assert.ok(warned)
	})

	test('copyToWorktree: no node and no editor → no-op (no picker shown)', async () => {
		const { deps } = makeDeps()
		const handlers = captureHandlers(() => registerFileCommands(deps))
		let pickerShown = false
		await withStubbedWindow(
			{ showQuickPick: async () => { pickerShown = true; return undefined } },
			async () => {
				await handlers.get('gitbraid.copyToWorktree')!()
			},
		)
		assert.strictEqual(pickerShown, false)
	})

	test('moveToWorktree: no node and no editor → no-op', async () => {
		const { deps } = makeDeps()
		const handlers = captureHandlers(() => registerFileCommands(deps))
		let pickerShown = false
		await withStubbedWindow(
			{ showQuickPick: async () => { pickerShown = true; return undefined } },
			async () => {
				await handlers.get('gitbraid.moveToWorktree')!()
			},
		)
		assert.strictEqual(pickerShown, false)
	})

	test('assignGlob: empty stack → warning, no throw', async () => {
		const { deps } = makeDeps()
		const handlers = captureHandlers(() => registerFileCommands(deps))
		let warned = false
		await withStubbedWindow(
			{ showWarningMessage: async () => { warned = true; return undefined } },
			async () => {
				await handlers.get('gitbraid.assignGlob')!()
			},
		)
		assert.ok(warned)
	})

	test('assignGlob: cancelled pattern input → no-op, no picker', async () => {
		const stack = [entry('feat/a', 1)]
		const { deps } = makeDeps({ stack })
		const handlers = captureHandlers(() => registerFileCommands(deps))
		let pickerShown = false
		await withStubbedWindow(
			{
				showInputBox: async () => undefined,
				showQuickPick: async () => { pickerShown = true; return undefined },
			},
			async () => {
				await handlers.get('gitbraid.assignGlob')!()
			},
		)
		assert.strictEqual(pickerShown, false)
	})

	test('assignGlob: cancelled branch picker after pattern → no findFiles call', async () => {
		const stack = [entry('feat/a', 1)]
		const { deps } = makeDeps({ stack })
		let findCalled = false
		const origFind = vscode.workspace.findFiles
		;(vscode.workspace as unknown as { findFiles: unknown }).findFiles = async () => {
			findCalled = true
			return []
		}
		try {
			const handlers = captureHandlers(() => registerFileCommands(deps))
			await withStubbedWindow(
				{
					showInputBox: async () => 'src/**',
					showQuickPick: async () => undefined,
				},
				async () => {
					await handlers.get('gitbraid.assignGlob')!()
				},
			)
		} finally {
			;(vscode.workspace as unknown as { findFiles: unknown }).findFiles = origFind
		}
		assert.strictEqual(findCalled, false)
	})

	test('assignGlob: pattern with no matches → info, no throw', async () => {
		const stack = [entry('feat/a', 1)]
		const { deps } = makeDeps({ stack })
		const origFind = vscode.workspace.findFiles
		;(vscode.workspace as unknown as { findFiles: unknown }).findFiles = async () => []
		try {
			const handlers = captureHandlers(() => registerFileCommands(deps))
			let infoed = false
			await withStubbedWindow(
				{
					showInputBox: async () => 'no-such-pattern/**',
					showQuickPick: async () => 'feat/a',
					showInformationMessage: async () => { infoed = true; return undefined },
				},
				async () => {
					await handlers.get('gitbraid.assignGlob')!()
				},
			)
			assert.ok(infoed)
		} finally {
			;(vscode.workspace as unknown as { findFiles: unknown }).findFiles = origFind
		}
	})
})
