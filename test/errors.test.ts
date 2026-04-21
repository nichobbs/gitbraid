import * as assert from 'node:assert'
import {
	NotImplementedError,
	ConfigError,
	SyncError,
	BranchStackError,
	GitError,
	WorktreeNotFoundError,
} from '../src/errors'

suite('errors', () => {

	// ── NotImplementedError ───────────────────────────────────────────────────

	test('NotImplementedError: default message', () => {
		const e = new NotImplementedError()
		assert.ok(e instanceof Error)
		assert.ok(e instanceof NotImplementedError)
		assert.strictEqual(e.name, 'NotImplementedError')
		assert.strictEqual(e.message, 'Not implemented')
	})

	test('NotImplementedError: custom message', () => {
		const e = new NotImplementedError('custom msg')
		assert.strictEqual(e.message, 'custom msg')
		assert.strictEqual(e.name, 'NotImplementedError')
	})

	// ── ConfigError ───────────────────────────────────────────────────────────

	test('ConfigError: has correct name and message', () => {
		const e = new ConfigError('bad config')
		assert.ok(e instanceof Error)
		assert.ok(e instanceof ConfigError)
		assert.strictEqual(e.name, 'ConfigError')
		assert.strictEqual(e.message, 'bad config')
	})

	// ── SyncError ─────────────────────────────────────────────────────────────

	test('SyncError: has correct name and message', () => {
		const e = new SyncError('sync failed')
		assert.ok(e instanceof Error)
		assert.ok(e instanceof SyncError)
		assert.strictEqual(e.name, 'SyncError')
		assert.strictEqual(e.message, 'sync failed')
	})

	test('SyncError: stores optional sourcePath', () => {
		const e = new SyncError('sync failed', 'src/foo.ts')
		assert.strictEqual(e.sourcePath, 'src/foo.ts')
	})

	test('SyncError: sourcePath defaults to undefined', () => {
		const e = new SyncError('sync failed')
		assert.strictEqual(e.sourcePath, undefined)
	})

	// ── BranchStackError ──────────────────────────────────────────────────────

	test('BranchStackError: has correct name and message', () => {
		const e = new BranchStackError('stack error')
		assert.ok(e instanceof Error)
		assert.ok(e instanceof BranchStackError)
		assert.strictEqual(e.name, 'BranchStackError')
		assert.strictEqual(e.message, 'stack error')
	})

	// ── GitError ──────────────────────────────────────────────────────────────

	test('GitError: has correct name, message, and code', () => {
		const e = new GitError('git failed', 128)
		assert.ok(e instanceof Error)
		assert.ok(e instanceof GitError)
		assert.strictEqual(e.name, 'GitError')
		assert.strictEqual(e.message, 'git failed')
		assert.strictEqual(e.code, 128)
	})

	test('GitError: code=0 is valid', () => {
		const e = new GitError('ok', 0)
		assert.strictEqual(e.code, 0)
	})

	// ── WorktreeNotFoundError ─────────────────────────────────────────────────

	test('WorktreeNotFoundError: has correct name and message', () => {
		const e = new WorktreeNotFoundError('not found')
		assert.ok(e instanceof Error)
		assert.ok(e instanceof WorktreeNotFoundError)
		assert.strictEqual(e.name, 'WorktreeNotFoundError')
		assert.strictEqual(e.message, 'not found')
	})

	// ── Error instanceof chain ────────────────────────────────────────────────

	test('all custom errors are instances of Error', () => {
		const errors = [
			new NotImplementedError(),
			new ConfigError('x'),
			new SyncError('x'),
			new BranchStackError('x'),
			new GitError('x', 1),
			new WorktreeNotFoundError('x'),
		]
		for (const e of errors) {
			assert.ok(e instanceof Error, `${e.name} should be instanceof Error`)
		}
	})

	test('custom errors have distinct types', () => {
		const configErr = new ConfigError('x')
		assert.ok(!(configErr instanceof SyncError))
		assert.ok(!(configErr instanceof GitError))
	})

})
