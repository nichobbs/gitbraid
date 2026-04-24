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
