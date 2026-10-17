import * as assert from 'node:assert'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as vscode from 'vscode'
import { TmpRepo } from './helpers/tmpRepo'
import { ConfigService } from '../src/configService'
import { BranchStackService, worktreePath } from '../src/branchStackService'
import { WorkspaceSync } from '../src/workspaceSync'
import { StackResolver } from '../src/stackResolver'
import { getDefaultGitRunner } from '../src/gitRunner'
import type { IGitRunner } from '../src/gitRunner'
import {
	SparseWorktreeService, coneCovers, coneDirFor, dirsForFiles, parseGitVersion, versionAtLeast,
} from '../src/sparseWorktree'

suite('sparseWorktree: pure helpers', () => {
	test('parseGitVersion handles vendor suffixes', () => {
		assert.deepStrictEqual(parseGitVersion('git version 2.43.0'), [2, 43])
		assert.deepStrictEqual(parseGitVersion('git version 2.39.3 (Apple Git-146)'), [2, 39])
		assert.deepStrictEqual(parseGitVersion('git version 2.44.0.windows.1'), [2, 44])
		assert.strictEqual(parseGitVersion('nope'), undefined)
	})

	test('versionAtLeast compares major then minor', () => {
		assert.ok(versionAtLeast([2, 25], [2, 25]))
		assert.ok(versionAtLeast([3, 0], [2, 25]))
		assert.ok(!versionAtLeast([2, 24], [2, 25]))
		assert.ok(!versionAtLeast([1, 99], [2, 25]))
	})

	test('coneDirFor: root files need no cone entry, backslashes normalise', () => {
		assert.strictEqual(coneDirFor('README.md'), undefined)
		assert.strictEqual(coneDirFor('src/a/b.ts'), 'src/a')
		assert.strictEqual(coneDirFor('src\\a\\b.ts'), 'src/a')
	})

	test('coneCovers matches the entry or a descendant, not a name prefix', () => {
		assert.ok(coneCovers(['src'], 'src'))
		assert.ok(coneCovers(['src'], 'src/deep/er'))
		assert.ok(!coneCovers(['src'], 'src2'))
		assert.ok(!coneCovers([], 'src'))
	})

	test('dirsForFiles collapses descendants and adds extras', () => {
		assert.deepStrictEqual(
			dirsForFiles(['a/x.ts', 'a/b/y.ts', 'c/z.ts', 'top.ts'], ['cfg/']),
			['a', 'c', 'cfg'],
		)
		assert.deepStrictEqual(dirsForFiles([]), [])
	})
})

suite('sparseWorktree: git version fallback', () => {
	test('git below 2.25 degrades to full worktrees with one warning', async () => {
		let calls = 0
		const runner: IGitRunner = {
			run: async (args) => {
				calls++
				return args[0] === '--version'
					? { stdout: 'git version 2.20.1\n', stderr: '', exitCode: 0 }
					: { stdout: '', stderr: '', exitCode: 0 }
			},
		}
		const svc = new SparseWorktreeService(runner)
		const s = { mode: 'always' as const, threshold: 0, alwaysInclude: [] }
		assert.strictEqual(await svc.shouldUseSparse('/r', 'main', s), false)
		assert.strictEqual(await svc.shouldUseSparse('/r', 'main', s), false)
		assert.strictEqual(calls, 1, 'the version is probed once')
	})

	test('mode off never touches git', async () => {
		const runner: IGitRunner = { run: async () => { throw new Error('should not run') } }
		const svc = new SparseWorktreeService(runner)
		assert.strictEqual(await svc.shouldUseSparse('/r', 'main', { mode: 'off', threshold: 0, alwaysInclude: [] }), false)
	})
})

suite('sparseWorktree: real repo', function () {
	this.timeout(30_000)
	const runner = getDefaultGitRunner()
	let repo: TmpRepo

	suiteSetup(() => {
		repo = TmpRepo.create('sparse')
		repo.writeFile('a/x.txt', 'a\n')
		repo.writeFile('b/y.txt', 'b\n')
		repo.writeFile('c/z.txt', 'c\n')
		repo.writeFile('root.txt', 'r\n')
		repo.commit('layout')
	})
	suiteTeardown(() => repo.dispose())

	async function addWorktree(name: string): Promise<string> {
		const wt = path.join(repo.root, '.worktrees', name)
		const r = await runner.run(['worktree', 'add', '--no-checkout', '-b', name, wt, 'main'], { cwd: repo.root })
		assert.strictEqual(r.exitCode, 0, r.stderr)
		return wt
	}

	test('only the cone is on disk and status is clean (no spurious deletions)', async () => {
		const svc = new SparseWorktreeService()
		const wt = await addWorktree('s1')
		await svc.initCone(wt, ['a'], 's1')
		assert.ok(fs.existsSync(path.join(wt, 'a/x.txt')))
		assert.ok(fs.existsSync(path.join(wt, 'root.txt')))
		assert.ok(!fs.existsSync(path.join(wt, 'b')))
		assert.ok(!fs.existsSync(path.join(wt, 'c')))
		const st = await runner.run(['status', '--porcelain'], { cwd: wt })
		assert.strictEqual(st.stdout, '')
		assert.ok(await svc.isSparse(wt))
	})

	test('ensureInCone adds the directory once and is a no-op afterwards', async () => {
		const svc = new SparseWorktreeService()
		const wt = await addWorktree('s2')
		await svc.initCone(wt, ['a'], 's2')

		await svc.ensureInCone(wt, 'c/new.txt')
		assert.ok(fs.existsSync(path.join(wt, 'c/z.txt')))
		assert.deepStrictEqual((await svc.listCone(wt)).sort(), ['a', 'c'])

		const real = getDefaultGitRunner()
		const adds: string[] = []
		const counting = new SparseWorktreeService({
			run: (args, o) => { if (args[1] === 'add') adds.push(args.join(' ')); return real.run(args, o) },
		})
		await counting.ensureInCone(wt, 'c/new.txt')
		await counting.ensureInCone(wt, 'c/deeper/other.txt')
		await counting.ensureInCone(wt, 'root-level.txt')
		assert.deepStrictEqual(adds, [], 'covered paths and root files do not touch git')
		assert.deepStrictEqual((await svc.listCone(wt)).sort(), ['a', 'c'])
	})

	test('concurrent ensureInCone calls for different directories all land', async () => {
		const svc = new SparseWorktreeService()
		const wt = await addWorktree('s3')
		await svc.initCone(wt, ['a'], 's3')
		await Promise.all([svc.ensureInCone(wt, 'b/1.txt'), svc.ensureInCone(wt, 'c/1.txt'), svc.ensureInCone(wt, 'b/2.txt')])
		assert.deepStrictEqual((await svc.listCone(wt)).sort(), ['a', 'b', 'c'])
	})

	test('ensureInCone on a full worktree does nothing', async () => {
		const svc = new SparseWorktreeService()
		const wt = path.join(repo.root, '.worktrees', 's4')
		await runner.run(['worktree', 'add', '-b', 's4', wt, 'main'], { cwd: repo.root })
		await svc.ensureInCone(wt, 'c/x.txt')
		assert.ok(!(await svc.isSparse(wt)))
		assert.ok(await svc.isInCone(wt, 'c/x.txt'))
	})

	test('isInCone reflects the cone', async () => {
		const svc = new SparseWorktreeService()
		const wt = await addWorktree('s5')
		await svc.initCone(wt, ['a'], 's5')
		assert.ok(await svc.isInCone(wt, 'a/x.txt'))
		assert.ok(!(await svc.isInCone(wt, 'c/z.txt')))
		assert.ok(await svc.isInCone(wt, 'root.txt'))
	})

	test('convert sparse then full restores the whole tree', async () => {
		const svc = new SparseWorktreeService()
		const wt = path.join(repo.root, '.worktrees', 's6')
		await runner.run(['worktree', 'add', '-b', 's6', wt, 'main'], { cwd: repo.root })
		await svc.convert(wt, 'sparse', ['a'])
		assert.ok(!fs.existsSync(path.join(wt, 'c')))
		assert.ok(await svc.isSparse(wt))
		await svc.convert(wt, 'full')
		assert.ok(fs.existsSync(path.join(wt, 'c/z.txt')))
		assert.ok(!(await svc.isSparse(wt)))
	})

	test('failures surface as errors naming the git command', async () => {
		const svc = new SparseWorktreeService()
		const failing: IGitRunner = { run: async () => ({ stdout: '', stderr: 'fatal: boom', exitCode: 128 }) }
		await assert.rejects(() => new SparseWorktreeService(failing).initCone('/wt', ['a'], 'x'), /sparse-checkout init --cone failed: fatal: boom/)
	})
})

suite('sparseWorktree: BranchStackService integration', function () {
	this.timeout(30_000)
	let repo: TmpRepo
	let config: ConfigService
	let svc: BranchStackService
	// The shared `git` singleton runs worktree commands in the fixture repo, so
	// branch names must not collide with other suites' leftovers.
	let SP = '', FULL = '', AUTO = ''
	let seq = 0
	const cfg = () => vscode.workspace.getConfiguration('gitbraid')

	suiteSetup(() => {
		repo = TmpRepo.create('sparse-svc')
		repo.writeFile('a/x.txt', 'a\n')
		repo.writeFile('c/z.txt', 'c\n')
		repo.commit('layout')
	})
	suiteTeardown(() => repo.dispose())

	setup(async () => {
		seq++
		const tag = `${String(Date.now())}-${String(seq)}`
		SP = `feature/sp-${tag}`
		FULL = `feature/full-${tag}`
		AUTO = `feature/auto-${tag}`
		config = new ConfigService()
		await config.load(vscode.Uri.file(repo.root))
		svc = new BranchStackService(config)
		await svc.initStack(vscode.Uri.file(repo.root))
	})

	teardown(async () => {
		for (const k of ['sparseWorktrees', 'sparseWorktreeThreshold', 'sparseAlwaysInclude']) {
			await cfg().update(k, undefined, vscode.ConfigurationTarget.Global)
		}
		config.dispose()
		const runner = getDefaultGitRunner()
		const wtDir = path.join(repo.root, '.worktrees')
		if (fs.existsSync(wtDir)) {
			for (const e of fs.readdirSync(wtDir)) {
				const full = path.join(wtDir, e)
				if (fs.statSync(full, { throwIfNoEntry: false })?.isDirectory()) {
					await runner.run(['worktree', 'remove', '--force', full], { cwd: repo.root }).catch(() => undefined)
				}
			}
			await runner.run(['worktree', 'prune'], { cwd: repo.root }).catch(() => undefined)
			fs.rmSync(wtDir, { recursive: true, force: true })
		}
		await getDefaultGitRunner().run(['branch', '-D', SP, FULL, AUTO], { cwd: repo.root }).catch(() => undefined)
	})

	const wtOf = (name: string) => worktreePath(vscode.Uri.file(repo.root), name).fsPath

	test('always: new worktree holds only alwaysInclude plus root files', async () => {
		await cfg().update('sparseWorktrees', 'always', vscode.ConfigurationTarget.Global)
		await cfg().update('sparseAlwaysInclude', ['a'], vscode.ConfigurationTarget.Global)
		await svc.addBranchToStack(SP, 'main', '#123456')
		assert.ok(fs.existsSync(path.join(wtOf(SP), 'a/x.txt')))
		assert.ok(!fs.existsSync(path.join(wtOf(SP), 'c')))
		assert.ok(fs.existsSync(path.join(wtOf(SP), 'README.md')))
	})

	test('off: full worktree', async () => {
		await cfg().update('sparseWorktrees', 'off', vscode.ConfigurationTarget.Global)
		await svc.addBranchToStack(FULL, 'main', '#123456')
		assert.ok(fs.existsSync(path.join(wtOf(FULL), 'c/z.txt')))
		assert.ok(!(await svc.sparse.isSparse(wtOf(FULL))))
	})

	test('auto: sparse only above the threshold', async () => {
		await cfg().update('sparseWorktrees', 'auto', vscode.ConfigurationTarget.Global)
		await cfg().update('sparseWorktreeThreshold', 1_000_000, vscode.ConfigurationTarget.Global)
		await svc.addBranchToStack(FULL, 'main', '#123456')
		assert.ok(!(await svc.sparse.isSparse(wtOf(FULL))))

		await cfg().update('sparseWorktreeThreshold', 1, vscode.ConfigurationTarget.Global)
		await svc.addBranchToStack(AUTO, 'main', '#123456')
		assert.ok(await svc.sparse.isSparse(wtOf(AUTO)))
	})

	test('ownedDirs covers file and hunk assignments', async () => {
		await svc.addBranchToStack(SP, 'main', '#123456')
		await config.setAssignment('a/x.txt', SP)
		await config.setHunkAssignment('c/z.txt', 0, SP)
		assert.deepStrictEqual(svc.ownedDirs(SP, ['cfg']), ['a', 'c', 'cfg'])
	})

	test('setWorktreeSparse converts an existing worktree both ways', async () => {
		await cfg().update('sparseWorktrees', 'off', vscode.ConfigurationTarget.Global)
		await svc.addBranchToStack(SP, 'main', '#123456')
		await config.setAssignment('a/x.txt', SP)
		await svc.setWorktreeSparse(SP, true)
		assert.ok(!fs.existsSync(path.join(wtOf(SP), 'c')))
		assert.ok(fs.existsSync(path.join(wtOf(SP), 'a/x.txt')))
		await svc.setWorktreeSparse(SP, false)
		assert.ok(fs.existsSync(path.join(wtOf(SP), 'c/z.txt')))
		await assert.rejects(() => svc.setWorktreeSparse('nope', true), /no worktree/)
	})

	test('a save outside the cone widens it first, so the copy is a normal untracked file', async () => {
		await cfg().update('sparseWorktrees', 'always', vscode.ConfigurationTarget.Global)
		await cfg().update('sparseAlwaysInclude', ['a'], vscode.ConfigurationTarget.Global)
		await svc.addBranchToStack(SP, 'main', '#123456')
		const wt = wtOf(SP)
		assert.ok(!fs.existsSync(path.join(wt, 'c')), 'precondition: c/ is outside the cone')

		repo.writeFile('c/new.txt', 'new\n')
		await config.setAssignment('c/new.txt', SP)
		const sync = new WorkspaceSync(config)
		sync.setSparseService(svc.sparse)
		sync.init(vscode.Uri.file(repo.root))
		try {
			assert.strictEqual(await sync.syncAllAssigned(), 1)
		} finally {
			sync.dispose()
		}

		assert.strictEqual(fs.readFileSync(path.join(wt, 'c/new.txt'), 'utf-8'), 'new\n')
		assert.ok(fs.existsSync(path.join(wt, 'c/z.txt')), 'the whole directory arrived with the cone')
		const st = await getDefaultGitRunner().run(['status', '--porcelain'], { cwd: wt })
		assert.strictEqual(st.stdout.trim(), '?? c/new.txt')
	})

	test('resolver returns the same bytes for an out-of-cone file in sparse and full mode', async () => {
		await cfg().update('sparseWorktrees', 'always', vscode.ConfigurationTarget.Global)
		await cfg().update('sparseAlwaysInclude', ['a'], vscode.ConfigurationTarget.Global)
		await svc.addBranchToStack(SP, 'main', '#123456')
		await config.setAssignment('c/z.txt', SP)
		const resolver = new StackResolver(config, svc)
		const root = vscode.Uri.file(repo.root)

		assert.ok(!fs.existsSync(path.join(wtOf(SP), 'c/z.txt')), 'precondition: file is outside the cone')
		const sparse = await resolver.getResolvedContent(root, 'c/z.txt')
		await svc.setWorktreeSparse(SP, false)
		assert.ok(fs.existsSync(path.join(wtOf(SP), 'c/z.txt')))
		const full = await resolver.getResolvedContent(root, 'c/z.txt')
		assert.ok(sparse, 'served from committed state')
		assert.strictEqual(Buffer.from(sparse).toString(), 'c\n')
		assert.deepStrictEqual(Buffer.from(sparse), Buffer.from(full ?? []))
	})
})
