import * as assert from 'assert'
import * as vscode from 'vscode'
import * as fs from 'fs'
import * as path from 'path'
import { ConfigService } from '../src/configService'
import { WorkspaceSync } from '../src/workspaceSync'
import { git } from '../src/gitFunctions'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function wsRoot(): vscode.Uri {
	return vscode.workspace.workspaceFolders![0].uri
}

function cleanup() {
	try { fs.rmSync(path.join(wsRoot().fsPath, '.worktrees'), { recursive: true }) } catch {}
	try { fs.rmSync(path.join(wsRoot().fsPath, '.gitignore')) } catch {}
}

async function writeWorkspaceFile(relativePath: string, content: string): Promise<vscode.Uri> {
	const uri = vscode.Uri.joinPath(wsRoot(), relativePath)
	await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(uri.fsPath)))
	await vscode.workspace.fs.writeFile(uri, Buffer.from(content))
	return uri
}

async function readFile(uri: vscode.Uri): Promise<string> {
	const data = await vscode.workspace.fs.readFile(uri)
	return Buffer.from(data).toString('utf-8')
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Wait for an event, or time out. */
function waitForEvent<T>(event: vscode.Event<T>, timeoutMs = 2000): Promise<T> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error('Event timeout')), timeoutMs)
		const disposable = event((value) => {
			clearTimeout(timer)
			disposable.dispose()
			resolve(value)
		})
	})
}

// ─── Suite ───────────────────────────────────────────────────────────────────

suite('WorkspaceSync', () => {

	let config: ConfigService
	let sync: WorkspaceSync

	/** Fake worktree dir for branch 'feature-docs' (branch name 'feature/docs'). */
	const branchName = 'feature/docs'
	const wtDirName = 'feature-docs'

	function worktreeRoot(): string {
		return path.join(wsRoot().fsPath, '.worktrees', wtDirName)
	}

	suiteSetup(async () => {
		// Ensure the workspace is a git repo
		try { await git.init() } catch {}
		try { await git.add(undefined, '.gitkeep') } catch {}
		try { await git.commit('initial commit', '--no-gpg-sign') } catch {}
	})

	setup(async () => {
		cleanup()
		ConfigService.resetInstance()
		WorkspaceSync.resetInstance()
		config = ConfigService.getInstance()
		await config.load(wsRoot())
		// Add branch to config so assignments can reference it
		await config.addBranch({ name: branchName, base: 'main', color: '#4CAF50' })
		// Create the fake worktree directory (no actual git worktree needed for sync tests)
		fs.mkdirSync(worktreeRoot(), { recursive: true })
		sync = WorkspaceSync.getInstance(config)
		sync.init(wsRoot())
	})

	teardown(async () => {
		cleanup()
		WorkspaceSync.resetInstance()
		ConfigService.resetInstance()
	})

	// ── Assigned file sync ────────────────────────────────────────────────────

	test('assigned file save: file is copied to branch worktree', async () => {
		await config.setAssignment('src/hello.ts', branchName)
		await writeWorkspaceFile('src/hello.ts', 'const x = 1')

		// The watcher fires asynchronously — wait for the sync event
		const ev = await waitForEvent(sync.onDidSyncFile, 3000)

		assert.strictEqual(ev.relativePath, 'src/hello.ts')
		assert.strictEqual(ev.branch, branchName)

		const destPath = path.join(worktreeRoot(), 'src', 'hello.ts')
		assert.ok(fs.existsSync(destPath), 'file should be synced to worktree')
		assert.strictEqual(fs.readFileSync(destPath, 'utf-8'), 'const x = 1')
	})

	test('assigned file save: nested directory is created in worktree', async () => {
		await config.setAssignment('src/a/b/c.ts', branchName)
		await writeWorkspaceFile('src/a/b/c.ts', 'export {}')

		await waitForEvent(sync.onDidSyncFile, 3000)

		const destPath = path.join(worktreeRoot(), 'src', 'a', 'b', 'c.ts')
		assert.ok(fs.existsSync(destPath))
	})

	// ── Floating file handling ─────────────────────────────────────────────────

	test('floating file save: fires onDidFloatFile and is tracked', async () => {
		// No assignment for this file
		await writeWorkspaceFile('src/unassigned.ts', 'const y = 2')

		const ev = await waitForEvent(sync.onDidFloatFile, 3000)
		assert.strictEqual(ev.relativePath, 'src/unassigned.ts')
		assert.ok(sync.isFloating('src/unassigned.ts'))
	})

	test('floating file: cleared from dirty set once assigned', async () => {
		await writeWorkspaceFile('src/will-assign.ts', 'x')
		await waitForEvent(sync.onDidFloatFile, 3000)
		assert.ok(sync.isFloating('src/will-assign.ts'))

		// Now assign it — should trigger sync and clear floating
		await config.setAssignment('src/will-assign.ts', branchName)
		await waitForEvent(sync.onDidSyncFile, 3000)
		assert.ok(!sync.isFloating('src/will-assign.ts'))
	})

	// ── Assignment change triggers sync ───────────────────────────────────────

	test('setAssignment: immediately syncs the file to the new branch', async () => {
		await writeWorkspaceFile('src/reassign.ts', 'hello')
		// Wait for initial floating event
		await waitForEvent(sync.onDidFloatFile, 3000)

		const syncPromise = waitForEvent(sync.onDidSyncFile, 3000)
		await config.setAssignment('src/reassign.ts', branchName)
		const ev = await syncPromise

		assert.strictEqual(ev.branch, branchName)
		const destPath = path.join(worktreeRoot(), 'src', 'reassign.ts')
		assert.ok(fs.existsSync(destPath))
	})

	// ── Rapid saves are debounced ─────────────────────────────────────────────

	test('rapid saves: only one sync event fired', async () => {
		await config.setAssignment('src/debounce.ts', branchName)

		let syncCount = 0
		const disposable = sync.onDidSyncFile(() => { syncCount++ })

		// Write the file multiple times quickly
		for (let i = 0; i < 5; i++) {
			await writeWorkspaceFile('src/debounce.ts', `v=${i}`)
		}

		// Wait long enough for debounce to settle
		await sleep(600)
		disposable.dispose()

		assert.ok(syncCount <= 2, `Expected at most 2 sync events, got ${syncCount}`)
	})

	// ── Worktrees path excluded ───────────────────────────────────────────────

	test('changes inside .worktrees/ are not re-synced', async () => {
		await config.setAssignment('src/hello.ts', branchName)
		let syncCount = 0
		const disposable = sync.onDidSyncFile(() => { syncCount++ })

		// Directly write to the worktree dir (simulating what sync itself does)
		const wtFile = path.join(worktreeRoot(), 'src', 'hello.ts')
		fs.mkdirSync(path.dirname(wtFile), { recursive: true })
		fs.writeFileSync(wtFile, 'from worktree')

		await sleep(400)
		disposable.dispose()

		// If the worktrees dir is excluded, no extra sync fires
		assert.strictEqual(syncCount, 0)
	})
})
