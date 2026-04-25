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

	test('Follow-up: dashboard posts rowContextMenu instead of rendering its own popup', () => {
		const html = buildDashboardHtml({
			workspaceName: 'proj',
			branches: [{ name: 'feat/a', base: 'main', order: 1, color: '#abc' }],
		})
		// The hand-rolled <div id="menu"> is gone — the host now owns the
		// picker via vscode.window.showQuickPick.
		assert.ok(!html.includes('<div id="menu"'), 'legacy menu container should be removed')
		assert.ok(html.includes("kind: 'rowContextMenu'"), 'webview script should post rowContextMenu')
		// Both click-on-⋯ and right-click paths route through the same host call.
		assert.ok(html.includes("addEventListener('contextmenu'"), 'right-click should open the menu')
		assert.ok(html.includes("openRowContextMenu"), 'webview helper delegates to rowContextMenu')
		// The delta-patch message listener keeps working.
		assert.ok(html.includes("window.addEventListener('message'"), 'delta-patch message listener should be wired')
		assert.ok(html.includes("msg.kind === 'patchRow'"), 'patchRow handling should be in the script')
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

	// ── Wave C additions ───────────────────────────────────────────────────

	test('Wave C: commits drawer renders when branch has commits', () => {
		const row = buildBranchRowHtml({
			name: 'feat/a', base: 'main', order: 1, color: '#abc',
			commits: [
				{ shortSha: 'abc1234', subject: 'first', sha: 'abc1234deadbeef' },
				{ shortSha: 'def5678', subject: 'second', sha: 'def5678deadbeef' },
			],
		}, 0, 1)
		assert.ok(row.includes('data-testid="commits-drawer-feat/a"'))
		assert.ok(row.includes('first'))
		assert.ok(row.includes('second'))
		// One button per commit, each wiring the openCommit kind with its sha.
		assert.ok(row.includes('data-kind="openCommit"'))
		assert.ok(row.includes('data-sha="abc1234deadbeef"'))
	})

	test('Wave C: commits drawer hides when branch has no commits', () => {
		const row = buildBranchRowHtml({
			name: 'feat/a', base: 'main', order: 1, color: '#abc',
			commits: [],
		}, 0, 1)
		assert.ok(!row.includes('data-testid="commits-drawer-feat/a"'))
	})

	test('Wave C: files drawer renders when branch has assigned files', () => {
		const row = buildBranchRowHtml({
			name: 'feat/a', base: 'main', order: 1, color: '#abc',
			assignedFiles: ['src/a.ts', 'README.md'],
		}, 0, 1)
		assert.ok(row.includes('data-testid="files-drawer-feat/a"'))
		assert.ok(row.includes('src/a.ts'))
		assert.ok(row.includes('README.md'))
	})

	test('Wave C: row carries a data-search attribute scoping search', () => {
		const row = buildBranchRowHtml({
			name: 'Feat/A', base: 'main', order: 1, color: '#abc', prNumber: 42, prTitle: 'My Title',
		}, 0, 1)
		// Searchable content is lowercased and whitespace-joined.
		assert.ok(row.includes('data-search="feat/a my title #42"'), `expected lowercased search haystack, got: ${row.match(/data-search="([^"]*)"/)?.[1]}`)
	})

	test('Wave C: toolbar includes a search input', () => {
		const html = buildDashboardHtml({
			workspaceName: 'proj',
			branches: [{ name: 'feat/a', base: 'main', order: 1, color: '#abc' }],
		})
		assert.ok(html.includes('data-testid="search-input"'))
		assert.ok(html.includes('type="search"'))
	})

	test('Wave C: script restores drawer state + applies filter on hydrate', () => {
		const html = buildDashboardHtml({
			workspaceName: 'proj',
			branches: [],
		})
		assert.ok(html.includes('vscode.getState()'), 'state access should be present')
		assert.ok(html.includes('restoreDrawers'))
		assert.ok(html.includes('applyFilter'))
	})

	// ── Follow-up: PR-body preview drawer ──────────────────────────────────

	test('Follow-up: PR-body preview drawer renders when the snapshot supplies one', () => {
		const row = buildBranchRowHtml({
			name: 'feat/a', base: 'main', order: 1, color: '#abc',
			prNumber: 1,
			stackBlockPreview: '<!-- gitbraid:stack-start -->\nStacked PRs:\n1. #1 feat/a\n<!-- gitbraid:stack-end -->',
		}, 0, 1)
		assert.ok(row.includes('data-testid="body-drawer-feat/a"'))
		assert.ok(row.includes('&lt;!-- gitbraid:stack-start --&gt;'))
		assert.ok(row.includes('1. #1 feat/a'))
	})

	test('Follow-up: PR-body preview drawer hides when preview is empty', () => {
		const row = buildBranchRowHtml({
			name: 'feat/a', base: 'main', order: 1, color: '#abc',
			stackBlockPreview: '   ',
		}, 0, 1)
		assert.ok(!row.includes('data-testid="body-drawer-feat/a"'))
	})

	// ── Follow-up: reviews & checks drawer ─────────────────────────────────

	test('Follow-up: reviews & checks drawer renders review state + per-check detail', () => {
		const row = buildBranchRowHtml({
			name: 'feat/a', base: 'main', order: 1, color: '#abc',
			prNumber: 1, prState: 'open',
			reviewState: 'approved',
			reviewCount: 2,
			checksDetail: [
				{ name: 'lint',  state: 'success', url: 'https://example.com/lint' },
				{ name: 'tests', state: 'failure', url: 'https://example.com/tests' },
				{ name: 'slow',  state: 'pending' },
			],
		}, 0, 1)
		assert.ok(row.includes('data-testid="reviews-drawer-feat/a"'))
		assert.ok(row.includes('data-testid="review-state-approved"'))
		assert.ok(row.includes('lint'))
		assert.ok(row.includes('tests'))
		assert.ok(row.includes('slow'))
		assert.ok(row.includes('check check-success'))
		assert.ok(row.includes('check check-failure'))
		assert.ok(row.includes('check check-pending'))
		const links = (row.match(/>open</g) ?? []).length
		assert.strictEqual(links, 2, 'exactly two checks should link out')
	})

	test('Follow-up: reviews drawer hides when all fields absent', () => {
		const row = buildBranchRowHtml({
			name: 'feat/a', base: 'main', order: 1, color: '#abc',
		}, 0, 1)
		assert.ok(!row.includes('data-testid="reviews-drawer-feat/a"'))
	})

	test('Follow-up: reviews drawer shows with checks only (no review state)', () => {
		const row = buildBranchRowHtml({
			name: 'feat/a', base: 'main', order: 1, color: '#abc',
			checksDetail: [{ name: 'lint', state: 'success' }],
		}, 0, 1)
		assert.ok(row.includes('data-testid="reviews-drawer-feat/a"'))
	})
})
