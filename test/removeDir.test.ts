import * as assert from 'node:assert'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { RM_RETRY_OPTIONS, removeDirBestEffort, worstCaseRemoveMs } from './helpers/removeDir'

suite('removeDirBestEffort', () => {

	test('worstCaseRemoveMs: matches the linear-backoff formula', () => {
		assert.strictEqual(worstCaseRemoveMs({ maxRetries: 10, retryDelay: 200 }), 11_000)
		assert.strictEqual(worstCaseRemoveMs({ maxRetries: 5, retryDelay: 100 }), 1_500)
	})

	test('retry budget stays well under mocha\'s 10 s hook timeout', () => {
		// The old 10 x 200 ms budget blocked for ~11 s and tripped the timeout
		// in Windows teardown hooks.  Keep generous headroom.
		assert.ok(
			worstCaseRemoveMs(RM_RETRY_OPTIONS) <= 5_000,
			`worst case ${String(worstCaseRemoveMs(RM_RETRY_OPTIONS))} ms is too close to the hook timeout`,
		)
	})

	test('removes a directory tree', () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitbraid-rmdir-'))
		fs.mkdirSync(path.join(dir, 'a', 'b'), { recursive: true })
		fs.writeFileSync(path.join(dir, 'a', 'b', 'f.txt'), 'x')
		removeDirBestEffort(dir)
		assert.strictEqual(fs.existsSync(dir), false)
	})

	test('a missing directory is not an error', () => {
		const dir = path.join(os.tmpdir(), 'gitbraid-rmdir-does-not-exist-' + String(process.pid))
		assert.doesNotThrow(() => removeDirBestEffort(dir))
	})

	test('swallows removal failures instead of throwing', () => {
		// A file where rmSync would be handed a path under a non-directory:
		// the error must be logged, not propagated into the teardown hook.
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitbraid-rmdir-'))
		const file = path.join(dir, 'f')
		fs.writeFileSync(file, 'x')
		try {
			assert.doesNotThrow(() => removeDirBestEffort(path.join(file, 'child')))
		} finally {
			removeDirBestEffort(dir)
		}
	})
})
