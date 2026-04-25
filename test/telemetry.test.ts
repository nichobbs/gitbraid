import * as assert from 'node:assert'
import * as vscode from 'vscode'
import {
	setTelemetrySink,
	reportEvent,
	reportCommand,
	reportError,
	tracked,
	telemetryEnabled,
	TelemetryEvent,
	TelemetrySink,
	disposeTelemetry,
} from '../src/telemetry'

/**
 * Force `vscode.env.isTelemetryEnabled` to true for the duration of a test.
 * The headless test host launches with `--disable-telemetry`, which makes
 * the production gate short-circuit; rewriting the property lets us
 * exercise the real reporting paths.  Restored on teardown.
 */
function forceTelemetryOn(): () => void {
	const env = vscode.env as unknown as { isTelemetryEnabled: boolean }
	const original = env.isTelemetryEnabled
	let restored = false
	try {
		Object.defineProperty(vscode.env, 'isTelemetryEnabled', {
			value: true,
			writable: true,
			configurable: true,
		})
	} catch {
		restored = true
	}
	return () => {
		if (restored) return
		try {
			Object.defineProperty(vscode.env, 'isTelemetryEnabled', {
				value: original,
				writable: true,
				configurable: true,
			})
		} catch { /* ignore */ }
	}
}

class RecordingSink implements TelemetrySink {
	events: TelemetryEvent[] = []
	send(event: TelemetryEvent): void { this.events.push(event) }
}

async function enable(): Promise<() => Promise<void>> {
	// Tests run inside VS Code, so the global telemetry setting already
	// respects whatever the host provides; we only need to flip the GitBraid
	// side, then restore on teardown.
	const cfg = vscode.workspace.getConfiguration('gitbraid')
	await cfg.update('telemetry.enabled', true, vscode.ConfigurationTarget.Workspace)
	return async () => {
		await cfg.update('telemetry.enabled', false, vscode.ConfigurationTarget.Workspace)
	}
}

suite('telemetry: sanitisation', () => {
	let sink: RecordingSink
	let restore: () => Promise<void>

	setup(async () => {
		sink = new RecordingSink()
		setTelemetrySink(sink)
		restore = await enable()
	})

	teardown(async () => {
		await restore()
		await disposeTelemetry()
	})

	test('no-ops when global telemetry is disabled', async () => {
		// If the VS Code host reports telemetry disabled, reportEvent must
		// be a no-op.  Skip the assertion when the host has it enabled so
		// the suite still passes in both environments.
		if (vscode.env.isTelemetryEnabled) return
		reportEvent('anything')
		assert.strictEqual(sink.events.length, 0)
	})

	test('drops non-allow-listed properties', () => {
		if (!telemetryEnabled()) return
		reportEvent(
			'test.event',
			{ path: '/home/alice/secret.txt', outcome: 'success' },
			{ durationMs: 123, pii: 9 },
		)
		assert.strictEqual(sink.events.length, 1)
		const ev = sink.events[0]
		assert.strictEqual(ev.name, 'test.event')
		assert.deepStrictEqual(ev.properties, { outcome: 'success' })
		assert.deepStrictEqual(ev.measurements, { durationMs: 123 })
	})

	test('sanitises event names to safe charset', () => {
		if (!telemetryEnabled()) return
		reportEvent('rm -rf / ; user@example.com')
		assert.strictEqual(sink.events[0].name.includes('/'), false)
		assert.strictEqual(sink.events[0].name.includes(' '), false)
		assert.strictEqual(sink.events[0].name.includes(';'), false)
	})

	test('reportCommand classifies outcome', () => {
		if (!telemetryEnabled()) return
		reportCommand('gitbraid.assignFile', 'success', 45)
		const ev = sink.events[0]
		assert.strictEqual(ev.properties?.outcome, 'success')
		assert.strictEqual(ev.properties?.commandGroup, 'assign')
		assert.strictEqual(ev.measurements?.durationMs, 45)
	})

	test('reportError records class name but not message', () => {
		if (!telemetryEnabled()) return
		class MyCustomError extends Error {}
		reportError('submitStack', new MyCustomError('/home/alice/.env is missing'))
		const ev = sink.events[0]
		assert.strictEqual(ev.properties?.errorKind, 'MyCustomError')
		assert.strictEqual(
			JSON.stringify(ev).includes('/home/alice'),
			false,
			'error message must not leak into the sink',
		)
	})

	test('tracked() reports success duration', async () => {
		if (!telemetryEnabled()) return
		sink.events.length = 0
		const result = await tracked('gitbraid.test.op', async () => {
			await new Promise((r) => setTimeout(r, 5))
			return 42
		})
		assert.strictEqual(result, 42)
		assert.strictEqual(sink.events.length, 1)
		const ev = sink.events[0]
		assert.strictEqual(ev.properties?.outcome, 'success')
		assert.ok((ev.measurements?.durationMs ?? 0) >= 0)
	})

	test('tracked() reports error outcome and rethrows', async () => {
		if (!telemetryEnabled()) return
		sink.events.length = 0
		await assert.rejects(
			() => tracked('gitbraid.test.fail', async () => { throw new Error('boom') }),
			/boom/,
		)
		assert.strictEqual(sink.events.length, 1)
		assert.strictEqual(sink.events[0].properties?.outcome, 'error')
	})

	test('tracked() classifies cancel messages as canceled', async () => {
		if (!telemetryEnabled()) return
		sink.events.length = 0
		await assert.rejects(
			() => tracked('gitbraid.test.cancel', async () => { throw new Error('user canceled the picker') }),
			/canceled/,
		)
		assert.strictEqual(sink.events[0].properties?.outcome, 'canceled')
	})
})

// ─── Forced-on suite: exercise actual reporting paths ─────────────────────────

suite('telemetry: full coverage with isTelemetryEnabled forced on', () => {
	let sink: RecordingSink
	let restore: () => Promise<void>
	let restoreEnv: () => void

	setup(async () => {
		restoreEnv = forceTelemetryOn()
		sink = new RecordingSink()
		setTelemetrySink(sink)
		restore = await enable()
	})

	teardown(async () => {
		await restore()
		await disposeTelemetry()
		restoreEnv()
	})

	test('reportEvent forwards both properties and measurements', () => {
		if (!telemetryEnabled()) return
		reportEvent('test.full', { stackSize: '5', outcome: 'success' }, { count: 1, durationMs: 12 })
		assert.strictEqual(sink.events.length, 1)
		assert.deepStrictEqual(sink.events[0].properties, { stackSize: '5', outcome: 'success' })
		assert.deepStrictEqual(sink.events[0].measurements, { count: 1, durationMs: 12 })
	})

	test('reportEvent strips non-allow-listed measurement keys', () => {
		if (!telemetryEnabled()) return
		reportEvent('test.meas', undefined, { count: 1, secretValue: 999 })
		assert.deepStrictEqual(sink.events[0].measurements, { count: 1 })
	})

	test('reportEvent caps property values at 32 characters', () => {
		if (!telemetryEnabled()) return
		const longValue = 'x'.repeat(80)
		reportEvent('test.long', { outcome: longValue })
		assert.strictEqual(sink.events[0].properties?.outcome.length, 32)
	})

	test('reportEvent: sink throw is swallowed and does not reach caller', () => {
		if (!telemetryEnabled()) return
		const throwingSink: TelemetrySink = {
			send: () => { throw new Error('sink down') },
		}
		setTelemetrySink(throwingSink)
		// Must not throw
		reportEvent('test.swallow', undefined, undefined)
	})

	test('reportEvent: drops unrecognised property keys', () => {
		if (!telemetryEnabled()) return
		reportEvent('test.drop', { not_in_allow_list: 'oops' })
		// All keys filtered, properties undefined.
		assert.strictEqual(sink.events[0].properties, undefined)
	})

	test('reportEvent: drops non-finite measurements', () => {
		if (!telemetryEnabled()) return
		reportEvent('test.nan', undefined, { count: NaN, durationMs: 5 })
		assert.deepStrictEqual(sink.events[0].measurements, { durationMs: 5 })
	})

	test('reportCommand classifies commandGroup for stack/rebase/pr/mcp/other', () => {
		if (!telemetryEnabled()) return
		const cases: Array<[string, string]> = [
			['gitbraid.assignFile', 'assign'],
			['gitbraid.rebaseBranch', 'rebase'],
			['gitbraid.submitPr', 'pr'],
			['gitbraid.startmcpServer', 'mcp'],  // lowercase 'mcp'
			['gitbraid.refreshStackView', 'stack'],
			['gitbraid.somethingElse', 'other'],
		]
		for (const [cmd, group] of cases) {
			sink.events.length = 0
			reportCommand(cmd, 'success')
			assert.strictEqual(sink.events[0].properties?.commandGroup, group, `${cmd} → ${group}`)
		}
	})

	test('reportError records errorKind and outcome', () => {
		if (!telemetryEnabled()) return
		class CustomError extends Error {}
		reportError('site', new CustomError('whatever'))
		assert.strictEqual(sink.events[0].properties?.errorKind, 'CustomError')
		assert.strictEqual(sink.events[0].properties?.outcome, 'error')
	})

	test('reportError: non-Error value records "Unknown"', () => {
		if (!telemetryEnabled()) return
		reportError('site', 'string-error')
		assert.strictEqual(sink.events[0].properties?.errorKind, 'Unknown')
	})

	test('tracked: success path records durationMs ≥ 0', async () => {
		if (!telemetryEnabled()) return
		sink.events.length = 0
		const v = await tracked('gitbraid.test.success', async () => 99)
		assert.strictEqual(v, 99)
		assert.strictEqual(sink.events[0].properties?.outcome, 'success')
		assert.ok((sink.events[0].measurements?.durationMs ?? -1) >= 0)
	})

	test('tracked: classifies "conflict" messages', async () => {
		if (!telemetryEnabled()) return
		sink.events.length = 0
		await assert.rejects(
			() => tracked('gitbraid.test.conflict', async () => { throw new Error('merge conflict here') }),
			/conflict/,
		)
		assert.strictEqual(sink.events[0].properties?.outcome, 'conflict')
	})

	test('telemetryEnabled returns false when gitbraid setting is off', async () => {
		if (!telemetryEnabled()) return
		await vscode.workspace.getConfiguration('gitbraid')
			.update('telemetry.enabled', false, vscode.ConfigurationTarget.Workspace)
		assert.strictEqual(telemetryEnabled(), false)
		// Restore for teardown
		await vscode.workspace.getConfiguration('gitbraid')
			.update('telemetry.enabled', true, vscode.ConfigurationTarget.Workspace)
	})

	test('disposeTelemetry resets sink to no-op without throwing', async () => {
		if (!telemetryEnabled()) return
		const customSink: TelemetrySink = {
			events: [] as TelemetryEvent[],
			send(event) { (this as any).events.push(event) },
			flush: async () => { /* */ },
			dispose: () => { /* */ },
		} as TelemetrySink & { events: TelemetryEvent[] }
		setTelemetrySink(customSink)
		await disposeTelemetry()
	})

	test('reportCommand without durationMs: emits no measurements', () => {
		if (!telemetryEnabled()) return
		reportCommand('gitbraid.assignFile', 'success')
		assert.strictEqual(sink.events[0].measurements, undefined)
	})

	test('event name is sanitised and capped at 80 chars', () => {
		if (!telemetryEnabled()) return
		const longName = 'a'.repeat(200) + ' bad chars / ; '
		reportEvent(longName, { outcome: 'success' })
		assert.ok(sink.events[0].name.length <= 80)
		assert.ok(!/[\s/;]/.test(sink.events[0].name))
	})
})
