import * as assert from 'node:assert'
import { buildDashboardHtml, DashboardData } from '../src/stackDashboardView'

suite('stackDashboardView: buildDashboardHtml', () => {
	test('renders the empty-state message when no branches are present', () => {
		const html = buildDashboardHtml({ workspaceName: 'proj', branches: [] })
		assert.ok(html.includes('Stack is empty'))
		// Empty state still carries the toolbar.
		assert.ok(html.includes('data-cmd="submit"'))
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
})
