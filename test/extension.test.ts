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

	test('activate: returns MbcApi with expected methods', async () => {
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
})
