import * as assert from 'node:assert'
import * as vscode from 'vscode'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { ConfigService } from '../src/configService'
import { MergeQueueService } from '../src/mergeQueueService'
import type { Clock, MergeStackResult } from '../src/mergeQueueService'
import type { CreatePRInput, PRHostAdapter, PRMetadata, QueueStatus } from '../src/prHostAdapter'

// Plan 17: pipelined merge strategy, driven by a virtual clock and a fake host
// whose queue merges strictly in enqueue order.

function wsRoot(): vscode.Uri { return vscode.workspace.workspaceFolders![0].uri }
function cleanup(): void {
	try { fs.rmSync(path.join(wsRoot().fsPath, '.worktrees'), { recursive: true, force: true }) } catch { /* ignore */ }
}

class FakeClock implements Clock {
	private _t = 0
	readonly sleeps: number[] = []
	private _pending: Array<{ at: number, resolve: () => void }> = []
	now(): number { return this._t }
	sleep(ms: number, signal?: AbortSignal): Promise<void> {
		this.sleeps.push(ms)
		return new Promise((resolve, reject) => {
			if (signal?.aborted) { reject(new Error('aborted')); return }
			this._pending.push({ at: this._t + ms, resolve })
			signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
		})
	}
	async tick(ms: number): Promise<void> {
		this._t += ms
		const ready = this._pending.filter((p) => p.at <= this._t)
		this._pending = this._pending.filter((p) => p.at > this._t)
		for (const p of ready) p.resolve()
	}
}

const flush = async (): Promise<void> => { for (let i = 0; i < 6; i++) await new Promise<void>((r) => setImmediate(r)) }

/** Advance the clock in 1s steps until the promise settles; returns the virtual time at which it did. */
async function drive<T>(clock: FakeClock, done: Promise<T>, maxSteps = 400): Promise<{ result: T, at: number }> {
	let finished = false
	let at = -1
	void done.then(() => { finished = true; at = clock.now() }, () => { finished = true; at = clock.now() })
	for (let i = 0; i < maxSteps && !finished; i++) {
		await flush()
		await clock.tick(1_000)
	}
	await flush()
	assert.ok(finished, 'merge did not finish within the step budget')
	return { result: await done, at }
}

interface FakeOptions {
	ordered: boolean
	/** ms between enqueue and merge, per PR number. */
	delays?: Record<number, number>
	/** PR numbers that end up closed instead of merged. */
	closeInstead?: number[]
	/** PR numbers whose enqueue throws. */
	enqueueFails?: number[]
}

/**
 * Host that, like GitHub's queue, refuses a PR not targeting trunk and merges
 * entries strictly in order: a PR merges only when its delay has elapsed AND
 * every lower-numbered PR has merged.
 */
class FakeHost implements PRHostAdapter {
	readonly name = 'fake-host'
	readonly supportsOrderedQueue: boolean
	readonly events: string[] = []
	readonly mergeOrder: number[] = []
	maxInFlight = 0
	private readonly _byBranch = new Map<string, PRMetadata>()
	private readonly _enqueuedAt = new Map<number, number>()

	constructor(prs: PRMetadata[], private readonly _clock: FakeClock, private readonly _o: FakeOptions) {
		this.supportsOrderedQueue = _o.ordered
		for (const p of prs) this._byBranch.set(p.head, p)
	}

	retargetPR: PRHostAdapter['retargetPR'] = async (n: number, base: string): Promise<void> => {
		this.events.push(`retarget:${String(n)}->${base}@${String(this._clock.now())}`)
		for (const p of this._byBranch.values()) if (p.number === n) p.base = base
	}

	private _settle(): void {
		const all = [...this._byBranch.values()].sort((a, b) => a.number - b.number)
		for (const pr of all) {
			if (pr.state === 'merged' || pr.state === 'closed') continue
			const at = this._enqueuedAt.get(pr.number)
			if (at === undefined) continue
			if (this._clock.now() - at < (this._o.delays?.[pr.number] ?? 5_000)) continue
			const lowerDone = all.filter((p) => p.number < pr.number).every((p) => p.state === 'merged')
			if (!lowerDone) continue
			if (this._o.closeInstead?.includes(pr.number)) {
				pr.state = 'closed'
				this._enqueuedAt.delete(pr.number)
			} else {
				pr.state = 'merged'
				this.mergeOrder.push(pr.number)
				this.events.push(`merged:${String(pr.number)}@${String(this._clock.now())}`)
				// Like GitHub with "delete branch on merge": children of the merged head fall back to trunk.
				for (const child of all) if (child.base === pr.head) child.base = 'main'
				this._enqueuedAt.delete(pr.number)
			}
		}
	}

	async detect(): Promise<boolean> { return true }
	async listOpen(): Promise<PRMetadata[]> { return [] }
	async getPR(branch: string): Promise<PRMetadata | undefined> {
		this._settle()
		const pr = this._byBranch.get(branch)
		return pr ? { ...pr } : undefined
	}
	async createPR(_i: CreatePRInput): Promise<PRMetadata> { throw new Error('not used') }
	async updatePR(): Promise<PRMetadata> { throw new Error('not used') }
	async enqueue(n: number): Promise<{ position: number }> {
		const pr = [...this._byBranch.values()].find((p) => p.number === n)!
		if (this._o.enqueueFails?.includes(n)) throw new Error('queue refused')
		if (pr.base !== 'main') throw new Error(`host refuses #${String(n)}: base is ${pr.base}, not the queue branch`)
		this.events.push(`enqueue:${String(n)}@${String(this._clock.now())}`)
		this._enqueuedAt.set(n, this._clock.now())
		this.maxInFlight = Math.max(this.maxInFlight, this._enqueuedAt.size)
		return { position: this._enqueuedAt.size }
	}
	async dequeue(n: number): Promise<void> {
		this.events.push(`dequeue:${String(n)}@${String(this._clock.now())}`)
		this._enqueuedAt.delete(n)
	}
	async queueStatus(n: number): Promise<QueueStatus> { return { inQueue: this._enqueuedAt.has(n) } }

	timeOf(prefix: string): number {
		const e = this.events.find((x) => x.startsWith(prefix + '@'))
		assert.ok(e, `no event ${prefix}; have ${this.events.join(', ')}`)
		return Number(e.split('@')[1])
	}
	has(prefix: string): boolean { return this.events.some((x) => x.startsWith(prefix)) }
}

function stackPrs(n: number): PRMetadata[] {
	const prs: PRMetadata[] = []
	for (let i = 0; i < n; i++) {
		prs.push({
			number: 100 + i, url: 'u', state: 'open', title: 't', body: '',
			head: `feature/l${String(i)}`, base: i === 0 ? 'main' : `feature/l${String(i - 1)}`,
		})
	}
	return prs
}

suite('MergeQueueService: serial vs pipelined', function () {
	this.timeout(30_000)
	let config: ConfigService

	setup(async () => {
		cleanup()
		config = new ConfigService()
		await config.load(wsRoot())
	})
	teardown(() => { config.dispose(); cleanup() })

	async function build(n: number, o: FakeOptions, mutate?: (prs: PRMetadata[]) => void) {
		for (let i = 0; i < n; i++) {
			await config.addBranch({ name: `feature/l${String(i)}`, base: i === 0 ? 'main' : `feature/l${String(i - 1)}`, color: '#abc' })
		}
		const prs = stackPrs(n)
		mutate?.(prs)
		const clock = new FakeClock()
		const host = new FakeHost(prs, clock, o)
		return { clock, host, svc: new MergeQueueService(config, host, clock) }
	}

	const opts = { pollIntervalMs: 1_000, perBranchTimeoutMs: 120_000 }
	const states = (r: MergeStackResult[]) => r.map((x) => `${x.branch.slice(-2)}:${x.state}`)

	test('serial (default) is unchanged: one at a time, each enqueued after its parent merged, no retarget', async () => {
		const { clock, host, svc } = await build(3, { ordered: true, delays: { 100: 4_000, 101: 4_000, 102: 4_000 } })
		const { result } = await drive(clock, svc.mergeStack(opts))
		assert.deepStrictEqual(states(result), ['l0:merged', 'l1:merged', 'l2:merged'])
		assert.ok(result.every((r) => r.ok))
		assert.ok(host.timeOf('enqueue:101') >= host.timeOf('merged:100'))
		assert.ok(host.timeOf('enqueue:102') >= host.timeOf('merged:101'))
		assert.ok(!host.has('retarget'))
	})

	test('pipelined depth 2: L3 waits for L1 to merge, and the whole stack finishes sooner than serial', async () => {
		const delays = { 100: 10_000, 101: 10_000, 102: 10_000, 103: 10_000 }
		const serial = await build(4, { ordered: true, delays })
		const s = await drive(serial.clock, serial.svc.mergeStack(opts))
		cleanup()
		config.dispose()
		config = new ConfigService()
		await config.load(wsRoot())

		const piped = await build(4, { ordered: true, delays })
		const p = await drive(piped.clock, piped.svc.mergeStack({ ...opts, strategy: 'pipelined', pipelineDepth: 2 }))

		assert.deepStrictEqual(states(p.result), ['l0:merged', 'l1:merged', 'l2:merged', 'l3:merged'])
		assert.strictEqual(piped.host.timeOf('enqueue:100'), piped.host.timeOf('enqueue:101'), 'L1 and L2 go in together')
		assert.ok(piped.host.timeOf('enqueue:102') >= piped.host.timeOf('merged:100'), 'L3 only after L1 merged')
		assert.ok(piped.host.maxInFlight <= 2)
		assert.deepStrictEqual(piped.host.mergeOrder, [100, 101, 102, 103], 'never a child before its parent')
		assert.ok(p.at < s.at, `pipelined (${String(p.at)}ms) should beat serial (${String(s.at)}ms)`)
	})

	test('each layer that targets its parent is retargeted to trunk exactly once, before it is enqueued', async () => {
		const { clock, host, svc } = await build(3, { ordered: true })
		await drive(clock, svc.mergeStack({ ...opts, strategy: 'pipelined', pipelineDepth: 3 }))
		const retargets = host.events.filter((e) => e.startsWith('retarget'))
		assert.strictEqual(retargets.length, 2, retargets.join(', '))
		const idx = (p: string) => host.events.findIndex((e) => e.startsWith(p))
		assert.ok(idx('retarget:101') < idx('enqueue:101'))
		assert.ok(idx('retarget:102') < idx('enqueue:102'))
		assert.ok(!host.has('retarget:100'), 'the bottom layer already targets trunk')
	})

	test('hosts without retargetPR fall back to updatePR({ base })', async () => {
		const { clock, host, svc } = await build(2, { ordered: true })
		const calls: string[] = []
		host.retargetPR = undefined
		host.updatePR = async (n, patch) => { calls.push(`${String(n)}->${String(patch.base)}`); return {} as PRMetadata }
		// The fake host refuses a non-trunk base, so only the call is observable here.
		const { result } = await drive(clock, svc.mergeStack({ ...opts, strategy: 'pipelined', pipelineDepth: 2 }))
		assert.deepStrictEqual(calls, ['101->main'])
		assert.strictEqual(result[1].state, 'failed')
		assert.match(result[1].message ?? '', /enqueue: host refuses #101/)
	})

	test('a failure dequeues the in-flight layers above it and blocks the rest, which are never enqueued', async () => {
		const { clock, host, svc } = await build(4, { ordered: true, closeInstead: [101], delays: { 100: 3_000, 101: 3_000, 102: 60_000, 103: 3_000 } })
		const { result } = await drive(clock, svc.mergeStack({ ...opts, strategy: 'pipelined', pipelineDepth: 3 }))

		assert.deepStrictEqual(states(result), ['l0:merged', 'l1:failed', 'l2:blocked', 'l3:blocked'])
		assert.strictEqual(result[2].blockedBy, 'feature/l1')
		assert.strictEqual(result[3].blockedBy, 'feature/l1')
		assert.ok(host.has('dequeue:102'), 'the in-flight child was dequeued')
		assert.ok(!host.has('enqueue:103'), 'nothing is enqueued after a failure')
		assert.ok(!host.has('merged:102') && !host.has('merged:103'))
	})

	test('an enqueue error is a failure too: layers above are blocked', async () => {
		const { clock, host, svc } = await build(3, { ordered: true, enqueueFails: [101] })
		const { result } = await drive(clock, svc.mergeStack({ ...opts, strategy: 'pipelined', pipelineDepth: 2 }))
		assert.deepStrictEqual(states(result), ['l0:merged', 'l1:failed', 'l2:blocked'])
		assert.match(result[1].message ?? '', /enqueue: queue refused/)
		assert.ok(!host.has('enqueue:102'))
	})

	test('pre-flight failure enqueues nothing and says which layer to fix', async () => {
		const { clock, host, svc } = await build(3, { ordered: true }, (prs) => { prs[1].state = 'draft' })
		const { result } = await drive(clock, svc.mergeStack({ ...opts, strategy: 'pipelined' }))
		assert.deepStrictEqual(states(result), ['l0:skipped', 'l1:failed', 'l2:skipped'])
		assert.match(result[1].message ?? '', /draft/)
		assert.match(result[0].message ?? '', /pre-flight failed for "feature\/l1"/)
		assert.deepStrictEqual(host.events, [])
	})

	test('pre-flight catches a missing PR and an unexpected base', async () => {
		const missing = await build(2, { ordered: true }, (prs) => { prs.pop() })
		const a = await drive(missing.clock, missing.svc.mergeStack({ ...opts, strategy: 'pipelined' }))
		assert.match(a.result[1].message ?? '', /no PR/)
		assert.deepStrictEqual(missing.host.events, [])

		cleanup()
		config.dispose()
		config = new ConfigService()
		await config.load(wsRoot())
		const wrong = await build(2, { ordered: true }, (prs) => { prs[1].base = 'some-other-branch' })
		const b = await drive(wrong.clock, wrong.svc.mergeStack({ ...opts, strategy: 'pipelined' }))
		assert.match(b.result[1].message ?? '', /targets "some-other-branch", expected "feature\/l0"/)
		assert.deepStrictEqual(wrong.host.events, [])
	})

	test('cancel dequeues every in-flight layer and skips the rest', async () => {
		const { clock, host, svc } = await build(3, { ordered: true, delays: { 100: 600_000, 101: 600_000, 102: 600_000 } })
		const ac = new AbortController()
		const run = svc.mergeStack({ ...opts, strategy: 'pipelined', pipelineDepth: 2 }, undefined, ac.signal)
		await flush()
		await clock.tick(2_000)
		await flush()
		ac.abort()
		const { result } = await drive(clock, run)
		assert.deepStrictEqual(states(result), ['l0:failed', 'l1:failed', 'l2:skipped'])
		assert.ok(host.has('dequeue:100') && host.has('dequeue:101'))
		assert.match(result[0].message ?? '', /cancelled/)
	})

	test('cancel with keepQueuedOnCancel leaves them queued', async () => {
		const { clock, host, svc } = await build(2, { ordered: true, delays: { 100: 600_000, 101: 600_000 } })
		const ac = new AbortController()
		const run = svc.mergeStack({ ...opts, strategy: 'pipelined', pipelineDepth: 2, keepQueuedOnCancel: true }, undefined, ac.signal)
		await flush()
		await clock.tick(2_000)
		await flush()
		ac.abort()
		const { result } = await drive(clock, run)
		assert.ok(!host.has('dequeue'))
		assert.match(result[0].message ?? '', /left queued/)
	})

	test('a host without an ordered queue is clamped to one in flight, but still gets pre-flight', async () => {
		const { clock, host, svc } = await build(3, { ordered: false })
		const { result } = await drive(clock, svc.mergeStack({ ...opts, strategy: 'pipelined', pipelineDepth: 5 }))
		assert.deepStrictEqual(states(result), ['l0:merged', 'l1:merged', 'l2:merged'])
		assert.strictEqual(host.maxInFlight, 1)
		assert.ok(host.timeOf('enqueue:101') >= host.timeOf('merged:100'))
	})

	test('depth is clamped to 5 however high it is set', async () => {
		const { clock, host, svc } = await build(7, { ordered: true, delays: Object.fromEntries([100, 101, 102, 103, 104, 105, 106].map((n) => [n, 8_000])) })
		await drive(clock, svc.mergeStack({ ...opts, strategy: 'pipelined', pipelineDepth: 99 }))
		assert.strictEqual(host.maxInFlight, 5)
	})

	test('polling backs off while nothing changes, capped at 120s, and resets after progress', async () => {
		const { clock, svc } = await build(1, { ordered: true, delays: { 100: 400_000 } })
		await drive(clock, svc.mergeStack({ pollIntervalMs: 10_000, perBranchTimeoutMs: 600_000, strategy: 'pipelined' }), 600)
		const sleeps = clock.sleeps
		assert.strictEqual(sleeps[0], 15_000)
		assert.ok(sleeps.every((s, i) => i === 0 || s >= sleeps[i - 1]), 'never shrinks while idle')
		assert.strictEqual(Math.max(...sleeps), 120_000)
	})

	test('the backoff resets to the base interval once a layer merges', async () => {
		const { clock, svc } = await build(2, { ordered: false, delays: { 100: 600_000, 101: 60_000 } })
		await drive(clock, svc.mergeStack({ pollIntervalMs: 10_000, perBranchTimeoutMs: 1_800_000, strategy: 'pipelined' }), 1500)
		const peak = clock.sleeps.indexOf(120_000)
		assert.ok(peak >= 0)
		assert.strictEqual(clock.sleeps[peak + 1] !== undefined && clock.sleeps.slice(peak + 1).includes(10_000), true, clock.sleeps.join(','))
	})

	test('a layer that stops resolving fails fast, not after the full timeout', async () => {
		const { clock, host, svc } = await build(2, { ordered: true })
		const origGet = host.getPR.bind(host)
		let calls = 0
		host.getPR = async (b: string) => (b === 'feature/l1' && ++calls > 1 ? undefined : origGet(b))
		const { result, at } = await drive(clock, svc.mergeStack({ ...opts, strategy: 'pipelined', pipelineDepth: 2 }))
		assert.strictEqual(result[1].state, 'failed')
		assert.match(result[1].message ?? '', /not found on 3 consecutive polls/)
		assert.ok(at < 60_000)
	})

	test('progress reports merged, in-flight and pending counts', async () => {
		const { clock, svc } = await build(3, { ordered: true })
		const msgs: string[] = []
		await drive(clock, svc.mergeStack({ ...opts, strategy: 'pipelined', pipelineDepth: 2 }, { report: (m) => msgs.push(m) }))
		assert.ok(msgs.some((m) => /0\/3 merged, 2 in flight, 1 pending/.test(m)), msgs.join(' | '))
	})
})
