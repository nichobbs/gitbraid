import * as assert from 'node:assert'
import * as vscode from 'vscode'
import { showError, withErrorHandler } from '../src/errorSurfacer'

suite('errorSurfacer', () => {

	test('showError: posts a single notification with an Open Output action', async () => {
		const vscodeAny = vscode.window as unknown as {
			showErrorMessage: (msg: string, ...items: string[]) => Thenable<string | undefined>
		}
		const original = vscodeAny.showErrorMessage
		const calls: Array<{ msg: string, items: string[] }> = []
		vscodeAny.showErrorMessage = (msg, ...items) => {
			calls.push({ msg, items })
			// Return undefined so we don't trigger `log.show()` during the test.
			return Promise.resolve(undefined)
		}
		try {
			await showError('boom', new Error('kaboom'))
			assert.strictEqual(calls.length, 1)
			assert.match(calls[0].msg, /boom.*kaboom/)
			assert.deepStrictEqual(calls[0].items, ['Open Output'])
		} finally {
			vscodeAny.showErrorMessage = original
		}
	})

	test('withErrorHandler: swallows rejections and surfaces them', async () => {
		const vscodeAny = vscode.window as unknown as {
			showErrorMessage: (msg: string, ...items: string[]) => Thenable<string | undefined>
		}
		const original = vscodeAny.showErrorMessage
		let callCount = 0
		vscodeAny.showErrorMessage = () => { callCount++; return Promise.resolve(undefined) }
		try {
			const wrapped = withErrorHandler(async () => { throw new Error('fail') })
			await assert.doesNotReject(() => wrapped())
			assert.strictEqual(callCount, 1)
		} finally {
			vscodeAny.showErrorMessage = original
		}
	})

	test('withErrorHandler: successful calls do not post', async () => {
		const vscodeAny = vscode.window as unknown as {
			showErrorMessage: (msg: string, ...items: string[]) => Thenable<string | undefined>
		}
		const original = vscodeAny.showErrorMessage
		let callCount = 0
		vscodeAny.showErrorMessage = () => { callCount++; return Promise.resolve(undefined) }
		try {
			const wrapped = withErrorHandler(async (n: number) => { assert.strictEqual(n, 7) })
			await wrapped(7)
			assert.strictEqual(callCount, 0)
		} finally {
			vscodeAny.showErrorMessage = original
		}
	})
})
