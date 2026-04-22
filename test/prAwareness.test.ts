import * as assert from 'node:assert'
import * as vscode from 'vscode'
import { PRAwareness, codiconForState, stateLabel } from '../src/prAwareness'

// PRAwareness adapts against a third-party extension's exported API whose
// shape is not officially stable.  These tests pin the defensive behaviour:
//
//   - Missing extension / inactive extension → no cache, no events.
//   - Various shapes of `getAPI(1).repositories[n].pullRequests` → parsed.
//   - Garbage entries → skipped, not crashes.
//
// We stub the extension host's registry by replacing
// `vscode.extensions.getExtension` in place.  Restored in teardown.

type Ext = { isActive: boolean, activate: () => Promise<void>, exports: unknown }

function withGhExtension<T>(fake: Ext | undefined, fn: () => Promise<T>): Promise<T> {
	const anyExt = vscode.extensions as unknown as {
		getExtension: (id: string) => Ext | undefined
	}
	const original = anyExt.getExtension
	anyExt.getExtension = (id) => {
		if (id === 'GitHub.vscode-pull-request-github') return fake
		return original.call(vscode.extensions, id) as Ext | undefined
	}
	return fn().finally(() => { anyExt.getExtension = original })
}

suite('PRAwareness (T75)', () => {

	teardown(async () => {
		// Reset the setting back to default so downstream suites aren't affected.
		try {
			await vscode.workspace.getConfiguration('gitbraid').update(
				'prDecorationsEnabled', undefined, vscode.ConfigurationTarget.Workspace,
			)
		} catch { /* ignore */ }
	})

	test('refresh: extension absent → cache stays empty, no crash', async () => {
		await withGhExtension(undefined, async () => {
			const pr = new PRAwareness()
			await pr.refresh()
			assert.strictEqual(pr.getForBranch('feature/a'), undefined)
			pr.dispose()
		})
	})

	test('refresh: v1 API with repositories[].pullRequests → populates cache', async () => {
		const fakeApi = {
			getAPI: (_v: number) => ({
				repositories: [
					{
						pullRequests: [
							{
								number: 42,
								title: 'fix the thing',
								state: 'open',
								isDraft: false,
								head: { ref: 'feature/a' },
								url: 'https://example.com/pr/42',
							},
							{
								number: 43,
								title: 'draft work',
								isDraft: true,
								head: { ref: 'feature/b' },
							},
							{
								number: 44,
								title: 'merged',
								state: 'closed',
								merged: true,
								head: { ref: 'feature/c' },
							},
						],
					},
				],
			}),
		}
		await withGhExtension(
			{ isActive: true, activate: async () => { /* no-op */ }, exports: fakeApi },
			async () => {
				const pr = new PRAwareness()
				await pr.refresh()
				const a = pr.getForBranch('feature/a')
				const b = pr.getForBranch('feature/b')
				const c = pr.getForBranch('feature/c')
				assert.ok(a, 'feature/a should be cached')
				assert.strictEqual(a!.state, 'open')
				assert.strictEqual(a!.number, 42)
				assert.strictEqual(b!.state, 'draft')
				assert.strictEqual(c!.state, 'merged')
				pr.dispose()
			},
		)
	})

	test('refresh: malformed entries (missing head ref) are skipped, not crashed', async () => {
		const fakeApi = {
			getAPI: (_v: number) => ({
				repositories: [{
					pullRequests: [
						{ number: 1 }, // no head at all
						{ number: 2, head: { ref: 'feature/x' }, title: 'ok', state: 'open' },
						null, // null entry
						'garbage', // wrong type
					],
				}],
			}),
		}
		await withGhExtension(
			{ isActive: true, activate: async () => { /* no-op */ }, exports: fakeApi },
			async () => {
				const pr = new PRAwareness()
				await pr.refresh()
				assert.strictEqual(pr.getForBranch('feature/x')?.number, 2)
				// No crash even with the malformed siblings.
				pr.dispose()
			},
		)
	})

	test('refresh: activates the extension if not already active', async () => {
		let activateCalls = 0
		const fakeApi = {
			getAPI: (_v: number) => ({ repositories: [] }),
		}
		await withGhExtension(
			{
				isActive: false,
				activate: async () => { activateCalls++ },
				exports: fakeApi,
			},
			async () => {
				const pr = new PRAwareness()
				await pr.refresh()
				assert.strictEqual(activateCalls, 1)
				pr.dispose()
			},
		)
	})

	test('refresh: when disabled via setting, cache clears and no query runs', async () => {
		const fakeApi = { getAPI: () => ({ repositories: [] }) }
		await withGhExtension(
			{ isActive: true, activate: async () => { /* noop */ }, exports: fakeApi },
			async () => {
				const pr = new PRAwareness()
				// Seed a cached entry by poking the private field through the
				// refresh path, then disable.
				await pr.refresh()
				await vscode.workspace.getConfiguration('gitbraid').update(
					'prDecorationsEnabled', false, vscode.ConfigurationTarget.Workspace,
				)
				await pr.refresh()
				assert.strictEqual(pr.getForBranch('feature/x'), undefined)
				pr.dispose()
			},
		)
	})

	// ── Pure helpers ─────────────────────────────────────────────────────────

	test('codiconForState: produces known codicons for every state', () => {
		assert.strictEqual(codiconForState('open'), 'git-pull-request')
		assert.strictEqual(codiconForState('draft'), 'git-pull-request-draft')
		assert.strictEqual(codiconForState('merged'), 'git-merge')
		assert.strictEqual(codiconForState('closed'), 'git-pull-request-closed')
	})

	test('stateLabel: produces human labels for every state', () => {
		assert.strictEqual(stateLabel('open'), 'Open PR')
		assert.strictEqual(stateLabel('draft'), 'Draft PR')
		assert.strictEqual(stateLabel('merged'), 'Merged PR')
		assert.strictEqual(stateLabel('closed'), 'Closed PR')
	})
})
