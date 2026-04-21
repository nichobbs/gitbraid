import * as assert from 'node:assert'
import * as path from 'node:path'
import * as fs from 'node:fs'
import { TmpRepo } from '../helpers/tmpRepo'
import { ProcessGitRunner } from '../../src/gitRunner'

// Integration sanity test: `ProcessGitRunner` actually invokes git against
// a real repo.  Covers the seam that unit tests mock with `FakeGitRunner`.
// See test/integration/README.md for guidelines.

suite('ProcessGitRunner — integration', () => {
	let repo: TmpRepo
	let runner: ProcessGitRunner

	before(() => {
		repo = TmpRepo.create('gitrunner')
		runner = new ProcessGitRunner()
	})
	after(() => repo.dispose())

	test('status --porcelain on a clean repo exits 0 with empty stdout', async () => {
		const r = await runner.run(['status', '--porcelain'], { cwd: repo.root })
		assert.strictEqual(r.exitCode, 0)
		assert.strictEqual(r.stdout.trim(), '')
	})

	test('status --porcelain shows modified tracked file', async () => {
		repo.writeFile('README.md', '# updated\n')
		const r = await runner.run(['status', '--porcelain'], { cwd: repo.root })
		assert.strictEqual(r.exitCode, 0)
		assert.match(r.stdout, /^\s*M README\.md\r?\n?$/)
	})

	test('non-zero exit is reported without throwing', async () => {
		const r = await runner.run(['rev-parse', 'not-a-real-ref'], { cwd: repo.root })
		assert.notStrictEqual(r.exitCode, 0)
		assert.ok(r.stderr.length > 0, 'stderr should include git error message')
	})

	test('argv entries with shell metacharacters are passed verbatim', async () => {
		// Proves the spawn(shell:false) contract end-to-end: a file name
		// with a `$(...)` substring must create that literal file rather
		// than execute the substitution.
		const literal = 'file$(whoami).txt'
		fs.writeFileSync(path.join(repo.root, literal), 'hi')
		const r = await runner.run(['status', '--porcelain'], { cwd: repo.root })
		assert.strictEqual(r.exitCode, 0)
		assert.ok(
			r.stdout.includes(literal),
			`expected literal filename in porcelain output, got ${r.stdout}`,
		)
		// No file named after the resolved `whoami` should exist.
		const contents = fs.readdirSync(repo.root)
		assert.ok(
			!contents.some((f) => /^file[^$].+\.txt$/.test(f) && f !== literal),
			'no unexpected file created',
		)
	})
})
