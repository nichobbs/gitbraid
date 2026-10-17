import * as assert from 'node:assert'
import * as path from 'node:path'
import {
	StackInvariantError,
	describeError,
	requireBranch,
	requireForceAllowed,
	requireHunkInRange,
	requireNotScratch,
	requirePermutation,
	requireWorkspacePath,
	requireWorktree,
} from '../src/stackInvariants'
import type { BranchStackEntry } from '../src/configTypes'

const ROOT = path.resolve('/tmp/gitbraid-invariants-fixture')

function entry(name: string, extra: Partial<BranchStackEntry> = {}): BranchStackEntry {
	return { name, color: '#111', order: 1, base: 'main', ...extra }
}

function code(fn: () => unknown): string | undefined {
	try {
		fn()
		return undefined
	} catch (e) {
		return e instanceof StackInvariantError ? e.code : `non-invariant: ${String(e)}`
	}
}

suite('stackInvariants: requireWorkspacePath', () => {
	test('accepts ordinary relative paths and normalises them', () => {
		assert.strictEqual(requireWorkspacePath(ROOT, 'src/foo.ts'), 'src/foo.ts')
		assert.strictEqual(requireWorkspacePath(ROOT, './src/foo.ts'), 'src/foo.ts')
		assert.strictEqual(requireWorkspacePath(ROOT, 'src\\foo.ts'), 'src/foo.ts')
		assert.strictEqual(requireWorkspacePath(ROOT, 'src/../src/foo.ts'), 'src/foo.ts')
		assert.strictEqual(requireWorkspacePath(ROOT, 'a/b/../c.txt'), 'a/c.txt')
	})

	test('rejects empty and whitespace-only paths', () => {
		assert.strictEqual(code(() => requireWorkspacePath(ROOT, '')), 'PATH_INVALID')
		assert.strictEqual(code(() => requireWorkspacePath(ROOT, '   ')), 'PATH_INVALID')
	})

	test('rejects a NUL byte', () => {
		assert.strictEqual(code(() => requireWorkspacePath(ROOT, 'src/a\0.ts')), 'PATH_INVALID')
	})

	test('rejects paths that leave the workspace, however they are spelled', () => {
		for (const p of ['../x', '../../etc/passwd', 'src/../../x', '..', '..\\..\\x', './../x', 'a/b/../../../x']) {
			assert.strictEqual(code(() => requireWorkspacePath(ROOT, p)), 'PATH_ESCAPES_WORKSPACE', p)
		}
	})

	test('rejects absolute paths, including Windows forms on any host, even inside the workspace', () => {
		for (const p of ['/etc/passwd', path.join(ROOT, 'src/a.ts'), 'C:\\Users\\x\\a.ts', 'C:/Users/x/a.ts', '\\\\server\\share\\a.ts', '//server/share/a.ts']) {
			assert.strictEqual(code(() => requireWorkspacePath(ROOT, p)), 'PATH_INVALID', p)
		}
	})

	test('rejects files under .git and .worktrees, including via traversal', () => {
		for (const p of ['.git/config', '.git/hooks/pre-commit', '.worktrees/gitbraid-config.json', 'src/../.git/HEAD', './.worktrees/x']) {
			assert.strictEqual(code(() => requireWorkspacePath(ROOT, p)), 'PATH_RESERVED', p)
		}
	})

	test('does not over-match: .github, .gitignore, .gitattributes and nested .git-named files are fine', () => {
		for (const p of ['.github/workflows/ci.yml', '.gitignore', '.gitattributes', 'docs/.git/notes.md', 'src/.worktrees/x.ts', '.gitmodules']) {
			assert.strictEqual(requireWorkspacePath(ROOT, p), p, p)
		}
	})

	test('the error carries a code, a message and a hint', () => {
		try {
			requireWorkspacePath(ROOT, '/abs/path')
			assert.fail('should throw')
		} catch (e) {
			assert.ok(e instanceof StackInvariantError)
			assert.strictEqual(e.code, 'PATH_INVALID')
			assert.ok(e.message.includes('/abs/path'))
			assert.ok(e.hint && e.hint.length > 0)
		}
	})
})

suite('stackInvariants: branches', () => {
	const stack = [entry('feat/a'), entry('feat/v', { virtual: true }), entry('scratch', { scratch: true })]

	test('requireBranch returns the entry', () => {
		assert.strictEqual(requireBranch(stack, 'feat/a').name, 'feat/a')
	})

	test('requireBranch: unknown name keeps the established message and lists what exists', () => {
		try {
			requireBranch(stack, 'feat/typo')
			assert.fail('should throw')
		} catch (e) {
			assert.ok(e instanceof StackInvariantError)
			assert.strictEqual(e.code, 'BRANCH_NOT_FOUND')
			assert.match(e.message, /Branch "feat\/typo" is not in the stack/)
			assert.ok(e.hint?.includes('feat/a') && e.hint.includes('feat/v'))
		}
	})

	test('requireBranch: empty stack points at addBranch', () => {
		try {
			requireBranch([], 'x')
			assert.fail('should throw')
		} catch (e) {
			assert.ok(e instanceof StackInvariantError)
			assert.match(e.hint ?? '', /addBranch/)
		}
	})

	test('requireWorktree: only virtual branches are refused, and the hint says how to fix it', () => {
		assert.strictEqual(code(() => requireWorktree(stack[0], 'commit')), undefined)
		try {
			requireWorktree(stack[1], 'commit')
			assert.fail('should throw')
		} catch (e) {
			assert.ok(e instanceof StackInvariantError)
			assert.strictEqual(e.code, 'BRANCH_HAS_NO_WORKTREE')
			assert.match(e.hint ?? '', /materialiseBranch/)
		}
	})

	test('requireNotScratch', () => {
		assert.strictEqual(code(() => requireNotScratch(stack[0], 'commit')), undefined)
		assert.strictEqual(code(() => requireNotScratch(stack[2], 'commit')), 'BRANCH_IS_SCRATCH')
	})
})

suite('stackInvariants: hunks', () => {
	test('in-range indices pass', () => {
		assert.strictEqual(code(() => requireHunkInRange('f.ts', 0, 3)), undefined)
		assert.strictEqual(code(() => requireHunkInRange('f.ts', 2, 3)), undefined)
	})

	test('out-of-range, negative, fractional and NaN indices are refused', () => {
		for (const i of [3, 99, -1, 1.5, Number.NaN]) {
			assert.strictEqual(code(() => requireHunkInRange('f.ts', i, 3)), 'HUNK_OUT_OF_RANGE', String(i))
		}
	})

	test('a file with no changes says so, and points at getFileHunks', () => {
		try {
			requireHunkInRange('f.ts', 0, 0)
			assert.fail('should throw')
		} catch (e) {
			assert.ok(e instanceof StackInvariantError)
			assert.match(e.message, /no uncommitted changes/)
			assert.match(e.hint ?? '', /getFileHunks/)
		}
	})
})

suite('stackInvariants: reorder and force', () => {
	const stack = [entry('a'), entry('b'), entry('c')]

	test('a permutation passes, in any order', () => {
		assert.strictEqual(code(() => requirePermutation(stack, ['c', 'a', 'b'])), undefined)
		assert.strictEqual(code(() => requirePermutation(stack, ['a', 'b', 'c'])), undefined)
	})

	test('missing, unknown and duplicated names are all refused, and described', () => {
		const cases: Array<[string[], RegExp]> = [
			[['a', 'b'], /missing: c/],
			[['a', 'b', 'c', 'd'], /not in the stack: d/],
			[['a', 'b', 'b'], /missing: c/],
			[['a', 'a', 'b', 'c'], /duplicates/],
			[[], /missing: a, b, c/],
		]
		for (const [names, expected] of cases) {
			try {
				requirePermutation(stack, names)
				assert.fail(`should refuse ${JSON.stringify(names)}`)
			} catch (e) {
				assert.ok(e instanceof StackInvariantError, JSON.stringify(names))
				assert.strictEqual(e.code, 'REORDER_NOT_A_PERMUTATION')
				assert.match(e.message, expected)
			}
		}
	})

	test('an empty stack accepts only an empty list', () => {
		assert.strictEqual(code(() => requirePermutation([], [])), undefined)
		assert.strictEqual(code(() => requirePermutation([], ['x'])), 'REORDER_NOT_A_PERMUTATION')
	})

	test('force: refused unless allowed; not forcing is always fine', () => {
		assert.strictEqual(code(() => requireForceAllowed(true, false)), 'FORCE_REQUIRES_CONFIRMATION')
		assert.strictEqual(code(() => requireForceAllowed(true, true)), undefined)
		assert.strictEqual(code(() => requireForceAllowed(false, false)), undefined)
	})
})

suite('stackInvariants: describeError', () => {
	test('invariant errors keep their code and hint; others become ERROR', () => {
		const inv = new StackInvariantError('BRANCH_NOT_FOUND', 'nope', 'try this')
		assert.deepStrictEqual(describeError(inv), { code: 'BRANCH_NOT_FOUND', message: 'nope', hint: 'try this' })
		assert.deepStrictEqual(describeError(new Error('boom')), { code: 'ERROR', message: 'boom' })
		assert.deepStrictEqual(describeError('plain'), { code: 'ERROR', message: 'plain' })
	})

	test('toJSON omits an absent hint and round-trips through JSON', () => {
		const e = new StackInvariantError('PATH_INVALID', 'bad')
		assert.deepStrictEqual(JSON.parse(JSON.stringify(e)), { code: 'PATH_INVALID', message: 'bad' })
	})
})
