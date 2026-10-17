import * as assert from 'node:assert'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as vscode from 'vscode'
import { ConfigService } from '../src/configService'
import { BranchStackService } from '../src/branchStackService'
import { VirtualBranchStore } from '../src/virtualBranchStore'
import { git } from '../src/gitFunctions'
import { getDefaultGitRunner } from '../src/gitRunner'
import {
	StackSimulation,
	WorktreeAdopter,
	parseLiveStatusPaths,
	parseWorktreeList,
	type ExternalWorktree,
} from '../src/worktreeAdopter'
import { describeAdoptPrediction } from '../src/commands/_helpers'
import { TmpRepo } from './helpers/tmpRepo'
import { removeDirBestEffort } from './helpers/removeDir'

const runner = getDefaultGitRunner()

async function gitOk(cwd: string, ...args: string[]): Promise<string> {
	const r = await runner.run(['-c', 'commit.gpgsign=false', ...args], { cwd })
	if (r.exitCode !== 0) {
		throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${r.stderr}`)
	}
	return r.stdout.trim()
}

/**
 * Read a text file with line endings normalised: Windows runners check out
 * with `core.autocrlf=true`, so files that round-trip through git (stash
 * apply, rebase) come back as CRLF.
 */
function readText(file: string): string {
	return fs.readFileSync(file, 'utf-8').replaceAll('\r\n', '\n')
}

async function commitFile(cwd: string, rel: string, content: string, message: string): Promise<void> {
	fs.mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true })
	fs.writeFileSync(path.join(cwd, rel), content)
	await gitOk(cwd, 'add', '-A')
	await gitOk(cwd, 'commit', '-m', message)
}

// ─── Pure parsing ────────────────────────────────────────────────────────────

suite('worktreeAdopter: parseWorktreeList', () => {
	test('parses branch, detached, bare, locked and prunable entries', () => {
		const out = [
			'worktree /repo',
			'HEAD aaa',
			'branch refs/heads/main',
			'',
			'worktree /agents/one',
			'HEAD bbb',
			'branch refs/heads/feature/one',
			'locked agent busy',
			'',
			'worktree /agents/detached',
			'HEAD ccc',
			'detached',
			'',
			'worktree /gone',
			'HEAD ddd',
			'branch refs/heads/gone',
			'prunable gitdir file points to non-existent location',
			'',
			'worktree /bare.git',
			'bare',
			'',
		].join('\n')
		const entries = parseWorktreeList(out)
		assert.strictEqual(entries.length, 5)
		assert.deepStrictEqual(entries[0], { path: '/repo', head: 'aaa', branch: 'main', bare: false, locked: false, prunable: false })
		assert.strictEqual(entries[1].branch, 'feature/one')
		assert.strictEqual(entries[1].locked, true)
		assert.strictEqual(entries[2].branch, undefined)
		assert.strictEqual(entries[3].prunable, true)
		assert.strictEqual(entries[4].bare, true)
	})
})

suite('worktreeAdopter: parseLiveStatusPaths', () => {
	test('keeps modified, added, renamed and untracked paths; drops deletions', () => {
		const out = [' M src/a.ts', 'A  src/b.ts', 'R  src/new.ts', 'src/old.ts', ' D src/gone.ts', 'D  src/staged-gone.ts', '?? notes.md', ''].join('\0')
		assert.deepStrictEqual(parseLiveStatusPaths(out), ['src/a.ts', 'src/b.ts', 'src/new.ts', 'notes.md'])
	})
})

suite('worktreeAdopter: describeAdoptPrediction', () => {
	test('clean, unsupported and conflicted candidates', () => {
		assert.strictEqual(describeAdoptPrediction({ supported: true, conflicted: false, files: [], conflictsWith: [] }).icon, '$(check)')
		assert.match(describeAdoptPrediction({ supported: false, conflicted: false, files: [], conflictsWith: [] }).description, /2\.38/)
		const d = describeAdoptPrediction({
			supported: true,
			conflicted: true,
			files: ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
			conflictsWith: ['feature/x', 'feature/y'],
		})
		assert.strictEqual(d.icon, '$(warning)')
		assert.strictEqual(d.description, 'conflicts with feature/x, feature/y')
		assert.strictEqual(d.detail, '7 files: a, b, c, d, e, +2 more')
	})
})

// ─── Simulation (standalone repo) ────────────────────────────────────────────

suite('worktreeAdopter: StackSimulation', () => {
	let repo: TmpRepo

	suiteSetup(async () => {
		repo = TmpRepo.create('adopt-sim')
		repo.writeFile('shared.txt', 'one\ntwo\nthree\n')
		repo.commit('shared')
		for (const [branch, file, content] of [
			['sim/a', 'shared.txt', 'one\nA\nthree\n'],
			['sim/b', 'shared.txt', 'one\nB\nthree\n'],
			['sim/c', 'other.txt', 'c\n'],
		]) {
			await gitOk(repo.root, 'checkout', '-q', '-b', branch, 'main')
			await commitFile(repo.root, file, content, branch)
		}
		await gitOk(repo.root, 'checkout', '-q', 'main')
	})
	suiteTeardown(() => repo.dispose())

	test('flags a conflict against the layer that touched the same lines', async () => {
		const sim = await StackSimulation.start(runner, repo.root, 'main')
		const a = await sim.push('sim/a')
		assert.strictEqual(a.conflicted, false)
		assert.strictEqual(a.supported, true)

		const b = await sim.predict('sim/b')
		assert.strictEqual(b.conflicted, true)
		assert.deepStrictEqual(b.files, ['shared.txt'])
		assert.deepStrictEqual(b.conflictsWith, ['sim/a'])

		const c = await sim.predict('sim/c')
		assert.strictEqual(c.conflicted, false)
	})

	test('a conflicted layer is recorded but not folded into later checks', async () => {
		const sim = await StackSimulation.start(runner, repo.root, 'main')
		await sim.push('sim/a')
		const b = await sim.push('sim/b')
		assert.strictEqual(b.conflicted, true)
		assert.deepStrictEqual(sim.layers, ['sim/a', 'sim/b'])
		// sim/c is still checked against main + sim/a only, and stays clean.
		assert.strictEqual((await sim.push('sim/c')).conflicted, false)
	})

	test('order matters: the same pair is clean once either is alone on main', async () => {
		const sim = await StackSimulation.start(runner, repo.root, 'main')
		assert.strictEqual((await sim.predict('sim/b')).conflicted, false)
	})

	test('an unknown branch reports the check as unsupported rather than a conflict', async () => {
		const sim = await StackSimulation.start(runner, repo.root, 'main')
		const p = await sim.predict('sim/does-not-exist')
		assert.strictEqual(p.supported, false)
		assert.strictEqual(p.conflicted, false)
	})

	test('start() rejects a base that does not resolve', async () => {
		await assert.rejects(StackSimulation.start(runner, repo.root, 'nope/nothing'), /Cannot resolve base/)
	})
})

// ─── Adoption (shared test workspace) ────────────────────────────────────────

// BranchStackService creates worktrees through the `git` singleton, which
// always runs in `workspaceFolders[0]` — so, like doctorService.test.ts,
// this suite drives the shared test workspace rather than a TmpRepo.

function wsRoot(): vscode.Uri {
	return vscode.workspace.workspaceFolders![0].uri
}

suite('worktreeAdopter: WorktreeAdopter', () => {
	let config: ConfigService
	let store: VirtualBranchStore
	let svc: BranchStackService
	let adopter: WorktreeAdopter
	let outside: string
	let base: string
	const branches = ['zadopt/a', 'zadopt/b', 'zadopt/c', 'zadopt/d']
	const wsFiles = ['zadopt-a.txt', 'zadopt-b.txt', 'zadopt-b-new.txt', 'zadopt-conflict.txt']

	suiteSetup(async () => {
		await git.init()
		await git.worktree.prune()
		try { await git.add(undefined, '.gitkeep') } catch { /* ignore */ }
		try { await git.commit('initial commit', '--no-gpg-sign') } catch { /* ignore */ }
		base = await gitOk(wsRoot().fsPath, 'rev-parse', '--abbrev-ref', 'HEAD')
	})

	setup(async () => {
		outside = fs.mkdtempSync(path.join(os.tmpdir(), 'gitbraid-adopt-ext-'))
		config = new ConfigService()
		await config.load(wsRoot())
		store = new VirtualBranchStore()
		await store.load(wsRoot(), config.getVirtualBranches())
		svc = new BranchStackService(config, store)
		await svc.initStack(wsRoot())
		adopter = new WorktreeAdopter(config, svc, wsRoot().fsPath)
	})

	teardown(async () => {
		const root = wsRoot().fsPath
		for (const b of branches) {
			if (config.getBranch(b)) {
				try { await svc.removeBranchFromStack(b, true) } catch { /* ignore */ }
			}
		}
		for (const name of ['a', 'b', 'c', 'd']) {
			await runner.run(['worktree', 'remove', '--force', path.join(outside, name)], { cwd: root })
		}
		await runner.run(['worktree', 'prune'], { cwd: root })
		for (const b of branches) {
			await runner.run(['branch', '-D', b], { cwd: root })
		}
		for (const f of wsFiles) {
			try { fs.rmSync(path.join(root, f)) } catch { /* ignore */ }
		}
		await runner.run(['stash', 'clear'], { cwd: root })
		store.dispose()
		config.dispose()
		try { fs.rmSync(path.join(root, '.worktrees'), { recursive: true, force: true }) } catch { /* ignore */ }
		removeDirBestEffort(outside, 'adopt-ext')
	})

	async function external(name: string): Promise<string> {
		const dir = path.join(outside, name)
		await gitOk(wsRoot().fsPath, 'worktree', 'add', '-q', '-b', `zadopt/${name}`, dir, base)
		return dir
	}

	function find(list: ExternalWorktree[], branch: string): ExternalWorktree {
		const wt = list.find((w) => w.branch === branch)
		assert.ok(wt, `expected ${branch} in ${JSON.stringify(list.map((w) => w.branch))}`)
		return wt
	}

	test('lists external worktrees, flags dirty ones, and skips the primary checkout', async () => {
		const a = await external('a')
		await external('b')
		fs.writeFileSync(path.join(a, 'scratch.txt'), 'wip')

		const list = await adopter.listExternalWorktrees()
		assert.strictEqual(find(list, 'zadopt/a').dirty, true)
		assert.strictEqual(find(list, 'zadopt/b').dirty, false)
		assert.ok(!list.some((w) => w.branch === base), 'primary checkout must not be listed')
	})

	test('adopts siblings into a stack: rebases, moves worktrees, carries uncommitted work', async () => {
		const root = wsRoot().fsPath
		const a = await external('a')
		const b = await external('b')
		await commitFile(a, 'zadopt-a.txt', 'a\n', 'a')
		await commitFile(b, 'zadopt-b.txt', 'b\n', 'b')
		// Uncommitted: a tracked edit and a brand-new file.
		fs.writeFileSync(path.join(b, 'zadopt-b.txt'), 'b edited\n')
		fs.writeFileSync(path.join(b, 'zadopt-b-new.txt'), 'new\n')

		const list = await adopter.listExternalWorktrees()
		const results = await adopter.adopt([
			{ worktree: find(list, 'zadopt/a'), base },
			{ worktree: find(list, 'zadopt/b'), base: 'zadopt/a' },
		], '#123456')

		assert.deepStrictEqual(results.map((r) => [r.branch, r.ok, r.message]), [
			['zadopt/a', true, undefined],
			['zadopt/b', true, undefined],
		])
		assert.strictEqual(config.getBranch('zadopt/a')?.base, base)
		assert.strictEqual(config.getBranch('zadopt/b')?.base, 'zadopt/a')

		// b now sits on top of a.
		const anc = await runner.run(['merge-base', '--is-ancestor', 'zadopt/a', 'zadopt/b'], { cwd: root })
		assert.strictEqual(anc.exitCode, 0)

		// Old worktrees are gone; GitBraid's own ones exist.
		assert.strictEqual(fs.existsSync(a), false)
		assert.strictEqual(fs.existsSync(b), false)
		const newB = svc.getWorktreePath('zadopt/b').fsPath
		assert.strictEqual(readText(path.join(newB, 'zadopt-b.txt')), 'b edited\n')
		assert.strictEqual(readText(path.join(newB, 'zadopt-b-new.txt')), 'new\n')

		// Uncommitted files are mirrored into the workspace and assigned.
		assert.strictEqual(readText(path.join(root, 'zadopt-b-new.txt')), 'new\n')
		assert.strictEqual(config.getAssignment('zadopt-b-new.txt'), 'zadopt/b')
		assert.strictEqual(config.getAssignment('zadopt-b.txt'), 'zadopt/b')

		// The temporary stash was dropped.
		assert.strictEqual(await gitOk(root, 'stash', 'list'), '')
	})

	test('stops at a conflicting rebase and leaves that branch and its changes as they were', async () => {
		const root = wsRoot().fsPath
		const c = await external('c')
		const d = await external('d')
		await commitFile(c, 'zadopt-conflict.txt', 'from c\n', 'c')
		await commitFile(d, 'zadopt-conflict.txt', 'from d\n', 'd')
		fs.writeFileSync(path.join(d, 'wip.txt'), 'still here\n')
		const dHead = await gitOk(root, 'rev-parse', 'zadopt/d')

		const list = await adopter.listExternalWorktrees()
		const sim = await adopter.simulate(base)
		await sim.push('zadopt/c')
		const predicted = await sim.predict('zadopt/d')
		assert.strictEqual(predicted.conflicted, true)
		assert.deepStrictEqual(predicted.conflictsWith, ['zadopt/c'])

		const results = await adopter.adopt([
			{ worktree: find(list, 'zadopt/c'), base },
			{ worktree: find(list, 'zadopt/d'), base: 'zadopt/c' },
		], '#123456')

		assert.strictEqual(results[0].ok, true)
		assert.strictEqual(results[1].ok, false)
		assert.match(results[1].message ?? '', /conflicts in zadopt-conflict\.txt/)
		assert.strictEqual(results[1].stash, undefined)
		assert.strictEqual(config.getBranch('zadopt/d'), undefined)

		// d is untouched: same commit, same worktree, uncommitted file restored.
		assert.strictEqual(await gitOk(root, 'rev-parse', 'zadopt/d'), dHead)
		assert.strictEqual(readText(path.join(d, 'wip.txt')), 'still here\n')
		assert.strictEqual(await gitOk(root, 'stash', 'list'), '')
	})

	test('later steps are skipped after a failure', async () => {
		const list: ExternalWorktree[] = [
			{ branch: 'zadopt/a', path: path.join(outside, 'missing'), dirty: false, locked: true },
			{ branch: 'zadopt/b', path: path.join(outside, 'missing-too'), dirty: false, locked: false },
		]
		const results = await adopter.adopt([
			{ worktree: list[0], base },
			{ worktree: list[1], base: 'zadopt/a' },
		], '#123456')
		assert.strictEqual(results[0].ok, false)
		assert.match(results[0].message ?? '', /locked/)
		assert.deepStrictEqual(results[1], { branch: 'zadopt/b', ok: false, skipped: true })
	})
})
