/**
 * Direct-import shell tests for `src/commands/branchCommands.ts`.
 *
 * These complement the `extension.test.ts` end-to-end tests by importing
 * `registerBranchCommands` directly and invoking each registered handler in
 * isolation.  The bundled `dist/extension.js` doesn't surface fine-grained
 * source-map ranges back to c8, so coverage from `vscode.commands.execute
 * Command(...)` only counts the import + signature lines of the shell.
 * Calling the handlers through a captured registry on the source module
 * lets c8 record every branch the shell exercises (warning-on-empty-stack,
 * cancelled-picker, etc.).
 *
 * The tests deliberately avoid driving real git operations — every branch
 * here is the early-exit / warn path that the user hits when the stack is
 * empty or they cancel a prompt.  Drives roughly half of the shell.
 */
import * as assert from 'node:assert'
import * as vscode from 'vscode'
import { registerBranchCommands } from '../src/commands/branchCommands'
import { BranchNode } from '../src/branchStackTreeProvider'
import { git } from '../src/gitFunctions'
import type { CommandDeps } from '../src/commands/types'
import type { BranchStackEntry } from '../src/configTypes'

// ─── Test helpers ────────────────────────────────────────────────────────────

type Handler = (...args: unknown[]) => unknown

/**
 * Stubs `vscode.commands.registerCommand` so calls into
 * `registerBranchCommands(deps)` capture the handler functions instead of
 * registering them with VS Code (which would clash with the live extension).
 */
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

/**
 * Build a minimal `CommandDeps` that drives the early-exit code paths of
 * branchCommands.  Tests that need richer behaviour can override individual
 * fields.
 */
function makeDeps(overrides: Partial<DepsState> = {}): CommandDeps {
	const state: DepsState = {
		stack: overrides.stack ?? [],
		assignments: overrides.assignments ?? {},
		worktreeExists: overrides.worktreeExists ?? false,
		setScratchCalls: [],
		reorderCalls: [],
		commitTemplateCalls: [],
		removeBranchCalls: [],
		addBranchCalls: [],
	}
	const ctx = {
		root: vscode.Uri.file('/tmp/fake-repo'),
		config: {
			getStack: () => state.stack,
			getAllAssignments: () => state.assignments,
			getBranch: (name: string) => state.stack.find((e) => e.name === name),
			reorderStack: async (names: string[]) => { state.reorderCalls.push(names) },
			setScratch: async (name: string, on: boolean) => { state.setScratchCalls.push([name, on]) },
			setCommitTemplate: async (b: string, t: string) => { state.commitTemplateCalls.push([b, t]) },
			removeAssignment: async () => { /* no-op */ },
		},
		branchStack: {
			addBranchToStack: async (name: string, base: string, color?: string) => {
				state.addBranchCalls.push([name, base, color])
			},
			removeBranchFromStack: async (name: string) => { state.removeBranchCalls.push(name) },
			worktreeExists: () => state.worktreeExists,
			getWorktreePath: () => vscode.Uri.file('/tmp/fake-repo/.worktrees/fake'),
		},
		rebaseSvc: {
			rebaseBranch: async () => { /* no-op */ },
		},
		rebaseRecovery: {
			abort: async () => { /* no-op */ },
			continue: async () => { /* no-op */ },
			openConflicts: async () => { /* no-op */ },
		},
		stackCommands: {
			pushStack: async () => { /* no-op */ },
			syncStack: async () => { /* no-op */ },
		},
		stackShare: {
			exportToDisk: async () => '/tmp/fake-repo/.gitbraid/shared.json',
			readSharedFile: async () => undefined,
			diffWithCurrent: () => ({
				newBranches: [],
				newAssignments: [],
				conflictBranches: [],
				conflictAssignments: [],
			}),
			applyImport: async () => ({
				addedBranches: 0, addedAssignments: 0,
				updatedBranches: 0, updatedAssignments: 0, skipped: 0,
			}),
			exportAsTemplate: async () => '/tmp/fake-repo/.gitbraid/template.json',
		},
		stackedToolImporter: {
			detectAll: async () => [],
			preview: () => ({ newBranches: [], conflicts: [], unknownBases: [], warnings: [] }),
			apply: async () => ({ addedBranches: 0, skipped: 0, errors: [] }),
		},
		checkpoint: {
			saveCheckpoint: async () => '/tmp/fake-repo/.worktrees/checkpoints/cp.json',
			listCheckpoints: async () => [],
			restoreCheckpoint: async () => { /* no-op */ },
		},
		workspaceSync: {
			reseedFromGitStatus: async () => { /* no-op */ },
		},
	}
	return {
		registry: undefined as unknown as CommandDeps['registry'],
		primary: ctx as unknown as CommandDeps['primary'],
		activeContext: () => ctx as unknown as CommandDeps['primary'],
		contextForUri: () => ctx as unknown as CommandDeps['primary'],
		relativePathIn: (_c, u) => u.fsPath.replace(/^.*\//, ''),
		resolveBranchNameArg: overrides.resolveBranchNameArg
			?? (async () => undefined),
		resolveActiveBranchWorktree: overrides.resolveActiveBranchWorktree
			?? (async () => undefined),
		extractFileUri: () => undefined,
		stackTreeProvider: undefined as unknown as CommandDeps['stackTreeProvider'],
		stackView: { selection: [] } as unknown as CommandDeps['stackView'],
		statusBar: undefined as unknown as CommandDeps['statusBar'],
		prAwareness: undefined as unknown as CommandDeps['prAwareness'],
		overlayDiagnostics: undefined as unknown as CommandDeps['overlayDiagnostics'],
	}
}

interface DepsState {
	stack: BranchStackEntry[]
	assignments: Record<string, string>
	worktreeExists: boolean
	setScratchCalls: Array<[string, boolean]>
	reorderCalls: string[][]
	commitTemplateCalls: Array<[string, string]>
	removeBranchCalls: string[]
	addBranchCalls: Array<[string, string, string | undefined]>
	resolveBranchNameArg?: CommandDeps['resolveBranchNameArg']
	resolveActiveBranchWorktree?: CommandDeps['resolveActiveBranchWorktree']
}

function entry(name: string, order: number, extra: Partial<BranchStackEntry> = {}): BranchStackEntry {
	return { name, order, color: '#fff', base: 'main', ...extra }
}

/** Stub VS Code window prompts to a deterministic value for the duration of `fn`. */
async function withStubbedWindow(
	stubs: Partial<Record<'showWarningMessage' | 'showErrorMessage' | 'showInformationMessage' | 'showQuickPick' | 'showInputBox', (...args: unknown[]) => Promise<unknown>>>,
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

// ─── Suite ───────────────────────────────────────────────────────────────────

suite('branchCommands shell coverage (direct-import)', () => {

	test('removeStackBranch: empty stack → warning, no throw', async () => {
		const deps = makeDeps()
		const handlers = captureHandlers(() => registerBranchCommands(deps))
		let warned = false
		await withStubbedWindow(
			{ showWarningMessage: async () => { warned = true; return undefined } },
			async () => {
				await handlers.get('gitbraid.removeStackBranch')!()
			},
		)
		assert.ok(warned, 'expected stack-empty warning')
	})

	test('removeStackBranch: BranchNode arg drives the remove path', async () => {
		const stack = [entry('feat/a', 1)]
		const deps = makeDeps({ stack })
		const state = (deps.activeContext() as unknown as { branchStack: { removeBranchFromStack: unknown } })
			.branchStack as unknown as { removeBranchFromStack: (n: string) => Promise<void> }
		const calls: string[] = []
		;(state as unknown as { removeBranchFromStack: (n: string) => Promise<void> }).removeBranchFromStack =
			async (n) => { calls.push(n) }
		const handlers = captureHandlers(() => registerBranchCommands(deps))
		await withStubbedWindow(
			{ showInformationMessage: async () => undefined },
			async () => {
				await handlers.get('gitbraid.removeStackBranch')!(new BranchNode(stack[0]))
			},
		)
		assert.deepStrictEqual(calls, ['feat/a'])
	})

	test('addScratchWorktree: already-present scratch → info, no add', async () => {
		const stack = [entry('gitbraid-scratch', 0)]
		const deps = makeDeps({ stack })
		const handlers = captureHandlers(() => registerBranchCommands(deps))
		let infoed = false
		await withStubbedWindow(
			{ showInformationMessage: async () => { infoed = true; return undefined } },
			async () => {
				await handlers.get('gitbraid.addScratchWorktree')!()
			},
		)
		assert.ok(infoed)
	})

	test('resetBranch: empty stack → warning, no throw', async () => {
		const deps = makeDeps()
		const handlers = captureHandlers(() => registerBranchCommands(deps))
		await withStubbedWindow(
			{ showWarningMessage: async () => undefined },
			async () => {
				await handlers.get('gitbraid.resetBranch')!()
			},
		)
	})

	test('resetBranch: branch with no assigned files → info, no throw', async () => {
		const stack = [entry('feat/a', 1)]
		const deps = makeDeps({ stack })
		const handlers = captureHandlers(() => registerBranchCommands(deps))
		await withStubbedWindow(
			{
				showInformationMessage: async () => undefined,
				// resolveBranchNameArg falls through to QuickPick; return the branch name.
				showQuickPick: async () => 'feat/a',
			},
			async () => {
				await handlers.get('gitbraid.resetBranch')!()
			},
		)
	})

	test('rebaseBranch: empty stack → warning, no throw', async () => {
		const deps = makeDeps()
		const handlers = captureHandlers(() => registerBranchCommands(deps))
		await withStubbedWindow(
			{ showWarningMessage: async () => undefined },
			async () => {
				await handlers.get('gitbraid.rebaseBranch')!()
			},
		)
	})

	test('rebaseAbort/Continue/openRebaseConflicts: dismissed resolver → no-op', async () => {
		const deps = makeDeps()
		const handlers = captureHandlers(() => registerBranchCommands(deps))
		await handlers.get('gitbraid.rebaseAbort')!()
		await handlers.get('gitbraid.rebaseContinue')!()
		await handlers.get('gitbraid.openRebaseConflicts')!()
	})

	test('pushStack: empty stack → info, no throw', async () => {
		const deps = makeDeps()
		const handlers = captureHandlers(() => registerBranchCommands(deps))
		let infoed = false
		await withStubbedWindow(
			{ showInformationMessage: async () => { infoed = true; return undefined } },
			async () => {
				await handlers.get('gitbraid.pushStack')!()
			},
		)
		assert.ok(infoed)
	})

	test('pushStack: cancelled mode picker → bails before pushing', async () => {
		const stack = [entry('feat/a', 1)]
		const deps = makeDeps({ stack })
		const handlers = captureHandlers(() => registerBranchCommands(deps))
		let pushed = false
		;(deps.activeContext() as unknown as { stackCommands: { pushStack: unknown } }).stackCommands =
			{ pushStack: async () => { pushed = true } } as unknown as never
		await withStubbedWindow(
			{ showQuickPick: async () => undefined },
			async () => {
				await handlers.get('gitbraid.pushStack')!()
			},
		)
		assert.strictEqual(pushed, false)
	})

	test('syncStack: empty stack → info, no throw', async () => {
		const deps = makeDeps()
		const handlers = captureHandlers(() => registerBranchCommands(deps))
		await withStubbedWindow(
			{ showInformationMessage: async () => undefined },
			async () => {
				await handlers.get('gitbraid.syncStack')!()
			},
		)
	})

	test('syncStack: dismissed warning → bails before syncing', async () => {
		const stack = [entry('feat/a', 1)]
		const deps = makeDeps({ stack })
		let synced = false
		;(deps.activeContext() as unknown as { stackCommands: { syncStack: unknown } }).stackCommands =
			{ syncStack: async () => { synced = true } } as unknown as never
		const handlers = captureHandlers(() => registerBranchCommands(deps))
		await withStubbedWindow(
			{ showWarningMessage: async () => undefined },
			async () => {
				await handlers.get('gitbraid.syncStack')!()
			},
		)
		assert.strictEqual(synced, false)
	})

	test('exportStack: empty stack → info, no throw', async () => {
		const deps = makeDeps()
		const handlers = captureHandlers(() => registerBranchCommands(deps))
		await withStubbedWindow(
			{ showInformationMessage: async () => undefined },
			async () => {
				await handlers.get('gitbraid.exportStack')!()
			},
		)
	})

	test('importStack: missing shared file → info, no throw', async () => {
		const deps = makeDeps()
		const handlers = captureHandlers(() => registerBranchCommands(deps))
		await withStubbedWindow(
			{ showInformationMessage: async () => undefined },
			async () => {
				await handlers.get('gitbraid.importStack')!()
			},
		)
	})

	test('importStack: shared file with no diff → info, no throw', async () => {
		const deps = makeDeps()
		;(deps.activeContext() as unknown as { stackShare: { readSharedFile: unknown } }).stackShare = {
			readSharedFile: async () => ({}),
			diffWithCurrent: () => ({
				newBranches: [], newAssignments: [],
				conflictBranches: [], conflictAssignments: [],
			}),
		} as unknown as never
		const handlers = captureHandlers(() => registerBranchCommands(deps))
		await withStubbedWindow(
			{ showInformationMessage: async () => undefined },
			async () => {
				await handlers.get('gitbraid.importStack')!()
			},
		)
	})

	test('importStackedTool: nothing detected → info, no throw', async () => {
		const deps = makeDeps()
		const handlers = captureHandlers(() => registerBranchCommands(deps))
		await withStubbedWindow(
			{ showInformationMessage: async () => undefined },
			async () => {
				await handlers.get('gitbraid.importStackedTool')!()
			},
		)
	})

	test('saveCheckpoint: cancelled label input → no-op, no throw', async () => {
		const deps = makeDeps()
		const handlers = captureHandlers(() => registerBranchCommands(deps))
		await withStubbedWindow(
			{ showInputBox: async () => undefined },
			async () => {
				await handlers.get('gitbraid.saveCheckpoint')!()
			},
		)
	})

	test('saveCheckpoint: empty label → still saves (passes undefined to service)', async () => {
		const deps = makeDeps()
		const labels: Array<string | undefined> = []
		;(deps.activeContext() as unknown as { checkpoint: { saveCheckpoint: unknown } }).checkpoint = {
			saveCheckpoint: async (label?: string) => { labels.push(label); return '/tmp/cp.json' },
			listCheckpoints: async () => [],
			restoreCheckpoint: async () => undefined,
		} as unknown as never
		const handlers = captureHandlers(() => registerBranchCommands(deps))
		await withStubbedWindow(
			{
				showInputBox: async () => '',
				showInformationMessage: async () => undefined,
			},
			async () => {
				await handlers.get('gitbraid.saveCheckpoint')!()
			},
		)
		assert.deepStrictEqual(labels, [undefined])
	})

	test('restoreCheckpoint: empty list → info, no throw', async () => {
		const deps = makeDeps()
		const handlers = captureHandlers(() => registerBranchCommands(deps))
		await withStubbedWindow(
			{ showInformationMessage: async () => undefined },
			async () => {
				await handlers.get('gitbraid.restoreCheckpoint')!()
			},
		)
	})

	test('restoreCheckpoint: dismissed picker → no restore call', async () => {
		const deps = makeDeps()
		;(deps.activeContext() as unknown as { checkpoint: { listCheckpoints: unknown } }).checkpoint = {
			saveCheckpoint: async () => '/tmp/cp.json',
			listCheckpoints: async () => [{
				filename: 'cp1.json',
				filePath: '/tmp/cp1.json',
				timestamp: 0,
				branchCount: 1,
				assignmentCount: 0,
			}],
			restoreCheckpoint: async () => undefined,
		} as unknown as never
		const handlers = captureHandlers(() => registerBranchCommands(deps))
		await withStubbedWindow(
			{ showQuickPick: async () => undefined },
			async () => {
				await handlers.get('gitbraid.restoreCheckpoint')!()
			},
		)
	})

	test('setCommitTemplate: cancelled name resolver → no-op', async () => {
		const deps = makeDeps()
		const handlers = captureHandlers(() => registerBranchCommands(deps))
		await handlers.get('gitbraid.setCommitTemplate')!()
	})

	test('setCommitTemplate: cancelled template input → no setter call', async () => {
		const stack = [entry('feat/a', 1)]
		const deps = makeDeps({
			stack,
			resolveBranchNameArg: async () => 'feat/a',
		})
		const calls: Array<[string, string]> = []
		;(deps.activeContext() as unknown as { config: { setCommitTemplate: unknown } }).config = {
			...((deps.activeContext() as unknown as { config: object }).config),
			getBranch: () => stack[0],
			setCommitTemplate: async (b: string, t: string) => { calls.push([b, t]) },
		} as unknown as never
		const handlers = captureHandlers(() => registerBranchCommands(deps))
		await withStubbedWindow(
			{ showInputBox: async () => undefined },
			async () => {
				await handlers.get('gitbraid.setCommitTemplate')!()
			},
		)
		assert.strictEqual(calls.length, 0)
	})

	test('setCommitTemplate: clearing template emits cleared message', async () => {
		const stack = [entry('feat/a', 1)]
		const deps = makeDeps({
			stack,
			resolveBranchNameArg: async () => 'feat/a',
		})
		const calls: Array<[string, string]> = []
		;(deps.activeContext() as unknown as { config: { setCommitTemplate: unknown } }).config = {
			...((deps.activeContext() as unknown as { config: object }).config),
			getBranch: () => stack[0],
			setCommitTemplate: async (b: string, t: string) => { calls.push([b, t]) },
		} as unknown as never
		const handlers = captureHandlers(() => registerBranchCommands(deps))
		await withStubbedWindow(
			{
				showInputBox: async () => '',
				showInformationMessage: async () => undefined,
			},
			async () => {
				await handlers.get('gitbraid.setCommitTemplate')!()
			},
		)
		assert.deepStrictEqual(calls, [['feat/a', '']])
	})

	test('moveBranchUp/Down: with no selection and cancelled resolver → no-op', async () => {
		const deps = makeDeps()
		const handlers = captureHandlers(() => registerBranchCommands(deps))
		await handlers.get('gitbraid.moveBranchUp')!()
		await handlers.get('gitbraid.moveBranchDown')!()
	})

	test('moveBranchUp: with BranchNode → calls reorderStack', async () => {
		const stack = [entry('a', 1), entry('b', 2)]
		const deps = makeDeps({ stack })
		const calls: string[][] = []
		;(deps.activeContext() as unknown as { config: { reorderStack: unknown } }).config = {
			...((deps.activeContext() as unknown as { config: object }).config),
			getStack: () => stack,
			reorderStack: async (names: string[]) => { calls.push(names) },
		} as unknown as never
		const handlers = captureHandlers(() => registerBranchCommands(deps))
		await handlers.get('gitbraid.moveBranchUp')!(new BranchNode(stack[0]))
		assert.deepStrictEqual(calls, [['b', 'a']])
	})

	test('exportStackTemplate: empty stack → warning, no throw', async () => {
		const deps = makeDeps()
		const handlers = captureHandlers(() => registerBranchCommands(deps))
		await withStubbedWindow(
			{ showWarningMessage: async () => undefined },
			async () => {
				await handlers.get('gitbraid.exportStackTemplate')!()
			},
		)
	})

	test('exportStackTemplate: cancelled instruction input → no-op', async () => {
		const stack = [entry('feat/a', 1)]
		const deps = makeDeps({ stack })
		const handlers = captureHandlers(() => registerBranchCommands(deps))
		let exported = false
		;(deps.activeContext() as unknown as { stackShare: { exportAsTemplate: unknown } }).stackShare = {
			exportAsTemplate: async () => { exported = true; return '/tmp/template.json' },
		} as unknown as never
		await withStubbedWindow(
			{ showInputBox: async () => undefined },
			async () => {
				await handlers.get('gitbraid.exportStackTemplate')!()
			},
		)
		assert.strictEqual(exported, false)
	})

	test('exportStackTemplate: empty instructions → still exports (without "Open File" choice)', async () => {
		const stack = [entry('feat/a', 1)]
		const deps = makeDeps({ stack })
		const handlers = captureHandlers(() => registerBranchCommands(deps))
		let exportedInstructions: string | undefined = 'sentinel'
		;(deps.activeContext() as unknown as { stackShare: { exportAsTemplate: unknown } }).stackShare = {
			exportAsTemplate: async (instructions?: string) => {
				exportedInstructions = instructions
				return '/tmp/fake-repo/template.json'
			},
		} as unknown as never
		await withStubbedWindow(
			{
				showInputBox: async () => '',
				showInformationMessage: async () => undefined,
			},
			async () => {
				await handlers.get('gitbraid.exportStackTemplate')!()
			},
		)
		assert.strictEqual(exportedInstructions, undefined)
	})

	test('addScratchWorktree: not present → adds branch + sets scratch', async () => {
		const deps = makeDeps()
		const calls: Array<[string, string, string | undefined]> = []
		const scratchCalls: Array<[string, boolean]> = []
		;(deps.activeContext() as unknown as { branchStack: { addBranchToStack: unknown } }).branchStack = {
			addBranchToStack: async (n: string, b: string, c?: string) => { calls.push([n, b, c]) },
		} as unknown as never
		;(deps.activeContext() as unknown as { config: { setScratch: unknown } }).config = {
			...((deps.activeContext() as unknown as { config: object }).config),
			getStack: () => [],
			setScratch: async (n: string, on: boolean) => { scratchCalls.push([n, on]) },
		} as unknown as never
		const handlers = captureHandlers(() => registerBranchCommands(deps))
		await withStubbedWindow(
			{ showInformationMessage: async () => undefined },
			async () => {
				await handlers.get('gitbraid.addScratchWorktree')!()
			},
		)
		assert.strictEqual(calls.length, 1)
		assert.strictEqual(calls[0][0], 'gitbraid-scratch')
		assert.deepStrictEqual(scratchCalls, [['gitbraid-scratch', true]])
	})

	test('rebaseBranch: with BranchNode arg → drives rebaseSvc.rebaseBranch', async () => {
		const stack = [entry('feat/a', 1)]
		const deps = makeDeps({ stack })
		const calls: string[] = []
		;(deps.activeContext() as unknown as { rebaseSvc: { rebaseBranch: unknown } }).rebaseSvc = {
			rebaseBranch: async (n: string) => { calls.push(n) },
		} as unknown as never
		const handlers = captureHandlers(() => registerBranchCommands(deps))
		await handlers.get('gitbraid.rebaseBranch')!(new BranchNode(stack[0]))
		assert.deepStrictEqual(calls, ['feat/a'])
	})

	test('moveBranchDown: with BranchNode → calls reorderStack', async () => {
		const stack = [entry('a', 1), entry('b', 2)]
		const deps = makeDeps({ stack })
		const calls: string[][] = []
		;(deps.activeContext() as unknown as { config: { reorderStack: unknown } }).config = {
			...((deps.activeContext() as unknown as { config: object }).config),
			getStack: () => stack,
			reorderStack: async (names: string[]) => { calls.push(names) },
		} as unknown as never
		const handlers = captureHandlers(() => registerBranchCommands(deps))
		await handlers.get('gitbraid.moveBranchDown')!(new BranchNode(stack[1]))
		assert.deepStrictEqual(calls, [['b', 'a']])
	})

	// ─── resetStacks ─────────────────────────────────────────────────────────

	test('resetStacks: empty stack → info, no throw', async () => {
		const deps = makeDeps()
		const handlers = captureHandlers(() => registerBranchCommands(deps))
		let infoed = false
		await withStubbedWindow(
			{ showInformationMessage: async () => { infoed = true; return undefined } },
			async () => {
				await handlers.get('gitbraid.resetStacks')!()
			},
		)
		assert.ok(infoed)
	})

	test('resetStacks: dismissed confirm → no removal, no clearAll', async () => {
		const stack = [entry('feat/a', 1)]
		const deps = makeDeps({ stack, worktreeExists: true })
		let cleared = false
		;(deps.activeContext() as unknown as { config: { clearAll: unknown } }).config = {
			...((deps.activeContext() as unknown as { config: object }).config),
			getAllAssignments: () => ({}),
			clearAll: async () => { cleared = true },
		} as unknown as never
		const handlers = captureHandlers(() => registerBranchCommands(deps))
		await withStubbedWindow(
			{ showWarningMessage: async () => undefined },
			async () => {
				await handlers.get('gitbraid.resetStacks')!()
			},
		)
		assert.strictEqual(cleared, false)
	})

	test('resetStacks: confirmed → unhides files, force-removes worktrees, clears config, reseeds', async () => {
		const stack = [entry('feat/a', 1), entry('feat/virt', 2, { virtual: true })]
		const assignments = { 'src/a.ts': 'feat/a', 'src/b.ts': 'feat/virt' }
		const deps = makeDeps({ stack, assignments, worktreeExists: true })
		const ctx = deps.activeContext() as unknown as {
			config: { clearAll: unknown }
			workspaceSync: { reseedFromGitStatus: unknown }
		}
		let cleared = false
		let reseeded = false
		ctx.config = {
			...(deps.activeContext() as unknown as { config: object }).config,
			getAllAssignments: () => assignments,
			clearAll: async () => { cleared = true },
		} as unknown as never
		ctx.workspaceSync = { reseedFromGitStatus: async () => { reseeded = true } } as unknown as never

		const removeCalls: Array<[string, boolean]> = []
		const origRemove = git.worktree.remove
		git.worktree.remove = (async (p: string, force: boolean) => {
			removeCalls.push([p, force])
		}) as typeof git.worktree.remove

		let successMsg: string | undefined
		try {
			const handlers = captureHandlers(() => registerBranchCommands(deps))
			await withStubbedWindow(
				{
					showWarningMessage: async () => 'Reset',
					showInformationMessage: async (msg: string) => { successMsg = msg; return undefined },
				},
				async () => {
					await handlers.get('gitbraid.resetStacks')!()
				},
			)
		} finally {
			git.worktree.remove = origRemove
		}

		// Only the real (non-virtual) branch's worktree is force-removed.
		assert.strictEqual(removeCalls.length, 1)
		assert.strictEqual(removeCalls[0][1], true, 'must force-remove')
		assert.strictEqual(cleared, true)
		assert.strictEqual(reseeded, true)
		assert.match(successMsg ?? '', /reset complete/)
	})

	test('resetStacks: worktree removal failure is logged, does not abort the reset', async () => {
		const stack = [entry('feat/a', 1)]
		const deps = makeDeps({ stack, assignments: {}, worktreeExists: true })
		const ctx = deps.activeContext() as unknown as {
			config: { clearAll: unknown }
			workspaceSync: { reseedFromGitStatus: unknown }
		}
		let cleared = false
		ctx.config = {
			...(deps.activeContext() as unknown as { config: object }).config,
			getAllAssignments: () => ({}),
			clearAll: async () => { cleared = true },
		} as unknown as never
		ctx.workspaceSync = { reseedFromGitStatus: async () => { /* no-op */ } } as unknown as never

		const origRemove = git.worktree.remove
		git.worktree.remove = (async () => { throw new Error('boom') }) as typeof git.worktree.remove

		try {
			const handlers = captureHandlers(() => registerBranchCommands(deps))
			await withStubbedWindow(
				{
					showWarningMessage: async () => 'Reset',
					showInformationMessage: async () => undefined,
				},
				async () => {
					await assert.doesNotReject(() => handlers.get('gitbraid.resetStacks')!())
				},
			)
		} finally {
			git.worktree.remove = origRemove
		}
		// clearAll/reseed still run even though the worktree removal threw.
		assert.strictEqual(cleared, true)
	})

	// ─── pushStack / syncStack confirmed paths ──────────────────────────────

	test('pushStack: confirmed mode → drives stackCommands.pushStack with the chosen force flag', async () => {
		const stack = [entry('feat/a', 1)]
		const deps = makeDeps({ stack })
		const calls: Array<{ forceWithLease?: boolean } | undefined> = []
		;(deps.activeContext() as unknown as { stackCommands: { pushStack: unknown } }).stackCommands = {
			pushStack: async (opts?: { forceWithLease?: boolean }) => { calls.push(opts) },
		} as unknown as never
		const handlers = captureHandlers(() => registerBranchCommands(deps))
		await withStubbedWindow(
			{ showQuickPick: async () => ({ label: 'Push with --force-with-lease', force: true }) },
			async () => {
				await handlers.get('gitbraid.pushStack')!()
			},
		)
		assert.strictEqual(calls.length, 1)
		assert.strictEqual(calls[0]?.forceWithLease, true)
	})

	test('syncStack: confirmed → drives stackCommands.syncStack', async () => {
		const stack = [entry('feat/a', 1)]
		const deps = makeDeps({ stack })
		let synced = false
		;(deps.activeContext() as unknown as { stackCommands: { syncStack: unknown } }).stackCommands = {
			syncStack: async () => { synced = true },
		} as unknown as never
		const handlers = captureHandlers(() => registerBranchCommands(deps))
		await withStubbedWindow(
			{ showWarningMessage: async () => 'Sync' },
			async () => {
				await handlers.get('gitbraid.syncStack')!()
			},
		)
		assert.strictEqual(synced, true)
	})

	// ─── rebaseAbort / rebaseContinue / openRebaseConflicts with a resolved worktree ──

	test('rebaseAbort/Continue/openRebaseConflicts: resolved worktree drives rebaseRecovery', async () => {
		const worktreeDir = '/tmp/fake-repo/.worktrees/feat-a'
		const abortCalls: string[] = []
		const continueCalls: string[] = []
		const openCalls: string[] = []
		const fakeCtx = {
			rebaseRecovery: {
				abort: async (dir: string) => { abortCalls.push(dir) },
				continue: async (dir: string) => { continueCalls.push(dir) },
				openConflicts: async (dir: string) => { openCalls.push(dir) },
			},
		}
		const deps = makeDeps({
			resolveActiveBranchWorktree: async () => ({ ctx: fakeCtx, worktreeDir } as unknown as never),
		})
		const handlers = captureHandlers(() => registerBranchCommands(deps))
		await handlers.get('gitbraid.rebaseAbort')!()
		await handlers.get('gitbraid.rebaseContinue')!()
		await handlers.get('gitbraid.openRebaseConflicts')!()
		assert.deepStrictEqual(abortCalls, [worktreeDir])
		assert.deepStrictEqual(continueCalls, [worktreeDir])
		assert.deepStrictEqual(openCalls, [worktreeDir])
	})

	// ─── importStack happy path (with conflict resolution) ──────────────────

	test('importStack: no conflicts → imports immediately without a resolution QuickPick', async () => {
		const deps = makeDeps()
		let qpShown = false
		let importArgs: unknown
		;(deps.activeContext() as unknown as { stackShare: object }).stackShare = {
			readSharedFile: async () => ({ stack: [] }),
			diffWithCurrent: () => ({
				newBranches: [{ name: 'feat/x' }],
				newAssignments: [],
				conflictBranches: [],
				conflictAssignments: [],
			}),
			applyImport: async (_shared: unknown, resolution: unknown) => {
				importArgs = resolution
				return { addedBranches: 1, addedAssignments: 0, updatedBranches: 0, updatedAssignments: 0, skipped: 0 }
			},
		} as unknown as never
		const handlers = captureHandlers(() => registerBranchCommands(deps))
		let successMsg: string | undefined
		await withStubbedWindow(
			{
				showQuickPick: async () => { qpShown = true; return undefined },
				showInformationMessage: async (msg: string) => { successMsg = msg; return undefined },
			},
			async () => {
				await handlers.get('gitbraid.importStack')!()
			},
		)
		assert.strictEqual(qpShown, false, 'no conflicts means no resolution picker')
		assert.deepStrictEqual(importArgs, { branches: 'theirs', assignments: 'theirs' })
		assert.match(successMsg ?? '', /imported 1 new branch/)
	})

	test('importStack: conflicts + "keep local values" → applyImport receives the "ours" resolution', async () => {
		const deps = makeDeps()
		let importArgs: unknown
		;(deps.activeContext() as unknown as { stackShare: object }).stackShare = {
			readSharedFile: async () => ({ stack: [] }),
			diffWithCurrent: () => ({
				newBranches: [],
				newAssignments: [],
				conflictBranches: [{ name: 'feat/x' }],
				conflictAssignments: [],
			}),
			applyImport: async (_shared: unknown, resolution: unknown) => {
				importArgs = resolution
				return { addedBranches: 0, addedAssignments: 0, updatedBranches: 0, updatedAssignments: 0, skipped: 1 }
			},
		} as unknown as never
		const handlers = captureHandlers(() => registerBranchCommands(deps))
		await withStubbedWindow(
			{
				showQuickPick: async (items: Array<{ label: string, resolution: unknown }>) =>
					items.find((i) => i.label === 'Keep local values'),
				showInformationMessage: async () => undefined,
			},
			async () => {
				await handlers.get('gitbraid.importStack')!()
			},
		)
		assert.deepStrictEqual(importArgs, { branches: 'ours', assignments: 'ours' })
	})

	test('importStack: conflicts + cancelled resolution picker → applyImport never called', async () => {
		const deps = makeDeps()
		let applied = false
		;(deps.activeContext() as unknown as { stackShare: object }).stackShare = {
			readSharedFile: async () => ({ stack: [] }),
			diffWithCurrent: () => ({
				newBranches: [],
				newAssignments: [],
				conflictBranches: [{ name: 'feat/x' }],
				conflictAssignments: [],
			}),
			applyImport: async () => { applied = true; return { addedBranches: 0, addedAssignments: 0, updatedBranches: 0, updatedAssignments: 0, skipped: 0 } },
		} as unknown as never
		const handlers = captureHandlers(() => registerBranchCommands(deps))
		await withStubbedWindow(
			{ showQuickPick: async () => undefined },
			async () => {
				await handlers.get('gitbraid.importStack')!()
			},
		)
		assert.strictEqual(applied, false)
	})

	// ─── importStackedTool happy path ────────────────────────────────────────

	test('importStackedTool: single detected tool, confirmed → applies and reports the summary', async () => {
		const deps = makeDeps()
		let applyArgs: [unknown, boolean] | undefined
		;(deps.activeContext() as unknown as { stackedToolImporter: object }).stackedToolImporter = {
			detectAll: async () => ([
				{ tool: 'graphite', source: '.git/refs/branch-metadata', branches: [{ name: 'feat/x', base: 'main', order: 1 }], warnings: [] },
			]),
			preview: () => ({
				newBranches: [{ name: 'feat/x', base: 'main', order: 1 }],
				conflicts: [], unknownBases: [], warnings: [],
			}),
			apply: async (chosen: unknown, dryRun: boolean) => {
				applyArgs = [chosen, dryRun]
				return { addedBranches: 1, skipped: 0, errors: [] }
			},
		} as unknown as never
		const handlers = captureHandlers(() => registerBranchCommands(deps))
		let successMsg: string | undefined
		await withStubbedWindow(
			{
				showInformationMessage: async (msg: string, opts?: unknown, ...actions: string[]) => {
					// The confirm dialog passes {modal:true} + 'Import'; the final
					// summary call passes no actions. Only "confirm" should return 'Import'.
					if (actions.includes('Import')) return 'Import'
					successMsg = msg
					return undefined
				},
			},
			async () => {
				await handlers.get('gitbraid.importStackedTool')!()
			},
		)
		assert.strictEqual(applyArgs?.[1], false, 'apply must be called with dryRun=false')
		assert.match(successMsg ?? '', /imported 1 branch/)
	})

	test('importStackedTool: all detected branches already in stack → info, no confirm shown', async () => {
		const deps = makeDeps()
		let confirmShown = false
		;(deps.activeContext() as unknown as { stackedToolImporter: object }).stackedToolImporter = {
			detectAll: async () => ([
				{ tool: 'graphite', source: '.git/refs/branch-metadata', branches: [{ name: 'feat/x', base: 'main', order: 1 }], warnings: [] },
			]),
			preview: () => ({ newBranches: [], conflicts: [{ existing: {}, detected: {} }], unknownBases: [], warnings: [] }),
			apply: async () => { throw new Error('should not be called') },
		} as unknown as never
		const handlers = captureHandlers(() => registerBranchCommands(deps))
		await withStubbedWindow(
			{
				showInformationMessage: async (_msg: string, opts?: { modal?: boolean }) => {
					if (opts?.modal) confirmShown = true
					return undefined
				},
			},
			async () => {
				await handlers.get('gitbraid.importStackedTool')!()
			},
		)
		assert.strictEqual(confirmShown, false)
	})

	test('importStackedTool: multiple detected tools → QuickPick chooses which to import', async () => {
		const deps = makeDeps()
		const graphite = { tool: 'graphite', source: 'a', branches: [{ name: 'feat/g', base: 'main', order: 1 }], warnings: [] }
		const gitStack = { tool: 'git-stack', source: 'b', branches: [{ name: 'feat/s', base: 'main', order: 1 }], warnings: [] }
		let previewedTool: unknown
		;(deps.activeContext() as unknown as { stackedToolImporter: object }).stackedToolImporter = {
			detectAll: async () => ([graphite, gitStack]),
			preview: (chosen: unknown) => {
				previewedTool = chosen
				return { newBranches: [{ name: 'feat/s', base: 'main', order: 1 }], conflicts: [], unknownBases: [], warnings: [] }
			},
			apply: async () => ({ addedBranches: 1, skipped: 0, errors: [] }),
		} as unknown as never
		const handlers = captureHandlers(() => registerBranchCommands(deps))
		await withStubbedWindow(
			{
				showQuickPick: async (items: Array<{ stack: unknown }>) => items[1],
				showInformationMessage: async () => 'Import',
			},
			async () => {
				await handlers.get('gitbraid.importStackedTool')!()
			},
		)
		assert.strictEqual(previewedTool, gitStack)
	})
})
