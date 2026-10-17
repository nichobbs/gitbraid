import * as vscode from 'vscode'
import { log } from './channelLogger'
import { ConfigService } from './configService'
import type { BranchStackEntry } from './configTypes'
import { PRHostAdapter, PRMetadata, QueueStatus } from './prHostAdapter'

/**
 * Plan 05 — drive a stack through the PR host's merge queue, one layer at a
 * time, waiting for each predecessor to merge before enqueuing the next.
 *
 * The service is deliberately poll-based; it does not watch webhooks.  A
 * single `mergeStack()` invocation:
 *
 *   1. For each stack branch (base-first), ensure the PR is known.
 *   2. Call `adapter.enqueue(prNumber)`.
 *   3. Poll `queueStatus` + `getPR` until the PR is out of queue (merged).
 *   4. Move on to the next branch.
 *
 * Progress updates flow through a {@link vscode.Progress} handle so the
 * status bar can render `$(list-ordered) N/M queued`.
 *
 * The polling loop is interruptible via a
 * {@link vscode.CancellationToken} so `withProgress(..., { cancellable })`
 * can abort the sequence without leaving the queue half-advanced.
 */

export type MergeStrategy = 'serial' | 'pipelined'

export interface MergeStackOptions {
	/** How often to poll the host for queue status.  Default 30s. */
	pollIntervalMs?: number
	/** Hard timeout per branch (ms).  Default 30 minutes. */
	perBranchTimeoutMs?: number
	/** `serial` (default) waits for each layer before enqueuing the next. */
	strategy?: MergeStrategy
	/** Pipelined only: layers in flight at once, clamped to 1..5.  Default 2. */
	pipelineDepth?: number
	/** Pipelined only: leave in-flight layers queued when the run is cancelled. */
	keepQueuedOnCancel?: boolean
}

/**
 * What became of a layer.  `blocked` means a layer below it failed, so it was
 * never merged (or was dequeued); `skipped` means it was never attempted.
 */
export type MergeLayerState = 'merged' | 'failed' | 'blocked' | 'skipped'

export interface MergeStackResult {
	branch: string
	prNumber?: number
	ok: boolean
	state: MergeLayerState
	/** For `blocked`: the lower layer whose failure stopped this one. */
	blockedBy?: string
	message?: string
}

export interface ProgressSink {
	report(msg: string): void
}

/**
 * Inject a clock so tests can fast-forward polling without real setTimeout.
 */
export interface Clock {
	now(): number
	sleep(ms: number, signal?: AbortSignal): Promise<void>
}

export const defaultClock: Clock = {
	now: () => Date.now(),
	sleep: (ms, signal) => new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error('aborted'))
			return
		}
		const t = setTimeout(() => resolve(), ms)
		signal?.addEventListener('abort', () => {
			clearTimeout(t)
			reject(new Error('aborted'))
		}, { once: true })
	}),
}

export class MergeQueueService {

	constructor(
		private readonly _config: ConfigService,
		private readonly _adapter: PRHostAdapter,
		private readonly _clock: Clock = defaultClock,
	) {}

	/**
	 * Sequentially enqueue every branch in the stack and wait for it to merge
	 * before moving on.  Returns per-branch results; failures do not cascade —
	 * later branches are still attempted in isolation because the host may
	 * have accepted some of them already.
	 */
	async mergeStack(
		options: MergeStackOptions = {},
		progress?: ProgressSink,
		token?: AbortSignal,
	): Promise<MergeStackResult[]> {
		const stack = this._config.getStack().filter((e) => !e.scratch)
		if (stack.length === 0) return []

		if (options.strategy === 'pipelined') {
			return this._mergePipelined(stack, options, progress, token)
		}

		const poll = Math.max(1_000, options.pollIntervalMs ?? 30_000)
		const timeout = Math.max(poll, options.perBranchTimeoutMs ?? 30 * 60_000)
		const results: MergeStackResult[] = []

		for (let i = 0; i < stack.length; i++) {
			const entry = stack[i]
			progress?.report(`${String(i + 1)}/${String(stack.length)} ${entry.name} — fetching PR`)

			let pr: PRMetadata | undefined
			try {
				pr = await this._adapter.getPR(entry.name)
			} catch (e) {
				results.push({ branch: entry.name, ok: false, state: 'failed', message: `getPR: ${errMsg(e)}` })
				continue
			}
			if (!pr) {
				results.push({
					branch: entry.name,
					ok: false,
					state: 'skipped',
					message: 'no PR — run Submit Stack first',
				})
				continue
			}
			if (pr.state === 'merged') {
				results.push({ branch: entry.name, prNumber: pr.number, ok: true, state: 'merged', message: 'already merged' })
				continue
			}

			progress?.report(`${String(i + 1)}/${String(stack.length)} ${entry.name} — enqueuing #${String(pr.number)}`)
			try {
				const { position } = await this._adapter.enqueue(pr.number)
				log.info(`MergeQueue: enqueued ${entry.name} (#${String(pr.number)}) at position ${String(position)}`)
			} catch (e) {
				results.push({ branch: entry.name, prNumber: pr.number, ok: false, state: 'failed', message: `enqueue: ${errMsg(e)}` })
				continue
			}

			try {
				await this._waitForMerge(entry.name, pr.number, poll, timeout, progress, token, i + 1, stack.length)
				results.push({ branch: entry.name, prNumber: pr.number, ok: true, state: 'merged' })
			} catch (e) {
				results.push({ branch: entry.name, prNumber: pr.number, ok: false, state: 'failed', message: errMsg(e) })
				// Try to dequeue so a stuck PR doesn't block the user.
				try { await this._adapter.dequeue(pr.number) } catch { /* best-effort */ }
				// Bail out of the loop if the user cancelled — no point enqueuing more.
				if (token?.aborted) break
			}
		}

		return results
	}

	// ─── Pipelined strategy (Plan 17) ─────────────────────────────────────────

	/**
	 * Keep up to `pipelineDepth` layers in flight.  A layer is enqueued only
	 * once every layer below it is merged or itself in flight, and on hosts
	 * whose queue is not ordered the depth is clamped to one.  A failure stops
	 * all enqueuing and dequeues everything above the failed layer.
	 */
	private async _mergePipelined(
		stack: BranchStackEntry[],
		options: MergeStackOptions,
		progress: ProgressSink | undefined,
		token: AbortSignal | undefined,
	): Promise<MergeStackResult[]> {
		const poll = Math.max(1_000, options.pollIntervalMs ?? 30_000)
		const timeout = Math.max(poll, options.perBranchTimeoutMs ?? 30 * 60_000)
		const ordered = this._adapter.supportsOrderedQueue === true
		const depth = ordered ? Math.min(5, Math.max(1, Math.floor(options.pipelineDepth ?? 2))) : 1
		const trunk = stack[0].base
		if (!ordered && (options.pipelineDepth ?? 1) > 1) {
			log.info(`MergeQueue: ${this._adapter.name} has no ordered queue; pipeline depth clamped to 1`)
		}

		const layers: Layer[] = stack.map((entry) => ({ entry, status: 'pending', misses: 0 }))

		// 1. Pre-flight, in parallel.  Nothing is enqueued unless every layer passes.
		const lookups = await Promise.allSettled(stack.map((e) => this._adapter.getPR(e.name)))
		const problems: string[] = []
		lookups.forEach((r, i) => {
			const layer = layers[i]
			if (r.status === 'rejected') {
				layer.status = 'failed'
				layer.message = `getPR: ${errMsg(r.reason)}`
			} else if (!r.value) {
				layer.status = 'skipped'
				layer.message = 'no PR — run Submit Stack first'
			} else {
				const pr = r.value
				layer.pr = pr
				if (pr.state === 'merged') {
					layer.status = 'merged'
					layer.message = 'already merged'
				} else if (pr.state === 'closed') {
					layer.status = 'failed'
					layer.message = `PR #${String(pr.number)} is closed`
				} else if (pr.state === 'draft') {
					layer.status = 'failed'
					layer.message = `PR #${String(pr.number)} is a draft`
				} else if (pr.base !== layer.entry.base && pr.base !== trunk) {
					layer.status = 'failed'
					layer.message = `PR #${String(pr.number)} targets "${pr.base}", expected "${layer.entry.base}"`
				}
			}
			if (layer.status === 'failed' || layer.status === 'skipped') {
				problems.push(`${layer.entry.name}: ${layer.message ?? ''}`)
			}
		})
		if (problems.length > 0) {
			const first = layers.find((l) => l.status === 'failed' || l.status === 'skipped')!
			for (const l of layers) {
				if (l.status === 'pending') {
					l.status = 'skipped'
					l.message = `pre-flight failed for "${first.entry.name}"; nothing was enqueued`
				}
			}
			log.warn('MergeQueue: pre-flight failed: ' + problems.join('; '))
			return this._pipelineResults(layers)
		}

		// 2..6. Sliding window.
		const inflight = new Set<number>()
		let stopped = false
		let interval = poll
		const fail = async (i: number, message: string, dequeueSelf: boolean): Promise<void> => {
			const layer = layers[i]
			layer.status = 'failed'
			layer.message = message
			inflight.delete(i)
			if (dequeueSelf && layer.pr) await this._dequeueQuietly(layer.pr.number)
			stopped = true
			// Everything above the failed layer must not merge without it.
			for (let j = i + 1; j < layers.length; j++) {
				const above = layers[j]
				if (above.status === 'merged' || above.status === 'failed') continue
				if (above.status === 'inflight') {
					inflight.delete(j)
					if (above.pr) await this._dequeueQuietly(above.pr.number)
				}
				above.status = 'blocked'
				above.blockedBy = layer.entry.name
				above.message = `blocked by "${layer.entry.name}"`
			}
		}

		for (;;) {
			if (token?.aborted) {
				for (const i of [...inflight]) {
					const layer = layers[i]
					if (!options.keepQueuedOnCancel && layer.pr) await this._dequeueQuietly(layer.pr.number)
					layer.status = 'failed'
					layer.message = options.keepQueuedOnCancel ? 'cancelled (left queued)' : 'cancelled'
				}
				inflight.clear()
				for (const l of layers) {
					if (l.status === 'pending') {
						l.status = 'skipped'
						l.message = 'cancelled'
					}
				}
				break
			}

			// Fill the window.
			while (!stopped && inflight.size < depth) {
				const n = layers.findIndex((l) => l.status === 'pending')
				if (n < 0) break
				const layer = layers[n]
				const pr = layer.pr!
				try {
					if (pr.base !== trunk) {
						await this._retarget(pr.number, trunk)
						log.info(`MergeQueue: retargeted #${String(pr.number)} to ${trunk}`)
					}
					const { position } = await this._adapter.enqueue(pr.number)
					log.info(`MergeQueue: enqueued ${layer.entry.name} (#${String(pr.number)}) at position ${String(position)}`)
				} catch (e) {
					await fail(n, `enqueue: ${errMsg(e)}`, false)
					break
				}
				layer.status = 'inflight'
				layer.enqueuedAt = this._clock.now()
				inflight.add(n)
			}

			if (inflight.size === 0) break

			// One poll over everything in flight.
			const order = [...inflight].sort((a, b) => a - b)
			const checks = await Promise.allSettled(order.map((i) => this._checkLayer(layers[i])))
			let changed = false
			for (let k = 0; k < order.length; k++) {
				const i = order[k]
				const layer = layers[i]
				if (layer.status !== 'inflight') continue   // already handled by a lower layer's failure
				const check = checks[k]
				const outcome: LayerOutcome = check.status === 'fulfilled' ? check.value : 'waiting'
				if (outcome === 'merged') {
					layer.status = 'merged'
					inflight.delete(i)
					changed = true
				} else if (outcome === 'closed') {
					await fail(i, `PR #${String(layer.pr!.number)} was closed without merging`, false)
					changed = true
				} else if (outcome === 'missing') {
					layer.misses++
					if (layer.misses >= MAX_CONSECUTIVE_PR_NOT_FOUND) {
						await fail(i,
							`PR #${String(layer.pr!.number)} for "${layer.entry.name}" was not found on ${String(layer.misses)} ` +
							'consecutive polls — it may have been deleted, renamed, or force-pushed to a different branch.',
							true)
						changed = true
					}
				} else {
					layer.misses = 0
					if (this._clock.now() - (layer.enqueuedAt ?? 0) > timeout) {
						await fail(i, `timed out after ${String(Math.round(timeout / 1000))}s waiting for #${String(layer.pr!.number)}`, true)
						changed = true
					}
				}
			}

			const merged = layers.filter((l) => l.status === 'merged').length
			const pending = layers.filter((l) => l.status === 'pending').length
			progress?.report(`${String(merged)}/${String(layers.length)} merged, ${String(inflight.size)} in flight, ${String(pending)} pending`)

			if (inflight.size === 0 && (stopped || pending === 0)) break
			interval = changed ? poll : Math.min(Math.max(poll, MAX_IDLE_POLL_MS), Math.ceil(interval * 1.5))
			try {
				await this._clock.sleep(interval, token)
			} catch {
				// Aborted: the top of the loop performs the cancellation.
			}
		}

		return this._pipelineResults(layers)
	}

	private _pipelineResults(layers: Layer[]): MergeStackResult[] {
		return layers.map((l): MergeStackResult => {
			const state: MergeLayerState = l.status === 'merged' ? 'merged'
				: l.status === 'blocked' ? 'blocked'
				: l.status === 'failed' ? 'failed'
				: 'skipped'
			return {
				branch: l.entry.name,
				...(l.pr ? { prNumber: l.pr.number } : {}),
				ok: state === 'merged',
				state,
				...(l.blockedBy ? { blockedBy: l.blockedBy } : {}),
				...(l.message ? { message: l.message } : {}),
			}
		})
	}

	private async _checkLayer(layer: Layer): Promise<LayerOutcome> {
		const pr = await this._adapter.getPR(layer.entry.name).catch(() => undefined)
		if (pr?.state === 'merged') return 'merged'
		if (pr?.state === 'closed') return 'closed'
		return pr ? 'waiting' : 'missing'
	}

	private async _retarget(prNumber: number, newBase: string): Promise<void> {
		if (this._adapter.retargetPR) {
			await this._adapter.retargetPR(prNumber, newBase)
		} else {
			await this._adapter.updatePR(prNumber, { base: newBase })
		}
	}

	private async _dequeueQuietly(prNumber: number): Promise<void> {
		try {
			await this._adapter.dequeue(prNumber)
		} catch (e) {
			log.warn(`MergeQueue: could not dequeue #${String(prNumber)}: ${errMsg(e)}`)
		}
	}

	private async _waitForMerge(
		branch: string,
		prNumber: number,
		pollMs: number,
		totalTimeoutMs: number,
		progress: ProgressSink | undefined,
		token: AbortSignal | undefined,
		idx: number,
		total: number,
	): Promise<void> {
		const start = this._clock.now()
		let consecutiveNotFound = 0
		for (;;) {
			if (token?.aborted) throw new Error('cancelled')
			if (this._clock.now() - start > totalTimeoutMs) {
				throw new Error(`timed out after ${String(Math.round(totalTimeoutMs / 1000))}s waiting for #${String(prNumber)}`)
			}

			let status: QueueStatus
			try {
				status = await this._adapter.queueStatus(prNumber)
			} catch (e) {
				log.warn('MergeQueue.queueStatus: ' + errMsg(e))
				status = { inQueue: false }
			}

			const pr = await this._adapter.getPR(branch).catch(() => undefined)
			if (pr?.state === 'merged') return
			if (pr?.state === 'closed') {
				throw new Error(`PR #${String(prNumber)} was closed without merging`)
			}

			// A PR that stops resolving (deleted, renamed, force-pushed to a
			// different head) would otherwise poll silently until the full
			// timeout — often 30 minutes — before failing. A few consecutive
			// misses is a much stronger signal than one, so fail fast instead
			// of waiting out the clock on an unrecoverable state.
			if (!pr) {
				consecutiveNotFound++
				if (consecutiveNotFound >= MAX_CONSECUTIVE_PR_NOT_FOUND) {
					throw new Error(
						`PR #${String(prNumber)} for "${branch}" was not found on ${String(consecutiveNotFound)} ` +
						'consecutive polls — it may have been deleted, renamed, or force-pushed to a different branch.',
					)
				}
			} else {
				consecutiveNotFound = 0
			}

			const positionText = status.position !== undefined ? ` (position ${String(status.position)})` : ''
			const stateText = pr?.state ?? 'unknown'
			progress?.report(`${String(idx)}/${String(total)} ${branch} — ${stateText}${positionText}`)

			await this._clock.sleep(pollMs, token)
		}
	}
}

/**
 * How many consecutive polls a PR may fail to resolve before `_waitForMerge`
 * gives up early instead of waiting out the full per-branch timeout.
 */
const MAX_CONSECUTIVE_PR_NOT_FOUND = 3

/** Pipelined polling backs off towards this interval while nothing changes. */
const MAX_IDLE_POLL_MS = 120_000

type LayerOutcome = 'merged' | 'closed' | 'missing' | 'waiting'

interface Layer {
	entry: BranchStackEntry
	status: 'pending' | 'inflight' | 'merged' | 'failed' | 'blocked' | 'skipped'
	pr?: PRMetadata
	enqueuedAt?: number
	misses: number
	blockedBy?: string
	message?: string
}

function errMsg(e: unknown): string {
	return e instanceof Error ? e.message : String(e)
}

/**
 * Wrap a VS Code `withProgress` call with a status-bar-aware sink so
 * callers that want the terser status-bar rendering (e.g. the background
 * path from a gesture) can swap it in.
 */
export function progressFromVsCode(
	progress: vscode.Progress<{ message?: string }>,
): ProgressSink {
	return { report: (msg) => progress.report({ message: msg }) }
}
