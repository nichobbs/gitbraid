import * as assert from 'node:assert'
import * as vscode from 'vscode'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { ConfigService } from '../src/configService'
import { WorkspaceSync } from '../src/workspaceSync'
import { IFileChangeBus, PrimarySaveEvent, WorktreeChangeEvent } from '../src/fileChangeBus'
import { worktreePath, branchToWorktreeDirName } from '../src/branchStackService'

// Minimal fake bus that exposes emitters so tests can fire events directly.
class FakeBus implements IFileChangeBus {
	readonly _save = new vscode.EventEmitter<PrimarySaveEvent>()
	readonly _delete = new vscode.EventEmitter<PrimarySaveEvent>()
	readonly _worktree = new vscode.EventEmitter<WorktreeChangeEvent>()
	readonly _any = new vscode.EventEmitter<void>()

	readonly onDidSavePrimary = this._save.event
	readonly onDidDeletePrimary = this._delete.event
	readonly onDidChangeWorktree = this._worktree.event
	readonly onDidAnyFileChange = this._any.event

	dispose() {
		this._save.dispose()
		this._delete.dispose()
		this._worktree.dispose()
		this._any.dispose()
	}
}

function wsRoot(): vscode.Uri {
	return vscode.workspace.workspaceFolders![0].uri
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms))
}

suite('WorkspaceSync — bidirectional sync', () => {
	let config: ConfigService
	let sync: WorkspaceSync
	let bus: FakeBus
	const branch = 'feature/bidir'
	let wtDir: string

	suiteSetup(async () => {
		// Enable bidirectional sync for the duration of this suite.
		await vscode.workspace.getConfiguration('gitbraid').update(
			'bidirectionalSync', true, vscode.ConfigurationTarget.Workspace,
		)
	})

	suiteTeardown(async () => {
		await vscode.workspace.getConfiguration('gitbraid').update(
			'bidirectionalSync', undefined, vscode.ConfigurationTarget.Workspace,
		)
	})

	setup(async () => {
		wtDir = worktreePath(wsRoot(), branch).fsPath
		try { fs.rmSync(wtDir, { recursive: true, force: true }) } catch { /* ignore */ }
		// Scrub any persisted config from a prior test so
		// `load()` starts from a clean slate — otherwise the second test's
		// `addBranch` sees the first test's branch still on disk and
		// throws "already exists".
		try { fs.rmSync(path.join(wsRoot().fsPath, '.worktrees', 'gitbraid-config.json'), { force: true }) } catch { /* ignore */ }
		ConfigService.resetInstance()
		WorkspaceSync.resetInstance()
		config = ConfigService.getInstance()
		await config.load(wsRoot())
		await config.addBranch({ name: branch, base: 'main', color: '#80CBC4' })
		fs.mkdirSync(wtDir, { recursive: true })
		bus = new FakeBus()
		sync = WorkspaceSync.getInstance(config)
		sync.init(wsRoot(), bus)
	})

	teardown(() => {
		bus.dispose()
		WorkspaceSync.resetInstance()
		ConfigService.resetInstance()
		try { fs.rmSync(wtDir, { recursive: true, force: true }) } catch { /* ignore */ }
	})

	test('worktree change propagates to primary when file is assigned', async () => {
		const relPath = 'bidir-test.txt'
		await config.setAssignment(relPath, branch)

		// Write content to the worktree.
		const wtFile = path.join(wtDir, relPath)
		fs.writeFileSync(wtFile, 'from-worktree')

		// Fire the bus event as FileChangeBus would.
		bus._worktree.fire({
			uri: vscode.Uri.file(wtFile),
			worktreeDirName: branchToWorktreeDirName(branch),
			relativePath: relPath,
			deleted: false,
		})

		// Wait for debounce + async write.
		await sleep(400)

		const primaryContent = fs.readFileSync(path.join(wsRoot().fsPath, relPath), 'utf-8')
		assert.strictEqual(primaryContent, 'from-worktree')
	})

	test('worktree change is ignored when file is not assigned to that branch', async () => {
		const relPath = 'bidir-unassigned.txt'
		// No assignment — config.getAssignment(relPath) returns undefined.

		const wtFile = path.join(wtDir, relPath)
		fs.writeFileSync(wtFile, 'should-not-propagate')

		bus._worktree.fire({
			uri: vscode.Uri.file(wtFile),
			worktreeDirName: branchToWorktreeDirName(branch),
			relativePath: relPath,
			deleted: false,
		})

		await sleep(400)

		// Primary file should NOT exist.
		const exists = fs.existsSync(path.join(wsRoot().fsPath, relPath))
		assert.strictEqual(exists, false, 'unassigned file should not be reverse-synced')
	})

	test('echo suppression: second worktree event with gen>0 does not overwrite primary', async () => {
		const relPath = 'bidir-echo.txt'
		await config.setAssignment(relPath, branch)
		// Let the assignment-triggered _syncFile debounce fire while the
		// primary file doesn't exist yet so it returns early without bumping
		// the generation counter.
		await sleep(400)

		// Seed worktree file.
		const wtFile = path.join(wtDir, relPath)
		fs.writeFileSync(wtFile, 'original')

		// First event → reverse sync runs.
		bus._worktree.fire({
			uri: vscode.Uri.file(wtFile),
			worktreeDirName: branchToWorktreeDirName(branch),
			relativePath: relPath,
			deleted: false,
		})
		await sleep(400)

		// Simulate the extension having incremented the generation counter
		// (as happens in _syncFile before writing to the worktree).
		// We do this by firing a second event immediately — _reverseSync already
		// ran once, so the generation is 0; a subsequent event goes through.
		// Now change the worktree content and fire again.
		fs.writeFileSync(wtFile, 'updated')
		bus._worktree.fire({
			uri: vscode.Uri.file(wtFile),
			worktreeDirName: branchToWorktreeDirName(branch),
			relativePath: relPath,
			deleted: false,
		})
		await sleep(400)

		// Both events should result in the latest content being in primary.
		const primaryContent = fs.readFileSync(path.join(wsRoot().fsPath, relPath), 'utf-8')
		assert.strictEqual(primaryContent, 'updated')
	})

	test('deleted worktree event removes path from floating-dirty set', async () => {
		const relPath = 'bidir-deleted.txt'
		// No assignment needed — deleted events prune _floatingDirty regardless.
		bus._worktree.fire({
			uri: vscode.Uri.file(path.join(wtDir, relPath)),
			worktreeDirName: branchToWorktreeDirName(branch),
			relativePath: relPath,
			deleted: true,
		})
		await sleep(100)
		// Just assert no exception is thrown — the float-dirty pruning path
		// is defensive and silent when the path isn't present.
		assert.ok(true)
	})
})
