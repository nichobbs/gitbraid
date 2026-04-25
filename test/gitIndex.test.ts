import * as assert from 'node:assert'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { hideAssignedFile, unhideAssignedFile } from '../src/gitIndex'
import { FakeGitRunner } from './helpers/fakeGitRunner'

function tmpRoot(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'gitbraid-gitindex-'))
}

function readExclude(root: string): string {
	return fs.readFileSync(path.join(root, '.git', 'info', 'exclude'), 'utf-8')
}

suite('gitIndex.hideAssignedFile', () => {
	test('tracked file: applies skip-worktree', async () => {
		const root = tmpRoot()
		try {
			const runner = new FakeGitRunner()
			runner.fixture('ls-files --error-unmatch -- src/foo.ts', { exitCode: 0 })
			runner.fixture('update-index --skip-worktree -- src/foo.ts', { exitCode: 0 })
			await hideAssignedFile(runner, root, 'src/foo.ts')
			const calls = runner.calls.map((c) => c.args.join(' '))
			assert.ok(calls.includes('update-index --skip-worktree -- src/foo.ts'))
			// no exclude file written for tracked files
			assert.strictEqual(fs.existsSync(path.join(root, '.git', 'info', 'exclude')), false)
		} finally {
			fs.rmSync(root, { recursive: true, force: true })
		}
	})

	test('untracked file: adds to .git/info/exclude', async () => {
		const root = tmpRoot()
		try {
			const runner = new FakeGitRunner()
			runner.fixture('ls-files --error-unmatch -- new.ts', { exitCode: 1 })
			await hideAssignedFile(runner, root, 'new.ts')
			const content = readExclude(root)
			assert.ok(content.includes('# gitbraid: new.ts'))
			assert.ok(content.includes('/new.ts'))
		} finally {
			fs.rmSync(root, { recursive: true, force: true })
		}
	})

	test('untracked file: idempotent — does not duplicate existing pattern', async () => {
		const root = tmpRoot()
		try {
			fs.mkdirSync(path.join(root, '.git', 'info'), { recursive: true })
			fs.writeFileSync(
				path.join(root, '.git', 'info', 'exclude'),
				'# gitbraid: new.ts\n/new.ts\n',
			)
			const runner = new FakeGitRunner()
			runner.fixture('ls-files --error-unmatch -- new.ts', { exitCode: 1 })
			await hideAssignedFile(runner, root, 'new.ts')
			const content = readExclude(root)
			const matches = content.split('\n').filter((line) => line === '/new.ts').length
			assert.strictEqual(matches, 1, 'pattern must not duplicate on repeated calls')
		} finally {
			fs.rmSync(root, { recursive: true, force: true })
		}
	})

	test('untracked file: appends newline before block when file lacks one', async () => {
		const root = tmpRoot()
		try {
			fs.mkdirSync(path.join(root, '.git', 'info'), { recursive: true })
			fs.writeFileSync(
				path.join(root, '.git', 'info', 'exclude'),
				'# pre-existing line',
			)
			const runner = new FakeGitRunner()
			runner.fixture('ls-files --error-unmatch -- new.ts', { exitCode: 1 })
			await hideAssignedFile(runner, root, 'new.ts')
			const content = readExclude(root)
			assert.ok(content.startsWith('# pre-existing line\n'))
			assert.ok(content.includes('/new.ts'))
		} finally {
			fs.rmSync(root, { recursive: true, force: true })
		}
	})

	test('runner failure is swallowed (best-effort)', async () => {
		const root = tmpRoot()
		try {
			const runner = new FakeGitRunner()
			// No fixtures: every git call returns exit=128 with no fixture errors thrown.
			// hideAssignedFile must not throw.
			await hideAssignedFile(runner, root, 'src/foo.ts')
		} finally {
			fs.rmSync(root, { recursive: true, force: true })
		}
	})
})

suite('gitIndex.unhideAssignedFile', () => {
	test('runs --no-skip-worktree and strips exclude entry', async () => {
		const root = tmpRoot()
		try {
			fs.mkdirSync(path.join(root, '.git', 'info'), { recursive: true })
			fs.writeFileSync(
				path.join(root, '.git', 'info', 'exclude'),
				'# gitbraid: hide.ts\n/hide.ts\n# unrelated\n/other-file\n',
			)
			const runner = new FakeGitRunner()
			runner.fixture('update-index --no-skip-worktree -- hide.ts', { exitCode: 0 })
			await unhideAssignedFile(runner, root, 'hide.ts')
			const content = readExclude(root)
			assert.ok(!content.includes('/hide.ts'))
			assert.ok(!content.includes('# gitbraid: hide.ts'))
			// Other entries survive
			assert.ok(content.includes('/other-file'))
		} finally {
			fs.rmSync(root, { recursive: true, force: true })
		}
	})

	test('no-op when exclude file missing', async () => {
		const root = tmpRoot()
		try {
			const runner = new FakeGitRunner()
			runner.fixture('update-index --no-skip-worktree -- ghost.ts', { exitCode: 0 })
			// Should not throw
			await unhideAssignedFile(runner, root, 'ghost.ts')
		} finally {
			fs.rmSync(root, { recursive: true, force: true })
		}
	})
})
