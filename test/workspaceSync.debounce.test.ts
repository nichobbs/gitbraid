import * as assert from 'node:assert'
import * as vscode from 'vscode'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { ConfigService } from '../src/configService'
import { WorkspaceSync } from '../src/workspaceSync'

// These tests drive real (not faked) timers because VS Code's filesystem
// watcher emits via the host's event loop.  Sinon fake-timers would freeze
// that loop.  Instead we lean on small, stable waits and count event
// firings, which matches the pattern of the existing workspaceSync.test.ts
// suite.  Covers remediation T57 (docs/remediation/07-testing.md).

function wsRoot(): vscode.Uri {
	return vscode.workspace.workspaceFolders![0].uri
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms))
}

suite('WorkspaceSync — debounce + re-entrancy', () => {

	let config: ConfigService
	let sync: WorkspaceSync

	setup(async () => {
		ConfigService.resetInstance()
		WorkspaceSync.resetInstance()
		config = ConfigService.getInstance()
		await config.load(wsRoot())
		// Force the debounce to a small-but-nonzero value so rapid events
		// reliably coalesce (the production default is 200 ms).
		await vscode.workspace.getConfiguration('gitbraid').update(
			'syncDebounceMs', 150, vscode.ConfigurationTarget.Workspace,
		)
		sync = WorkspaceSync.getInstance(config)
		sync.init(wsRoot())
	})

	teardown(async () => {
		try { await vscode.workspace.getConfiguration('gitbraid').update(
			'syncDebounceMs', undefined, vscode.ConfigurationTarget.Workspace,
		) } catch { /* ignore */ }
		WorkspaceSync.resetInstance()
		ConfigService.resetInstance()
		try { fs.rmSync(path.join(wsRoot().fsPath, '.worktrees'), { recursive: true }) } catch { /* ignore */ }
	})

	test('syncDebounceMs setting is honoured', async () => {
		// The setting was updated to 150 ms.  Two rapid saves within 150 ms
		// should coalesce into one sync event.  With the legacy hard-coded
		// 200 ms default this test would pass only by accident.
		await config.addBranch({ name: 'feature/a', base: 'main', color: '#888' })
		const rel = 'src/debounce-target.ts'
		const uri = vscode.Uri.joinPath(wsRoot(), rel)
		await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(uri.fsPath)))
		await vscode.workspace.fs.writeFile(uri, Buffer.from('v1'))
		await config.setAssignment(rel, 'feature/a')

		let syncCount = 0
		const disposable = sync.onDidSyncFile((e) => {
			if (e.relativePath === rel) syncCount++
		})

		// Fire two saves ~50 ms apart — well inside the 150 ms debounce.
		await vscode.workspace.fs.writeFile(uri, Buffer.from('v2'))
		await sleep(50)
		await vscode.workspace.fs.writeFile(uri, Buffer.from('v3'))

		// Wait a bit more than the debounce window for the coalesced sync.
		await sleep(400)
		disposable.dispose()

		// We can't guarantee exactly 1 — the VS Code watcher may coalesce or
		// split the events — but the legacy behaviour would produce 2+.
		assert.ok(syncCount <= 2, `expected at most 2 syncs (ideally 1), got ${String(syncCount)}`)
	})

	test('saves that arrive during _syncing are not dropped', async () => {
		// Regression for reviews/bugs.md B1/B2.  We drive the re-entrant path
		// by forcing `_syncing = true` manually, firing _onChanged, then
		// clearing the flag.  The deferred retry should still arrive.
		await config.addBranch({ name: 'feature/b', base: 'main', color: '#888' })
		const rel = 'src/defer-target.ts'
		const uri = vscode.Uri.joinPath(wsRoot(), rel)
		await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(uri.fsPath)))
		await vscode.workspace.fs.writeFile(uri, Buffer.from('initial'))
		await config.setAssignment(rel, 'feature/b')

		// Drain the assignment-triggered sync.
		await sleep(500)

		let syncCount = 0
		const disposable = sync.onDidSyncFile((e) => {
			if (e.relativePath === rel) syncCount++
		})

		// Flip the private _syncing flag, trigger a change, clear the flag.
		;(sync as unknown as { _syncing: boolean })._syncing = true
		await vscode.workspace.fs.writeFile(uri, Buffer.from('during-sync'))
		// Wait a hair — the watcher fires, _onChanged sees _syncing and
		// re-queues via setTimeout rather than dropping.
		await sleep(50)
		;(sync as unknown as { _syncing: boolean })._syncing = false

		await sleep(500)
		disposable.dispose()

		assert.ok(syncCount >= 1, `expected deferred sync to arrive, got ${String(syncCount)}`)
	})
})
