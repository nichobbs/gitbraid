import * as assert from 'node:assert'
import * as vscode from 'vscode'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { ConfigService } from '../src/configService'
import { BranchStackService, branchToWorktreeDirName, worktreePath } from '../src/branchStackService'
import { BranchStackError } from '../src/errors'
import { git } from '../src/gitFunctions'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function wsRoot(): vscode.Uri {
	return vscode.workspace.workspaceFolders![0].uri
}

function cleanup() {
	try { fs.rmSync(path.join(wsRoot().fsPath, '.worktrees'), { recursive: true }) } catch {}
	try { fs.rmSync(path.join(wsRoot().fsPath, '.gitignore')) } catch {}
}

async function removeAllTestWorktrees(): Promise<void> {
	const wtDir = path.join(wsRoot().fsPath, '.worktrees')
	if (!fs.existsSync(wtDir)) {
		return
	}
	for (const entry of fs.readdirSync(wtDir)) {
		if (entry.endsWith('.json') || entry.endsWith('.tmp')) {
			continue
		}
		const p = path.join(wtDir, entry)
		if (fs.statSync(p, { throwIfNoEntry: false })?.isDirectory()) {
			try { await git.worktree.remove('"' + p + '"', true) } catch {}
		}
	}
}

// ─── Suite ───────────────────────────────────────────────────────────────────

suite('BranchStackService', () => {

	let config: ConfigService
	let svc: BranchStackService

	suiteSetup('BranchStackService setup', async () => {
		// Ensure we have a clean git repo (proj1 suite sets this up)
		await git.init()
		await git.worktree.prune()
		try { await git.add(undefined, '.gitkeep') } catch {}
		try { await git.commit('initial commit', '--no-gpg-sign') } catch {}
	})

	setup(async () => {
		cleanup()
		ConfigService.resetInstance()
		BranchStackService.resetInstance()
		config = ConfigService.getInstance()
		await config.load(wsRoot())
		svc = BranchStackService.getInstance(config)
		try { await git.worktree.prune() } catch {}
	})

	teardown(async () => {
		await removeAllTestWorktrees()
		cleanup()
		BranchStackService.resetInstance()
		ConfigService.resetInstance()
		try { await git.worktree.prune() } catch {}
	})

	// ── Utilities ────────────────────────────────────────────────────────────

	test('branchToWorktreeDirName: replaces slashes with dashes and appends a stable hash suffix', () => {
		const dir = branchToWorktreeDirName('feature/docs')
		assert.match(dir, /^feature-docs__[a-f0-9]{7}$/)
		const dir2 = branchToWorktreeDirName('feat/scope/sub')
		assert.match(dir2, /^feat-scope-sub__[a-f0-9]{7}$/)
		const dir3 = branchToWorktreeDirName('main')
		assert.match(dir3, /^main__[a-f0-9]{7}$/)
	})

	test('branchToWorktreeDirName: deterministic', () => {
		assert.strictEqual(
			branchToWorktreeDirName('feature/docs'),
			branchToWorktreeDirName('feature/docs'),
		)
	})

	test('branchToWorktreeDirName: is injective for slug-colliding names', () => {
		// feat/a and feat-a used to map to the same directory (see T9 / reviews
		// bugs.md B4); now they must differ.
		assert.notStrictEqual(
			branchToWorktreeDirName('feature/a'),
			branchToWorktreeDirName('feature-a'),
		)
	})

	test('worktreePath: returns URI under .worktrees/ with hashed leaf', () => {
		const p = worktreePath(wsRoot(), 'feature/docs')
		assert.match(p.fsPath, new RegExp(`\\${path.sep}\\.worktrees\\${path.sep}feature-docs__[a-f0-9]{7}$`))
	})

	// ── initStack ────────────────────────────────────────────────────────────

	test('initStack: no-op with empty config', async () => {
		await svc.initStack(wsRoot())
		// Should not throw; .worktrees dir created
		const wtDir = path.join(wsRoot().fsPath, '.worktrees')
		assert.ok(fs.existsSync(wtDir), '.worktrees directory should be created')
	})

	test('initStack: creates worktree for each config branch', async () => {
		// Pre-populate config with one branch
		await config.addBranch({ name: 'feature/docs', color: '#4CAF50', base: 'main' })
		await svc.initStack(wsRoot())
		assert.ok(svc.worktreeExists('feature/docs'), 'worktree should exist for feature/docs')
	})

	test('initStack: skips branches that already have a worktree', async () => {
		await config.addBranch({ name: 'feature/docs', color: '#4CAF50', base: 'main' })
		await svc.initStack(wsRoot())
		// Second call should not throw
		await svc.initStack(wsRoot())
		assert.ok(svc.worktreeExists('feature/docs'))
	})

	// ── addBranchToStack ─────────────────────────────────────────────────────

	test('addBranchToStack: creates branch and worktree', async () => {
		await svc.initStack(wsRoot())
		await svc.addBranchToStack('feature/docs', 'main')
		assert.ok(svc.worktreeExists('feature/docs'), 'worktree should exist')
		assert.strictEqual(config.getStack().length, 1)
		assert.strictEqual(config.getStack()[0].name, 'feature/docs')
	})

	test('addBranchToStack: uses provided color', async () => {
		await svc.initStack(wsRoot())
		await svc.addBranchToStack('feature/docs', 'main', '#4CAF50')
		assert.strictEqual(config.getBranch('feature/docs')?.color, '#4CAF50')
	})

	test('addBranchToStack: throws BranchStackError on circular base', async () => {
		await svc.initStack(wsRoot())
		await svc.addBranchToStack('feature/docs', 'main')
		await svc.addBranchToStack('feature/impl', 'feature/docs')
		// feature/docs bases on feature/impl would be: feature/docs → feature/impl → feature/docs
		// This is circular. The service should reject it before touching git.
		// We simulate by directly manipulating config so feature/impl → feature/docs
		// is already recorded, then trying to add a branch whose chain cycles back.
		// Simplest way: add a branch that tries to base on itself.
		await assert.rejects(
			() => svc.addBranchToStack('feature/docs-cycle', 'feature/docs-cycle'),
			BranchStackError
		)
	})

	// ── removeBranchFromStack ─────────────────────────────────────────────────

	test('removeBranchFromStack: removes worktree and config entry', async () => {
		await svc.initStack(wsRoot())
		await svc.addBranchToStack('feature/docs', 'main')
		assert.ok(svc.worktreeExists('feature/docs'))
		await svc.removeBranchFromStack('feature/docs', true)
		assert.strictEqual(config.getStack().length, 0)
		assert.ok(!svc.worktreeExists('feature/docs'), 'worktree should be removed')
	})

	test('removeBranchFromStack: no-op if branch not in config', async () => {
		await svc.initStack(wsRoot())
		// Should not throw
		await svc.removeBranchFromStack('nonexistent', true)
	})

	// ── getWorktreePath ───────────────────────────────────────────────────────

	test('getWorktreePath: returns expected URI', async () => {
		await svc.initStack(wsRoot())
		const p = svc.getWorktreePath('feature/docs')
		assert.ok(p.fsPath.includes(path.join('.worktrees', 'feature-docs')))
	})

	test('getWorktreePath: throws if not initialised', () => {
		// Create a fresh uninitialised instance
		BranchStackService.resetInstance()
		ConfigService.resetInstance()
		const freshConfig = ConfigService.getInstance()
		const freshSvc = BranchStackService.getInstance(freshConfig)
		assert.throws(() => freshSvc.getWorktreePath('feature/docs'), BranchStackError)
	})

	// ── Orphan pruning ────────────────────────────────────────────────────────

	test('initStack: skips non-directory entries inside .worktrees/ during pruning', async () => {
		// Create .worktrees/ dir and put a plain file (not a branch dir) inside it
		await svc.initStack(wsRoot())
		const wtDir = path.join(wsRoot().fsPath, '.worktrees')
		const orphanFile = path.join(wtDir, 'some-random-file.txt')
		fs.writeFileSync(orphanFile, 'not a branch')
		// Re-init — _pruneOrphans should skip non-directories (covers the !isDirectory() continue)
		BranchStackService.resetInstance()
		const freshSvc = BranchStackService.getInstance(config)
		await assert.doesNotReject(() => freshSvc.initStack(wsRoot()))
		// The plain file should still be there (it was skipped, not deleted)
		assert.ok(fs.existsSync(orphanFile), 'non-directory entry should not be deleted')
	})

	test('initStack: prunes orphaned worktree directories', async () => {
		// Manually create a worktree not in config
		await svc.initStack(wsRoot())
		await svc.addBranchToStack('feature/docs', 'main')

		// Remove from config but leave the worktree on disk
		await config.removeBranch('feature/docs')

		// Re-init should prune the orphan
		BranchStackService.resetInstance()
		const freshSvc = BranchStackService.getInstance(config)
		await freshSvc.initStack(wsRoot())

		assert.ok(!freshSvc.worktreeExists('feature/docs'), 'orphan worktree should be pruned')
	})
})
