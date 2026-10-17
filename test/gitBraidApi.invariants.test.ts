import * as assert from 'node:assert'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as vscode from 'vscode'
import { ConfigService } from '../src/configService'
import { BranchStackService } from '../src/branchStackService'
import { WorkspaceSync } from '../src/workspaceSync'
import { GitBraidApi } from '../src/gitBraidApi'
import { DiffEngine, parseDiffHunks } from '../src/diffEngine'
import { HunkRouter } from '../src/hunkRouter'
import { GitError } from '../src/errors'
import { PersistentUndoLog } from '../src/persistentUndoLog'
import { StackInvariantError } from '../src/stackInvariants'
import type { InvariantCode } from '../src/stackInvariants'
import { FakeGitRunner } from './helpers/fakeGitRunner'

/**
 * Plan 12: the API refuses operations that would leave the stack in a bad state,
 * for every caller, with a stable code and a hint.  Each test also checks the
 * refusal changed nothing and, where git would have run, never reached git.
 */

const TWO_HUNKS = [
	'diff --git a/src/foo.ts b/src/foo.ts',
	'index 111..222 100644',
	'--- a/src/foo.ts',
	'+++ b/src/foo.ts',
	'@@ -1,3 +1,3 @@',
	' a',
	'-b',
	'+B',
	' c',
	'@@ -20,3 +20,4 @@',
	' x',
	'+inserted',
	' y',
	' z',
].join('\n')

function wsRoot(): vscode.Uri {
	return vscode.workspace.workspaceFolders![0].uri
}

function cleanup(): void {
	try { fs.rmSync(path.join(wsRoot().fsPath, '.worktrees'), { recursive: true }) } catch { /* ignore */ }
	try { fs.rmSync(path.join(wsRoot().fsPath, '.gitignore')) } catch { /* ignore */ }
}

/** Run `fn`, expecting a StackInvariantError with `code`; fail with a clear message otherwise. */
async function refused(fn: () => Promise<unknown> | unknown, code: InvariantCode): Promise<StackInvariantError> {
	try {
		await fn()
	} catch (e) {
		assert.ok(e instanceof StackInvariantError, `expected a StackInvariantError, got ${String(e)}`)
		assert.strictEqual(e.code, code, e.message)
		return e
	}
	assert.fail(`expected ${code}, but the call succeeded`)
}

suite('GitBraidApi - invariants', function () {
	this.timeout(15_000)

	let config: ConfigService
	let branchStack: BranchStackService
	let sync: WorkspaceSync
	let runner: FakeGitRunner
	let engine: DiffEngine
	let hunkCalls: string[]
	let undoDir: string
	let undoLog: PersistentUndoLog
	let api: GitBraidApi

	setup(async () => {
		cleanup()
		ConfigService.resetInstance()
		BranchStackService.resetInstance()
		WorkspaceSync.resetInstance()
		config = ConfigService.getInstance()
		await config.load(wsRoot())
		branchStack = BranchStackService.getInstance(config)
		await branchStack.initStack(wsRoot())
		sync = WorkspaceSync.getInstance(config)
		runner = new FakeGitRunner()
		hunkCalls = []
		engine = new DiffEngine()
		engine.getHunksForFile = async (_root, rel) => {
			hunkCalls.push(rel)
			return rel === 'src/foo.ts' ? parseDiffHunks(TWO_HUNKS) : []
		}
		undoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitbraid-api-undo-'))
		undoLog = new PersistentUndoLog(undoDir)
		api = new GitBraidApi(config, branchStack, sync, wsRoot(), runner, new HunkRouter(engine), undoLog)

		await config.addBranch({ name: 'real', color: '#111', base: 'main' })
		await config.addBranch({ name: 'virt', color: '#222', base: 'real', virtual: true })
		await config.addBranch({ name: 'park', color: '#333', base: 'virt', scratch: true })
	})

	teardown(() => {
		sync.dispose()
		cleanup()
		try { fs.rmSync(undoDir, { recursive: true, force: true }) } catch { /* ignore */ }
		BranchStackService.resetInstance()
		ConfigService.resetInstance()
		WorkspaceSync.resetInstance()
	})

	// ── Branch must exist ─────────────────────────────────────────────────────

	test('assignFile: unknown branch is refused, lists what exists, and records nothing', async () => {
		const e = await refused(() => api.assignFile('src/a.ts', 'nope'), 'BRANCH_NOT_FOUND')
		assert.match(e.message, /Branch "nope" is not in the stack/)
		assert.ok(e.hint?.includes('real'), 'the hint lists the real branches')
		assert.strictEqual(api.getAssignment('src/a.ts'), undefined)
	})

	test('every branch-taking call refuses an unknown branch without running git', async () => {
		const calls: Array<[string, () => Promise<unknown>]> = [
			['assignHunk', () => api.assignHunk('src/foo.ts', 0, 'nope')],
			['removeBranch', () => api.removeBranch('nope')],
			['getBranchStatus', () => api.getBranchStatus('nope')],
			['getBranchDiff', () => api.getBranchDiff('nope')],
			['commitBranch', () => api.commitBranch('nope', 'm')],
			['stageBranch', () => api.stageBranch('nope')],
			['pullBranch', () => api.pullBranch('nope')],
			['syncBranch', () => api.syncBranch('nope')],
			['rebaseBranch', () => api.rebaseBranch('nope')],
		]
		for (const [name, call] of calls) {
			await refused(call, 'BRANCH_NOT_FOUND').catch((e: unknown) => { throw new Error(`${name}: ${String(e)}`) })
		}
		assert.strictEqual(runner.calls.length, 0, 'git must not be reached')
		assert.deepStrictEqual(config.getStack().map((b) => b.name), ['real', 'virt', 'park'], 'the stack is untouched')
	})

	// ── Paths ─────────────────────────────────────────────────────────────────

	test('path rules apply to every path-taking call', async () => {
		const bad: Array<[string, InvariantCode]> = [
			['', 'PATH_INVALID'],
			['/etc/passwd', 'PATH_INVALID'],
			['C:\\Windows\\system.ini', 'PATH_INVALID'],
			['../outside.txt', 'PATH_ESCAPES_WORKSPACE'],
			['src/../../outside.txt', 'PATH_ESCAPES_WORKSPACE'],
			['.git/config', 'PATH_RESERVED'],
			['.worktrees/gitbraid-config.json', 'PATH_RESERVED'],
		]
		for (const [p, code] of bad) {
			await refused(() => api.assignFile(p, 'real'), code)
			await refused(() => api.assignHunk(p, 0, 'real'), code)
			await refused(() => api.unassignFile(p), code)
			await refused(() => api.removeHunkAssignment(p, 0), code)
			await refused(() => api.routeHunks(p), code)
			await refused(() => api.getFileHunks(p), code)
			await refused(() => Promise.resolve(api.getFileOwnership(p)), code)
		}
		assert.deepStrictEqual(config.getAllAssignments(), {}, 'nothing was recorded')
	})

	test('assignFile stores the normalised path', async () => {
		await api.assignFile('.\\src\\a.ts', 'real')
		assert.strictEqual(api.getAssignment('src/a.ts'), 'real')
		assert.deepStrictEqual(Object.keys(config.getAllAssignments()), ['src/a.ts'])
	})

	test('files that merely look reserved are still assignable', async () => {
		for (const p of ['.github/workflows/ci.yml', '.gitignore', '.gitattributes']) {
			await assert.doesNotReject(() => api.assignFile(p, 'real'), p)
		}
	})

	// ── Hunks ─────────────────────────────────────────────────────────────────

	test('assignHunk: an index that does not exist is refused with the hunk count', async () => {
		const e = await refused(() => api.assignHunk('src/foo.ts', 2, 'real'), 'HUNK_OUT_OF_RANGE')
		assert.match(e.message, /2 hunk\(s\)/)
		assert.match(e.hint ?? '', /getFileHunks/)
		await refused(() => api.assignHunk('src/foo.ts', -1, 'real'), 'HUNK_OUT_OF_RANGE')
		await refused(() => api.assignHunk('src/foo.ts', 0.5, 'real'), 'HUNK_OUT_OF_RANGE')
		assert.strictEqual(config.getHunkAssignments('src/foo.ts'), undefined)
	})

	test('assignHunk: a file with no changes has no hunks to assign', async () => {
		const e = await refused(() => api.assignHunk('src/clean.ts', 0, 'real'), 'HUNK_OUT_OF_RANGE')
		assert.match(e.message, /no uncommitted changes/)
	})

	test('assignHunk: a valid hunk is assigned and anchored', async () => {
		await api.assignHunk('src/foo.ts', 0, 'real')
		assert.strictEqual(config.getHunkAssignments('src/foo.ts')?.get(0), 'real')
		assert.ok(config.getHunkAnchor('src/foo.ts', 0)?.bodyHash, 'has a content anchor')
	})

	// ── Worktree-dependent operations ─────────────────────────────────────────

	test('a virtual branch has no worktree: git operations are refused and say to materialise it', async () => {
		const ops: Array<() => Promise<unknown>> = [
			() => api.commitBranch('virt', 'm'),
			() => api.stageBranch('virt'),
			() => api.pullBranch('virt'),
			() => api.syncBranch('virt'),
			() => api.rebaseBranch('virt'),
			() => api.getBranchDiff('virt'),
		]
		for (const op of ops) {
			const e = await refused(op, 'BRANCH_HAS_NO_WORKTREE')
			assert.match(e.hint ?? '', /materialiseBranch/)
		}
		assert.strictEqual(runner.calls.length, 0)
	})

	test('a virtual branch can still receive assignments', async () => {
		await assert.doesNotReject(() => api.assignFile('src/a.ts', 'virt'))
	})

	test('a scratch worktree cannot be committed, pulled or synced, but can be staged and assigned to', async () => {
		await refused(() => api.commitBranch('park', 'm'), 'BRANCH_IS_SCRATCH')
		await refused(() => api.pullBranch('park'), 'BRANCH_IS_SCRATCH')
		await refused(() => api.syncBranch('park'), 'BRANCH_IS_SCRATCH')
		assert.strictEqual(runner.calls.length, 0)

		runner.fixture('add -u', { exitCode: 0 })
		await assert.doesNotReject(() => api.stageBranch('park'))
		await assert.doesNotReject(() => api.assignFile('src/a.ts', 'park'))
	})

	// ── Reorder ───────────────────────────────────────────────────────────────

	test('reorderStack: a partial, unknown or duplicated list is refused and the order is unchanged', async () => {
		for (const names of [['virt', 'real'], ['park', 'virt', 'real', 'ghost'], ['real', 'real', 'virt', 'park'], []]) {
			await refused(() => api.reorderStack(names), 'REORDER_NOT_A_PERMUTATION')
		}
		assert.deepStrictEqual(config.getStack().map((b) => b.name), ['real', 'virt', 'park'])
	})

	test('reorderStack: a full permutation is applied', async () => {
		await api.reorderStack(['park', 'real', 'virt'])
		assert.deepStrictEqual(config.getStack().map((b) => b.name), ['park', 'real', 'virt'])
	})

	// ── New read methods ──────────────────────────────────────────────────────

	test('getFileOwnership: whole-file branch, hunk assignments, not floating', async () => {
		await api.assignFile('src/a.ts', 'real')
		await api.assignHunk('src/foo.ts', 1, 'virt')
		assert.deepStrictEqual(api.getFileOwnership('src/a.ts'), {
			path: 'src/a.ts', branch: 'real', hunkAssignments: {}, floating: false,
		})
		assert.deepStrictEqual(api.getFileOwnership('./src/foo.ts'), {
			path: 'src/foo.ts', hunkAssignments: { 1: 'virt' }, floating: false,
		})
		assert.strictEqual('branch' in api.getFileOwnership('src/unassigned.ts'), false, 'no branch key when unassigned')
	})

	test('getFileHunks: lists the live hunks with assignments; patches only on request', async () => {
		await api.assignHunk('src/foo.ts', 1, 'virt')
		const plain = await api.getFileHunks('src/foo.ts')
		assert.deepStrictEqual(plain.map((h) => [h.index, h.startLine, h.endLine, h.assignedBranch]), [
			[0, 1, 3, undefined],
			[1, 20, 23, 'virt'],
		])
		assert.ok(plain.every((h) => h.patch === undefined), 'no patch text by default')
		const withPatch = await api.getFileHunks('src/foo.ts', { includePatch: true })
		assert.ok(withPatch[1].patch?.includes('+inserted'))
		assert.deepStrictEqual(await api.getFileHunks('src/clean.ts'), [])
	})

	test('getFileHunks gives the indices assignHunk accepts', async () => {
		for (const h of await api.getFileHunks('src/foo.ts')) {
			await assert.doesNotReject(() => api.assignHunk('src/foo.ts', h.index, 'real'))
		}
	})

	// ── getBranchDiff ─────────────────────────────────────────────────────────

	test('getBranchDiff: diffs against the fork point, not the tip of the base', async () => {
		runner.fixture('merge-base main HEAD', { stdout: 'abc123\n' })
		runner.fixture('diff --no-color abc123', { stdout: 'diff --git a/x b/x\n+hello\n' })
		const d = await api.getBranchDiff('real')
		assert.deepStrictEqual(d, { branch: 'real', base: 'main', diff: 'diff --git a/x b/x\n+hello\n', truncated: false })
		assert.ok(runner.calls.some((c) => c.args.join(' ') === 'diff --no-color abc123'))
	})

	test('getBranchDiff: falls back to the base ref if there is no merge-base', async () => {
		runner.fixture('merge-base main HEAD', { exitCode: 1 })
		runner.fixture('diff --no-color main', { stdout: 'D\n' })
		assert.strictEqual((await api.getBranchDiff('real')).diff, 'D\n')
	})

	test('getBranchDiff: stat mode asks git for --stat', async () => {
		runner.fixture('merge-base main HEAD', { stdout: 'abc123\n' })
		runner.fixture('diff --no-color --stat abc123', { stdout: ' x | 1 +\n' })
		assert.strictEqual((await api.getBranchDiff('real', { stat: true })).diff, ' x | 1 +\n')
	})

	test('getBranchDiff: output over maxBytes is cut on a line boundary and flagged', async () => {
		const lines = Array.from({ length: 50 }, (_, i) => `+line ${String(i)} caf\u00e9`).join('\n') + '\n'
		runner.fixture('merge-base main HEAD', { stdout: 'abc123\n' })
		runner.fixture('diff --no-color abc123', { stdout: lines })
		const d = await api.getBranchDiff('real', { maxBytes: 100 })
		assert.strictEqual(d.truncated, true)
		assert.ok(Buffer.byteLength(d.diff) <= 100)
		assert.ok(d.diff.endsWith('\n'), 'ends at a line boundary')
		assert.ok(!d.diff.includes('\ufffd'), 'no half-cut multibyte character')
		assert.ok(lines.startsWith(d.diff), 'a prefix of the real output')
	})

	test('getBranchDiff: a git failure is a GitError', async () => {
		runner.fixture('merge-base main HEAD', { stdout: 'abc123\n' })
		runner.fixture('diff --no-color abc123', { exitCode: 128, stderr: 'fatal: bad object' })
		await assert.rejects(() => api.getBranchDiff('real'), (e: unknown) => e instanceof GitError && /bad object/.test(e.message))
	})

	// ── getUndoLog ────────────────────────────────────────────────────────────

	test('getUndoLog: newest first, limited, and clamped', async () => {
		for (let i = 0; i < 5; i++) await undoLog.append({ ts: `t${String(i)}`, action: `a${String(i)}`, detail: {} })
		assert.deepStrictEqual((await api.getUndoLog(3)).map((e) => e.action), ['a4', 'a3', 'a2'])
		assert.strictEqual((await api.getUndoLog()).length, 5)
		assert.strictEqual((await api.getUndoLog(0)).length, 1, 'a limit below 1 is raised to 1')
		assert.strictEqual((await api.getUndoLog(10_000)).length, 5)
	})

	test('getUndoLog: empty when there is no log', async () => {
		const bare = new GitBraidApi(config, branchStack, sync, wsRoot(), runner)
		assert.deepStrictEqual(await bare.getUndoLog(), [])
	})
})
