import * as assert from 'node:assert'
import * as vscode from 'vscode'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { ConfigService } from '../src/configService'
import { WorkspaceSync } from '../src/workspaceSync'
import {
	BranchStackTreeProvider,
	BranchNode,
	FloatingGroupNode,
	FileNode,
	FloatingFileNode,
} from '../src/branchStackTreeProvider'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function wsRoot(): vscode.Uri {
	return vscode.workspace.workspaceFolders![0].uri
}

function cleanup() {
	try { fs.rmSync(path.join(wsRoot().fsPath, '.worktrees'), { recursive: true }) } catch {}
	try { fs.rmSync(path.join(wsRoot().fsPath, '.gitignore')) } catch {}
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

// ─── Suite ───────────────────────────────────────────────────────────────────

suite('BranchStackTreeProvider', () => {

	let svc: ConfigService
	let sync: WorkspaceSync
	let tree: BranchStackTreeProvider

	suiteSetup(async () => {
		const { git } = await import('../src/gitFunctions')
		try {
			await git.init()
			await git.add(wsRoot().fsPath)
			await git.commit('Initial commit for tree tests')
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
		tree = new BranchStackTreeProvider(svc, sync)
	})

	teardown(() => {
		cleanup()
		tree.dispose()
		WorkspaceSync.resetInstance()
		ConfigService.resetInstance()
	})

	// ── Root children ─────────────────────────────────────────────────────────

	test('root children: empty stack → only FloatingGroupNode', () => {
		const children = tree.getChildren()
		assert.strictEqual(children.length, 1)
		assert.ok(children[0] instanceof FloatingGroupNode)
	})

	test('root children: two branches + floating group', async () => {
		await svc.addBranch({ name: 'feature/docs', color: '#4CAF50', base: 'main' })
		await svc.addBranch({ name: 'feature/impl', color: '#2196F3', base: 'feature/docs' })

		const children = tree.getChildren()
		assert.strictEqual(children.length, 3)
		assert.ok(children[0] instanceof BranchNode)
		assert.ok(children[1] instanceof BranchNode)
		assert.ok(children[2] instanceof FloatingGroupNode)

		const names = children.slice(0, 2).map((n) => (n as BranchNode).entry.name)
		assert.deepStrictEqual(names, ['feature/docs', 'feature/impl'])
	})

	// ── Branch children ───────────────────────────────────────────────────────

	test('branch children: files assigned to that branch', async () => {
		await svc.addBranch({ name: 'feature/docs', color: '#4CAF50', base: 'main' })
		await svc.setAssignment('README.md', 'feature/docs')
		await svc.setAssignment('docs/PLAN.md', 'feature/docs')
		await svc.setAssignment('src/bar.ts', 'feature/impl')  // different branch — not in config yet

		const docsEntry = svc.getBranch('feature/docs')
		assert.ok(docsEntry, 'Expected feature/docs in stack')
		const branchNode = new BranchNode(docsEntry)
		const children = tree.getChildren(branchNode)

		assert.strictEqual(children.length, 2)
		const relPaths = (children as FileNode[]).map((n) => n.relativePath).sort((a, b) => a.localeCompare(b))
		assert.deepStrictEqual(relPaths, ['README.md', 'docs/PLAN.md'])
	})

	test('branch children: no files assigned → empty array', async () => {
		await svc.addBranch({ name: 'feature/empty', color: '#888888', base: 'main' })
		const emptyEntry = svc.getBranch('feature/empty')
		assert.ok(emptyEntry, 'Expected feature/empty in stack')
		const branchNode = new BranchNode(emptyEntry)
		const children = tree.getChildren(branchNode)
		assert.strictEqual(children.length, 0)
	})

	// ── Floating group ────────────────────────────────────────────────────────

	test('floating group children: empty when no floating files', () => {
		const floatingNode = new FloatingGroupNode(0)
		const children = tree.getChildren(floatingNode)
		assert.strictEqual(children.length, 0)
	})

	// ── Refresh ───────────────────────────────────────────────────────────────

	test('tree refreshes on assignment change', async () => {
		await svc.addBranch({ name: 'feature/docs', color: '#4CAF50', base: 'main' })

		const changePromise = waitForEvent(tree.onDidChangeTreeData)
		await svc.setAssignment('README.md', 'feature/docs')
		await changePromise  // Should not timeout
	})

	test('tree refreshes on stack change', async () => {
		const changePromise = waitForEvent(tree.onDidChangeTreeData)
		await svc.addBranch({ name: 'feature/new', color: '#FF5722', base: 'main' })
		await changePromise
	})

	// ── File node ordering ────────────────────────────────────────────────────

	test('file nodes sorted alphabetically', async () => {
		await svc.addBranch({ name: 'feature/docs', color: '#4CAF50', base: 'main' })
		await svc.setAssignment('src/z.ts', 'feature/docs')
		await svc.setAssignment('src/a.ts', 'feature/docs')
		await svc.setAssignment('src/m.ts', 'feature/docs')

		const docsEntry2 = svc.getBranch('feature/docs')
		assert.ok(docsEntry2, 'Expected feature/docs in stack')
		const branchNode = new BranchNode(docsEntry2)
		const children = tree.getChildren(branchNode) as FileNode[]

		const relPaths = children.map((n) => n.relativePath)
		assert.deepStrictEqual(relPaths, ['src/a.ts', 'src/m.ts', 'src/z.ts'])
	})

	// ── FloatingFileNode ──────────────────────────────────────────────────────

	test('FloatingFileNode has correct label and context', () => {
		const node = new FloatingFileNode('src/floating.ts')
		assert.strictEqual(node.label, 'floating.ts')
		assert.strictEqual(node.description, 'src/floating.ts')
		assert.strictEqual(node.contextValue, 'floatingFile')
	})
})
