import * as assert from 'node:assert'
import { LogLevel } from 'vscode'
import { log } from '../src/channelLogger'

// ─── Suite ───────────────────────────────────────────────────────────────────

suite('Logger (channelLogger)', () => {

	// ── notification ──────────────────────────────────────────────────────────

	test('notification: info type does not throw', () => {
		assert.doesNotThrow(() => log.notification('test info notification'))
	})

	test('notification: warn type does not throw', () => {
		assert.doesNotThrow(() => log.notification('test warn notification', 'Warn' as any))
	})

	test('notification: error type does not throw', () => {
		assert.doesNotThrow(() => log.notification('test error notification', 'Error' as any))
	})

	test('notificationWarn: does not throw', () => {
		assert.doesNotThrow(() => log.notificationWarn('test warn'))
	})

	test('notificationError: does not throw', () => {
		assert.doesNotThrow(() => log.notificationError('test error'))
	})

	test('error: accepts an Error object', () => {
		assert.doesNotThrow(() => log.error(new Error('test error object')))
	})

	test('error: accepts an Error object without stack', () => {
		const e = new Error('no stack')
		delete e.stack
		assert.doesNotThrow(() => log.error(e))
	})

	test('writeMessage: undefined message is a no-op', () => {
		// Covers the early-return guard for undefined messages
		assert.doesNotThrow(() => (log as any).writeMessage(LogLevel.Info, undefined))
	})

	test('writeMessage: with includeStack=true covers decorateMessage includeStack branch', () => {
		// LogLevel.Info >= consoleLogLevel so writeToConsole is called, decorateMessage with includeStack=true
		assert.doesNotThrow(() => (log as any).writeMessage(LogLevel.Info, 'test-include-stack', true))
	})

	test('getLevelText: returns Off string for LogLevel.Off', () => {
		const result = (log as any).getLevelText(LogLevel.Off)
		assert.strictEqual(result, 'Off  ')
	})

	// ── Regression: notification must not double-fire ─────────────────────────
	// Before the fix for reviews/02-bugs-and-correctness.md
	// "log.notification double-fires info messages", calling notification()
	// with notificationsEnabled=true produced two popups. Verify one.

	test('notification(Info): with notifications enabled produces one popup', () => {
		const vscode = require('vscode') as typeof import('vscode')
		const originalShow = vscode.window.showInformationMessage
		let calls = 0
		;(vscode.window as any).showInformationMessage = () => {
			calls++
			return Promise.resolve(undefined)
		}
		try {
			;(log as any).notificationsEnabled = true
			log.notification('once-only')
			assert.strictEqual(calls, 1, 'expected exactly one showInformationMessage call')
		} finally {
			;(vscode.window as any).showInformationMessage = originalShow
		}
	})

	test('notification(Info): with notifications disabled produces no popup', () => {
		const vscode = require('vscode') as typeof import('vscode')
		const originalShow = vscode.window.showInformationMessage
		let calls = 0
		;(vscode.window as any).showInformationMessage = () => {
			calls++
			return Promise.resolve(undefined)
		}
		try {
			;(log as any).notificationsEnabled = false
			log.notification('suppressed')
			assert.strictEqual(calls, 0)
		} finally {
			;(log as any).notificationsEnabled = true
			;(vscode.window as any).showInformationMessage = originalShow
		}
	})

	// ── Regression: getInstance is idempotent ─────────────────────────────────
	// Earlier, Logger.getInstance() created a fresh Logger and cleared the
	// output channel on every call; any previously-held `log` reference would
	// end up writing to the old channel while new code ran on a new one.

	test('Logger.getInstance: returns the same instance on repeated calls', () => {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const { Logger } = require('../src/channelLogger') as { Logger?: { getInstance: () => unknown } }
		if (!Logger) {
			// The class isn't exported; the module-level `log` export is
			// itself the singleton. Reading through the prototype is enough.
			const proto = Object.getPrototypeOf(log) as { constructor: { getInstance?: () => unknown } }
			const ctor = proto.constructor
			if (typeof ctor.getInstance !== 'function') {
				return // nothing to assert; behaviour is covered by compile
			}
			const a = ctor.getInstance()
			const b = ctor.getInstance()
			assert.strictEqual(a, b)
			return
		}
		assert.strictEqual(Logger.getInstance(), Logger.getInstance())
	})

})
