import * as assert from 'node:assert'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as vscode from 'vscode'
import { ConfigService } from '../src/configService'
import { DiffEngine, DiffHunk } from '../src/diffEngine'
import {
	HunkCodeLensProvider,
	OverlayDiagnostics,
} from '../src/hunkCodeLensProvider'
import { git } from '../src/gitFunctions'

function wsRoot(): vscode.Uri {
	return vscode.workspace.workspaceFolders![0].uri
}

function cleanup(): void {
	try { fs.rmSync(path.join(wsRoot().fsPath, '.worktrees'), { recursive: true, force: true }) } catch { /* */ }
	try { fs.rmSync(path.join(wsRoot().fsPath, '.gitignore')) } catch { /* */ }
}

class StubDiffEngine extends DiffEngine {

	constructor(public readonly hunks: DiffHunk[] = []) {
		super()
	}

	override async getHunksForFile(_root: string, _rel: string): Promise<DiffHunk[]> {
		return this.hunks
	}
}

function makeHunk(index: number, startLine: number, endLine: number): DiffHunk {
	return {
		index,
		startLine,
		endLine,
		header: `@@ -${String(startLine)},${String(endLine - startLine + 1)} +${String(startLine)},${String(endLine - startLine + 1)} @@`,
		patch: 'patch text',
	}
}

suite('HunkCodeLensProvider', function () {
	this.timeout(10_000)

	let config: ConfigService
	let provider: HunkCodeLensProvider
	let diffEngine: StubDiffEngine

	suiteSetup(async () => {
		await git.init()
		try { await git.add(undefined, '.gitkeep') } catch { /* */ }
		try { await git.commit('initial commit', '--no-gpg-sign') } catch { /* */ }
	})

	setup(async () => {
		cleanup()
		ConfigService.resetInstance()
		config = ConfigService.getInstance()
		await config.load(wsRoot())
	})

	teardown(() => {
		provider?.dispose()
		cleanup()
		ConfigService.resetInstance()
	})

	test('returns [] for non-file scheme URIs', async () => {
		diffEngine = new StubDiffEngine([makeHunk(0, 1, 5)])
		provider = new HunkCodeLensProvider(diffEngine, config)
		const fakeDoc = {
			uri: vscode.Uri.parse('untitled:foo.ts'),
			version: 1,
		} as unknown as vscode.TextDocument
		const lenses = await provider.provideCodeLenses(fakeDoc, {} as vscode.CancellationToken)
		assert.deepStrictEqual(lenses, [])
	})

	test('returns [] for files inside .worktrees/', async () => {
		diffEngine = new StubDiffEngine([makeHunk(0, 1, 5)])
		provider = new HunkCodeLensProvider(diffEngine, config)
		const fakeDoc = {
			uri: vscode.Uri.joinPath(wsRoot(), '.worktrees', 'something.ts'),
			version: 1,
		} as unknown as vscode.TextDocument
		const lenses = await provider.provideCodeLenses(fakeDoc, {} as vscode.CancellationToken)
		assert.deepStrictEqual(lenses, [])
	})

	test('returns one CodeLens per unassigned hunk with "Assign hunk" title', async () => {
		const file = path.join(wsRoot().fsPath, 'src', 'foo.ts')
		fs.mkdirSync(path.dirname(file), { recursive: true })
		fs.writeFileSync(file, 'line 1\nline 2\n')
		diffEngine = new StubDiffEngine([makeHunk(0, 1, 5), makeHunk(1, 6, 10)])
		provider = new HunkCodeLensProvider(diffEngine, config)
		const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file))
		const lenses = await provider.provideCodeLenses(doc, {} as vscode.CancellationToken)
		assert.strictEqual(lenses.length, 2)
		assert.ok(lenses[0].command?.title?.includes('Assign'))
	})

	test('assigned hunks render reassign + unassign lenses', async () => {
		const file = path.join(wsRoot().fsPath, 'src', 'bar.ts')
		fs.mkdirSync(path.dirname(file), { recursive: true })
		fs.writeFileSync(file, 'a\nb\nc\n')
		await config.addBranch({ name: 'feat/a', base: 'main', color: '#fff' })
		await config.setHunkAssignment('src/bar.ts', 0, 'feat/a')
		diffEngine = new StubDiffEngine([makeHunk(0, 1, 3)])
		provider = new HunkCodeLensProvider(diffEngine, config)
		const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file))
		const lenses = await provider.provideCodeLenses(doc, {} as vscode.CancellationToken)
		// One reassign + one unassign for the assigned hunk.
		assert.strictEqual(lenses.length, 2)
		assert.ok(lenses[0].command?.title?.includes('feat/a'))
		assert.ok(lenses[1].command?.title?.toLowerCase().includes('unassign'))
	})

	test('resolveCodeLens returns lens unchanged', async () => {
		diffEngine = new StubDiffEngine([])
		provider = new HunkCodeLensProvider(diffEngine, config)
		const lens = new vscode.CodeLens(new vscode.Range(0, 0, 0, 0))
		const result = provider.resolveCodeLens(lens, {} as vscode.CancellationToken)
		assert.strictEqual(result, lens)
	})

	test('provideCodeLenses: cache returns same hunks on second call within version', async () => {
		const file = path.join(wsRoot().fsPath, 'src', 'cache.ts')
		fs.mkdirSync(path.dirname(file), { recursive: true })
		fs.writeFileSync(file, 'a\n')
		let callCount = 0
		const stub = new (class extends DiffEngine {
			override async getHunksForFile(): Promise<DiffHunk[]> {
				callCount++
				return [makeHunk(0, 1, 1)]
			}
		})()
		provider = new HunkCodeLensProvider(stub, config)
		const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file))
		await provider.provideCodeLenses(doc, {} as vscode.CancellationToken)
		await provider.provideCodeLenses(doc, {} as vscode.CancellationToken)
		assert.strictEqual(callCount, 1, 'second call should hit cache')
	})
})

suite('OverlayDiagnostics', function () {
	this.timeout(10_000)

	let config: ConfigService
	let overlay: OverlayDiagnostics

	suiteSetup(async () => {
		await git.init()
		try { await git.add(undefined, '.gitkeep') } catch { /* */ }
		try { await git.commit('initial commit', '--no-gpg-sign') } catch { /* */ }
	})

	setup(async () => {
		cleanup()
		ConfigService.resetInstance()
		config = ConfigService.getInstance()
		await config.load(wsRoot())
	})

	teardown(() => {
		overlay?.dispose()
		cleanup()
		ConfigService.resetInstance()
	})

	test('refreshForUri: returns silently for URIs outside the workspace', async () => {
		const diffEngine = new StubDiffEngine([])
		overlay = new OverlayDiagnostics(diffEngine, config)
		await overlay.refreshForUri(vscode.Uri.file('/tmp/some-file-not-in-workspace.ts'))
		// Should not throw; diagnostics collection stays empty for that uri.
	})

	test('refreshForUri: clears diagnostics when no hunk assignments', async () => {
		const diffEngine = new StubDiffEngine([makeHunk(0, 1, 5)])
		overlay = new OverlayDiagnostics(diffEngine, config)
		const file = path.join(wsRoot().fsPath, 'src', 'overlap.ts')
		fs.mkdirSync(path.dirname(file), { recursive: true })
		fs.writeFileSync(file, 'a\nb\n')
		await overlay.refreshForUri(vscode.Uri.file(file))
		// No diagnostics expected.
	})
})
