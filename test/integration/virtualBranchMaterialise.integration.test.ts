import * as assert from 'node:assert'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as vscode from 'vscode'
import { TmpRepo } from '../helpers/tmpRepo'
import { ConfigService } from '../../src/configService'
import { BranchStackService, worktreePath } from '../../src/branchStackService'
import { VirtualBranchStore } from '../../src/virtualBranchStore'
import { getDefaultGitRunner } from '../../src/gitRunner'

// ─── Integration: virtual branch → materialise → commit ─────────────────────
//
// Drives the full virtual-branch pipeline end-to-end against a real git repo:
// add branch virtually, seed the virtual store with three files, materialise
// the branch, then commit and verify the resulting worktree's HEAD matches.

suite('Virtual branch materialise — integration', () => {
	let repo: TmpRepo
	let config: ConfigService
	let store: VirtualBranchStore
	let svc: BranchStackService

	before(() => {
		repo = TmpRepo.create('virtual-materialise')
	})
	after(() => repo.dispose())

	setup(async () => {
		config = new ConfigService()
		await config.load(vscode.Uri.file(repo.root))
		store = new VirtualBranchStore()
		await store.load(vscode.Uri.file(repo.root), config.getVirtualBranches())
		svc = new BranchStackService(config, store)
		await svc.initStack(vscode.Uri.file(repo.root))
	})

	teardown(async () => {
		store.dispose()
		config.dispose()
		// Remove worktrees on disk so subsequent tests start clean.
		const wtDir = path.join(repo.root, '.worktrees')
		if (fs.existsSync(wtDir)) {
			const runner = getDefaultGitRunner()
			for (const entry of fs.readdirSync(wtDir)) {
				if (entry === 'virtual') continue
				const full = path.join(wtDir, entry)
				if (fs.statSync(full, { throwIfNoEntry: false })?.isDirectory()) {
					try { await runner.run(['worktree', 'remove', '--force', full], { cwd: repo.root }) } catch { /* ignore */ }
				}
			}
			try { await runner.run(['worktree', 'prune'], { cwd: repo.root }) } catch { /* ignore */ }
			try { fs.rmSync(wtDir, { recursive: true, force: true }) } catch { /* ignore */ }
		}
	})

	test('add virtual, seed three files, materialise — worktree contains every file with exact contents', async () => {
		await svc.addBranchToStack('feature/v-mat', 'main', '#888', { virtual: true })

		// No worktree yet.
		assert.strictEqual(svc.worktreeExists('feature/v-mat'), false)

		// Seed three files via the virtual store (as WorkspaceSync would).
		await store.writeFile('feature/v-mat', 'src/a.ts', Buffer.from('export const a = 1\n'))
		await store.writeFile('feature/v-mat', 'src/b.ts', Buffer.from('export const b = 2\n'))
		await store.writeFile('feature/v-mat', 'docs/README.md', Buffer.from('# v-mat\n'))

		// Materialise.
		await svc.materialiseBranch('feature/v-mat')

		assert.strictEqual(svc.worktreeExists('feature/v-mat'), true)
		const wtDir = worktreePath(vscode.Uri.file(repo.root), 'feature/v-mat').fsPath
		assert.strictEqual(fs.readFileSync(path.join(wtDir, 'src/a.ts'), 'utf-8'), 'export const a = 1\n')
		assert.strictEqual(fs.readFileSync(path.join(wtDir, 'src/b.ts'), 'utf-8'), 'export const b = 2\n')
		assert.strictEqual(fs.readFileSync(path.join(wtDir, 'docs/README.md'), 'utf-8'), '# v-mat\n')

		// Virtual flag is cleared and the store no longer tracks the branch.
		assert.notStrictEqual(config.getBranch('feature/v-mat')?.virtual, true)
		assert.deepStrictEqual(store.listFiles('feature/v-mat'), [])

		// Worktree is checked out at the expected branch.
		const runner = getDefaultGitRunner()
		const { stdout } = await runner.run(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: wtDir })
		assert.strictEqual(stdout.trim(), 'feature/v-mat')

		// Commit in the worktree — the cumulative result is a single commit with three new files.
		await runner.run(['add', '.'], { cwd: wtDir })
		await runner.run(
			['-c', 'user.email=t@gitbraid', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', 'commit', '-m', 'v-mat'],
			{ cwd: wtDir },
		)
		const { stdout: lsStdout } = await runner.run(['ls-tree', '-r', '--name-only', 'HEAD'], { cwd: wtDir })
		const tree = lsStdout.split('\n').filter(Boolean).sort()
		assert.ok(tree.includes('src/a.ts'), 'src/a.ts should be in tree')
		assert.ok(tree.includes('src/b.ts'), 'src/b.ts should be in tree')
		assert.ok(tree.includes('docs/README.md'), 'docs/README.md should be in tree')
	})
})
