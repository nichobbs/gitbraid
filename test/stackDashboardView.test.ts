import * as assert from 'node:assert'
import { buildDashboardHtml, buildBranchRowHtml, DashboardData } from '../src/stackDashboardView'

suite('stackDashboardView: buildDashboardHtml', () => {
	test('renders the empty-state message when no branches are present', () => {
		const html = buildDashboardHtml({ workspaceName: 'proj', branches: [] })
		assert.ok(html.includes('Stack is empty'))
		// Empty state still carries the toolbar (Wave B contract uses `data-kind`).
		assert.ok(html.includes('data-kind="submit"'))
	})

	test('renders every branch with its PR state', () => {
		const data: DashboardData = {
			workspaceName: 'proj',
			branches: [
				{ name: 'feature/a', base: 'main', order: 1, color: '#4ec9b0', prNumber: 42, prState: 'open', prTitle: 'Big feature' },
				{ name: 'feature/b', base: 'feature/a', order: 2, color: '#f0d000', prNumber: 43, prState: 'draft' },
				{ name: 'feature/c', base: 'feature/b', order: 3, color: '#e06c75' },
			],
		}
		const html = buildDashboardHtml(data)
		// Each branch name shows up, paired with its base link.
		assert.ok(html.includes('feature/a'))
		assert.ok(html.includes('feature/b'))
		assert.ok(html.includes('→ feature/a'))
		// PR numbers and states render.
		assert.ok(html.includes('#42'))
		assert.ok(html.includes('open'))
		assert.ok(html.includes('draft'))
		// The branch without a PR still renders and its "Open PR" button is disabled.
		assert.ok(html.match(/data-branch="feature\/c"[^>]*disabled/))
	})

	test('escapes dangerous characters in branch names', () => {
		const html = buildDashboardHtml({
			workspaceName: '<proj>',
			branches: [{ name: 'feat"/<script>', base: 'main', order: 1, color: '#abc' }],
		})
		assert.ok(!html.includes('<script>'))
		assert.ok(html.includes('&lt;proj&gt;'))
		assert.ok(html.includes('&lt;script&gt;'))
	})

	test('includes CSP headers with the provided cspSource', () => {
		const html = buildDashboardHtml({ workspaceName: 'p', branches: [] }, 'vscode-webview://abc')
		assert.ok(html.includes("style-src vscode-webview://abc 'unsafe-inline'"))
	})

	// ── Wave A additions ───────────────────────────────────────────────────

	test('Wave A: current-branch marker renders for isCurrent rows only', () => {
		const data: DashboardData = {
			workspaceName: 'proj',
			branches: [
				{ name: 'feat/a', base: 'main', order: 1, color: '#abc', isCurrent: true },
				{ name: 'feat/b', base: 'feat/a', order: 2, color: '#abc' },
			],
		}
		const html = buildDashboardHtml(data)
		assert.ok(html.includes('data-testid="current-marker"'), 'current marker should render for feat/a')
		// Exactly one marker — feat/b isn't current.
		const occurrences = html.match(/data-testid="current-marker"/g) ?? []
		assert.strictEqual(occurrences.length, 1)
	})

	test('Wave A: floating-files banner appears when count > 0 and hides at 0', () => {
		const base: DashboardData = {
			workspaceName: 'proj',
			branches: [{ name: 'feat/a', base: 'main', order: 1, color: '#abc' }],
		}
		const withFloating = buildDashboardHtml({ ...base, banners: { floatingCount: 3 } })
		assert.ok(withFloating.includes('data-testid="floating-banner"'), 'banner should render when count > 0')
		assert.ok(withFloating.includes('3 floating files'), 'banner should include count and label')

		const zero = buildDashboardHtml({ ...base, banners: { floatingCount: 0 } })
		assert.ok(!zero.includes('data-testid="floating-banner"'), 'banner should hide at 0')
	})

	test('Wave A: singleton pluralisation in floating banner', () => {
		const html = buildDashboardHtml({
			workspaceName: 'proj',
			branches: [],
			banners: { floatingCount: 1 },
		})
		// Empty state + banner — banner still shows.
		assert.ok(html.includes('1 floating file —'), 'singular "file" should be used for count=1')
	})

	test('Wave A: checks pill renders for each PR state variant', () => {
		const variants: Array<'pending' | 'success' | 'failure'> = ['pending', 'success', 'failure']
		for (const s of variants) {
			const html = buildDashboardHtml({
				workspaceName: 'proj',
				branches: [{
					name: 'feat/a', base: 'main', order: 1, color: '#abc',
					prNumber: 1, prState: 'open', checksStatus: s,
				}],
			})
			assert.ok(
				html.includes(`data-testid="checks-${s}"`),
				`expected checks-${s} pill in output`,
			)
		}
	})

	test('Wave A: ahead / behind badges render when non-zero, hide at zero', () => {
		const withBoth = buildDashboardHtml({
			workspaceName: 'proj',
			branches: [{ name: 'feat/a', base: 'main', order: 1, color: '#abc', aheadCount: 3, behindCount: 1 }],
		})
		assert.ok(withBoth.includes('data-testid="ahead-behind"'))
		assert.ok(withBoth.includes('↑3'), 'ahead glyph should include count')
		assert.ok(withBoth.includes('↓1'), 'behind glyph should include count')

		const both_zero = buildDashboardHtml({
			workspaceName: 'proj',
			branches: [{ name: 'feat/a', base: 'main', order: 1, color: '#abc', aheadCount: 0, behindCount: 0 }],
		})
		assert.ok(!both_zero.includes('data-testid="ahead-behind"'), 'zero/zero should suppress the badge')
	})

	test('Wave A: singleCommit icon appears only for flagged branches', () => {
		const html = buildDashboardHtml({
			workspaceName: 'proj',
			branches: [
				{ name: 'feat/a', base: 'main', order: 1, color: '#abc', singleCommit: true },
				{ name: 'feat/b', base: 'main', order: 2, color: '#abc' },
			],
		})
		const count = (html.match(/data-testid="single-commit-icon"/g) ?? []).length
		assert.strictEqual(count, 1, 'exactly one single-commit icon should render')
	})

	test('Wave A: assigned-files count renders when > 0', () => {
		const html = buildDashboardHtml({
			workspaceName: 'proj',
			branches: [
				{ name: 'feat/a', base: 'main', order: 1, color: '#abc', assignedFilesCount: 5 },
				{ name: 'feat/b', base: 'main', order: 2, color: '#abc', assignedFilesCount: 0 },
			],
		})
		// Only feat/a has a count > 0.
		const countBadges = (html.match(/data-testid="files-count"/g) ?? []).length
		assert.strictEqual(countBadges, 1)
		assert.ok(html.includes('📄 5'))
	})

	test('Wave A: adapter strip appears when data.adapter is set', () => {
		const html = buildDashboardHtml({
			workspaceName: 'proj',
			branches: [],
			adapter: { label: 'GitHub (Octokit)' },
		})
		assert.ok(html.includes('data-testid="adapter-strip"'))
		assert.ok(html.includes('GitHub (Octokit)'))
	})

	test('Wave A: adapter strip hidden when absent', () => {
		const html = buildDashboardHtml({
			workspaceName: 'proj',
			branches: [],
		})
		assert.ok(!html.includes('data-testid="adapter-strip"'))
	})

	// ── Wave B additions ───────────────────────────────────────────────────

	test('Wave B: toolbar exposes the new stack-wide actions', () => {
		const html = buildDashboardHtml({
			workspaceName: 'proj',
			branches: [{ name: 'feat/a', base: 'main', order: 1, color: '#abc' }],
		})
		for (const kind of ['addBranch', 'refresh', 'submit', 'mergeStack', 'saveCheckpoint', 'showUndoLog']) {
			assert.ok(html.includes(`data-kind="${kind}"`), `toolbar should include data-kind="${kind}"`)
		}
	})

	test('Wave B: every row gets a "more" menu button', () => {
		const html = buildDashboardHtml({
			workspaceName: 'proj',
			branches: [
				{ name: 'feat/a', base: 'main', order: 1, color: '#abc' },
				{ name: 'feat/b', base: 'main', order: 2, color: '#abc', prNumber: 9, prUrl: 'https://example.com/pr/9' },
			],
		})
		const moreButtons = html.match(/data-testid="row-menu-button-[^"]+"/g) ?? []
		assert.strictEqual(moreButtons.length, 2, 'exactly one more-menu button per row')
		assert.ok(html.includes('data-testid="row-menu-button-feat/a"'))
		assert.ok(html.includes('data-testid="row-menu-button-feat/b"'))
		// The branch without a PR URL carries an empty data-branch-pr-url attribute.
		assert.ok(html.includes('data-testid="row-menu-button-feat/a"'))
		assert.ok(html.match(/row-menu-button-feat\/a"[^>]*data-branch-pr-url=""/))
		// The branch with a PR URL carries the URL.
		assert.ok(html.includes('data-branch-pr-url="https://example.com/pr/9"'))
	})

	test('Wave B: host markup includes the menu container + message listener', () => {
		const html = buildDashboardHtml({
			workspaceName: 'proj',
			branches: [{ name: 'feat/a', base: 'main', order: 1, color: '#abc' }],
		})
		// The host-rendered <div id="menu"> is the anchor the script positions.
		assert.ok(html.includes('<div id="menu"'))
		// The script wires the message listener for `patchRow` delta updates.
		assert.ok(html.includes("window.addEventListener('message'"), 'delta-patch message listener should be wired')
		assert.ok(html.includes("msg.kind === 'patchRow'"), 'patchRow handling should be in the script')
	})

	test('Wave B: Escape key closes the menu via keydown handler', () => {
		const html = buildDashboardHtml({
			workspaceName: 'proj',
			branches: [],
		})
		assert.ok(html.includes("e.key === 'Escape'"))
	})

	// ── buildBranchRowHtml (delta patching) ─────────────────────────────────

	test('buildBranchRowHtml: produces a self-contained <li class="row"> for patching', () => {
		const row = buildBranchRowHtml(
			{ name: 'feat/a', base: 'main', order: 1, color: '#abc', assignedFilesCount: 2 },
			0,
			3,
		)
		assert.ok(row.trim().startsWith('<li class="row"'), 'row markup should start with <li>')
		assert.ok(row.includes('data-branch="feat/a"'))
		assert.ok(row.includes('📄 2'))
		// Exactly one more-menu button per row.
		assert.strictEqual((row.match(/class="more"/g) ?? []).length, 1)
	})

	test('buildBranchRowHtml: preserves position classes (first/last)', () => {
		const first = buildBranchRowHtml({ name: 'a', base: 'main', order: 1, color: '#abc' }, 0, 3)
		assert.ok(first.includes('connector first'))
		assert.ok(!first.includes('connector last'))
		const last = buildBranchRowHtml({ name: 'a', base: 'main', order: 1, color: '#abc' }, 2, 3)
		assert.ok(last.includes('connector last'))
		assert.ok(!last.includes('connector first'))
		const mid = buildBranchRowHtml({ name: 'a', base: 'main', order: 1, color: '#abc' }, 1, 3)
		assert.ok(!mid.includes('connector first'))
		assert.ok(!mid.includes('connector last'))
	})
})
