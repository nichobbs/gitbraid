import * as assert from 'node:assert'
import * as vscode from 'vscode'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { ConfigService } from '../src/configService'
import { PersistentUndoLog, UndoLogEntry } from '../src/persistentUndoLog'
import {
	buildReplayPlan,
	applyReplay,
	summarisePlan,
} from '../src/undoReplay'

function wsRoot(): vscode.Uri {
	return vscode.workspace.workspaceFolders![0].uri
}

function cleanup(): void {
	try { fs.rmSync(path.join(wsRoot().fsPath, '.worktrees'), { recursive: true, force: true }) } catch { /* ignore */ }
}

function mkLog(): PersistentUndoLog {
	// Use a tmp dir so concurrent tests don't race on the shared proj1 log.
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitbraid-undo-'))
	return new PersistentUndoLog(dir)
}

async function seed(log: PersistentUndoLog, entries: UndoLogEntry[]): Promise<void> {
	await log.writeAll(entries)
}

suite('undoReplay (Plan 09)', () => {

	let config: ConfigService

	setup(async () => {
		cleanup()
		config = new ConfigService()
		await config.load(wsRoot())
	})

	teardown(() => { cleanup() })

	// ── buildReplayPlan ──────────────────────────────────────────────────────

	test('buildReplayPlan returns steps newest-first, excluding the target', () => {
		const entries: UndoLogEntry[] = [
			{ ts: 'a', action: 'assign-file', detail: { path: 'a', from: null, to: 'feat/a' } },
			{ ts: 'b', action: 'assign-file', detail: { path: 'b', from: null, to: 'feat/a' } },
			{ ts: 'c', action: 'assign-file', detail: { path: 'c', from: null, to: 'feat/a' } },
		]
		const plan = buildReplayPlan(entries, 'a', config)
		assert.deepStrictEqual(plan.steps.map((s) => s.entry.ts), ['c', 'b'])
	})

	test('buildReplayPlan: target is newest → empty plan', () => {
		const entries: UndoLogEntry[] = [
			{ ts: 'a', action: 'assign-file', detail: { path: 'a', from: null, to: 'feat/a' } },
			{ ts: 'b', action: 'assign-file', detail: { path: 'b', from: null, to: 'feat/a' } },
		]
		const plan = buildReplayPlan(entries, 'b', config)
		assert.deepStrictEqual(plan.steps, [])
	})

	// ── describeInverse / summarisePlan ──────────────────────────────────────

	test('describeInverse (assign-file): restore or unassign; flag divergence', async () => {
		await config.addBranch({ name: 'feat/a', base: 'main', color: '#fff' })
		await config.setAssignment('src/x.ts', 'feat/a')
		// Logs: earlier unassigned → feat/a, then we simulate a later reassignment.
		const entries: UndoLogEntry[] = [
			{ ts: '1', action: 'assign-file', detail: { path: 'src/x.ts', from: null, to: 'feat/a' } },
			{ ts: '2', action: 'assign-file', detail: { path: 'src/x.ts', from: 'feat/a', to: 'feat/b' } },
		]
		// State: feat/a is current (not feat/b), so the inverse of entry '2'
		// has diverged.
		const plan = buildReplayPlan(entries, '1', config)
		// Newest first → only step is entry '2'.
		assert.strictEqual(plan.steps.length, 1)
		assert.ok(plan.steps[0].skipReason?.includes('logged branch'), `got skipReason: ${String(plan.steps[0].skipReason)}`)
	})

	test('describeInverse (assign-file): branch no longer exists → skip', async () => {
		// Logged "from: feat/a" but that branch isn't in config anymore.
		await config.addBranch({ name: 'feat/b', base: 'main', color: '#fff' })
		await config.setAssignment('src/x.ts', 'feat/b')
		const entries: UndoLogEntry[] = [
			{ ts: '1', action: 'assign-file', detail: { path: 'src/x.ts', from: 'feat/a', to: 'feat/b' } },
		]
		const plan = buildReplayPlan(entries, 'earliest-not-found', config)
		assert.strictEqual(plan.steps.length, 1)
		assert.ok(plan.steps[0].skipReason?.includes('feat/a'), `got skipReason: ${String(plan.steps[0].skipReason)}`)
	})

	test('summarisePlan produces one line per step', () => {
		const entries: UndoLogEntry[] = [
			{ ts: '1', action: 'assign-file', detail: { path: 'src/x.ts', from: null, to: 'feat/a' } },
			{ ts: '2', action: 'unassign-file', detail: { path: 'src/y.ts', from: 'feat/b' } },
		]
		const plan = buildReplayPlan(entries, 'zero', config)
		const s = summarisePlan(plan)
		assert.strictEqual(s.split('\n').length, 2)
	})

	// ── applyReplay ──────────────────────────────────────────────────────────

	test('applyReplay: undoes assign-file by reverting to prior branch', async () => {
		await config.addBranch({ name: 'feat/a', base: 'main', color: '#fff' })
		await config.addBranch({ name: 'feat/b', base: 'main', color: '#fff' })
		await config.setAssignment('src/x.ts', 'feat/b')

		const log0 = mkLog()
		const entries: UndoLogEntry[] = [
			// Pre-change: x was on feat/a. Then the user moved it to feat/b.
			{ ts: '1', action: 'assign-file', detail: { path: 'src/x.ts', from: null, to: 'feat/a' } },
			{ ts: '2', action: 'assign-file', detail: { path: 'src/x.ts', from: 'feat/a', to: 'feat/b' } },
		]
		await seed(log0, entries)

		const plan = buildReplayPlan(entries, '1', config)
		const result = await applyReplay(plan, config, log0)

		assert.strictEqual(result.applied, 1)
		assert.strictEqual(result.skipped, 0)
		assert.strictEqual(config.getAssignment('src/x.ts'), 'feat/a')
		// Log should now contain only entries up to and including '1'.
		const remaining = await log0.load()
		assert.deepStrictEqual(remaining.map((e) => e.ts), ['1'])
	})

	test('applyReplay: undoes assign-file by unassigning when from=null', async () => {
		await config.addBranch({ name: 'feat/a', base: 'main', color: '#fff' })
		await config.setAssignment('src/x.ts', 'feat/a')

		const log0 = mkLog()
		const entries: UndoLogEntry[] = [
			{ ts: '1', action: 'assign-file', detail: { path: 'src/x.ts', from: null, to: 'feat/a' } },
		]
		await seed(log0, entries)

		const plan = buildReplayPlan(entries, 'before-1', config)
		const result = await applyReplay(plan, config, log0)

		assert.strictEqual(result.applied, 1)
		assert.strictEqual(config.getAssignment('src/x.ts'), undefined)
	})

	test('applyReplay: skipped steps count but don\'t touch config', async () => {
		await config.addBranch({ name: 'feat/a', base: 'main', color: '#fff' })
		// x was assigned to feat/a originally — the log says so — but someone
		// has since manually unassigned it, so the replay should NOT reassign.
		await config.setAssignment('src/x.ts', 'feat/a')
		await config.removeAssignment('src/x.ts')

		const log0 = mkLog()
		const entries: UndoLogEntry[] = [
			{ ts: '1', action: 'unassign-file', detail: { path: 'src/x.ts', from: 'feat/a' } },
			{ ts: '2', action: 'assign-file', detail: { path: 'src/x.ts', from: null, to: 'feat/a' } },
		]
		await seed(log0, entries)

		const plan = buildReplayPlan(entries, '1', config)
		const result = await applyReplay(plan, config, log0)

		// The '2' entry says current should be 'feat/a' — and it's not.
		// Skip, don't apply.
		assert.strictEqual(result.applied, 0)
		assert.strictEqual(result.skipped, 1)
		assert.strictEqual(config.getAssignment('src/x.ts'), undefined)
	})

	test('applyReplay: unsupported action is skipped cleanly', async () => {
		const log0 = mkLog()
		const entries: UndoLogEntry[] = [
			{ ts: '1', action: 'who-knows', detail: { foo: 'bar' } },
			{ ts: '2', action: 'assign-file', detail: { path: 'src/x.ts', from: null, to: 'feat/a' } },
		]
		await seed(log0, entries)
		const plan = buildReplayPlan(entries, 'ancient', config)
		const result = await applyReplay(plan, config, log0)
		assert.strictEqual(result.skipped >= 1, true)
	})
})
