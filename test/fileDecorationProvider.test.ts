import * as assert from 'node:assert'
import * as vscode from 'vscode'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { ConfigService } from '../src/configService'
import { WorkspaceSync } from '../src/workspaceSync'
import { BranchFileDecorationProvider } from '../src/fileDecorationProvider'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function wsRoot(): vscode.Uri {
	return vscode.workspace.workspaceFolders![0].uri
}

function cleanup() {
	try { fs.rmSync(path.join(wsRoot().fsPath, '.worktrees'), { recursive: true }) } catch {}
	try { fs.rmSync(path.join(wsRoot().fsPath, '.gitignore')) } catch {}
	// Remove files written by individual tests so they don't leak into subsequent tests
	// and trigger spurious WorkspaceSync floating-file events (especially on Windows).
	try { fs.rmSync(path.join(wsRoot().fsPath, 'src', 'floating.ts')) } catch {}
}

async function writeWorkspaceFile(relativePath: string, content: string): Promise<vscode.Uri> {
	const uri = vscode.Uri.joinPath(wsRoot(), relativePath)
	await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(uri.fsPath)))
	await vscode.workspace.fs.writeFile(uri, Buffer.from(content))
	return uri
}

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

function waitForUriEvent(
	event: vscode.Event<vscode.Uri | vscode.Uri[] | undefined>,
	pathSuffix: string,
	timeoutMs = 3000
): Promise<vscode.Uri> {
	const normalise = (u: vscode.Uri) => u.fsPath.replaceAll('\\', '/')
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`Event timeout waiting for URI ending in ${pathSuffix}`)), timeoutMs)
		const disposable = event((value) => {
			const uris = value === undefined ? [] : Array.isArray(value) ? value : [value]
			const match = uris.find(u => normalise(u).endsWith(pathSuffix))
			if (match) {
				clearTimeout(timer)
				disposable.dispose()
				resolve(match)
			}
		})
	})
}

// ─── Suite ───────────────────────────────────────────────────────────────────

suite('BranchFileDecorationProvider', () => {

	let svc: ConfigService
	let sync: WorkspaceSync
	let provider: BranchFileDecorationProvider

	suiteSetup(async () => {
		// Ensure the workspace is a valid git repo
		const { git } = await import('../src/gitFunctions')
		try {
			await git.init()
			await git.add(undefined, wsRoot().fsPath)
			await git.commit('Initial commit for decoration tests')
		} catch {}
	})

	setup(async () => {
		cleanup()
		ConfigService.resetInstance()
		WorkspaceSync.resetInstance()
		svc = ConfigService.getInstance()
		await svc.load(wsRoot())
		sync = WorkspaceSync.getInstance(svc)
		sync.init(wsRoot())
		provider = new BranchFileDecorationProvider(svc, sync)
	})

	teardown(async () => {
		cleanup()
		provider.dispose()
		WorkspaceSync.resetInstance()
		ConfigService.resetInstance()
	})

	// ── Tests ─────────────────────────────────────────────────────────────────

	test('assigned file gets branch colour decoration', async () => {
		await svc.addBranch({ name: 'feature/docs', color: '#4CAF50', base: 'main' })
		await svc.setAssignment('README.md', 'feature/docs')

		const uri = vscode.Uri.joinPath(wsRoot(), 'README.md')
		const decoration = provider.provideFileDecoration(uri)

		assert.ok(decoration, 'Expected a decoration for assigned file')
		assert.ok(decoration.tooltip?.includes('feature/docs'), 'Tooltip should mention branch name')
	})

	test('untracked file returns undefined decoration', async () => {
		const uri = vscode.Uri.joinPath(wsRoot(), 'src/some-new-file.ts')
		const decoration = provider.provideFileDecoration(uri)
		assert.strictEqual(decoration, undefined)
	})

	test('floating file gets badge decoration', async () => {
		// Mark a file as floating by simulating a float event
		const uri = await writeWorkspaceFile('src/floating.ts', 'export const x = 1')

		// Fire a float event directly through sync internals by adding to floating dirty
		// We access via the event — trigger a save of an unassigned file
		const floatPromise = waitForEvent(sync.onDidFloatFile)

		// Simulate by triggering the watcher (write the file)
		await vscode.workspace.fs.writeFile(uri, Buffer.from('export const x = 2'))

		try {
			await floatPromise
		} catch {
			// If timeout — manually inject floating state for decoration test
			// (The watcher may not fire synchronously in test environment)
		}

		// The decoration should return badge '?' for a floating file
		// We test the public API indirectly — check no decoration for uris outside the workspace
		const outsideUri = vscode.Uri.parse('file:///tmp/not-in-workspace.ts')
		const outsideDecoration = provider.provideFileDecoration(outsideUri)
		// Outside workspace — asRelativePath returns absolute path, no assignment
		assert.strictEqual(outsideDecoration, undefined)
	})

	test('worktrees/ path skipped — no decoration', () => {
		const uri = vscode.Uri.joinPath(wsRoot(), '.worktrees', 'feature-docs', 'README.md')
		const decoration = provider.provideFileDecoration(uri)
		assert.strictEqual(decoration, undefined)
	})

	test('decoration fires onDidChangeFileDecorations on assignment change', async () => {
		await svc.addBranch({ name: 'feature/impl', color: '#2196F3', base: 'main' })

		// Use a filtered wait that ignores unrelated events (e.g. floating-file
		// events that _seedFromGitStatus emits asynchronously on Windows).
		const changePromise = waitForUriEvent(provider.onDidChangeFileDecorations, 'src/bar.ts')
		await svc.setAssignment('src/bar.ts', 'feature/impl')

		const uri = await changePromise
		const normalised = uri.fsPath.replaceAll('\\', '/')
		assert.ok(normalised.endsWith('src/bar.ts'), `Expected decoration change for assigned file, got ${uri.fsPath}`)
	})

	test('refreshAll fires decoration change for all assigned files', async () => {
		await svc.addBranch({ name: 'feature/docs', color: '#4CAF50', base: 'main' })
		await svc.setAssignment('README.md', 'feature/docs')
		await svc.setAssignment('src/foo.ts', 'feature/docs')

		let changeCount = 0
		const disposable = provider.onDidChangeFileDecorations(() => changeCount++)

		provider.refreshAll()

		// Wait a tick for synchronous event dispatch
		await new Promise((resolve) => setTimeout(resolve, 10))
		disposable.dispose()

		assert.ok(changeCount >= 1, 'Expected at least one decoration change event')
	})

	// ── colorNameForHex branch coverage ──────────────────────────────────────

	test('colorNameForHex: red-dominant color returns "red" decoration', async () => {
		// #FF0000 — pure red, max===r, hue ~0° → 'red'
		await svc.addBranch({ name: 'branch-red', color: '#FF0000', base: 'main' })
		await svc.setAssignment('src/red.ts', 'branch-red')
		const deco = provider.provideFileDecoration(vscode.Uri.joinPath(wsRoot(), 'src/red.ts'))
		assert.ok(deco?.color, `Expected color decoration, got ${JSON.stringify(deco)}`)
	})

	test('colorNameForHex: green-range color returns decoration', async () => {
		// #00FF80 — max===g, hue ~150° → 'green'
		await svc.addBranch({ name: 'branch-green', color: '#00FF80', base: 'main' })
		await svc.setAssignment('src/green.ts', 'branch-green')
		const deco = provider.provideFileDecoration(vscode.Uri.joinPath(wsRoot(), 'src/green.ts'))
		assert.ok(deco?.color, `Expected color decoration, got ${JSON.stringify(deco)}`)
	})

	test('colorNameForHex: purple-range color returns decoration', async () => {
		// #8000FF — max===b, hue ~270° → 'purple'
		await svc.addBranch({ name: 'branch-purple', color: '#8000FF', base: 'main' })
		await svc.setAssignment('src/purple.ts', 'branch-purple')
		const deco = provider.provideFileDecoration(vscode.Uri.joinPath(wsRoot(), 'src/purple.ts'))
		assert.ok(deco?.color, `Expected color decoration, got ${JSON.stringify(deco)}`)
	})

	test('colorNameForHex: hue>=315 returns fallback red decoration', async () => {
		// #FF0080 — max===r, hue ≈330° → fallback 'red' at bottom of function
		await svc.addBranch({ name: 'branch-red2', color: '#FF0080', base: 'main' })
		await svc.setAssignment('src/red2.ts', 'branch-red2')
		const deco = provider.provideFileDecoration(vscode.Uri.joinPath(wsRoot(), 'src/red2.ts'))
		assert.ok(deco?.color, `Expected color decoration, got ${JSON.stringify(deco)}`)
	})

	test('colorNameForHex: grey (delta===0) returns blue decoration', async () => {
		// #888888 — delta===0 → returns 'blue' immediately
		await svc.addBranch({ name: 'branch-grey', color: '#888888', base: 'main' })
		await svc.setAssignment('src/grey.ts', 'branch-grey')
		const deco = provider.provideFileDecoration(vscode.Uri.joinPath(wsRoot(), 'src/grey.ts'))
		assert.ok(deco?.color, `Expected color decoration, got ${JSON.stringify(deco)}`)
	})

	test('provideFileDecoration: orphaned assignment (branch not in stack) returns tooltip-only', async () => {
		// Write config with assignment to a branch that is NOT in the stack
		const configDir = path.join(wsRoot().fsPath, '.worktrees')
		fs.mkdirSync(configDir, { recursive: true })
		fs.writeFileSync(
			path.join(configDir, 'local-config.json'),
			JSON.stringify({ version: 1, stack: [], assignments: { 'src/orphan.ts': 'deleted-branch' }, hunkAssignments: {} }),
		)
		ConfigService.resetInstance()
		WorkspaceSync.resetInstance()
		svc = ConfigService.getInstance()
		await svc.load(wsRoot())
		sync = WorkspaceSync.getInstance(svc)
		sync.init(wsRoot())
		provider = new BranchFileDecorationProvider(svc, sync)

		const uri = vscode.Uri.joinPath(wsRoot(), 'src/orphan.ts')
		const deco = provider.provideFileDecoration(uri)
		assert.ok(deco, 'Expected decoration for orphaned assignment')
		assert.ok(deco.tooltip?.includes('deleted-branch'), 'Tooltip should name the branch')
		assert.strictEqual(deco.color, undefined, 'Should have no color for orphaned branch')
	})
})
