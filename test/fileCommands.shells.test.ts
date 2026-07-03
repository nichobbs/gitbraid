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
import { setDefaultGitRunnerForTest } from '../src/gitRunner'
import { FakeGitRunner } from './helpers/fakeGitRunner'
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

	test('assignFile: multi-URI allArgs path → picker shown, assignment happens', async () => {
		const stack = [entry('feat/a', 1)]
		const { deps, state } = makeDeps({
			stack,
			worktreeExists: false,
			extractFileUri: (a) => a instanceof vscode.Uri ? a : undefined,
		})
		const fs = await import('node:fs')
		const path = await import('node:path')
		const os = await import('node:os')
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitbraid-fc-multi-'))
		const f1 = path.join(dir, 'a.ts')
		const f2 = path.join(dir, 'b.ts')
		fs.writeFileSync(f1, 'x')
		fs.writeFileSync(f2, 'y')
		// Override relativePathIn so the test doesn't depend on the deps' fake root.
		;(deps as unknown as { relativePathIn: typeof deps.relativePathIn }).relativePathIn =
			(_c, u) => path.basename(u.fsPath)
		// The shell branches on `arg instanceof vscode.Uri` for a single URI, but
		// uses the `allArgs` parameter when it's a non-empty array.
		// Pass undefined as `arg` and the array as `allArgs`.
		const handlers = captureHandlers(() => registerFileCommands(deps))
		try {
			await withStubbedWindow(
				{
					showQuickPick: async () => ({ label: 'feat/a', description: '#fff' }),
					showInformationMessage: async () => undefined,
				},
				async () => {
					await handlers.get('gitbraid.assignFile')!(
						undefined,
						[vscode.Uri.file(f1), vscode.Uri.file(f2)],
					)
				},
			)
			// Both files end up assigned to feat/a.
			assert.deepStrictEqual(
				state.setAssignmentCalls.sort(),
				[['a.ts', 'feat/a'], ['b.ts', 'feat/a']].sort(),
			)
		} finally {
			fs.rmSync(dir, { recursive: true, force: true })
		}
	})

	test('assignFile: with assignment + worktree exists → invokes hideAssignedFile path', async () => {
		const stack = [entry('feat/a', 1)]
		const { deps, state } = makeDeps({ stack, worktreeExists: true })
		const fs = await import('node:fs')
		const path = await import('node:path')
		const os = await import('node:os')
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitbraid-fc-assign-'))
		const file = path.join(dir, 'foo.ts')
		fs.writeFileSync(file, 'x')
		;(deps as unknown as { relativePathIn: typeof deps.relativePathIn }).relativePathIn =
			(_c, u) => path.basename(u.fsPath)
		const handlers = captureHandlers(() => registerFileCommands(deps))
		try {
			// `hideAssignedFile` will fail because of the fake root, but
			// `withErrorHandler` swallows it.  We only need to drive lines
			// up to and including the hide call.
			await withStubbedWindow(
				{
					showQuickPick: async () => ({ label: 'feat/a', description: '#fff' }),
					showInformationMessage: async () => undefined,
					showErrorMessage: async () => undefined,
				},
				async () => {
					await handlers.get('gitbraid.assignFile')!(vscode.Uri.file(file))
				},
			)
			assert.strictEqual(state.setAssignmentCalls.length, 1)
		} finally {
			fs.rmSync(dir, { recursive: true, force: true })
		}
	})

	test('assignFile: FloatingFileNode arg → uses node.resourceUri', async () => {
		const stack = [entry('feat/a', 1)]
		const { deps, state } = makeDeps({ stack })
		const fs = await import('node:fs')
		const path = await import('node:path')
		const os = await import('node:os')
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitbraid-fc-floating-'))
		const file = path.join(dir, 'float.ts')
		fs.writeFileSync(file, 'x')
		;(deps as unknown as { relativePathIn: typeof deps.relativePathIn }).relativePathIn =
			(_c, u) => path.basename(u.fsPath)
		const { FloatingFileNode } = await import('../src/branchStackTreeProvider')
		const node = new FloatingFileNode(path.basename(file))
		;(node as unknown as { resourceUri: vscode.Uri }).resourceUri = vscode.Uri.file(file)
		const handlers = captureHandlers(() => registerFileCommands(deps))
		try {
			await withStubbedWindow(
				{
					showQuickPick: async () => ({ label: 'feat/a', description: '#fff' }),
					showInformationMessage: async () => undefined,
				},
				async () => {
					await handlers.get('gitbraid.assignFile')!(node)
				},
			)
			assert.strictEqual(state.setAssignmentCalls.length, 1)
		} finally {
			fs.rmSync(dir, { recursive: true, force: true })
		}
	})

	test('assignFile: directory arg expands via ls-files to the changed files inside it', async () => {
		const stack = [entry('feat/a', 1)]
		const { deps, state } = makeDeps({ stack })
		const fs = await import('node:fs')
		const path = await import('node:path')
		const os = await import('node:os')
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitbraid-fc-dir-'))
		const runner = new FakeGitRunner()
		runner.fixture('ls-files --modified --others --exclude-standard --', { stdout: 'src/a.ts\nsrc/b.ts\n' })
		setDefaultGitRunnerForTest(runner)
		try {
			const handlers = captureHandlers(() => registerFileCommands(deps))
			await withStubbedWindow(
				{
					showQuickPick: async () => ({ label: 'feat/a', description: '#fff' }),
					showInformationMessage: async () => undefined,
				},
				async () => {
					await handlers.get('gitbraid.assignFile')!(vscode.Uri.file(dir))
				},
			)
			assert.deepStrictEqual(
				state.setAssignmentCalls.sort(),
				[['src/a.ts', 'feat/a'], ['src/b.ts', 'feat/a']].sort(),
			)
		} finally {
			setDefaultGitRunnerForTest(undefined)
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

	test('unassignFile: explicit URI with prior assignment → removes + records undo', async () => {
		const { deps, state } = makeDeps({
			assignments: { 'foo.ts': 'feat/a' },
			extractFileUri: (a) => a instanceof vscode.Uri ? a : undefined,
		})
		;(deps as unknown as { relativePathIn: typeof deps.relativePathIn }).relativePathIn =
			() => 'foo.ts'
		const handlers = captureHandlers(() => registerFileCommands(deps))
		await withStubbedWindow(
			{
				showInformationMessage: async () => undefined,
				showErrorMessage: async () => undefined,
			},
			async () => {
				await handlers.get('gitbraid.unassignFile')!(vscode.Uri.file('/tmp/foo.ts'))
			},
		)
		assert.deepStrictEqual(state.removeAssignmentCalls, ['foo.ts'])
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

	// ─── unassignFolder ──────────────────────────────────────────────────────

	test('unassignFolder: no folder arg → warning, no throw', async () => {
		const { deps } = makeDeps()
		const handlers = captureHandlers(() => registerFileCommands(deps))
		let warned = false
		await withStubbedWindow(
			{ showWarningMessage: async () => { warned = true; return undefined } },
			async () => {
				await handlers.get('gitbraid.unassignFolder')!()
			},
		)
		assert.ok(warned)
	})

	test('unassignFolder: no assigned files under the folder → info, no throw', async () => {
		const { deps } = makeDeps({
			extractFileUri: (a) => a instanceof vscode.Uri ? a : undefined,
		})
		const runner = new FakeGitRunner()
		runner.fixture('ls-files --modified --others --exclude-standard --', { stdout: 'src/a.ts\nsrc/b.ts\n' })
		setDefaultGitRunnerForTest(runner)
		try {
			const handlers = captureHandlers(() => registerFileCommands(deps))
			let infoMsg: string | undefined
			await withStubbedWindow(
				{ showInformationMessage: async (msg: string) => { infoMsg = msg; return undefined } },
				async () => {
					await handlers.get('gitbraid.unassignFolder')!(vscode.Uri.file('/tmp/fake-repo/src'))
				},
			)
			assert.match(infoMsg ?? '', /No assigned files found/)
		} finally {
			setDefaultGitRunnerForTest(undefined)
		}
	})

	test('unassignFolder: unassigns every assigned file under the folder and reports the count', async () => {
		const { deps, state } = makeDeps({
			assignments: { 'src/a.ts': 'feat/a', 'src/b.ts': 'feat/a', 'src/c.ts': 'feat/a' },
			extractFileUri: (a) => a instanceof vscode.Uri ? a : undefined,
		})
		// Only a.ts and c.ts are reported by ls-files — b.ts stays assigned.
		const runner = new FakeGitRunner()
		runner.fixture('ls-files --modified --others --exclude-standard --', { stdout: 'src/a.ts\nsrc/c.ts\n' })
		setDefaultGitRunnerForTest(runner)
		try {
			const handlers = captureHandlers(() => registerFileCommands(deps))
			let infoMsg: string | undefined
			await withStubbedWindow(
				{ showInformationMessage: async (msg: string) => { infoMsg = msg; return undefined } },
				async () => {
					await handlers.get('gitbraid.unassignFolder')!(vscode.Uri.file('/tmp/fake-repo/src'))
				},
			)
			assert.deepStrictEqual(state.removeAssignmentCalls.sort(), ['src/a.ts', 'src/c.ts'])
			assert.strictEqual(state.assignments['src/b.ts'], 'feat/a', 'b.ts was not reported by ls-files, so it stays assigned')
			assert.match(infoMsg ?? '', /Unassigned 2 files/)
		} finally {
			setDefaultGitRunnerForTest(undefined)
		}
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

	test('copyToWorktree: happy path copies the file into the worktree and leaves the original in place', async () => {
		const stack = [entry('feat/a', 1)]
		const { deps } = makeDeps({ stack })
		const fs = await import('node:fs')
		const path = await import('node:path')
		const os = await import('node:os')
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitbraid-fc-copy-'))
		const worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitbraid-fc-copy-wt-'))
		const file = path.join(dir, 'foo.ts')
		fs.writeFileSync(file, 'hello')
		;(deps as unknown as { relativePathIn: typeof deps.relativePathIn }).relativePathIn =
			(_c, u) => path.basename(u.fsPath)
		;(deps.activeContext() as unknown as { branchStack: { getWorktreePath: unknown } }).branchStack = {
			getWorktreePath: () => vscode.Uri.file(worktreeDir),
		}
		const { FileNode } = await import('../src/branchStackTreeProvider')
		const node = new FileNode('foo.ts', 'feat/old')
		node.resourceUri = vscode.Uri.file(file)
		try {
			const handlers = captureHandlers(() => registerFileCommands(deps))
			let infoMsg: string | undefined
			await withStubbedWindow(
				{
					showQuickPick: async () => 'feat/a',
					showInformationMessage: async (msg: string) => { infoMsg = msg; return undefined },
				},
				async () => {
					await handlers.get('gitbraid.copyToWorktree')!(node)
				},
			)
			assert.strictEqual(fs.readFileSync(path.join(worktreeDir, 'foo.ts'), 'utf-8'), 'hello')
			assert.strictEqual(fs.existsSync(file), true, 'original file must remain after a copy')
			assert.match(infoMsg ?? '', /Copied foo\.ts → feat\/a/)
		} finally {
			fs.rmSync(dir, { recursive: true, force: true })
			fs.rmSync(worktreeDir, { recursive: true, force: true })
		}
	})

	test('moveToWorktree: FileNode happy path copies, deletes the original, and clears the assignment', async () => {
		const stack = [entry('feat/a', 1)]
		const { deps, state } = makeDeps({ stack, assignments: { 'foo.ts': 'feat/old' } })
		const fs = await import('node:fs')
		const path = await import('node:path')
		const os = await import('node:os')
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitbraid-fc-move-'))
		const worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitbraid-fc-move-wt-'))
		const file = path.join(dir, 'foo.ts')
		fs.writeFileSync(file, 'hello')
		;(deps as unknown as { relativePathIn: typeof deps.relativePathIn }).relativePathIn =
			(_c, u) => path.basename(u.fsPath)
		;(deps.activeContext() as unknown as { branchStack: { getWorktreePath: unknown } }).branchStack = {
			getWorktreePath: () => vscode.Uri.file(worktreeDir),
		}
		const { FileNode } = await import('../src/branchStackTreeProvider')
		const node = new FileNode('foo.ts', 'feat/old')
		node.resourceUri = vscode.Uri.file(file)
		try {
			const handlers = captureHandlers(() => registerFileCommands(deps))
			let infoMsg: string | undefined
			await withStubbedWindow(
				{
					showQuickPick: async () => 'feat/a',
					showInformationMessage: async (msg: string) => { infoMsg = msg; return undefined },
				},
				async () => {
					await handlers.get('gitbraid.moveToWorktree')!(node)
				},
			)
			assert.strictEqual(fs.readFileSync(path.join(worktreeDir, 'foo.ts'), 'utf-8'), 'hello')
			assert.strictEqual(fs.existsSync(file), false, 'original file must be deleted after a move')
			assert.deepStrictEqual(state.removeAssignmentCalls, ['foo.ts'])
			assert.match(infoMsg ?? '', /Moved foo\.ts → feat\/a/)
		} finally {
			fs.rmSync(dir, { recursive: true, force: true })
			fs.rmSync(worktreeDir, { recursive: true, force: true })
		}
	})

	test('moveToWorktree: FloatingFileNode happy path does not touch config assignments', async () => {
		const stack = [entry('feat/a', 1)]
		const { deps, state } = makeDeps({ stack })
		const fs = await import('node:fs')
		const path = await import('node:path')
		const os = await import('node:os')
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitbraid-fc-move-float-'))
		const worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitbraid-fc-move-float-wt-'))
		const file = path.join(dir, 'floaty.ts')
		fs.writeFileSync(file, 'hi')
		;(deps as unknown as { relativePathIn: typeof deps.relativePathIn }).relativePathIn =
			(_c, u) => path.basename(u.fsPath)
		;(deps.activeContext() as unknown as { branchStack: { getWorktreePath: unknown } }).branchStack = {
			getWorktreePath: () => vscode.Uri.file(worktreeDir),
		}
		const { FloatingFileNode } = await import('../src/branchStackTreeProvider')
		const node = new FloatingFileNode(path.basename(file))
		;(node as unknown as { resourceUri: vscode.Uri }).resourceUri = vscode.Uri.file(file)
		try {
			const handlers = captureHandlers(() => registerFileCommands(deps))
			await withStubbedWindow(
				{
					showQuickPick: async () => 'feat/a',
					showInformationMessage: async () => undefined,
				},
				async () => {
					await handlers.get('gitbraid.moveToWorktree')!(node)
				},
			)
			assert.strictEqual(fs.existsSync(file), false)
			assert.strictEqual(state.removeAssignmentCalls.length, 0, 'a floating file has no assignment to clear')
		} finally {
			fs.rmSync(dir, { recursive: true, force: true })
			fs.rmSync(worktreeDir, { recursive: true, force: true })
		}
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

	test('assignGlob: cancelled file selection → no setAssignment calls', async () => {
		const stack = [entry('feat/a', 1)]
		const { deps, state } = makeDeps({ stack })
		const origFind = vscode.workspace.findFiles
		;(vscode.workspace as unknown as { findFiles: unknown }).findFiles = async () => [
			vscode.Uri.file('/tmp/fake-repo/foo.ts'),
		]
		try {
			const handlers = captureHandlers(() => registerFileCommands(deps))
			let pickerCount = 0
			await withStubbedWindow(
				{
					showInputBox: async () => 'src/**',
					showQuickPick: async () => {
						// First call → branch (return name string), second call → file picker (return undefined)
						pickerCount++
						return pickerCount === 1 ? 'feat/a' : undefined
					},
				},
				async () => {
					await handlers.get('gitbraid.assignGlob')!()
				},
			)
			assert.strictEqual(state.setAssignmentCalls.length, 0)
		} finally {
			;(vscode.workspace as unknown as { findFiles: unknown }).findFiles = origFind
		}
	})

	test('assignGlob: full happy path → records assignments + push undo entry', async () => {
		const stack = [entry('feat/a', 1)]
		const { deps, state } = makeDeps({ stack })
		const undoOps: unknown[] = []
		;(deps.activeContext() as unknown as { undoStack: { push: (op: unknown) => void } }).undoStack = {
			push: (op: unknown) => { undoOps.push(op) },
		}
		const origFind = vscode.workspace.findFiles
		;(vscode.workspace as unknown as { findFiles: unknown }).findFiles = async () => [
			vscode.Uri.file('/tmp/fake-repo/src/foo.ts'),
			vscode.Uri.file('/tmp/fake-repo/src/bar.ts'),
		]
		try {
			const handlers = captureHandlers(() => registerFileCommands(deps))
			let pickerCount = 0
			await withStubbedWindow(
				{
					showInputBox: async () => 'src/**',
					showQuickPick: async (items?: unknown) => {
						pickerCount++
						if (pickerCount === 1) return 'feat/a'
						// File-selection picker — return all items.
						return Array.isArray(items) ? items : []
					},
					showInformationMessage: async () => undefined,
				},
				async () => {
					await handlers.get('gitbraid.assignGlob')!()
				},
			)
			assert.strictEqual(state.setAssignmentCalls.length, 2)
			assert.strictEqual(undoOps.length, 1)
			// Exercise the undo + redo callbacks for additional coverage.
			const op = undoOps[0] as { undo: () => Promise<void>, redo: () => Promise<void> }
			await op.undo()
			await op.redo()
		} finally {
			;(vscode.workspace as unknown as { findFiles: unknown }).findFiles = origFind
		}
	})

})
