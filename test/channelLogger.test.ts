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

})
