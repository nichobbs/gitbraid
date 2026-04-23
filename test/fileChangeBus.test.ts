import * as assert from 'node:assert'
import * as vscode from 'vscode'
import { FileChangeBus } from '../src/fileChangeBus'

// These tests exercise `FileChangeBus._dispatch` directly instead of
// writing real files and waiting on `vscode.workspace
// .createFileSystemWatcher` to notice them.  The watcher's behaviour —
// whether it picks up a save / delete in a bounded window, whether it
// leaks stale events from prior teardowns — is platform-dependent
// (inotify on Linux, FSEvents on macOS, the Windows native watcher)
// and has been flaky enough on every CI runner to obscure real
// regressions.  What the bus itself owns is the *routing* logic: given
// a URI and a kind, fan out to the right event channel, and suppress
// `.git/` noise.  That's what these tests verify.

function wsRoot(): vscode.Uri {
	return vscode.workspace.workspaceFolders![0].uri
}

/** Escape hatch into the bus's private dispatcher for test purposes. */
function dispatch(bus: FileChangeBus, uri: vscode.Uri, kind: 'change' | 'delete'): void {
	;(bus as unknown as { _dispatch(u: vscode.Uri, r: vscode.Uri, k: 'change' | 'delete'): void })
		._dispatch(uri, wsRoot(), kind)
}

suite('FileChangeBus (T10)', () => {
	let bus: FileChangeBus

	setup(() => {
		bus = new FileChangeBus(wsRoot())
	})
	teardown(() => {
		bus.dispose()
	})

	test('change in primary workspace fires onDidSavePrimary with a relative path', () => {
		const events: Array<{ relativePath: string }> = []
		const disposable = bus.onDidSavePrimary((e) => { events.push({ relativePath: e.relativePath }) })
		dispatch(bus, vscode.Uri.joinPath(wsRoot(), 'bus-primary.txt'), 'change')
		disposable.dispose()
		assert.deepStrictEqual(events, [{ relativePath: 'bus-primary.txt' }])
	})

	test('delete in primary workspace fires onDidDeletePrimary, not onDidSavePrimary', () => {
		const saves: string[] = []
		const deletes: string[] = []
		const d1 = bus.onDidSavePrimary((e) => saves.push(e.relativePath))
		const d2 = bus.onDidDeletePrimary((e) => deletes.push(e.relativePath))
		dispatch(bus, vscode.Uri.joinPath(wsRoot(), 'bus-delete.txt'), 'delete')
		d1.dispose()
		d2.dispose()
		assert.deepStrictEqual(saves, [])
		assert.deepStrictEqual(deletes, ['bus-delete.txt'])
	})

	test('writes under .worktrees/<dir>/ go to onDidChangeWorktree, not onDidSavePrimary', () => {
		const primary: string[] = []
		const worktree: Array<{ worktreeDirName: string, relativePath: string }> = []
		const d1 = bus.onDidSavePrimary((e) => primary.push(e.relativePath))
		const d2 = bus.onDidChangeWorktree((e) => worktree.push({ worktreeDirName: e.worktreeDirName, relativePath: e.relativePath }))

		dispatch(bus, vscode.Uri.joinPath(wsRoot(), '.worktrees', 'synthetic-dir', 'file.txt'), 'change')

		d1.dispose()
		d2.dispose()

		assert.deepStrictEqual(primary, [], 'worktree writes must not fire onDidSavePrimary')
		assert.deepStrictEqual(
			worktree,
			[{ worktreeDirName: 'synthetic-dir', relativePath: 'file.txt' }],
		)
	})

	test('writes under .git/ are dropped (not routed to any primary event)', () => {
		const saves: string[] = []
		const deletes: string[] = []
		const anyChange: number[] = []
		const d1 = bus.onDidSavePrimary((e) => saves.push(e.relativePath))
		const d2 = bus.onDidDeletePrimary((e) => deletes.push(e.relativePath))
		const d3 = bus.onDidAnyFileChange(() => anyChange.push(1))
		dispatch(bus, vscode.Uri.joinPath(wsRoot(), '.git', 'HEAD'), 'change')
		d1.dispose()
		d2.dispose()
		d3.dispose()
		assert.deepStrictEqual(saves, [])
		assert.deepStrictEqual(deletes, [])
		assert.deepStrictEqual(anyChange, [], '.git/ writes must not reach onDidAnyFileChange either')
	})
})
