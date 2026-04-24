import * as vscode from 'vscode'
import { log } from './channelLogger'
import { ConfigService } from './configService'
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

export interface MergeStackOptions {
	/** How often to poll the host for queue status.  Default 30s. */
	pollIntervalMs?: number
	/** Hard timeout per branch (ms).  Default 30 minutes. */
	perBranchTimeoutMs?: number
}

export interface MergeStackResult {
	branch: string
	prNumber?: number
	ok: boolean
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
				results.push({ branch: entry.name, ok: false, message: `getPR: ${errMsg(e)}` })
				continue
			}
			if (!pr) {
				results.push({
					branch: entry.name,
					ok: false,
					message: 'no PR — run Submit Stack first',
				})
				continue
			}
			if (pr.state === 'merged') {
				results.push({ branch: entry.name, prNumber: pr.number, ok: true, message: 'already merged' })
				continue
			}

			progress?.report(`${String(i + 1)}/${String(stack.length)} ${entry.name} — enqueuing #${String(pr.number)}`)
			try {
				const { position } = await this._adapter.enqueue(pr.number)
				log.info(`MergeQueue: enqueued ${entry.name} (#${String(pr.number)}) at position ${String(position)}`)
			} catch (e) {
				results.push({ branch: entry.name, prNumber: pr.number, ok: false, message: `enqueue: ${errMsg(e)}` })
				continue
			}

			try {
				await this._waitForMerge(entry.name, pr.number, poll, timeout, progress, token, i + 1, stack.length)
				results.push({ branch: entry.name, prNumber: pr.number, ok: true })
			} catch (e) {
				results.push({ branch: entry.name, prNumber: pr.number, ok: false, message: errMsg(e) })
				// Try to dequeue so a stuck PR doesn't block the user.
				try { await this._adapter.dequeue(pr.number) } catch { /* best-effort */ }
				// Bail out of the loop if the user cancelled — no point enqueuing more.
				if (token?.aborted) break
			}
		}

		return results
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

			const positionText = status.position !== undefined ? ` (position ${String(status.position)})` : ''
			const stateText = pr?.state ?? 'unknown'
			progress?.report(`${String(idx)}/${String(total)} ${branch} — ${stateText}${positionText}`)

			await this._clock.sleep(pollMs, token)
		}
	}
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
