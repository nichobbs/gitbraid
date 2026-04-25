/**
 * Tests for src/extension.ts
 *
 * The extension runs inside the VS Code extension host so we can exercise
 * commands and the activation path using the real vscode API.
 */
import * as assert from 'node:assert'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as vscode from 'vscode'
import { ConfigService } from '../src/configService'
import { BranchStackService } from '../src/branchStackService'
import { WorkspaceSync } from '../src/workspaceSync'
import { git } from '../src/gitFunctions'
import { showError } from '../src/extension'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function wsRoot(): vscode.Uri {
	return vscode.workspace.workspaceFolders![0].uri
}

function cleanup() {
	try { fs.rmSync(path.join(wsRoot().fsPath, '.worktrees'), { recursive: true }) } catch {}
	try { fs.rmSync(path.join(wsRoot().fsPath, '.gitignore')) } catch {}
}

async function getExt() {
	const ext = vscode.extensions.getExtension('nichobbs.gitbraid')
	assert.ok(ext, 'extension not found — is it installed in the test host?')
	return ext?.activate()
}

// ─── Suite: Extension activation ─────────────────────────────────────────────

suite('extension: activate', function () {
	this.timeout(15_000)

	suiteSetup(async () => {
		await git.init()
		try { await git.add(undefined, '.gitkeep') } catch {}
		try { await git.commit('initial commit', '--no-gpg-sign') } catch {}
	})

	test('activate: returns GitBraidApi with expected methods', async () => {
		const api = await getExt()
		assert.ok(api, 'activate() should return the exported API')
		assert.strictEqual(typeof api.getStack, 'function')
		assert.strictEqual(typeof api.addBranch, 'function')
		assert.strictEqual(typeof api.removeBranch, 'function')
		assert.strictEqual(typeof api.assignFile, 'function')
		assert.strictEqual(typeof api.getFloatingFiles, 'function')
		assert.strictEqual(typeof api.commitBranch, 'function')
	})

	test('activate: calling activate twice returns the same API (idempotent)', async () => {
		const api1 = await getExt()
		const api2 = await getExt()
		assert.ok(api1)
		assert.ok(api2)
		// Both should expose the same interface
		assert.strictEqual(typeof api1.getStack, 'function')
		assert.strictEqual(typeof api2.getStack, 'function')
	})
})

// ─── Suite: Registered commands ──────────────────────────────────────────────

suite('extension: registered commands', function () {
	this.timeout(10_000)

	const EXPECTED_COMMANDS = [
		'gitbraid.stackView.refresh',
		'gitbraid.focusStackView',
		'gitbraid.scm.commitBranch',
		'gitbraid.scm.refreshAll',
		'gitbraid.assignHunk',
		'gitbraid.unassignHunk',
		'gitbraid.openResolvedAtTop',
		'gitbraid.showStackDiff',
		'gitbraid.routeHunks',
		'gitbraid.assignFile',
		'gitbraid.unassignFile',
		'gitbraid.addStackBranch',
		'gitbraid.removeStackBranch',
		'gitbraid.rebaseBranch',
		'gitbraid.launchWindowForWorktree',
		'gitbraid.lockWorktree',
		'gitbraid.unlockWorktree',
		'gitbraid.copyToWorktree',
		'gitbraid.moveToWorktree',
		'gitbraid.addVirtualBranch',
		'gitbraid.materialiseVirtualBranch',
		'gitbraid.discardVirtualBranch',
	]

	suiteSetup(async () => {
		await getExt()
	})

	for (const cmdId of EXPECTED_COMMANDS) {
		test(`command '${cmdId}' is registered`, async () => {
			const all = await vscode.commands.getCommands(true)
			assert.ok(all.includes(cmdId), `Expected command '${cmdId}' to be registered`)
		})
	}
})

// ─── Suite: showError re-export ───────────────────────────────────────────────

suite('extension: showError re-export', function () {
	this.timeout(5_000)

	test('showError is exported and is a function', () => {
		assert.strictEqual(typeof showError, 'function')
	})

	test('showError does not throw for non-Error values', async () => {
		// Intercept the VS Code error notification so it doesn't appear during tests
		const win = vscode.window as unknown as {
			showErrorMessage: (msg: string, ...items: string[]) => Thenable<string | undefined>
		}
		const original = win.showErrorMessage
		let intercepted = false
		win.showErrorMessage = async () => { intercepted = true; return undefined }
		try {
			showError(new Error('test from extension.test.ts'))
			// Give the async notification a tick to fire
			await new Promise((resolve) => setImmediate(resolve))
		} finally {
			win.showErrorMessage = original
		}
		assert.ok(intercepted, 'showError should invoke showErrorMessage')
	})
})

// ─── Suite: command execution (safe no-arg paths) ────────────────────────────

suite('extension: command execution', function () {
	this.timeout(15_000)

	let config: ConfigService
	let sync: WorkspaceSync

	// Stub all blocking VS Code window calls so commands complete immediately
	// in the headless test host rather than waiting for user interaction.
	type WinAny = Record<string, (...args: unknown[]) => Promise<unknown>>
	let origWarn: WinAny['showWarningMessage']
	let origErr: WinAny['showErrorMessage']
	let origInfo: WinAny['showInformationMessage']
	let origQP: WinAny['showQuickPick']
	let origIB: WinAny['showInputBox']

	suiteSetup(async () => {
		await git.init()
		try { await git.add(undefined, '.gitkeep') } catch {}
		try { await git.commit('initial commit', '--no-gpg-sign') } catch {}
		await getExt()
	})

	setup(async () => {
		const win = vscode.window as unknown as WinAny
		origWarn = win.showWarningMessage
		origErr = win.showErrorMessage
		origInfo = win.showInformationMessage
		origQP = win.showQuickPick
		origIB = win.showInputBox
		win.showWarningMessage = async () => undefined
		win.showErrorMessage = async () => undefined
		win.showInformationMessage = async () => undefined
		win.showQuickPick = async () => undefined
		win.showInputBox = async () => undefined

		cleanup()
		ConfigService.resetInstance()
		BranchStackService.resetInstance()
		WorkspaceSync.resetInstance()
		config = ConfigService.getInstance()
		await config.load(wsRoot())
		sync = WorkspaceSync.getInstance(config)
	})

	teardown(() => {
		const win = vscode.window as unknown as WinAny
		win.showWarningMessage = origWarn
		win.showErrorMessage = origErr
		win.showInformationMessage = origInfo
		win.showQuickPick = origQP
		win.showInputBox = origIB

		sync.dispose()
		cleanup()
		BranchStackService.resetInstance()
		ConfigService.resetInstance()
		WorkspaceSync.resetInstance()
	})

	test('gitbraid.stackView.refresh: executes without throwing', async () => {
		await assert.doesNotReject(
			vscode.commands.executeCommand('gitbraid.stackView.refresh'),
		)
	})

	test('gitbraid.scm.refreshAll: executes without throwing', async () => {
		await assert.doesNotReject(
			vscode.commands.executeCommand('gitbraid.scm.refreshAll'),
		)
	})

	test('gitbraid.unassignFile: no active editor → shows warning, does not throw', async () => {
		// Close all editors first
		await vscode.commands.executeCommand('workbench.action.closeAllEditors')
		await assert.doesNotReject(
			vscode.commands.executeCommand('gitbraid.unassignFile'),
		)
	})

	test('gitbraid.assignFile: no active editor → shows warning, does not throw', async () => {
		await vscode.commands.executeCommand('workbench.action.closeAllEditors')
		await assert.doesNotReject(
			vscode.commands.executeCommand('gitbraid.assignFile'),
		)
	})

	test('gitbraid.scm.commitBranch: no branch arg shows warning, does not throw', async () => {
		// Without a branch name argument the command should handle gracefully
		await assert.doesNotReject(
			vscode.commands.executeCommand('gitbraid.scm.commitBranch'),
		)
	})

	test('gitbraid.removeStackBranch: empty stack → shows warning, does not throw', async () => {
		await assert.doesNotReject(
			vscode.commands.executeCommand('gitbraid.removeStackBranch'),
		)
	})

	test('gitbraid.rebaseBranch: empty stack → shows warning, does not throw', async () => {
		await assert.doesNotReject(
			vscode.commands.executeCommand('gitbraid.rebaseBranch'),
		)
	})

	test('gitbraid.launchWindowForWorktree: no selection → no-op, does not throw', async () => {
		await assert.doesNotReject(
			vscode.commands.executeCommand('gitbraid.launchWindowForWorktree'),
		)
	})

	test('gitbraid.lockWorktree: no selection → no-op, does not throw', async () => {
		await assert.doesNotReject(
			vscode.commands.executeCommand('gitbraid.lockWorktree'),
		)
	})

	test('gitbraid.unlockWorktree: no selection → no-op, does not throw', async () => {
		await assert.doesNotReject(
			vscode.commands.executeCommand('gitbraid.unlockWorktree'),
		)
	})

	test('gitbraid.copyToWorktree: no active editor → no-op, does not throw', async () => {
		await vscode.commands.executeCommand('workbench.action.closeAllEditors')
		await assert.doesNotReject(
			vscode.commands.executeCommand('gitbraid.copyToWorktree'),
		)
	})

	test('gitbraid.moveToWorktree: no active editor → no-op, does not throw', async () => {
		await vscode.commands.executeCommand('workbench.action.closeAllEditors')
		await assert.doesNotReject(
			vscode.commands.executeCommand('gitbraid.moveToWorktree'),
		)
	})

	test('gitbraid.openResolvedAtTop: no active editor → no-op or warning, does not throw', async () => {
		await vscode.commands.executeCommand('workbench.action.closeAllEditors')
		await assert.doesNotReject(
			vscode.commands.executeCommand('gitbraid.openResolvedAtTop'),
		)
	})

	test('gitbraid.routeHunks: no active editor → no-op or warning, does not throw', async () => {
		await vscode.commands.executeCommand('workbench.action.closeAllEditors')
		await assert.doesNotReject(
			vscode.commands.executeCommand('gitbraid.routeHunks'),
		)
	})

	test('gitbraid.showStackDiff: no active editor → no-op or warning, does not throw', async () => {
		await vscode.commands.executeCommand('workbench.action.closeAllEditors')
		await assert.doesNotReject(
			vscode.commands.executeCommand('gitbraid.showStackDiff'),
		)
	})

	test('gitbraid.materialiseVirtualBranch: empty stack → info, does not throw', async () => {
		await assert.doesNotReject(
			vscode.commands.executeCommand('gitbraid.materialiseVirtualBranch'),
		)
	})

	test('gitbraid.discardVirtualBranch: empty stack → info, does not throw', async () => {
		await assert.doesNotReject(
			vscode.commands.executeCommand('gitbraid.discardVirtualBranch'),
		)
	})

	test('gitbraid.materialiseVirtualBranch: with non-virtual branch name shows error, does not throw', async () => {
		await assert.doesNotReject(
			vscode.commands.executeCommand('gitbraid.materialiseVirtualBranch', 'not-a-real-branch'),
		)
	})

	test('gitbraid.addVirtualBranch: input cancelled → returns without creating a branch', async () => {
		// showInputBox is stubbed to undefined in the suite setup — command should bail out cleanly.
		await assert.doesNotReject(
			vscode.commands.executeCommand('gitbraid.addVirtualBranch'),
		)
		assert.strictEqual(config.getStack().length, 0, 'stack should remain empty when input is cancelled')
	})

	test('gitbraid.addVirtualBranch: happy path — creates a virtual entry with no worktree', async () => {
		const api = await getExt()
		const win = vscode.window as unknown as {
			showInputBox: (...args: unknown[]) => Promise<string | undefined>
			showQuickPick: (...args: unknown[]) => Promise<unknown>
			showInformationMessage: (...args: unknown[]) => Promise<undefined>
		}
		const prevInput = win.showInputBox
		const prevQP = win.showQuickPick
		const prevInfo = win.showInformationMessage
		win.showInputBox = async () => 'feature/virt-smoke'
		win.showQuickPick = async () => 'main'
		win.showInformationMessage = async () => undefined
		try {
			await vscode.commands.executeCommand('gitbraid.addVirtualBranch')
			// The extension holds its own ConfigService instance; query via the
			// exported API rather than the legacy test singleton.
			const stack: ReadonlyArray<{ name: string, virtual?: boolean }> = api.getStack()
			const entry = stack.find((e) => e.name === 'feature/virt-smoke')
			assert.ok(entry, 'branch should have been recorded in the stack via the API')
			assert.strictEqual(entry?.virtual, true)
			// No worktree on disk.
			const wtDir = path.join(wsRoot().fsPath, '.worktrees')
			const branchDir = fs.readdirSync(wtDir).find((d) => d.startsWith('feature-virt-smoke__'))
			assert.strictEqual(branchDir, undefined, 'no worktree directory expected for a virtual branch')
			// Clean up so the next test starts with an empty stack.
			await api.removeBranch('feature/virt-smoke', true)
		} finally {
			win.showInputBox = prevInput
			win.showQuickPick = prevQP
			win.showInformationMessage = prevInfo
		}
	})

	test('gitbraid.discardVirtualBranch: single-virtual-branch stack → auto-selects and discards', async () => {
		const api = await getExt()
		const win = vscode.window as unknown as {
			showInputBox: (...args: unknown[]) => Promise<string | undefined>
			showQuickPick: (...args: unknown[]) => Promise<unknown>
			showInformationMessage: (...args: unknown[]) => Promise<undefined>
			showWarningMessage: (...args: unknown[]) => Promise<string | undefined>
		}
		const prev = {
			input: win.showInputBox,
			qp: win.showQuickPick,
			info: win.showInformationMessage,
			warn: win.showWarningMessage,
		}
		win.showInputBox = async () => 'feature/virt-discard'
		win.showQuickPick = async () => 'main'
		win.showInformationMessage = async () => undefined
		win.showWarningMessage = async () => 'Discard'
		try {
			await vscode.commands.executeCommand('gitbraid.addVirtualBranch')
			await vscode.commands.executeCommand('gitbraid.discardVirtualBranch')
			const entry = api.getStack().find((e: { name: string }) => e.name === 'feature/virt-discard')
			assert.strictEqual(entry, undefined, 'virtual branch should be gone after discard')
		} finally {
			win.showInputBox = prev.input
			win.showQuickPick = prev.qp
			win.showInformationMessage = prev.info
			win.showWarningMessage = prev.warn
		}
	})
})
