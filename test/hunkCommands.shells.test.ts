/**
 * Direct-import shell tests for `src/commands/hunkCommands.ts`.
 */
import * as assert from 'node:assert'
import * as vscode from 'vscode'
import { registerHunkCommands } from '../src/commands/hunkCommands'
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

function entry(name: string, order: number): BranchStackEntry {
	return { name, order, color: '#fff', base: 'main' }
}

function makeDeps(stack: BranchStackEntry[] = []): {
	deps: CommandDeps
	hunkAssignments: Map<number, string>
	hunkAnchors: Map<number, unknown>
	overlayRefreshes: vscode.Uri[]
} {
	const hunkAssignments = new Map<number, string>()
	const hunkAnchors = new Map<number, unknown>()
	const overlayRefreshes: vscode.Uri[] = []
	const ctx = {
		root: vscode.Uri.file('/tmp/fake-repo'),
		config: {
			getStack: () => stack,
			getHunkAssignments: () => hunkAssignments.size > 0 ? hunkAssignments : undefined,
			getHunkAnchor: (_rel: string, idx: number) => hunkAnchors.get(idx),
			setHunkAssignment: async (_rel: string, idx: number, branch: string, anchor?: unknown) => {
				hunkAssignments.set(idx, branch)
				if (anchor) hunkAnchors.set(idx, anchor)
			},
			removeHunkAssignment: async (_rel: string, idx: number) => {
				hunkAssignments.delete(idx)
				hunkAnchors.delete(idx)
			},
			clearHunkAssignments: async () => { hunkAssignments.clear() },
		},
		branchStack: {
			getWorktreePath: () => vscode.Uri.file('/tmp/fake-repo/.worktrees/fake'),
		},
		diffEngine: {
			getHunksForFile: async () => [],
		},
		undoStack: { push: () => undefined },
		hunkRouter: {
			routeFile: async () => true,
		},
		stackResolver: {
			getStackDiff: async () => undefined,
		},
	}
	const deps: CommandDeps = {
		registry: undefined as unknown as CommandDeps['registry'],
		primary: ctx as unknown as CommandDeps['primary'],
		activeContext: () => ctx as unknown as CommandDeps['primary'],
		contextForUri: () => ctx as unknown as CommandDeps['primary'],
		relativePathIn: (_c, u) => u.fsPath.replace(/^\/tmp\/fake-repo\//, ''),
		resolveBranchNameArg: async () => undefined,
		resolveActiveBranchWorktree: async () => undefined,
		extractFileUri: () => undefined,
		stackTreeProvider: undefined as unknown as CommandDeps['stackTreeProvider'],
		stackView: undefined as unknown as CommandDeps['stackView'],
		statusBar: undefined as unknown as CommandDeps['statusBar'],
		prAwareness: undefined as unknown as CommandDeps['prAwareness'],
		overlayDiagnostics: {
			refreshForUri: async (uri: vscode.Uri) => { overlayRefreshes.push(uri) },
		} as unknown as CommandDeps['overlayDiagnostics'],
	}
	return { deps, hunkAssignments, hunkAnchors, overlayRefreshes }
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

suite('hunkCommands shell coverage (direct-import)', () => {

	const fakeUri = vscode.Uri.file('/tmp/fake-repo/foo.ts')

	test('assignHunk: empty stack → warning, no throw', async () => {
		const { deps } = makeDeps()
		const handlers = captureHandlers(() => registerHunkCommands(deps))
		let warned = false
		await withStubbedWindow(
			{ showWarningMessage: async () => { warned = true; return undefined } },
			async () => {
				await handlers.get('gitbraid.assignHunk')!(fakeUri, 0)
			},
		)
		assert.ok(warned)
	})

	test('assignHunk: cancelled picker → no setHunkAssignment call', async () => {
		const stack = [entry('feat/a', 1)]
		const { deps, hunkAssignments } = makeDeps(stack)
		const handlers = captureHandlers(() => registerHunkCommands(deps))
		await withStubbedWindow(
			{ showQuickPick: async () => undefined },
			async () => {
				await handlers.get('gitbraid.assignHunk')!(fakeUri, 0)
			},
		)
		assert.strictEqual(hunkAssignments.size, 0)
	})

	test('assignHunk: with picker selection → assigns and refreshes overlay', async () => {
		const stack = [entry('feat/a', 1)]
		const { deps, hunkAssignments, overlayRefreshes } = makeDeps(stack)
		const handlers = captureHandlers(() => registerHunkCommands(deps))
		await withStubbedWindow(
			{
				showQuickPick: async () => ({ label: 'feat/a', description: '#fff' }),
				showInformationMessage: async () => undefined,
			},
			async () => {
				await handlers.get('gitbraid.assignHunk')!(fakeUri, 3)
			},
		)
		assert.strictEqual(hunkAssignments.get(3), 'feat/a')
		assert.strictEqual(overlayRefreshes.length, 1)
		assert.strictEqual(overlayRefreshes[0].fsPath, fakeUri.fsPath)
	})

	test('unassignHunk: with no prior assignment → still refreshes overlay', async () => {
		const { deps, overlayRefreshes } = makeDeps()
		const handlers = captureHandlers(() => registerHunkCommands(deps))
		await handlers.get('gitbraid.unassignHunk')!(fakeUri, 0)
		assert.strictEqual(overlayRefreshes.length, 1)
	})

	test('unassignHunk: with prior assignment → records undo + refreshes', async () => {
		const { deps, hunkAssignments, overlayRefreshes } = makeDeps()
		hunkAssignments.set(2, 'feat/a')
		const handlers = captureHandlers(() => registerHunkCommands(deps))
		await handlers.get('gitbraid.unassignHunk')!(fakeUri, 2)
		assert.strictEqual(hunkAssignments.has(2), false)
		assert.strictEqual(overlayRefreshes.length, 1)
	})

	test('openResolvedAtTop: no editor and no arg → warning, no diff opened', async () => {
		const { deps } = makeDeps()
		const handlers = captureHandlers(() => registerHunkCommands(deps))
		let opened = false
		const orig = vscode.commands.executeCommand
		;(vscode.commands as unknown as { executeCommand: unknown }).executeCommand = async (cmd: string) => {
			if (cmd === 'vscode.diff') opened = true
			return undefined
		}
		try {
			let warned = false
			await withStubbedWindow(
				{ showWarningMessage: async () => { warned = true; return undefined } },
				async () => {
					await handlers.get('gitbraid.openResolvedAtTop')!()
				},
			)
			assert.ok(warned)
			assert.strictEqual(opened, false)
		} finally {
			;(vscode.commands as unknown as { executeCommand: unknown }).executeCommand = orig
		}
	})

	test('openResolvedAtTop: explicit URI → opens vscode.diff', async () => {
		const { deps } = makeDeps()
		const handlers = captureHandlers(() => registerHunkCommands(deps))
		let openedArgs: unknown[] | undefined
		const orig = vscode.commands.executeCommand
		;(vscode.commands as unknown as { executeCommand: unknown }).executeCommand =
			async (cmd: string, ...args: unknown[]) => {
				if (cmd === 'vscode.diff') openedArgs = args
				return undefined
			}
		try {
			await handlers.get('gitbraid.openResolvedAtTop')!(fakeUri)
		} finally {
			;(vscode.commands as unknown as { executeCommand: unknown }).executeCommand = orig
		}
		assert.ok(openedArgs, 'vscode.diff should have been called')
	})

	test('showStackDiff: no editor → warning', async () => {
		const { deps } = makeDeps()
		const handlers = captureHandlers(() => registerHunkCommands(deps))
		let warned = false
		await withStubbedWindow(
			{ showWarningMessage: async () => { warned = true; return undefined } },
			async () => {
				await handlers.get('gitbraid.showStackDiff')!()
			},
		)
		assert.ok(warned)
	})

	test('showStackDiff: no diff for file → info, no document opened', async () => {
		const { deps } = makeDeps()
		const handlers = captureHandlers(() => registerHunkCommands(deps))
		let infoed = false
		await withStubbedWindow(
			{ showInformationMessage: async () => { infoed = true; return undefined } },
			async () => {
				await handlers.get('gitbraid.showStackDiff')!(fakeUri)
			},
		)
		assert.ok(infoed)
	})

	test('routeHunks: no editor → warning', async () => {
		const { deps } = makeDeps()
		const handlers = captureHandlers(() => registerHunkCommands(deps))
		let warned = false
		await withStubbedWindow(
			{ showWarningMessage: async () => { warned = true; return undefined } },
			async () => {
				await handlers.get('gitbraid.routeHunks')!()
			},
		)
		assert.ok(warned)
	})

	test('routeHunks: file with no assignments → info, no router call', async () => {
		const { deps } = makeDeps()
		const handlers = captureHandlers(() => registerHunkCommands(deps))
		let infoed = false
		await withStubbedWindow(
			{ showInformationMessage: async () => { infoed = true; return undefined } },
			async () => {
				await handlers.get('gitbraid.routeHunks')!(fakeUri)
			},
		)
		assert.ok(infoed)
	})

	test('routeHunks: with assignments → drives router and clears them on success', async () => {
		const stack = [entry('feat/a', 1)]
		const { deps, hunkAssignments } = makeDeps(stack)
		hunkAssignments.set(0, 'feat/a')
		const handlers = captureHandlers(() => registerHunkCommands(deps))
		await withStubbedWindow(
			{ showInformationMessage: async () => undefined },
			async () => {
				await handlers.get('gitbraid.routeHunks')!(fakeUri)
			},
		)
		assert.strictEqual(hunkAssignments.size, 0, 'router should clear assignments after success')
	})
})
