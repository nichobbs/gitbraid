import * as assert from 'node:assert'
import * as vscode from 'vscode'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { FileChangeBus } from '../src/fileChangeBus'

// Drive the bus against the real vscode-test workspace so the
// FileSystemWatcher lifecycle is exercised end-to-end.  Small waits cover
// the watcher's internal debouncing.

function wsRoot(): vscode.Uri {
	return vscode.workspace.workspaceFolders![0].uri
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms))
}

suite('FileChangeBus (T10)', () => {
	let bus: FileChangeBus

	setup(() => {
		bus = new FileChangeBus(wsRoot())
	})
	teardown(() => {
		bus.dispose()
		// Clean up test artefacts
		for (const f of ['bus-primary.txt', 'bus-delete.txt']) {
			try { fs.unlinkSync(path.join(wsRoot().fsPath, f)) } catch { /* ignore */ }
		}
	})

	test('save in primary workspace fires onDidSavePrimary with a relative path', async () => {
		const events: Array<{ relativePath: string }> = []
		const disposable = bus.onDidSavePrimary((e) => { events.push({ relativePath: e.relativePath }) })
		fs.writeFileSync(path.join(wsRoot().fsPath, 'bus-primary.txt'), 'hello')
		await sleep(400)
		disposable.dispose()
		assert.ok(
			events.some((e) => e.relativePath === 'bus-primary.txt'),
			`expected a save event for bus-primary.txt, got ${JSON.stringify(events)}`,
		)
	})

	test('delete fires onDidDeletePrimary', async () => {
		fs.writeFileSync(path.join(wsRoot().fsPath, 'bus-delete.txt'), 'hi')
		await sleep(100)
		const events: string[] = []
		const disposable = bus.onDidDeletePrimary((e) => { events.push(e.relativePath) })
		fs.unlinkSync(path.join(wsRoot().fsPath, 'bus-delete.txt'))
		await sleep(400)
		disposable.dispose()
		assert.ok(
			events.includes('bus-delete.txt'),
			`expected delete event, got ${JSON.stringify(events)}`,
		)
	})

	test('writes under .worktrees/<dir>/ go to onDidChangeWorktree, not onDidSavePrimary', async () => {
		const worktreeDir = path.join(wsRoot().fsPath, '.worktrees', 'synthetic-dir')
		fs.mkdirSync(worktreeDir, { recursive: true })

		const primary: string[] = []
		const worktree: Array<{ worktreeDirName: string, relativePath: string }> = []
		const d1 = bus.onDidSavePrimary((e) => primary.push(e.relativePath))
		const d2 = bus.onDidChangeWorktree((e) => worktree.push({ worktreeDirName: e.worktreeDirName, relativePath: e.relativePath }))

		fs.writeFileSync(path.join(worktreeDir, 'file.txt'), 'hi')
		await sleep(400)

		d1.dispose()
		d2.dispose()
		fs.rmSync(path.join(wsRoot().fsPath, '.worktrees', 'synthetic-dir'), { recursive: true, force: true })

		assert.strictEqual(primary.length, 0, 'worktree writes must not fire onDidSavePrimary')
		assert.ok(
			worktree.some((e) => e.worktreeDirName === 'synthetic-dir' && e.relativePath === 'file.txt'),
			`expected worktree event, got ${JSON.stringify(worktree)}`,
		)
	})
})
