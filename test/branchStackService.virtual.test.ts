import * as assert from 'node:assert'
import * as vscode from 'vscode'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { ConfigService } from '../src/configService'
import { BranchStackService, worktreePath } from '../src/branchStackService'
import { VirtualBranchStore, encodeBranchToFilename } from '../src/virtualBranchStore'
import { BranchStackError } from '../src/errors'
import { git } from '../src/gitFunctions'

function wsRoot(): vscode.Uri {
	return vscode.workspace.workspaceFolders![0].uri
}

function cleanup(): void {
	try { fs.rmSync(path.join(wsRoot().fsPath, '.worktrees'), { recursive: true }) } catch { /* ignore */ }
	try { fs.rmSync(path.join(wsRoot().fsPath, '.gitignore')) } catch { /* ignore */ }
}

async function removeAllTestWorktrees(): Promise<void> {
	const wtDir = path.join(wsRoot().fsPath, '.worktrees')
	if (!fs.existsSync(wtDir)) return
	for (const entry of fs.readdirSync(wtDir)) {
		if (entry.endsWith('.json') || entry.endsWith('.tmp') || entry === 'virtual') continue
		const p = path.join(wtDir, entry)
		if (fs.statSync(p, { throwIfNoEntry: false })?.isDirectory()) {
			try { await git.worktree.remove('"' + p + '"', true) } catch { /* ignore */ }
		}
	}
}

suite('BranchStackService — virtual branches', () => {

	let config: ConfigService
	let store: VirtualBranchStore
	let svc: BranchStackService

	suiteSetup(async () => {
		await git.init()
		await git.worktree.prune()
		try { await git.add(undefined, '.gitkeep') } catch { /* ignore */ }
		try { await git.commit('initial commit', '--no-gpg-sign') } catch { /* ignore */ }
	})

	setup(async () => {
		cleanup()
		ConfigService.resetInstance()
		BranchStackService.resetInstance()
		config = ConfigService.getInstance()
		await config.load(wsRoot())
		store = new VirtualBranchStore()
		await store.load(wsRoot(), config.getVirtualBranches())
		svc = new BranchStackService(config, store)
		try { await git.worktree.prune() } catch { /* ignore */ }
	})

	teardown(async () => {
		await removeAllTestWorktrees()
		store.dispose()
		cleanup()
		BranchStackService.resetInstance()
		ConfigService.resetInstance()
		try { await git.worktree.prune() } catch { /* ignore */ }
	})

	// ─── addBranchToStack: virtual flag ──────────────────────────────────────

	test('addBranchToStack({virtual:true}): records config entry but creates no worktree', async () => {
		await svc.initStack(wsRoot())
		await svc.addBranchToStack('feature/virt', 'main', '#6C8EBF', { virtual: true })

		assert.strictEqual(svc.worktreeExists('feature/virt'), false, 'no worktree on disk')
		const entry = config.getBranch('feature/virt')
		assert.strictEqual(entry?.virtual, true, 'config entry marked virtual')
		assert.strictEqual(entry?.base, 'main')
	})

	test('addBranchToStack: non-virtual path is unaffected by virtual store presence', async () => {
		await svc.initStack(wsRoot())
		await svc.addBranchToStack('feature/real', 'main')
		assert.ok(svc.worktreeExists('feature/real'))
		assert.notStrictEqual(config.getBranch('feature/real')?.virtual, true)
	})

	// ─── initStack: virtual branches skipped ─────────────────────────────────

	test('initStack: does not create a worktree for virtual entries in config', async () => {
		await config.addBranch({ name: 'feature/virt', color: '#888', base: 'main', virtual: true })
		await svc.initStack(wsRoot())
		assert.strictEqual(svc.worktreeExists('feature/virt'), false)
	})

	// ─── _pruneOrphans: spares the virtual/ directory ────────────────────────

	test('_pruneOrphans: does not remove .worktrees/virtual/', async () => {
		await svc.initStack(wsRoot())
		// Write a real JSONL file inside .worktrees/virtual/ through the store.
		await store.writeFile('feature/virt', 'src/f.ts', Buffer.from('x'))
		const virtualDir = path.join(wsRoot().fsPath, '.worktrees', 'virtual')
		assert.ok(fs.existsSync(virtualDir), 'virtual/ directory should exist after write')
		// Re-initialise — the prune pass should skip the directory.
		const freshSvc = new BranchStackService(config, store)
		await freshSvc.initStack(wsRoot())
		assert.ok(fs.existsSync(virtualDir), 'virtual/ directory should survive pruning')
	})

	// ─── materialiseBranch ────────────────────────────────────────────────────

	test('materialiseBranch: throws when branch is not virtual', async () => {
		await svc.initStack(wsRoot())
		await svc.addBranchToStack('feature/real', 'main')
		await assert.rejects(() => svc.materialiseBranch('feature/real'), BranchStackError)
	})

	test('materialiseBranch: throws when branch is not in the stack', async () => {
		await svc.initStack(wsRoot())
		await assert.rejects(() => svc.materialiseBranch('feature/missing'), BranchStackError)
	})

	test('materialiseBranch: creates worktree, writes stored files, clears virtual flag', async () => {
		await svc.initStack(wsRoot())
		await svc.addBranchToStack('feature/virt', 'main', '#888', { virtual: true })
		await store.writeFile('feature/virt', 'new/file.ts', Buffer.from('hello virtual'))
		await store.writeFile('feature/virt', 'nested/dir/sample.ts', Buffer.from('nested content'))

		await svc.materialiseBranch('feature/virt')

		// Virtual flag cleared
		assert.notStrictEqual(config.getBranch('feature/virt')?.virtual, true)
		// Worktree on disk
		assert.ok(svc.worktreeExists('feature/virt'))
		const wtDir = worktreePath(wsRoot(), 'feature/virt').fsPath
		assert.strictEqual(
			fs.readFileSync(path.join(wtDir, 'new/file.ts'), 'utf-8'),
			'hello virtual',
		)
		assert.strictEqual(
			fs.readFileSync(path.join(wtDir, 'nested/dir/sample.ts'), 'utf-8'),
			'nested content',
		)
		// Virtual store's JSONL for the branch is deleted
		const jsonl = path.join(
			wsRoot().fsPath, '.worktrees', 'virtual',
			encodeBranchToFilename('feature/virt') + '.jsonl',
		)
		assert.strictEqual(fs.existsSync(jsonl), false, 'store file should be deleted after materialisation')
		assert.deepStrictEqual(store.listFiles('feature/virt'), [])
	})

	// ─── removeBranchFromStack: virtual path ─────────────────────────────────

	test('removeBranchFromStack: clears virtual store and config without touching git', async () => {
		await svc.initStack(wsRoot())
		await svc.addBranchToStack('feature/virt', 'main', '#888', { virtual: true })
		await store.writeFile('feature/virt', 'f.ts', Buffer.from('x'))
		await svc.removeBranchFromStack('feature/virt', true)
		assert.strictEqual(config.getBranch('feature/virt'), undefined)
		assert.strictEqual(store.readFile('feature/virt', 'f.ts'), undefined)
	})

})
