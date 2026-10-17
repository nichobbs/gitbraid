import * as assert from 'node:assert'
import * as fs from 'node:fs'
import { renameWithRetry } from '../src/configService'

suite('renameWithRetry', () => {
	const real = fs.promises.rename
	teardown(() => { fs.promises.rename = real })

	function failTimes(n: number, code: string): () => number {
		let calls = 0
		fs.promises.rename = async () => {
			calls++
			if (calls <= n) throw Object.assign(new Error(code), { code })
		}
		return () => calls
	}

	test('retries transient EPERM/EBUSY/EACCES and then succeeds', async () => {
		for (const code of ['EPERM', 'EBUSY', 'EACCES']) {
			const calls = failTimes(3, code)
			await renameWithRetry('a', 'b')
			assert.strictEqual(calls(), 4, code)
		}
	})

	test('gives up after the attempt budget and rethrows', async () => {
		const calls = failTimes(100, 'EPERM')
		await assert.rejects(() => renameWithRetry('a', 'b', 3), /EPERM/)
		assert.strictEqual(calls(), 3)
	})

	test('does not retry other errors', async () => {
		const calls = failTimes(100, 'ENOENT')
		await assert.rejects(() => renameWithRetry('a', 'b'), /ENOENT/)
		assert.strictEqual(calls(), 1)
	})
})
