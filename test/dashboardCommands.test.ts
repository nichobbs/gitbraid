import * as assert from 'node:assert'
import {
	handleDashboardRequest,
	buildRowContextMenuItems,
	pickedItemToRequest,
	DashboardDeps,
	QuickPickItemLite,
} from '../src/commands/dashboardCommands'
import { parseRequest, DashboardRequest } from '../src/dashboardMessages'

interface SpyExtras {
	commands: Array<{ cmd: string, args: unknown[] }>
	clipboardWrites: string[]
	toasts: string[]
	pickerCalls: Array<{ items: QuickPickItemLite[], placeHolder: string }>
	/** Canned response for the next showQuickPick call. */
	nextPick: QuickPickItemLite | undefined
}

/** Deps stub that records every command invocation for assertions. */
function spyDeps(): DashboardDeps & SpyExtras {
	const commands: Array<{ cmd: string, args: unknown[] }> = []
	const clipboardWrites: string[] = []
	const toasts: string[] = []
	const pickerCalls: Array<{ items: QuickPickItemLite[], placeHolder: string }> = []
	const spy: DashboardDeps & SpyExtras = {
		commands,
		clipboardWrites,
		toasts,
		pickerCalls,
		nextPick: undefined,
		executeCommand: async (cmd, ...args) => { commands.push({ cmd, args }); return undefined },
		clipboard: { writeText: async (s) => { clipboardWrites.push(s) } },
		showInformationMessage: async (m) => { toasts.push(m) },
		showQuickPick: async (items, opts) => {
			pickerCalls.push({ items, placeHolder: opts.placeHolder })
			return spy.nextPick
		},
	}
	return spy
}

suite('dashboardCommands / dashboardMessages (Wave B)', () => {

	// ── parseRequest ─────────────────────────────────────────────────────────

	test('parseRequest: accepts every stack-wide kind', () => {
		const wide = ['refresh', 'submit', 'mergeStack', 'addBranch', 'assignFloating', 'saveCheckpoint', 'showUndoLog']
		for (const kind of wide) {
			const got = parseRequest({ kind })
			assert.ok(got, `expected ${kind} to parse`)
			assert.strictEqual(got!.kind, kind)
		}
	})

	test('parseRequest: branch-kinds require a non-empty branch', () => {
		assert.strictEqual(parseRequest({ kind: 'openPr' }), undefined, 'missing branch → undefined')
		assert.strictEqual(parseRequest({ kind: 'openPr', branch: '' }), undefined, 'empty branch → undefined')
		const got = parseRequest({ kind: 'openPr', branch: 'feat/a' })
		assert.deepStrictEqual(got, { kind: 'openPr', branch: 'feat/a' })
	})

	test('parseRequest: copyPrUrl requires both branch and url', () => {
		assert.strictEqual(parseRequest({ kind: 'copyPrUrl', branch: 'b' }), undefined)
		assert.strictEqual(parseRequest({ kind: 'copyPrUrl', url: 'u' }), undefined)
		const got = parseRequest({ kind: 'copyPrUrl', branch: 'feat/a', url: 'https://github.com/x/y/pull/1' })
		assert.deepStrictEqual(got, { kind: 'copyPrUrl', branch: 'feat/a', url: 'https://github.com/x/y/pull/1' })
	})

	test('parseRequest: unknown kind → undefined', () => {
		assert.strictEqual(parseRequest({ kind: 'who-knows' }), undefined)
	})

	test('parseRequest: non-object input → undefined', () => {
		assert.strictEqual(parseRequest(null), undefined)
		assert.strictEqual(parseRequest('string'), undefined)
		assert.strictEqual(parseRequest(42), undefined)
	})

	// ── handleDashboardRequest — stack-wide ─────────────────────────────────

	async function dispatch(req: DashboardRequest, deps: DashboardDeps) {
		await handleDashboardRequest(req, deps)
	}

	test('handleDashboardRequest: stack-wide requests dispatch to the right commands', async () => {
		const cases: Array<{ req: DashboardRequest, expect: string }> = [
			{ req: { kind: 'refresh' },        expect: 'gitbraid.refreshPRStatus' },
			{ req: { kind: 'submit' },         expect: 'gitbraid.submitStack' },
			{ req: { kind: 'mergeStack' },     expect: 'gitbraid.mergeStack' },
			{ req: { kind: 'addBranch' },      expect: 'gitbraid.addStackBranch' },
			{ req: { kind: 'saveCheckpoint' }, expect: 'gitbraid.saveCheckpoint' },
			{ req: { kind: 'showUndoLog' },    expect: 'gitbraid.showUndoLog' },
			{ req: { kind: 'assignFloating' }, expect: 'gitbraid.assignFile' },
		]
		for (const c of cases) {
			const deps = spyDeps()
			await dispatch(c.req, deps)
			assert.strictEqual(deps.commands.length, 1, `one command per request (${c.req.kind})`)
			assert.strictEqual(deps.commands[0].cmd, c.expect)
			assert.deepStrictEqual(deps.commands[0].args, [])
		}
	})

	// ── handleDashboardRequest — per-branch ─────────────────────────────────

	test('handleDashboardRequest: per-branch requests forward the branch arg', async () => {
		const cases: Array<{ req: DashboardRequest, expect: string }> = [
			{ req: { kind: 'openPr',             branch: 'feat/a' }, expect: 'gitbraid.openStackedPR' },
			{ req: { kind: 'rebase',             branch: 'feat/a' }, expect: 'gitbraid.rebaseBranch' },
			{ req: { kind: 'switchBranch',       branch: 'feat/a' }, expect: 'gitbraid.switchBranch' },
			{ req: { kind: 'moveBranchUp',       branch: 'feat/a' }, expect: 'gitbraid.moveBranchUp' },
			{ req: { kind: 'moveBranchDown',     branch: 'feat/a' }, expect: 'gitbraid.moveBranchDown' },
			{ req: { kind: 'removeBranch',       branch: 'feat/a' }, expect: 'gitbraid.removeStackBranch' },
			{ req: { kind: 'commit',             branch: 'feat/a' }, expect: 'gitbraid.scm.commitBranch' },
			{ req: { kind: 'pushBranch',         branch: 'feat/a' }, expect: 'gitbraid.scm.pushBranch' },
			{ req: { kind: 'absorbHunks',        branch: 'feat/a' }, expect: 'gitbraid.absorbHunks' },
			{ req: { kind: 'routeHunks',         branch: 'feat/a' }, expect: 'gitbraid.routeHunks' },
			{ req: { kind: 'toggleSingleCommit', branch: 'feat/a' }, expect: 'gitbraid.toggleSingleCommitMode' },
			{ req: { kind: 'setCommitTemplate',  branch: 'feat/a' }, expect: 'gitbraid.setCommitTemplate' },
			{ req: { kind: 'openWorktree',       branch: 'feat/a' }, expect: 'gitbraid.launchWindowForWorktree' },
		]
		for (const c of cases) {
			const deps = spyDeps()
			await dispatch(c.req, deps)
			assert.strictEqual(deps.commands.length, 1, `${c.req.kind} dispatches exactly once`)
			assert.strictEqual(deps.commands[0].cmd, c.expect, `${c.req.kind} → ${c.expect}`)
			assert.deepStrictEqual(deps.commands[0].args, ['feat/a'])
		}
	})

	// ── handleDashboardRequest — clipboard-shaped ──────────────────────────

	test('handleDashboardRequest: copyBranchName writes to clipboard + toasts', async () => {
		const deps = spyDeps()
		await dispatch({ kind: 'copyBranchName', branch: 'feat/a' }, deps)
		assert.deepStrictEqual(deps.clipboardWrites, ['feat/a'])
		assert.strictEqual(deps.toasts.length, 1)
		assert.ok(deps.toasts[0].includes('feat/a'))
		assert.strictEqual(deps.commands.length, 0)
	})

	test('handleDashboardRequest: copyPrUrl writes the URL', async () => {
		const deps = spyDeps()
		await dispatch({ kind: 'copyPrUrl', branch: 'feat/a', url: 'https://example.com/pr/1' }, deps)
		assert.deepStrictEqual(deps.clipboardWrites, ['https://example.com/pr/1'])
		assert.strictEqual(deps.toasts.length, 1)
		assert.ok(deps.toasts[0].includes('feat/a'))
	})

	test('Wave C: parseRequest accepts openCommit with sha + branch', () => {
		assert.strictEqual(parseRequest({ kind: 'openCommit', branch: 'feat/a' }), undefined)
		assert.strictEqual(parseRequest({ kind: 'openCommit', sha: 'abc' }), undefined)
		const got = parseRequest({ kind: 'openCommit', branch: 'feat/a', sha: 'abc123' })
		assert.deepStrictEqual(got, { kind: 'openCommit', branch: 'feat/a', sha: 'abc123' })
	})

	test('Wave C: handleDashboardRequest(openCommit) delegates to gitbraid.openStackedCommit', async () => {
		const deps = spyDeps()
		await dispatch({ kind: 'openCommit', branch: 'feat/a', sha: 'abc123' }, deps)
		assert.strictEqual(deps.commands.length, 1)
		assert.strictEqual(deps.commands[0].cmd, 'gitbraid.openStackedCommit')
		assert.deepStrictEqual(deps.commands[0].args, [{ branch: 'feat/a', sha: 'abc123' }])
	})

	// ── Follow-up: native QuickPick row context menu ─────────────────────────

	test('Follow-up: parseRequest accepts rowContextMenu with empty prUrl', () => {
		const got = parseRequest({ kind: 'rowContextMenu', branch: 'feat/a' })
		assert.deepStrictEqual(got, { kind: 'rowContextMenu', branch: 'feat/a', prUrl: '' })
	})

	test('Follow-up: parseRequest forwards prUrl when provided', () => {
		const got = parseRequest({ kind: 'rowContextMenu', branch: 'feat/a', prUrl: 'https://x/y/pull/1' })
		assert.deepStrictEqual(got, { kind: 'rowContextMenu', branch: 'feat/a', prUrl: 'https://x/y/pull/1' })
	})

	test('Follow-up: parseRequest rejects rowContextMenu without branch', () => {
		assert.strictEqual(parseRequest({ kind: 'rowContextMenu' }), undefined)
	})

	test('Follow-up: buildRowContextMenuItems exposes a stable action set', () => {
		const items = buildRowContextMenuItems('feat/a', 'https://example.com/pr/1')
		const ids = items.map((i) => i.id)
		assert.deepStrictEqual(ids, [
			'switchBranch', 'commit', 'pushBranch',
			'moveBranchUp', 'moveBranchDown',
			'absorbHunks', 'routeHunks', 'toggleSingleCommit', 'setCommitTemplate',
			'openWorktree', 'copyBranchName', 'copyPrUrl', 'removeBranch',
		])
		// The branch name appears in the "Switch to …" label for context.
		assert.ok(items[0].label.includes('feat/a'))
		// copyPrUrl is enabled + shows the URL as description.
		const copyPr = items.find((i) => i.id === 'copyPrUrl')!
		assert.strictEqual(copyPr.disabled, false)
		assert.strictEqual(copyPr.description, 'https://example.com/pr/1')
	})

	test('Follow-up: buildRowContextMenuItems disables copyPrUrl when URL is empty', () => {
		const items = buildRowContextMenuItems('feat/a', '')
		const copyPr = items.find((i) => i.id === 'copyPrUrl')!
		assert.strictEqual(copyPr.disabled, true)
		assert.strictEqual(copyPr.description, undefined)
	})

	test('Follow-up: pickedItemToRequest maps branch-only ids', () => {
		assert.deepStrictEqual(
			pickedItemToRequest('switchBranch', 'feat/a', ''),
			{ kind: 'switchBranch', branch: 'feat/a' },
		)
		assert.deepStrictEqual(
			pickedItemToRequest('removeBranch', 'feat/a', ''),
			{ kind: 'removeBranch', branch: 'feat/a' },
		)
	})

	test('Follow-up: pickedItemToRequest maps copyPrUrl and rejects when URL missing', () => {
		assert.deepStrictEqual(
			pickedItemToRequest('copyPrUrl', 'feat/a', 'https://example.com/pr/1'),
			{ kind: 'copyPrUrl', branch: 'feat/a', url: 'https://example.com/pr/1' },
		)
		assert.strictEqual(pickedItemToRequest('copyPrUrl', 'feat/a', ''), undefined)
	})

	test('Follow-up: pickedItemToRequest returns undefined for unknown ids', () => {
		assert.strictEqual(pickedItemToRequest('who-knows', 'feat/a', ''), undefined)
	})

	test('Follow-up: rowContextMenu opens a QuickPick and dispatches the selection', async () => {
		const deps = spyDeps()
		deps.nextPick = { id: 'switchBranch', label: 'Switch to feat/a' }
		await dispatch({ kind: 'rowContextMenu', branch: 'feat/a', prUrl: '' }, deps)

		assert.strictEqual(deps.pickerCalls.length, 1, 'QuickPick should be shown exactly once')
		assert.ok(deps.pickerCalls[0].placeHolder.includes('feat/a'))
		assert.strictEqual(deps.commands.length, 1, 'selection should dispatch once')
		assert.strictEqual(deps.commands[0].cmd, 'gitbraid.switchBranch')
		assert.deepStrictEqual(deps.commands[0].args, ['feat/a'])
	})

	test('Follow-up: rowContextMenu dispatches copyPrUrl via clipboard path', async () => {
		const deps = spyDeps()
		deps.nextPick = { id: 'copyPrUrl', label: 'Copy PR URL' }
		await dispatch(
			{ kind: 'rowContextMenu', branch: 'feat/a', prUrl: 'https://example.com/pr/1' },
			deps,
		)
		assert.deepStrictEqual(deps.clipboardWrites, ['https://example.com/pr/1'])
		assert.strictEqual(deps.commands.length, 0)
	})

	test('Follow-up: rowContextMenu dismissal is a no-op', async () => {
		const deps = spyDeps()
		deps.nextPick = undefined
		await dispatch({ kind: 'rowContextMenu', branch: 'feat/a', prUrl: '' }, deps)
		assert.strictEqual(deps.pickerCalls.length, 1)
		assert.strictEqual(deps.commands.length, 0)
		assert.strictEqual(deps.clipboardWrites.length, 0)
	})
})
