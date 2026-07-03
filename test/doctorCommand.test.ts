/**
 * Direct-import shell tests for `src/commands/doctorCommand.ts`.
 *
 * `DoctorService`'s own detection logic is already covered end-to-end by
 * `test/doctorService.test.ts` against a real workspace. This file only
 * drives the command layer — QuickPick selection, the no-fix vs has-fix
 * branches, and the confirm/apply/throw paths around a fix — using plain
 * duck-typed `CommandDeps` (no real git or worktrees needed), following the
 * same pattern as `branchCommands.shells.test.ts`.
 */
import * as assert from 'node:assert'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as vscode from 'vscode'
import { registerDoctorCommand } from '../src/commands/doctorCommand'
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

/** A minimal duck-typed FolderContext-like object sufficient for `new DoctorService(ctx.config, ctx.branchStack, ctx.root)`. */
function makeFakeCtx(opts: { root: string, stack?: BranchStackEntry[], worktreeExists?: boolean }): unknown {
	return {
		root: vscode.Uri.file(opts.root),
		config: {
			getStack: () => opts.stack ?? [],
			getAllAssignments: () => ({}),
		},
		branchStack: {
			worktreeExists: () => opts.worktreeExists ?? true,
		},
	}
}

function mkTmpRoot(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'gitbraid-doctorcmd-'))
}

function writeOrphanVirtualFile(root: string): string {
	const dir = path.join(root, '.worktrees', 'virtual')
	fs.mkdirSync(dir, { recursive: true })
	const file = path.join(dir, 'orphan__1234567.jsonl')
	fs.writeFileSync(file, '')
	return file
}

suite('doctorCommand shell (direct-import)', () => {
	type WinAny = {
		showInformationMessage: (...args: unknown[]) => Promise<unknown>
		showWarningMessage: (...args: unknown[]) => Promise<unknown>
		showErrorMessage: (...args: unknown[]) => Promise<unknown>
		showQuickPick: (...args: unknown[]) => Promise<unknown>
	}
	let orig: WinAny
	let roots: string[]

	setup(() => {
		const win = vscode.window as unknown as WinAny
		orig = {
			showInformationMessage: win.showInformationMessage,
			showWarningMessage: win.showWarningMessage,
			showErrorMessage: win.showErrorMessage,
			showQuickPick: win.showQuickPick,
		}
		roots = []
	})

	teardown(() => {
		const win = vscode.window as unknown as WinAny
		win.showInformationMessage = orig.showInformationMessage
		win.showWarningMessage = orig.showWarningMessage
		win.showErrorMessage = orig.showErrorMessage
		win.showQuickPick = orig.showQuickPick
		for (const r of roots) {
			try { fs.rmSync(r, { recursive: true, force: true }) } catch { /* ignore */ }
		}
	})

	function trackRoot(root: string): string {
		roots.push(root)
		return root
	}

	test('no issues across any folder → info message, no QuickPick shown', async () => {
		const root = trackRoot(mkTmpRoot())
		const deps = { registry: { getAll: () => [makeFakeCtx({ root })] } } as unknown as CommandDeps
		const handlers = captureHandlers(() => registerDoctorCommand(deps))

		let infoMsg: string | undefined
		let qpShown = false
		const win = vscode.window as unknown as WinAny
		win.showInformationMessage = async (msg: string) => { infoMsg = msg; return undefined }
		win.showQuickPick = async () => { qpShown = true; return undefined }

		await handlers.get('gitbraid.runDoctor')!()
		assert.match(infoMsg ?? '', /no issues/)
		assert.strictEqual(qpShown, false)
	})

	test('cancelled QuickPick → no further dialogs', async () => {
		const root = trackRoot(mkTmpRoot())
		const stack: BranchStackEntry[] = [{ name: 'feature/a', base: 'main', color: '#abc', order: 1 }]
		const deps = {
			registry: { getAll: () => [makeFakeCtx({ root, stack, worktreeExists: false })] },
		} as unknown as CommandDeps
		const handlers = captureHandlers(() => registerDoctorCommand(deps))

		let warnShown = false
		const win = vscode.window as unknown as WinAny
		win.showQuickPick = async () => undefined
		win.showWarningMessage = async () => { warnShown = true; return undefined }

		await handlers.get('gitbraid.runDoctor')!()
		assert.strictEqual(warnShown, false, 'cancelling the QuickPick must not proceed to a fix confirmation')
	})

	test('picking a no-fix finding shows a modal info message, not a fix confirmation', async () => {
		const root = trackRoot(mkTmpRoot())
		const stack: BranchStackEntry[] = [{ name: 'feature/a', base: 'main', color: '#abc', order: 1 }]
		const deps = {
			registry: { getAll: () => [makeFakeCtx({ root, stack, worktreeExists: false })] },
		} as unknown as CommandDeps
		const handlers = captureHandlers(() => registerDoctorCommand(deps))

		let modalMsg: string | undefined
		let warnShown = false
		const win = vscode.window as unknown as WinAny
		win.showQuickPick = async (items: Array<{ finding: unknown }>) => items[0]
		win.showInformationMessage = async (msg: string, opts?: { modal?: boolean }) => {
			if (opts?.modal) modalMsg = msg
			return undefined
		}
		win.showWarningMessage = async () => { warnShown = true; return undefined }

		await handlers.get('gitbraid.runDoctor')!()
		assert.match(modalMsg ?? '', /no worktree on disk/)
		assert.strictEqual(warnShown, false, 'a no-fix finding must never prompt for fix confirmation')
	})

	test('fix declined → fix is never invoked, file stays on disk', async () => {
		const root = trackRoot(mkTmpRoot())
		const orphanFile = writeOrphanVirtualFile(root)
		const deps = { registry: { getAll: () => [makeFakeCtx({ root })] } } as unknown as CommandDeps
		const handlers = captureHandlers(() => registerDoctorCommand(deps))

		const win = vscode.window as unknown as WinAny
		win.showQuickPick = async (items: Array<{ finding: unknown }>) => items[0]
		win.showWarningMessage = async () => undefined
		let infoAfterFix: string | undefined
		win.showInformationMessage = async (msg: string) => { infoAfterFix = msg; return undefined }

		await handlers.get('gitbraid.runDoctor')!()
		assert.strictEqual(fs.existsSync(orphanFile), true, 'declining the confirm must not apply the fix')
		assert.strictEqual(infoAfterFix, undefined, 'no "fix applied" message when declined')
	})

	test('fix confirmed and succeeds → applies fix and shows success message', async () => {
		const root = trackRoot(mkTmpRoot())
		const orphanFile = writeOrphanVirtualFile(root)
		const deps = { registry: { getAll: () => [makeFakeCtx({ root })] } } as unknown as CommandDeps
		const handlers = captureHandlers(() => registerDoctorCommand(deps))

		const win = vscode.window as unknown as WinAny
		win.showQuickPick = async (items: Array<{ finding: unknown }>) => items[0]
		win.showWarningMessage = async () => 'Apply Fix'
		let successMsg: string | undefined
		win.showInformationMessage = async (msg: string) => { successMsg = msg; return undefined }
		let errorShown = false
		win.showErrorMessage = async () => { errorShown = true; return undefined }

		await handlers.get('gitbraid.runDoctor')!()
		assert.strictEqual(fs.existsSync(orphanFile), false, 'fix should have deleted the orphaned file')
		assert.match(successMsg ?? '', /fix applied/)
		assert.strictEqual(errorShown, false)
	})

	test('fix confirmed but throws → shows an error message instead of "fix applied"', async () => {
		const root = trackRoot(mkTmpRoot())
		const orphanFile = writeOrphanVirtualFile(root)
		const deps = { registry: { getAll: () => [makeFakeCtx({ root })] } } as unknown as CommandDeps
		const handlers = captureHandlers(() => registerDoctorCommand(deps))

		const win = vscode.window as unknown as WinAny
		win.showQuickPick = async (items: Array<{ finding: unknown }>) => items[0]
		win.showWarningMessage = async () => {
			// Remove the file out from under the fix so `fs.promises.unlink` throws ENOENT.
			fs.rmSync(orphanFile, { force: true })
			return 'Apply Fix'
		}
		let errorMsg: string | undefined
		win.showErrorMessage = async (msg: string) => { errorMsg = msg; return undefined }
		let successShown = false
		win.showInformationMessage = async (msg: string) => {
			if (msg.includes('fix applied')) successShown = true
			return undefined
		}

		await handlers.get('gitbraid.runDoctor')!()
		assert.match(errorMsg ?? '', /fix failed/)
		assert.strictEqual(successShown, false)
	})

	test('multi-root: QuickPick item descriptions carry the owning folder path', async () => {
		const rootA = trackRoot(mkTmpRoot())
		const rootB = trackRoot(mkTmpRoot())
		const stackA: BranchStackEntry[] = [{ name: 'feature/a', base: 'main', color: '#abc', order: 1 }]
		const stackB: BranchStackEntry[] = [{ name: 'feature/b', base: 'main', color: '#abc', order: 1 }]
		const deps = {
			registry: {
				getAll: () => [
					makeFakeCtx({ root: rootA, stack: stackA, worktreeExists: false }),
					makeFakeCtx({ root: rootB, stack: stackB, worktreeExists: false }),
				],
			},
		} as unknown as CommandDeps
		const handlers = captureHandlers(() => registerDoctorCommand(deps))

		let seenItems: Array<{ description?: string }> = []
		const win = vscode.window as unknown as WinAny
		win.showQuickPick = async (items: Array<{ description?: string }>) => { seenItems = items; return undefined }

		await handlers.get('gitbraid.runDoctor')!()
		assert.strictEqual(seenItems.length, 2)
		assert.deepStrictEqual(seenItems.map((i) => i.description).sort(), [rootA, rootB].sort())
	})

	test('single folder: QuickPick item description is left undefined', async () => {
		const root = trackRoot(mkTmpRoot())
		const stack: BranchStackEntry[] = [{ name: 'feature/a', base: 'main', color: '#abc', order: 1 }]
		const deps = {
			registry: { getAll: () => [makeFakeCtx({ root, stack, worktreeExists: false })] },
		} as unknown as CommandDeps
		const handlers = captureHandlers(() => registerDoctorCommand(deps))

		let seenItems: Array<{ description?: string }> = []
		const win = vscode.window as unknown as WinAny
		win.showQuickPick = async (items: Array<{ description?: string }>) => { seenItems = items; return undefined }

		await handlers.get('gitbraid.runDoctor')!()
		assert.strictEqual(seenItems.length, 1)
		assert.strictEqual(seenItems[0].description, undefined)
	})
})
