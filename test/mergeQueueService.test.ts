import * as assert from 'node:assert'
import * as vscode from 'vscode'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { ConfigService } from '../src/configService'
import {
	MergeQueueService,
	Clock,
	ProgressSink,
} from '../src/mergeQueueService'
import {
	PRHostAdapter,
	PRMetadata,
	CreatePRInput,
	QueueStatus,
} from '../src/prHostAdapter'

function wsRoot(): vscode.Uri { return vscode.workspace.workspaceFolders![0].uri }

function cleanup(): void {
	try { fs.rmSync(path.join(wsRoot().fsPath, '.worktrees'), { recursive: true, force: true }) } catch { /* ignore */ }
}

/** Virtual clock that advances via `tick()` rather than real time. */
class FakeClock implements Clock {
	private _t = 0
	private readonly _pending: Array<{ at: number, resolve: () => void }> = []

	now(): number { return this._t }

	sleep(ms: number, signal?: AbortSignal): Promise<void> {
		return new Promise((resolve, reject) => {
			if (signal?.aborted) {
				reject(new Error('aborted'))
				return
			}
			this._pending.push({ at: this._t + ms, resolve })
			signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
		})
	}

	/** Advance time, resolving any sleeps whose deadlines are reached. */
	async tick(ms: number): Promise<void> {
		this._t += ms
		// Fire ready timers.  Multi-pass so resolvers that schedule more
		// sleeps get collected too.
		for (let pass = 0; pass < 10; pass++) {
			const ready = this._pending.filter((p) => p.at <= this._t)
			if (ready.length === 0) return
			for (const p of ready) {
				const idx = this._pending.indexOf(p)
				if (idx >= 0) this._pending.splice(idx, 1)
				p.resolve()
			}
			// Give the JS microtask queue a chance to run so the resolving
			// `await` in mergeQueueService can re-poll before we tick again.
			await Promise.resolve()
		}
	}
}

/**
 * Scripted adapter: PRs become "merged" N ticks after being enqueued.  Each
 * call to queueStatus / getPR is recorded so tests can assert ordering.
 */
class ScriptedAdapter implements PRHostAdapter {
	readonly name = 'scripted'
	private readonly _prs = new Map<string, PRMetadata>()
	private readonly _enqueueAt = new Map<number, number>()   // prNumber → time it was enqueued
	readonly enqueueOrder: number[] = []
	// Time-to-merge per PR number, in the same unit as the FakeClock.
	readonly mergeDelay: Map<number, number>

	constructor(prs: PRMetadata[], mergeDelay: Map<number, number>, private readonly _clock: FakeClock) {
		for (const pr of prs) this._prs.set(pr.head, pr)
		this.mergeDelay = mergeDelay
	}

	async detect(): Promise<boolean> { return true }
	async listOpen(): Promise<PRMetadata[]> { return [...this._prs.values()].filter((p) => p.state === 'open') }

	async getPR(branch: string): Promise<PRMetadata | undefined> {
		const pr = this._prs.get(branch)
		if (!pr) return undefined
		// Auto-transition: if mergeDelay elapsed since enqueue, mark as merged.
		const enqueuedAt = this._enqueueAt.get(pr.number)
		if (pr.state !== 'merged' && enqueuedAt !== undefined) {
			const delay = this.mergeDelay.get(pr.number) ?? 60_000
			if (this._clock.now() - enqueuedAt >= delay) pr.state = 'merged'
		}
		return pr
	}

	async createPR(_input: CreatePRInput): Promise<PRMetadata> { throw new Error('not used') }
	async updatePR(_prNumber: number, _patch: Partial<CreatePRInput>): Promise<PRMetadata> { throw new Error('not used') }

	async enqueue(prNumber: number): Promise<{ position: number }> {
		this.enqueueOrder.push(prNumber)
		this._enqueueAt.set(prNumber, this._clock.now())
		return { position: this.enqueueOrder.length }
	}
	async dequeue(prNumber: number): Promise<void> {
		this._enqueueAt.delete(prNumber)
	}
	async queueStatus(prNumber: number): Promise<QueueStatus> {
		const enqueued = this._enqueueAt.has(prNumber)
		return { inQueue: enqueued }
	}
}

suite('MergeQueueService', () => {
	let config: ConfigService

	setup(async () => {
		cleanup()
		config = new ConfigService()
		await config.load(wsRoot())
	})

	teardown(() => cleanup())

	test('enqueues PRs base-first and waits for each before the next', async () => {
		await config.addBranch({ name: 'feature/a', base: 'main', color: '#abc' })
		await config.addBranch({ name: 'feature/b', base: 'feature/a', color: '#abc' })
		await config.addBranch({ name: 'feature/c', base: 'feature/b', color: '#abc' })

		const clock = new FakeClock()
		const prs: PRMetadata[] = [
			{ number: 100, url: 'u', state: 'open', base: 'main', head: 'feature/a', title: 't', body: '' },
			{ number: 101, url: 'u', state: 'open', base: 'feature/a', head: 'feature/b', title: 't', body: '' },
			{ number: 102, url: 'u', state: 'open', base: 'feature/b', head: 'feature/c', title: 't', body: '' },
		]
		const delay = new Map([[100, 2_000], [101, 2_000], [102, 2_000]])
		const adapter = new ScriptedAdapter(prs, delay, clock)

		const svc = new MergeQueueService(config, adapter, clock)
		const progressed: string[] = []
		const progress: ProgressSink = { report: (m) => progressed.push(m) }

		const done = svc.mergeStack({ pollIntervalMs: 1_000, perBranchTimeoutMs: 30_000 }, progress)
		// Drive the clock forward enough for each PR to merge after its enqueue.
		for (let i = 0; i < 20; i++) {
			await Promise.resolve()
			await clock.tick(1_000)
		}
		const results = await done

		assert.strictEqual(results.length, 3)
		assert.deepStrictEqual(adapter.enqueueOrder, [100, 101, 102], 'PRs are enqueued bottom-up')
		for (const r of results) {
			assert.strictEqual(r.ok, true, `expected ok for ${r.branch}: ${r.message}`)
		}
	})

	test('records a failure when a PR is closed without merging', async () => {
		await config.addBranch({ name: 'feature/a', base: 'main', color: '#abc' })
		const clock = new FakeClock()
		const adapter = new ScriptedAdapter(
			[{ number: 200, url: 'u', state: 'closed', base: 'main', head: 'feature/a', title: 't', body: '' }],
			new Map(),
			clock,
		)
		const svc = new MergeQueueService(config, adapter, clock)
		const done = svc.mergeStack({ pollIntervalMs: 1_000, perBranchTimeoutMs: 5_000 })
		for (let i = 0; i < 10; i++) {
			await Promise.resolve()
			await clock.tick(1_000)
		}
		const results = await done
		assert.strictEqual(results[0].ok, false)
		assert.ok(results[0].message?.includes('closed') || results[0].message?.includes('timed out'))
	})

	test('skips branches with no PR and reports why', async () => {
		await config.addBranch({ name: 'feature/x', base: 'main', color: '#abc' })
		const clock = new FakeClock()
		const adapter = new ScriptedAdapter([], new Map(), clock)
		const svc = new MergeQueueService(config, adapter, clock)
		const results = await svc.mergeStack()
		assert.strictEqual(results.length, 1)
		assert.strictEqual(results[0].ok, false)
		assert.ok(results[0].message?.includes('no PR'))
	})
})
