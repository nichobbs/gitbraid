import * as assert from 'node:assert'
import * as path from 'node:path'
import { requireInside, resolveInside } from '../src/pathGuard'
import { ConfigError } from '../src/errors'

const ROOT = path.resolve('/tmp/gitbraid-pathguard-fixture')

suite('pathGuard', () => {

	test('requireInside: accepts a normal relative path', () => {
		const resolved = requireInside(ROOT, 'src/foo.ts')
		assert.strictEqual(resolved, path.join(ROOT, 'src/foo.ts'))
	})

	test('requireInside: accepts the workspace root itself (empty relative path)', () => {
		const resolved = requireInside(ROOT, '.')
		assert.strictEqual(resolved, ROOT)
	})

	test('requireInside: rejects straight parent traversal', () => {
		assert.throws(() => requireInside(ROOT, '../foo.ts'), ConfigError)
	})

	test('requireInside: rejects deep parent traversal', () => {
		assert.throws(() => requireInside(ROOT, 'a/../../etc/passwd'), ConfigError)
	})

	test('requireInside: rejects Windows-style backslash traversal', () => {
		assert.throws(() => requireInside(ROOT, '..\\..\\win.txt'), ConfigError)
	})

	test('requireInside: rejects absolute paths outside the root', () => {
		assert.throws(() => requireInside(ROOT, '/etc/passwd'), ConfigError)
	})

	test('requireInside: accepts a sibling prefix that is not a child', () => {
		// "srcfoo/bar" must not be accepted as inside "src/"
		assert.doesNotThrow(() => requireInside(ROOT, 'srcfoo/bar'))
	})

	test('resolveInside: returns undefined on escape instead of throwing', () => {
		assert.strictEqual(resolveInside(ROOT, '../etc/passwd'), undefined)
	})

	test('resolveInside: returns resolved path on success', () => {
		assert.strictEqual(
			resolveInside(ROOT, 'a/b/c.ts'),
			path.join(ROOT, 'a/b/c.ts'),
		)
	})
})
