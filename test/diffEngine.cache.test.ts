import * as assert from 'node:assert'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { spawnSync } from 'node:child_process'
import { DiffEngine } from '../src/diffEngine'
import { TmpRepo } from './helpers/tmpRepo'
import { RecordingGitRunner } from './helpers/recordingGitRunner'

/**
 * Plan 15: the hunk cache is keyed on what the diff depends on (the HEAD it is
 * taken against, and the file's content), not on the file's mtime.
 *
 * These run real git against a temp repo, because the bugs they guard against
 * come from how git and the filesystem actually behave.
 */
suite('DiffEngine cache identity', function () {
	this.timeout(20_000)

	let repo: TmpRepo
	let runner: RecordingGitRunner
	let engine: DiffEngine

	setup(() => {
		repo = TmpRepo.create('diff-cache')
		runner = new RecordingGitRunner()
		engine = new DiffEngine(runner)
		repo.writeFile('f.txt', 'one\ntwo\nthree\n')
		repo.commit('add f')
	})

	teardown(() => repo.dispose())

	const file = () => path.join(repo.root, 'f.txt')

	test('REGRESSION: hunks are not served stale after HEAD moves with the file untouched', async () => {
		// Committing leaves the working file (and so its mtime) exactly as it was, but
		// the diff against the new HEAD is empty. An mtime-keyed cache returns the
		// old hunks until something touches the file.
		fs.writeFileSync(file(), 'one\nTWO\nthree\n')
		const before = await engine.getHunksForFile(repo.root, 'f.txt')
		assert.strictEqual(before.length, 1, 'precondition: one hunk against the old HEAD')

		repo.commit('commit the change') // HEAD moves; f.txt itself is not written again
		const after = await engine.getHunksForFile(repo.root, 'f.txt')
		assert.deepStrictEqual(after, [], 'diff against the new HEAD is empty')
	})

	test('REGRESSION: rewriting identical content does not trigger another git diff', async () => {
		fs.writeFileSync(file(), 'one\nTWO\nthree\n')
		await engine.getHunksForFile(repo.root, 'f.txt')
		assert.strictEqual(runner.count('diff'), 1)

		// Format-on-save, a tool re-saving, `git checkout`: new mtime, same bytes.
		fs.writeFileSync(file(), 'one\nTWO\nthree\n')
		const later = new Date(Date.now() + 10_000)
		fs.utimesSync(file(), later, later)

		await engine.getHunksForFile(repo.root, 'f.txt')
		assert.strictEqual(runner.count('diff'), 1, 'same content must be served from cache')
	})

	test('REGRESSION: different content with an identical size and mtime is still detected', async () => {
		// Same length, and an mtime pinned to the same whole second both times (so no
		// sub-millisecond difference can rescue an mtime comparison). Only the
		// content differs. An mtime-keyed cache serves the first result.
		const pinned = new Date(Math.floor(Date.now() / 1000) * 1000 - 60_000)
		fs.writeFileSync(file(), 'one\nAAA\nthree\n')
		fs.utimesSync(file(), pinned, pinned)
		const first = await engine.getHunksForFile(repo.root, 'f.txt')

		fs.writeFileSync(file(), 'one\nBBB\nthree\n')
		fs.utimesSync(file(), pinned, pinned)
		const second = await engine.getHunksForFile(repo.root, 'f.txt')

		assert.ok(first[0].patch.includes('+AAA'))
		assert.ok(second[0].patch.includes('+BBB'), 'must not serve the AAA hunks for BBB content')
	})

	test('an unchanged file and HEAD hit the cache', async () => {
		fs.writeFileSync(file(), 'one\nTWO\nthree\n')
		await engine.getHunksForFile(repo.root, 'f.txt')
		await engine.getHunksForFile(repo.root, 'f.txt')
		await engine.getHunksForFile(repo.root, 'f.txt')
		assert.strictEqual(runner.count('diff'), 1)
	})

	test('a deleted tracked file is diffed, and recomputed when it comes back', async () => {
		fs.rmSync(file())
		const deleted = await engine.getHunksForFile(repo.root, 'f.txt')
		assert.strictEqual(deleted.length, 1)
		assert.ok(deleted[0].patch.includes('-one'))

		fs.writeFileSync(file(), 'one\ntwo\nthree\n') // restored to HEAD's content
		assert.deepStrictEqual(await engine.getHunksForFile(repo.root, 'f.txt'), [])
	})

	test('the cache is per worktree root: same relative path in two roots does not collide', async () => {
		const other = TmpRepo.create('diff-cache-b')
		try {
			other.writeFile('f.txt', 'one\ntwo\nthree\n')
			other.commit('add f')
			fs.writeFileSync(file(), 'one\nTWO\nthree\n')
			fs.writeFileSync(path.join(other.root, 'f.txt'), 'one\ntwo\nTHREE\nfour\n')
			const a = await engine.getHunksForFile(repo.root, 'f.txt')
			const b = await engine.getHunksForFile(other.root, 'f.txt')
			assert.ok(a[0].patch.includes('+TWO'))
			assert.ok(b[0].patch.includes('+THREE'))
		} finally {
			other.dispose()
		}
	})

	test('HEAD is resolved by reading .git directly: no rev-parse process in a normal repo', async () => {
		fs.writeFileSync(file(), 'one\nTWO\nthree\n')
		await engine.getHunksForFile(repo.root, 'f.txt')
		await engine.getHunksForFile(repo.root, 'f.txt')
		assert.strictEqual(runner.count('rev-parse'), 0)
		assert.strictEqual(runner.count('diff'), 1)
	})

	test('where .git is not at the root, it falls back to git; concurrent lookups share one process', async () => {
		const sub = path.join(repo.root, 'sub')
		fs.mkdirSync(sub)
		fs.writeFileSync(path.join(sub, 'g.txt'), 'x\n')
		await Promise.all(Array.from({ length: 6 }, () => engine.getHunksForFile(sub, 'g.txt')))
		assert.strictEqual(runner.count('rev-parse'), 1, 'six simultaneous lookups, one rev-parse')

		// With no time-based reuse, the next lookup asks again - a commit may have happened.
		await engine.getHunksForFile(sub, 'g.txt')
		assert.strictEqual(runner.count('rev-parse'), 2)
	})

	test('switching to another commit with the same file content recomputes against it', async () => {
		fs.writeFileSync(file(), 'one\nTWO\nthree\n')
		assert.strictEqual((await engine.getHunksForFile(repo.root, 'f.txt')).length, 1)
		// A different commit where HEAD:f.txt already equals the working file.
		repo.commit('adopt the change')
		assert.deepStrictEqual(await engine.getHunksForFile(repo.root, 'f.txt'), [])
	})

	test('the direct HEAD read always agrees with git rev-parse HEAD', async () => {
		const git = (cwd: string, ...args: string[]) => {
			const r = spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf-8' })
			assert.strictEqual(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`)
			return r.stdout.trim()
		}
		const headIdOf = (dir: string): Promise<string> => (engine as unknown as { _headId(d: string): Promise<string> })._headId(dir)
		const check = async (label: string, dir = repo.root) => {
			assert.strictEqual(await headIdOf(dir), git(dir, 'rev-parse', 'HEAD'), label)
		}
		const commit = (dir: string, name: string) => {
			fs.writeFileSync(path.join(dir, name), name)
			git(dir, 'add', name)
			git(dir, 'commit', '-m', name)
		}

		await check('initial')
		commit(repo.root, 'a.txt')
		await check('after a commit')
		git(repo.root, 'switch', '-c', 'feature/with/slashes')
		commit(repo.root, 'b.txt')
		await check('on a new branch with a slashed name')
		git(repo.root, 'checkout', '--detach')
		await check('detached HEAD')
		commit(repo.root, 'c.txt')
		await check('commit while detached')
		git(repo.root, 'checkout', 'main')
		await check('back on main')
		git(repo.root, 'pack-refs', '--all')
		await check('refs packed into packed-refs')
		commit(repo.root, 'd.txt')
		await check('a loose ref overrides the packed one')
		git(repo.root, 'reset', '--hard', 'HEAD~1')
		await check('after reset --hard')

		// A linked worktree: HEAD lives in .git/worktrees/<name>, branches in the main .git.
		const wt = path.join(path.dirname(repo.root), path.basename(repo.root) + '-wt')
		try {
			git(repo.root, 'worktree', 'add', wt, '-b', 'wt-branch')
			await check('fresh linked worktree', wt)
			commit(wt, 'w.txt')
			await check('commit inside the linked worktree', wt)
			await check('main worktree unaffected by the linked one')
			git(repo.root, 'pack-refs', '--all')
			await check('packed refs seen from the linked worktree', wt)
		} finally {
			fs.rmSync(wt, { recursive: true, force: true })
		}

		assert.strictEqual(runner.count('rev-parse'), 0, 'every one of those was resolved without spawning git')
	})

	test('a repository with no commits yet returns [] rather than throwing, and caches nothing', async () => {
		const empty = fs.mkdtempSync(path.join(repo.root, '..', 'gitbraid-empty-'))
		try {
			const { spawnSync } = await import('node:child_process')
			spawnSync('git', ['init', '-b', 'main'], { cwd: empty })
			fs.writeFileSync(path.join(empty, 'a.txt'), 'x\n')
			const headIdOf = (engine as unknown as { _headId(d: string): Promise<string> })._headId.bind(engine)
			assert.strictEqual(await headIdOf(empty), 'none', 'no commit yet: git is asked, and says so')
			assert.deepStrictEqual(await engine.getHunksForFile(empty, 'a.txt'), [])
			assert.deepStrictEqual(await engine.getHunksForFile(empty, 'a.txt'), [])
			assert.strictEqual(runner.count('diff'), 2, 'a failed diff is not cached')
		} finally {
			fs.rmSync(empty, { recursive: true, force: true })
		}
	})

	test('invalidateCache forces a fresh diff', async () => {
		fs.writeFileSync(file(), 'one\nTWO\nthree\n')
		await engine.getHunksForFile(repo.root, 'f.txt')
		engine.invalidateCache(repo.root, 'f.txt')
		await engine.getHunksForFile(repo.root, 'f.txt')
		assert.strictEqual(runner.count('diff'), 2)
	})

	test('a file that changes while git is reading it is not cached under the old content', async () => {
		fs.writeFileSync(file(), 'one\nAAA\nthree\n')
		const racing = new RecordingGitRunner()
		let raced = false
		const realRun = racing.run.bind(racing)
		racing.run = async (args, opts) => {
			const result = await realRun(args, opts)
			if (args[0] === 'diff' && !raced) {
				raced = true
				fs.writeFileSync(file(), 'one\nBBB\nthree\n') // changes after we hashed, during the diff
			}
			return result
		}
		const racy = new DiffEngine(racing)

		await racy.getHunksForFile(repo.root, 'f.txt') // hashed AAA; the diff may have seen either
		fs.writeFileSync(file(), 'one\nAAA\nthree\n') // back to the content that was hashed
		const again = await racy.getHunksForFile(repo.root, 'f.txt')
		assert.ok(again[0].patch.includes('+AAA'), 'must reflect AAA, not whatever the raced diff saw')
		assert.strictEqual(racing.count('diff'), 2, 'the raced result must not have been cached')
	})

	test('large files reuse their hash while mtime and size are unchanged and the mtime is old', async () => {
		const big = 'x'.repeat(1024 * 1024 + 10) + '\n'
		fs.writeFileSync(file(), big)
		const old = new Date(Date.now() - 60_000)
		fs.utimesSync(file(), old, old)
		await engine.getHunksForFile(repo.root, 'f.txt')
		await engine.getHunksForFile(repo.root, 'f.txt')
		assert.strictEqual(runner.count('diff'), 1)
	})

	test('large files with a recent mtime are re-hashed, so a same-size swap is still caught', async () => {
		fs.writeFileSync(file(), 'a'.repeat(1024 * 1024 + 10) + '\n')
		const first = await engine.getHunksForFile(repo.root, 'f.txt')
		fs.writeFileSync(file(), 'b'.repeat(1024 * 1024 + 10) + '\n') // same size, mtime within the racy window
		const second = await engine.getHunksForFile(repo.root, 'f.txt')
		assert.notStrictEqual(first[0].patch, second[0].patch)
	})
})

suite('DiffEngine cache limits', function () {
	this.timeout(20_000)

	let repo: TmpRepo
	let runner: RecordingGitRunner

	setup(() => {
		repo = TmpRepo.create('diff-cache-limits')
		runner = new RecordingGitRunner()
		for (const name of ['a', 'b', 'c', 'd']) repo.writeFile(`${name}.txt`, 'x\ny\n')
		repo.commit('add files')
		for (const name of ['a', 'b', 'c', 'd']) fs.writeFileSync(path.join(repo.root, `${name}.txt`), 'x\nCHANGED\n')
	})

	teardown(() => repo.dispose())

	test('evicts the least recently used file past maxEntries', async () => {
		const engine = new DiffEngine(runner, { maxEntries: 3 })
		for (const n of ['a', 'b', 'c']) await engine.getHunksForFile(repo.root, `${n}.txt`)
		await engine.getHunksForFile(repo.root, 'a.txt') // a is now most recent; b is oldest
		await engine.getHunksForFile(repo.root, 'd.txt') // evicts b
		assert.strictEqual(runner.count('diff'), 4)

		await engine.getHunksForFile(repo.root, 'a.txt')
		await engine.getHunksForFile(repo.root, 'c.txt')
		await engine.getHunksForFile(repo.root, 'd.txt')
		assert.strictEqual(runner.count('diff'), 4, 'a, c and d are still cached')
		await engine.getHunksForFile(repo.root, 'b.txt')
		assert.strictEqual(runner.count('diff'), 5, 'b was evicted')
	})

	test('stays under maxBytes: the newest entries are kept and the oldest are evicted', async () => {
		// Each small diff is a few hundred bytes with overhead, so 700 holds about two.
		const engine = new DiffEngine(runner, { maxBytes: 700 })
		for (const n of ['a', 'b', 'c', 'd']) await engine.getHunksForFile(repo.root, `${n}.txt`)
		assert.strictEqual(runner.count('diff'), 4)

		await engine.getHunksForFile(repo.root, 'd.txt') // newest: still cached
		assert.strictEqual(runner.count('diff'), 4)
		await engine.getHunksForFile(repo.root, 'a.txt') // oldest: evicted to make room
		assert.strictEqual(runner.count('diff'), 5)
	})

	test('a single result larger than maxBytes is returned but not cached', async () => {
		const engine = new DiffEngine(runner, { maxBytes: 10 })
		const hunks = await engine.getHunksForFile(repo.root, 'a.txt')
		assert.strictEqual(hunks.length, 1)
		await engine.getHunksForFile(repo.root, 'a.txt')
		assert.strictEqual(runner.count('diff'), 2)
	})
})

suite('DiffEngine.getHunksForFiles', function () {
	this.timeout(20_000)

	let repo: TmpRepo
	let runner: RecordingGitRunner
	let engine: DiffEngine

	setup(() => {
		repo = TmpRepo.create('diff-batch')
		runner = new RecordingGitRunner()
		engine = new DiffEngine(runner)
		for (const name of ['one.txt', 'two.txt', 'with space.txt', 'same.txt']) repo.writeFile(name, 'a\nb\nc\n')
		repo.commit('add files')
		fs.writeFileSync(path.join(repo.root, 'one.txt'), 'a\nONE\nc\n')
		fs.writeFileSync(path.join(repo.root, 'two.txt'), 'a\nb\nc\nTWO\n')
		fs.writeFileSync(path.join(repo.root, 'with space.txt'), 'A\nb\nc\n')
		// same.txt left unchanged
	})

	teardown(() => repo.dispose())

	/** Reference answer: ask about each file separately with a fresh engine. */
	async function oneByOne(paths: string[]): Promise<Map<string, string[]>> {
		const fresh = new DiffEngine(new RecordingGitRunner())
		const out = new Map<string, string[]>()
		for (const p of paths) out.set(p, (await fresh.getHunksForFile(repo.root, p)).map((h) => h.patch))
		return out
	}

	test('returns the same hunks as asking one file at a time, using a single diff process', async () => {
		const paths = ['one.txt', 'two.txt', 'with space.txt', 'same.txt']
		const batch = await engine.getHunksForFiles(repo.root, paths)
		const reference = await oneByOne(paths)
		for (const p of paths) {
			assert.deepStrictEqual(batch.get(p)?.map((h) => h.patch), reference.get(p), p)
		}
		assert.strictEqual(runner.count('diff'), 1, 'one process for the whole batch')
		assert.deepStrictEqual(batch.get('same.txt'), [], 'an unchanged file has no hunks')
	})

	test('hunk indices and line ranges match the single-file results', async () => {
		const batch = await engine.getHunksForFiles(repo.root, ['one.txt', 'two.txt'])
		const single = await new DiffEngine(new RecordingGitRunner()).getHunksForFile(repo.root, 'two.txt')
		const b = batch.get('two.txt') ?? []
		assert.deepStrictEqual(b.map((h) => [h.index, h.startLine, h.endLine, h.header]), single.map((h) => [h.index, h.startLine, h.endLine, h.header]))
	})

	test('populates the cache, so later single lookups spawn no further diff', async () => {
		await engine.getHunksForFiles(repo.root, ['one.txt', 'two.txt', 'with space.txt'])
		await engine.getHunksForFile(repo.root, 'two.txt')
		await engine.getHunksForFile(repo.root, 'with space.txt')
		assert.strictEqual(runner.count('diff'), 1)
	})

	test('already-cached files are not diffed again', async () => {
		await engine.getHunksForFile(repo.root, 'one.txt')
		runner.reset()
		await engine.getHunksForFiles(repo.root, ['one.txt', 'two.txt', 'with space.txt'])
		const diff = runner.calls.find((a) => a.includes('diff'))
		assert.ok(diff, 'a diff ran for the files that were not cached')
		assert.ok(!diff.includes('one.txt'), 'but not for the cached one')
	})

	test('duplicate paths are answered once, and the empty list is a no-op', async () => {
		const result = await engine.getHunksForFiles(repo.root, ['one.txt', 'one.txt'])
		assert.strictEqual(result.size, 1)
		assert.strictEqual((await engine.getHunksForFiles(repo.root, [])).size, 0)
	})

	test('a path git prints quoted (non-ASCII) falls back to per-file diffs and is still right', async () => {
		repo.writeFile('caf\u00e9.txt', 'a\nb\n')
		repo.commit('add accented file')
		fs.writeFileSync(path.join(repo.root, 'caf\u00e9.txt'), 'a\nCHANGED\n')
		const paths = ['one.txt', 'caf\u00e9.txt', 'two.txt']
		const batch = await engine.getHunksForFiles(repo.root, paths)
		const reference = await oneByOne(paths)
		for (const p of paths) assert.deepStrictEqual(batch.get(p)?.map((h) => h.patch), reference.get(p), p)
	})

	test('rejects a path that escapes the root before running git', async () => {
		await assert.rejects(() => engine.getHunksForFiles(repo.root, ['one.txt', '../outside.txt']), /escapes workspace root/)
		assert.strictEqual(runner.calls.length, 0)
	})
})

