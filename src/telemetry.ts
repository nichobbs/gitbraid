import * as vscode from 'vscode'
import { log } from './channelLogger'

/**
 * GitBraid telemetry: opt-in, anonymous, and deliberately narrow.
 *
 * What we record:
 *   - Command invocations by command id (e.g. `gitbraid.assignFile`).
 *   - Aggregate counters exposed via {@link reportGauge} — stack size,
 *     floating-file count, rebase durations — always as numbers.
 *   - Error *kinds* via {@link reportError} (constructor name only, never
 *     the message, which can contain paths or branch names).
 *
 * What we never record:
 *   - File contents, file paths, workspace paths.
 *   - Branch names, remote URLs, repository identifiers.
 *   - Commit messages, PR titles, diff hunks.
 *   - Usernames, tokens, or any secret.
 *
 * Transport is plugged in via {@link setTelemetrySink}.  The default sink is
 * a no-op (writes through {@link log.debug} so developers can see events
 * locally but nothing leaves the machine).  A future downstream reporter —
 * Application Insights, Sentry, self-hosted collector — slots in with one
 * call at activation time; no command-site code has to change.
 *
 * Gating rules (all must be true):
 *   1. `gitbraid.telemetry.enabled` setting is `true`.
 *   2. `vscode.env.isTelemetryEnabled` is `true` (honours the user's
 *      global VS Code telemetry preference — we never override it).
 *   3. Workspace trust has been granted (checked by `extension.ts` before
 *      any telemetry call site runs).
 *
 * Privacy by construction:  every public function strips its payload to the
 * safe-keys allow-list in {@link _sanitise} before forwarding.  A stray
 * `path: ...` property added by a caller is dropped, not forwarded.
 */

export interface TelemetryEvent {
	name: string
	/** Low-cardinality string properties.  See allow-list in `_sanitise`. */
	properties?: Record<string, string>
	/** Numeric counters / durations. */
	measurements?: Record<string, number>
}

export interface TelemetrySink {
	send(event: TelemetryEvent): void
	flush?(): Promise<void>
	dispose?(): void
}

const SAFE_PROPERTY_KEYS = new Set([
	// Branch-stack shape — counts only, never names.
	'stackSize',
	'hostKind',            // 'github' | 'gitlab' | 'bitbucket' | 'none'
	// Command outcome qualifier — keep it enum-like.
	'outcome',             // 'success' | 'canceled' | 'conflict' | 'error'
	// Command family (groups related commands for dashboards).
	'commandGroup',        // 'assign' | 'stack' | 'rebase' | 'pr' | 'mcp'
	// Error class name — never the message.
	'errorKind',
])

const SAFE_MEASUREMENT_KEYS = new Set([
	'count',
	'durationMs',
	'stackSize',
	'floatingFiles',
	'hunkCount',
])

/**
 * Sink that drops every event.  Used by default so enabling telemetry via
 * setting alone does *not* cause any network activity — a real reporter has
 * to be wired in explicitly.
 */
class NoopSink implements TelemetrySink {
	send(event: TelemetryEvent): void {
		// log at debug level so local developers can see what would have been
		// sent without surfacing anything in release builds.
		log.debug('telemetry (no sink): ' + JSON.stringify(event))
	}
}

let _sink: TelemetrySink = new NoopSink()

/** Replace the sink.  Call this once during activation from a reporter plugin. */
export function setTelemetrySink(sink: TelemetrySink): void {
	try { _sink.dispose?.() } catch { /* ignore */ }
	_sink = sink
}

/** For tests. */
export function _getSinkForTest(): TelemetrySink {
	return _sink
}

export function telemetryEnabled(): boolean {
	try {
		if (!vscode.env.isTelemetryEnabled) return false
	} catch {
		// Older VS Code versions may not expose the API — treat as disabled.
		return false
	}
	try {
		return vscode.workspace.getConfiguration('gitbraid').get<boolean>('telemetry.enabled', false) === true
	} catch {
		return false
	}
}

export function reportEvent(
	name: string,
	properties?: Record<string, string>,
	measurements?: Record<string, number>,
): void {
	if (!telemetryEnabled()) return
	try {
		_sink.send({ name: _sanitiseName(name), ..._sanitise(properties, measurements) })
	} catch (e) {
		// Telemetry must never break the feature it's observing.  Log and
		// swallow.
		log.debug('telemetry.reportEvent failed: ' + (e instanceof Error ? e.message : String(e)))
	}
}

export function reportCommand(commandId: string, outcome: 'success' | 'canceled' | 'conflict' | 'error', durationMs?: number): void {
	if (!telemetryEnabled()) return
	const properties: Record<string, string> = { outcome, commandGroup: _commandGroup(commandId) }
	const measurements: Record<string, number> = durationMs === undefined ? {} : { durationMs }
	reportEvent(_sanitiseName(commandId), properties, measurements)
}

export function reportError(where: string, err: unknown): void {
	if (!telemetryEnabled()) return
	const kind = err instanceof Error ? err.constructor.name : 'Unknown'
	reportEvent(_sanitiseName(where + '.error'), { errorKind: kind, outcome: 'error' })
}

/**
 * Wrap an async command so its duration + outcome are reported automatically.
 * Use this in the command registration layer; callers don't need to touch
 * telemetry themselves.
 */
export function tracked<T>(commandId: string, fn: () => Promise<T>): Promise<T> {
	if (!telemetryEnabled()) return fn()
	const start = Date.now()
	return fn().then(
		(v) => { reportCommand(commandId, 'success', Date.now() - start); return v },
		(e) => {
			const outcome = /cancel/i.test(e?.message ?? '') ? 'canceled'
				: /conflict/i.test(e?.message ?? '') ? 'conflict'
				: 'error'
			reportCommand(commandId, outcome, Date.now() - start)
			throw e
		},
	)
}

export async function disposeTelemetry(): Promise<void> {
	try { await _sink.flush?.() } catch { /* ignore */ }
	try { _sink.dispose?.() } catch { /* ignore */ }
	_sink = new NoopSink()
}

// ─── Sanitisation ────────────────────────────────────────────────────────────

function _sanitiseName(name: string): string {
	// Strip anything that isn't a conventional command-id character so a
	// misuse like `reportEvent("user said: " + msg)` can't smuggle data
	// through the event name.
	return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80)
}

function _sanitise(
	properties: Record<string, string> | undefined,
	measurements: Record<string, number> | undefined,
): { properties?: Record<string, string>, measurements?: Record<string, number> } {
	const out: { properties?: Record<string, string>, measurements?: Record<string, number> } = {}
	if (properties) {
		const props: Record<string, string> = {}
		for (const [k, v] of Object.entries(properties)) {
			if (!SAFE_PROPERTY_KEYS.has(k)) continue
			// Cap property values to protect against accidental inclusion of
			// long unbounded strings (still no PII can slip through because
			// the key itself has to be in the allow-list).
			props[k] = String(v).slice(0, 32)
		}
		if (Object.keys(props).length > 0) out.properties = props
	}
	if (measurements) {
		const meas: Record<string, number> = {}
		for (const [k, v] of Object.entries(measurements)) {
			if (!SAFE_MEASUREMENT_KEYS.has(k)) continue
			if (Number.isFinite(v)) meas[k] = v
		}
		if (Object.keys(meas).length > 0) out.measurements = meas
	}
	return out
}

function _commandGroup(commandId: string): string {
	if (commandId.includes('assign')) return 'assign'
	if (commandId.includes('rebase')) return 'rebase'
	if (commandId.includes('Pr') || commandId.includes('submit') || commandId.includes('merge')) return 'pr'
	if (commandId.includes('mcp')) return 'mcp'
	if (commandId.includes('Stack') || commandId.includes('stack')) return 'stack'
	return 'other'
}
