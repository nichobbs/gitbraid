import * as assert from 'node:assert'
import * as vscode from 'vscode'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { ConfigService } from '../src/configService'
import { WorkspaceSync } from '../src/workspaceSync'
import {
	BranchStackTreeProvider,
	BranchNode,
	CurrentBranchNode,
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
		// A CurrentBranchNode may be prepended if the checkout branch isn't in the stack.
		const stackBranches = children.filter((n) => n instanceof BranchNode && !(n instanceof CurrentBranchNode))
		const floatingGroups = children.filter((n) => n instanceof FloatingGroupNode)
		assert.strictEqual(stackBranches.length, 2)
		assert.strictEqual(floatingGroups.length, 1)

		// Descending stack order: highest layer (feature/impl, order 2) first.
		const names = stackBranches.map((n) => (n as BranchNode).entry.name)
		assert.deepStrictEqual(names, ['feature/impl', 'feature/docs'])
	})

	// ── Branch children ───────────────────────────────────────────────────────

	test('branch children: files assigned to that branch', async () => {
		await svc.addBranch({ name: 'feature/docs', color: '#4CAF50', base: 'main' })
		await svc.addBranch({ name: 'feature/impl', color: '#2196F3', base: 'feature/docs' })
		await svc.setAssignment('README.md', 'feature/docs')
		await svc.setAssignment('docs/PLAN.md', 'feature/docs')
		await svc.setAssignment('src/bar.ts', 'feature/impl')  // different branch

		const docsEntry = svc.getBranch('feature/docs')
		assert.ok(docsEntry, 'Expected feature/docs in stack')
		const branchNode = new BranchNode(docsEntry)
		const children = tree.getChildren(branchNode)

		assert.strictEqual(children.length, 2)
		const relPaths = (children as FileNode[]).map((n) => n.relativePath).sort((a, b) => a.localeCompare(b))
		assert.deepStrictEqual(relPaths, ['docs/PLAN.md', 'README.md'])
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

	test('FloatingFileNode: file at root level uses name as label', () => {
		const node = new FloatingFileNode('README.md')
		assert.strictEqual(node.label, 'README.md')
		assert.strictEqual(node.description, 'README.md')
	})

	// ── getParent ─────────────────────────────────────────────────────────────

	test('getParent: FileNode returns parent BranchNode', async () => {
		await svc.addBranch({ name: 'feature/docs', color: '#4CAF50', base: 'main' })
		await svc.setAssignment('src/foo.ts', 'feature/docs')
		const docsEntry = svc.getBranch('feature/docs')!
		const fileNode = new FileNode('src/foo.ts', 'feature/docs')
		const parent = tree.getParent(fileNode)
		assert.ok(parent instanceof BranchNode)
		assert.strictEqual((parent as BranchNode).entry.name, 'feature/docs')
		assert.strictEqual((parent as BranchNode).entry.name, docsEntry.name)
	})

	test('getParent: FileNode for unknown branch returns undefined', async () => {
		const fileNode = new FileNode('src/foo.ts', 'nonexistent-branch')
		const parent = tree.getParent(fileNode)
		assert.strictEqual(parent, undefined)
	})

	test('getParent: FloatingFileNode returns FloatingGroupNode', () => {
		const floatNode = new FloatingFileNode('src/unassigned.ts')
		const parent = tree.getParent(floatNode)
		assert.ok(parent instanceof FloatingGroupNode)
	})

	test('getParent: BranchNode returns undefined (root level)', async () => {
		await svc.addBranch({ name: 'feature/docs', color: '#4CAF50', base: 'main' })
		const entry = svc.getBranch('feature/docs')!
		const branchNode = new BranchNode(entry)
		const parent = tree.getParent(branchNode)
		assert.strictEqual(parent, undefined)
	})

	// ── BranchNode properties ─────────────────────────────────────────────────

	test('BranchNode has correct label, context, and description', async () => {
		await svc.addBranch({ name: 'feature/impl', color: '#2196F3', base: 'feature/docs' })
		const entry = svc.getBranch('feature/impl')!
		const node = new BranchNode(entry)
		assert.strictEqual(node.label, 'feature/impl')
		assert.strictEqual(node.contextValue, 'branch')
		assert.strictEqual(node.description, 'feature/docs')
		assert.ok((node.tooltip as string).includes('feature/impl'))
		assert.ok((node.tooltip as string).includes('feature/docs'))
	})

	// ── FileNode properties ───────────────────────────────────────────────────

	test('FileNode has correct label, context, and tooltip', () => {
		const node = new FileNode('src/components/Button.tsx', 'feature/ui')
		assert.strictEqual(node.label, 'Button.tsx')
		assert.strictEqual(node.description, 'src/components/Button.tsx')
		assert.strictEqual(node.contextValue, 'assignedFile')
		assert.ok((node.tooltip as string).includes('feature/ui'))
	})

	// ── FloatingGroupNode properties ──────────────────────────────────────────

	test('FloatingGroupNode: count=0 description is undefined', () => {
		const node = new FloatingGroupNode(0)
		assert.strictEqual(node.description, undefined)
	})

	test('FloatingGroupNode: count>0 shows file count', () => {
		const node = new FloatingGroupNode(3)
		assert.ok(node.description?.toString().includes('3'))
	})

	// ── refresh ───────────────────────────────────────────────────────────────

	test('refresh with specific node fires with that node', async () => {
		await svc.addBranch({ name: 'feature/docs', color: '#4CAF50', base: 'main' })
		const entry = svc.getBranch('feature/docs')!
		const node = new BranchNode(entry)

		const changePromise = new Promise<StackTreeNode | undefined>((resolve) => {
			const disposable = tree.onDidChangeTreeData((e) => {
				disposable.dispose()
				resolve(e)
			})
		})

		tree.refresh(node)
		const fired = await changePromise
		assert.ok(fired instanceof BranchNode)
	})

	test('refresh without argument fires with undefined', async () => {
		const changePromise = new Promise<StackTreeNode | undefined>((resolve) => {
			const disposable = tree.onDidChangeTreeData((e) => {
				disposable.dispose()
				resolve(e)
			})
		})
		tree.refresh()
		const fired = await changePromise
		assert.strictEqual(fired, undefined)
	})

	// ── getTreeItem ───────────────────────────────────────────────────────────

	test('getTreeItem returns the element itself', async () => {
		await svc.addBranch({ name: 'feature/docs', color: '#4CAF50', base: 'main' })
		const entry = svc.getBranch('feature/docs')!
		const node = new BranchNode(entry)
		const treeItem = tree.getTreeItem(node)
		assert.strictEqual(treeItem, node)
	})

	// ── sync.onDidFloatFile triggers refresh ──────────────────────────────────

	test('tree refreshes on float file event', async () => {
		const changePromise = waitForEvent(tree.onDidChangeTreeData)
		// Directly inject floating state through WorkspaceSync internals
		// by writing an unassigned file (triggering the float event via file watcher)
		sync['_floatingDirty'].add('src/test-float.ts')
		sync['_onDidFloatFile'].fire({ relativePath: 'src/test-float.ts' })
		await changePromise
	})
})
