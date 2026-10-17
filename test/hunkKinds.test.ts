import * as assert from 'node:assert'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { absorbFiles } from '../src/absorb'
import type { DiffEngine, DiffHunk } from '../src/diffEngine'
import {
	autoRouteMode, classifyHunksOnDisk, inheritTrivialAssignments, withClassification, withInheritedTrivial,
} from '../src/hunkKinds'
import type { HunkKind } from '../src/hunkClassifier'
import { FakeGitRunner } from './helpers/fakeGitRunner'
import { diffOf } from './helpers/diffOf'

const OLD = ['export function f(x: number) {', '\t// compute', '\treturn x + 1', '}', ''].join('\n')

function tmpDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'gitbraid-kinds-'))
}

suite('hunkKinds: classifyHunksOnDisk', () => {
	let dir: string
	setup(() => { dir = tmpDir() })
	teardown(() => { fs.rmSync(dir, { recursive: true, force: true }) })

	test('classifies against the file on disk', async () => {
		const next = OLD.replace('// compute', '// compute it')
		fs.writeFileSync(path.join(dir, 'x.ts'), next)
		const hunks = diffOf(OLD, next, 'x.ts')
		assert.deepStrictEqual(await classifyHunksOnDisk(dir, 'x.ts', hunks), ['comment'])
		const tagged = await withClassification(dir, 'x.ts', hunks)
		assert.strictEqual(tagged[0].classification, 'comment')
	})

	test('a missing, stale or oversized file is logic, never trivial', async () => {
		const next = OLD.replace('// compute', '// compute it')
		const hunks = diffOf(OLD, next, 'x.ts')
		assert.deepStrictEqual(await classifyHunksOnDisk(dir, 'x.ts', hunks), ['logic'], 'file missing')

		fs.writeFileSync(path.join(dir, 'x.ts'), OLD)   // disk no longer matches the hunk
		assert.deepStrictEqual(await classifyHunksOnDisk(dir, 'x.ts', hunks), ['logic'], 'stale')

		fs.writeFileSync(path.join(dir, 'big.ts'), '// c\n'.repeat(500_000))
		const bigHunks = diffOf('// c\n', '// d\n', 'big.ts')
		assert.deepStrictEqual(await classifyHunksOnDisk(dir, 'big.ts', bigHunks), ['logic'], 'oversized')
	})

	test('path traversal is refused (logic)', async () => {
		const hunks = diffOf('a\n', 'a  \n', 'x.ts')
		assert.deepStrictEqual(await classifyHunksOnDisk(dir, '../escape.ts', hunks), ['logic'])
	})

	test('no hunks, no work', async () => {
		assert.deepStrictEqual(await classifyHunksOnDisk(dir, 'x.ts', []), [])
	})
})

function h(index: number, startLine: number, endLine: number, classification?: HunkKind) {
	return { index, startLine, endLine, classification }
}

suite('hunkKinds: inheritTrivialAssignments', () => {
	const assigned = new Map([[0, 'feat/a'], [4, 'feat/b']])

	test('off inherits nothing', () => {
		const hunks = [h(0, 1, 3, 'logic'), h(1, 10, 10, 'whitespace'), h(4, 40, 45, 'logic')]
		assert.strictEqual(inheritTrivialAssignments(hunks, assigned, 'off').size, 0)
	})

	test('a whitespace hunk follows the nearest assigned hunk by line distance', () => {
		const hunks = [h(0, 1, 3, 'logic'), h(1, 5, 5, 'whitespace'), h(2, 38, 38, 'whitespace'), h(4, 40, 45, 'logic')]
		const got = inheritTrivialAssignments(hunks, assigned, 'whitespace')
		assert.deepStrictEqual([...got], [[1, 'feat/a'], [2, 'feat/b']])
	})

	test('ties go to the hunk above', () => {
		const hunks = [h(0, 1, 10, 'logic'), h(1, 15, 15, 'whitespace'), h(4, 20, 25, 'logic')]
		assert.deepStrictEqual([...inheritTrivialAssignments(hunks, assigned, 'whitespace')], [[1, 'feat/a']])
	})

	test('comment hunks only inherit in whitespace+comment mode', () => {
		const hunks = [h(0, 1, 3, 'logic'), h(1, 5, 5, 'comment'), h(4, 40, 45, 'logic')]
		assert.strictEqual(inheritTrivialAssignments(hunks, assigned, 'whitespace').size, 0)
		assert.deepStrictEqual([...inheritTrivialAssignments(hunks, assigned, 'whitespace+comment')], [[1, 'feat/a']])
	})

	test('never touches logic, mixed, import, unclassified or already-assigned hunks', () => {
		const hunks = [
			h(0, 1, 3, 'whitespace'), h(1, 5, 5, 'logic'), h(2, 7, 7, 'mixed'), h(3, 9, 9, 'import'), h(5, 11, 11, undefined),
			h(4, 40, 45, 'whitespace'),
		]
		assert.strictEqual(inheritTrivialAssignments(hunks, assigned, 'whitespace+comment').size, 0)
	})

	test('with no assigned neighbour there is nothing to inherit', () => {
		assert.strictEqual(inheritTrivialAssignments([h(1, 5, 5, 'whitespace')], new Map(), 'whitespace').size, 0)
	})

	test('autoRouteMode parses the setting defensively', () => {
		assert.strictEqual(autoRouteMode('whitespace'), 'whitespace')
		assert.strictEqual(autoRouteMode('whitespace+comment'), 'whitespace+comment')
		assert.strictEqual(autoRouteMode('everything'), 'off')
		assert.strictEqual(autoRouteMode(undefined), 'off')
	})
})

suite('hunkKinds: withInheritedTrivial', () => {
	let dir: string
	setup(() => { dir = tmpDir() })
	teardown(() => { fs.rmSync(dir, { recursive: true, force: true }) })

	// A logic change at the top, an indentation-only change far below, and a code change further down.
	const lines = (n: number) => Array.from({ length: n }, (_, i) => `const v${String(i)} = ${String(i)}`)
	const oldText = [...lines(30), '\tfoo(1)', ...lines(30), 'bar(1)', ...lines(5)].join('\n') + '\n'
	const newText = oldText.replace('const v0 = 0', 'const v0 = 100').replace('\tfoo(1)', '    foo(1)').replace('bar(1)', 'bar(2)')

	test('merges inherited entries into the assignment map, leaving the originals alone', async () => {
		fs.writeFileSync(path.join(dir, 'a.ts'), newText)
		const hunks = diffOf(oldText, newText, 'a.ts', 1)
		assert.strictEqual(hunks.length, 3)
		const engine = { getHunksForFile: async () => hunks } as unknown as DiffEngine
		const assigned = new Map([[0, 'feat/a'], [2, 'feat/b']])

		const off = await withInheritedTrivial(engine, dir, 'a.ts', assigned, 'off')
		assert.strictEqual(off, assigned)

		const got = await withInheritedTrivial(engine, dir, 'a.ts', assigned, 'whitespace')
		assert.deepStrictEqual([...got].sort(), [[0, 'feat/a'], [1, 'feat/a'], [2, 'feat/b']])
		assert.deepStrictEqual([...assigned], [[0, 'feat/a'], [2, 'feat/b']], 'input untouched')
	})
})

suite('hunkKinds: absorb skipTrivial', () => {
	let dir: string
	setup(() => { dir = tmpDir() })
	teardown(() => { fs.rmSync(dir, { recursive: true, force: true }) })

	const mergeBase = 'd'.repeat(40)
	const sha = 'a'.repeat(40)
	const base = ['a()', 'b()', 'c()', 'd()', 'e()', 'f()', 'g()', 'h()', 'i()', 'j()', 'k()', 'l()', ''].join('\n')
	const next = base.replace('a()', '// about a\na()').replace('l()', 'l(1)')

	function engineFor(hunks: DiffHunk[]): DiffEngine {
		return {
			getHunksForFile: async () => hunks,
			getHunksForFiles: async (_root: string, rels: readonly string[]) => new Map(rels.map((r) => [r, hunks])),
		} as unknown as DiffEngine
	}

	function runner(): FakeGitRunner {
		const r = new FakeGitRunner()
		r.fixture('rev-parse', { stdout: sha })
		r.fixture('blame --line-porcelain', { stdout: `${sha} 1 1\n\tx\n` })
		r.fixture('merge-base --is-ancestor', { exitCode: 1 })
		return r
	}

	test('with skipTrivial a comment-only hunk is left in the worktree and never blamed', async () => {
		fs.writeFileSync(path.join(dir, 'f.ts'), next)
		const hunks = diffOf(base, next, 'f.ts', 0)
		assert.strictEqual(hunks.length, 2)
		const r = runner()
		const { plan } = await absorbFiles(dir, 'feat/a', ['f.ts'], engineFor(hunks), { mergeBase, dryRun: true, skipTrivial: true }, r)

		assert.match(plan.hunks[0].reason ?? '', /comment-only hunk left in the worktree/)
		assert.strictEqual(plan.hunks[0].targetSha, undefined)
		assert.strictEqual(plan.hunks[1].reason, undefined, 'the code hunk is still planned')
		const blamed = r.calls.filter((c) => c.args[0] === 'blame').map((c) => c.args.join(' '))
		assert.strictEqual(blamed.length, 1, blamed.join('; '))
		assert.match(blamed[0], /-L 13,13/)
	})

	test('without skipTrivial (the API default) both hunks are blamed', async () => {
		fs.writeFileSync(path.join(dir, 'f.ts'), next)
		const hunks = diffOf(base, next, 'f.ts', 0)
		const r = runner()
		const { plan } = await absorbFiles(dir, 'feat/a', ['f.ts'], engineFor(hunks), { mergeBase, dryRun: true }, r)
		assert.ok(plan.hunks.every((e) => e.reason === undefined || !/left in the worktree/.test(e.reason)))
		assert.strictEqual(r.calls.filter((c) => c.args[0] === 'blame').length, 2)
	})

	test('skipTrivial never skips a code hunk', async () => {
		const logicOnly = base.replace('l()', 'l(1)')
		fs.writeFileSync(path.join(dir, 'f.ts'), logicOnly)
		const hunks = diffOf(base, logicOnly, 'f.ts', 0)
		const r = runner()
		const { plan } = await absorbFiles(dir, 'feat/a', ['f.ts'], engineFor(hunks), { mergeBase, dryRun: true, skipTrivial: true }, r)
		assert.strictEqual(plan.hunks[0].reason === undefined || !/left in the worktree/.test(plan.hunks[0].reason), true)
		assert.strictEqual(r.calls.filter((c) => c.args[0] === 'blame').length, 1)
	})
})
