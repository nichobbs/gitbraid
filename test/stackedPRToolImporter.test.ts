import * as assert from 'node:assert'
import * as vscode from 'vscode'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { ConfigService } from '../src/configService'
import {
	StackedPRToolImporter,
	detectGraphite,
	detectGitButler,
	parseGitButlerToml,
	DetectedStack,
} from '../src/stackedPRToolImporter'
import { FakeGitRunner } from './helpers/fakeGitRunner'

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Create a disposable tmp directory seeded as a minimal "repo-like" tree
 * (no real git init — the importer detectors only touch `.git/` paths
 * synthetically, which is faster and deterministic).
 */
function mkTmpRepo(suite: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), `gitbraid-imp-${suite}-`))
	fs.mkdirSync(path.join(dir, '.git'), { recursive: true })
	return dir
}

function rmTmpRepo(dir: string): void {
	try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
}

function writeGraphiteRef(repo: string, branch: string, parent: string): void {
	const file = path.join(repo, '.git', 'refs', 'branch-metadata', branch)
	fs.mkdirSync(path.dirname(file), { recursive: true })
	fs.writeFileSync(file, JSON.stringify({ parentBranchName: parent }))
}

// ─── Graphite detector ───────────────────────────────────────────────────────

suite('stackedPRToolImporter: detectGraphite', () => {
	let repo: string

	setup(() => { repo = mkTmpRepo('graphite') })
	teardown(() => { rmTmpRepo(repo) })

	test('returns undefined when no metadata present', async () => {
		const result = await detectGraphite(repo)
		assert.strictEqual(result, undefined)
	})

	test('parses a linear 3-branch stack', async () => {
		writeGraphiteRef(repo, 'feature/a', 'main')
		writeGraphiteRef(repo, 'feature/b', 'feature/a')
		writeGraphiteRef(repo, 'feature/c', 'feature/b')
		const result = await detectGraphite(repo)
		assert.ok(result, 'expected Graphite detection')
		assert.strictEqual(result!.tool, 'graphite')
		assert.deepStrictEqual(
			result!.branches.map((b) => b.name),
			['feature/a', 'feature/b', 'feature/c'],
			'branches should come out in parent-before-child order',
		)
		assert.deepStrictEqual(
			result!.branches.map((b) => b.order),
			[1, 2, 3],
			'order should be 1..N',
		)
		assert.strictEqual(result!.branches[0].base, 'main')
		assert.strictEqual(result!.branches[2].base, 'feature/b')
	})

	test('ignores metadata files with unparseable JSON', async () => {
		writeGraphiteRef(repo, 'feature/a', 'main')
		const bad = path.join(repo, '.git', 'refs', 'branch-metadata', 'broken')
		fs.writeFileSync(bad, 'not json at all')
		const result = await detectGraphite(repo)
		assert.ok(result)
		assert.strictEqual(result!.branches.length, 1)
		assert.ok(result!.warnings.some((w) => w.includes('broken')))
	})

	test('topological sort handles branching (not just linear)', async () => {
		// main ← a ← {b, c}
		writeGraphiteRef(repo, 'feature/a', 'main')
		writeGraphiteRef(repo, 'feature/b', 'feature/a')
		writeGraphiteRef(repo, 'feature/c', 'feature/a')
		const result = await detectGraphite(repo)
		assert.ok(result)
		const names = result!.branches.map((b) => b.name)
		// feature/a must come before both b and c; b/c tie on depth so
		// they're ordered alphabetically.
		assert.strictEqual(names[0], 'feature/a')
		assert.ok(names.indexOf('feature/b') > names.indexOf('feature/a'))
		assert.ok(names.indexOf('feature/c') > names.indexOf('feature/a'))
	})
})

// ─── GitButler detector (TOML parse) ─────────────────────────────────────────

suite('stackedPRToolImporter: parseGitButlerToml', () => {
	test('returns empty array for empty input', () => {
		assert.deepStrictEqual(parseGitButlerToml(''), [])
	})

	test('parses a two-branch file with upstream fields', () => {
		const raw = [
			'[branches.a1b2c3]',
			'name = "feature/a"',
			'upstream = "main"',
			'',
			'[branches.d4e5f6]',
			'name = "feature/b"',
			'upstream = "feature/a"',
		].join('\n')
		const parsed = parseGitButlerToml(raw)
		assert.deepStrictEqual(parsed, [
			{ name: 'feature/a', upstream: 'main' },
			{ name: 'feature/b', upstream: 'feature/a' },
		])
	})

	test('ignores non-[branches.*] sections', () => {
		const raw = [
			'[project]',
			'name = "my-project"',
			'',
			'[branches.x]',
			'name = "feature/x"',
		].join('\n')
		const parsed = parseGitButlerToml(raw)
		assert.deepStrictEqual(parsed, [{ name: 'feature/x', upstream: undefined }])
	})

	test('supports single-quoted strings', () => {
		const raw = [
			'[branches.x]',
			"name = 'feature/x'",
			"upstream = 'main'",
		].join('\n')
		const parsed = parseGitButlerToml(raw)
		assert.deepStrictEqual(parsed, [{ name: 'feature/x', upstream: 'main' }])
	})
})

suite('stackedPRToolImporter: detectGitButler', () => {
	let repo: string

	setup(() => { repo = mkTmpRepo('gitbutler') })
	teardown(() => { rmTmpRepo(repo) })

	test('returns undefined when file missing', async () => {
		const result = await detectGitButler(repo)
		assert.strictEqual(result, undefined)
	})

	test('parses a real-shape TOML and builds a stack', async () => {
		const toml = [
			'[branches.aaaa]',
			'name = "feature/a"',
			'upstream = "main"',
			'',
			'[branches.bbbb]',
			'name = "feature/b"',
			'upstream = "feature/a"',
		].join('\n')
		const dir = path.join(repo, '.git', 'gitbutler')
		fs.mkdirSync(dir, { recursive: true })
		fs.writeFileSync(path.join(dir, 'virtual_branches.toml'), toml)
		const result = await detectGitButler(repo)
		assert.ok(result)
		assert.strictEqual(result!.tool, 'gitbutler')
		const names = result!.branches.map((b) => b.name)
		assert.deepStrictEqual(names, ['feature/a', 'feature/b'])
		assert.strictEqual(result!.branches[1].base, 'feature/a')
	})
})

// ─── git-stack + git-spr + upstream detectors via FakeGitRunner ──────────────

suite('stackedPRToolImporter: git-stack / git-spr / upstream (fake runner)', () => {
	let repo: string
	let runner: FakeGitRunner
	let importer: StackedPRToolImporter
	let config: ConfigService

	function wsRoot(): vscode.Uri { return vscode.workspace.workspaceFolders![0].uri }

	setup(async () => {
		repo = mkTmpRepo('runner')
		runner = new FakeGitRunner()
		config = new ConfigService()
		await config.load(wsRoot())
		importer = new StackedPRToolImporter(config, vscode.Uri.file(repo), runner)
	})

	teardown(() => {
		rmTmpRepo(repo)
	})

	test('git-stack detector walks refs/branch-stack symbolic refs', async () => {
		runner.fixture(
			'for-each-ref --format=%(refname:short) refs/branch-stack',
			{ stdout: 'branch-stack/feature/a\nbranch-stack/feature/b\n' },
		)
		runner.fixture(
			'symbolic-ref refs/branch-stack/feature/a',
			{ stdout: 'refs/heads/main\n' },
		)
		runner.fixture(
			'symbolic-ref refs/branch-stack/feature/b',
			{ stdout: 'refs/heads/feature/a\n' },
		)
		// No other tools present on disk → detectAll will only return git-stack.
		const all = await importer.detectAll()
		assert.strictEqual(all.length, 1)
		assert.strictEqual(all[0].tool, 'git-stack')
		const names = all[0].branches.map((b) => b.name)
		assert.deepStrictEqual(names, ['feature/a', 'feature/b'])
		assert.strictEqual(all[0].branches[1].base, 'feature/a')
	})

	test('upstream detector filters out non-local merge targets', async () => {
		// No git-stack metadata.
		runner.fixture(
			'for-each-ref --format=%(refname:short) refs/branch-stack',
			{ stdout: '' },
		)
		// Two local branches; only feature/b tracks another local branch.
		runner.fixture(
			'config --local --get-regexp branch\\..*\\.merge',
			{
				stdout: [
					'branch.feature/a.merge refs/heads/origin/main',
					'branch.feature/b.merge refs/heads/feature/a',
				].join('\n') + '\n',
			},
		)
		runner.fixture(
			'for-each-ref --format=%(refname:short) refs/heads',
			{ stdout: 'feature/a\nfeature/b\n' },
		)
		// git-spr / git-stack detectors see no matching content.
		runner.fixture(
			'log -1 --format=%B feature/a',
			{ stdout: 'feat: thing\n' },
		)
		runner.fixture(
			'log -1 --format=%B feature/b',
			{ stdout: 'feat: other\n' },
		)
		const all = await importer.detectAll()
		// Only upstream detector fires.
		assert.ok(all.some((d) => d.tool === 'upstream'))
		const upstream = all.find((d) => d.tool === 'upstream')!
		const names = upstream.branches.map((b) => b.name)
		assert.deepStrictEqual(names, ['feature/b'])
		assert.strictEqual(upstream.branches[0].base, 'feature/a')
	})
})

// ─── suggestImportIfEmpty (gitbraid.suggestImportOnActivate) ────────────────

suite('stackedPRToolImporter: suggestImportIfEmpty', () => {
	let repo: string
	let runner: FakeGitRunner
	let importer: StackedPRToolImporter
	let config: ConfigService

	function wsRoot(): vscode.Uri { return vscode.workspace.workspaceFolders![0].uri }

	// Shared with other suites in this file — each test must reset it, or a
	// branch left in the config by one test (e.g. the "already non-empty"
	// case) leaks into every later test's `getStack().length > 0` check.
	function cleanupWorktrees(): void {
		try { fs.rmSync(path.join(wsRoot().fsPath, '.worktrees'), { recursive: true, force: true }) } catch { /* ignore */ }
	}

	type WinAny = { showInformationMessage: (...args: unknown[]) => Promise<unknown> }
	type CmdAny = { executeCommand: (...args: unknown[]) => Promise<unknown> }
	let origInfo: WinAny['showInformationMessage']
	let origExec: CmdAny['executeCommand']
	let infoCalls: unknown[][]
	let execCalls: unknown[][]

	setup(async () => {
		cleanupWorktrees()
		repo = mkTmpRepo('suggest')
		runner = new FakeGitRunner()
		config = new ConfigService()
		await config.load(wsRoot())
		importer = new StackedPRToolImporter(config, vscode.Uri.file(repo), runner)

		infoCalls = []
		execCalls = []
		const win = vscode.window as unknown as WinAny
		const cmds = vscode.commands as unknown as CmdAny
		origInfo = win.showInformationMessage
		origExec = cmds.executeCommand
		win.showInformationMessage = async (...args: unknown[]) => { infoCalls.push(args); return undefined }
		cmds.executeCommand = async (...args: unknown[]) => { execCalls.push(args); return undefined }

		// No git-stack / upstream metadata on disk by default.
		runner.fixture('for-each-ref --format=%(refname:short) refs/branch-stack', { stdout: '' })
		runner.fixture('config --local --get-regexp branch\\..*\\.merge', { stdout: '', exitCode: 1 })
	})

	teardown(async () => {
		rmTmpRepo(repo)
		cleanupWorktrees()
		;(vscode.window as unknown as WinAny).showInformationMessage = origInfo
		;(vscode.commands as unknown as CmdAny).executeCommand = origExec
		await vscode.workspace.getConfiguration('gitbraid').update(
			'suggestImportOnActivate', undefined, vscode.ConfigurationTarget.Workspace,
		)
	})

	test('does nothing when the setting is off (default)', async () => {
		writeGraphiteRef(repo, 'feature/a', 'main')
		await importer.suggestImportIfEmpty()
		assert.strictEqual(infoCalls.length, 0)
	})

	test('does nothing when the stack is already non-empty', async () => {
		await vscode.workspace.getConfiguration('gitbraid').update(
			'suggestImportOnActivate', true, vscode.ConfigurationTarget.Workspace,
		)
		await config.addBranch({ name: 'feature/existing', base: 'main', color: '#abc' })
		writeGraphiteRef(repo, 'feature/a', 'main')
		await importer.suggestImportIfEmpty()
		assert.strictEqual(infoCalls.length, 0)
	})

	test('does nothing when nothing is detected', async () => {
		await vscode.workspace.getConfiguration('gitbraid').update(
			'suggestImportOnActivate', true, vscode.ConfigurationTarget.Workspace,
		)
		await importer.suggestImportIfEmpty()
		assert.strictEqual(infoCalls.length, 0)
	})

	test('offers to import and runs gitbraid.importStackedTool when accepted', async () => {
		await vscode.workspace.getConfiguration('gitbraid').update(
			'suggestImportOnActivate', true, vscode.ConfigurationTarget.Workspace,
		)
		writeGraphiteRef(repo, 'feature/a', 'main')
		;(vscode.window as unknown as WinAny).showInformationMessage = async () => 'Import…'
		await importer.suggestImportIfEmpty()
		assert.strictEqual(execCalls.length, 1)
		assert.strictEqual(execCalls[0][0], 'gitbraid.importStackedTool')
	})

	test('does not run the import command when dismissed', async () => {
		await vscode.workspace.getConfiguration('gitbraid').update(
			'suggestImportOnActivate', true, vscode.ConfigurationTarget.Workspace,
		)
		writeGraphiteRef(repo, 'feature/a', 'main')
		await importer.suggestImportIfEmpty()
		assert.strictEqual(infoCalls.length, 1)
		assert.strictEqual(execCalls.length, 0)
	})
})

// ─── preview() and apply() ───────────────────────────────────────────────────

suite('stackedPRToolImporter: preview + apply', () => {
	let repo: string
	let config: ConfigService
	let importer: StackedPRToolImporter

	function wsRoot(): vscode.Uri { return vscode.workspace.workspaceFolders![0].uri }

	function cleanup(): void {
		try { fs.rmSync(path.join(wsRoot().fsPath, '.worktrees'), { recursive: true, force: true }) } catch { /* ignore */ }
	}

	setup(async () => {
		cleanup()
		repo = mkTmpRepo('preview')
		config = new ConfigService()
		await config.load(wsRoot())
		importer = new StackedPRToolImporter(config, vscode.Uri.file(repo))
	})

	teardown(() => {
		cleanup()
		rmTmpRepo(repo)
	})

	function fakeStack(
		names: Array<[string, string]>,
		tool: 'graphite' = 'graphite',
	): DetectedStack {
		return {
			tool,
			source: '(test)',
			warnings: [],
			branches: names.map(([name, base], i) => ({ name, base, order: i + 1 })),
		}
	}

	test('preview: empty config → every detected branch is new', () => {
		const stack = fakeStack([['feature/a', 'main'], ['feature/b', 'feature/a']])
		const preview = importer.preview(stack)
		assert.strictEqual(preview.newBranches.length, 2)
		assert.strictEqual(preview.conflicts.length, 0)
	})

	test('preview: marks existing branches as conflicts', async () => {
		await config.addBranch({ name: 'feature/a', base: 'main', color: '#abc' })
		const stack = fakeStack([['feature/a', 'main'], ['feature/b', 'feature/a']])
		const preview = importer.preview(stack)
		assert.strictEqual(preview.newBranches.length, 1)
		assert.strictEqual(preview.newBranches[0].name, 'feature/b')
		assert.strictEqual(preview.conflicts.length, 1)
		assert.strictEqual(preview.conflicts[0].detected.name, 'feature/a')
	})

	test('preview: surfaces unknown bases', () => {
		const stack = fakeStack([['feature/a', 'develop']])
		const preview = importer.preview(stack)
		assert.deepStrictEqual(preview.unknownBases, ['develop'])
	})

	test('apply: skips conflicts by default', async () => {
		await config.addBranch({ name: 'feature/a', base: 'main', color: '#abc' })
		const stack = fakeStack([['feature/a', 'main'], ['feature/b', 'feature/a']])
		const summary = await importer.apply(stack)
		assert.strictEqual(summary.addedBranches, 1)
		assert.strictEqual(summary.skipped, 1)
		const entries = config.getStack()
		assert.strictEqual(entries.length, 2)
		assert.ok(entries.some((e) => e.name === 'feature/a'))
		assert.ok(entries.some((e) => e.name === 'feature/b'))
	})

	test('apply: overwriteExisting replaces conflicting entries', async () => {
		await config.addBranch({ name: 'feature/a', base: 'main', color: '#abc' })
		// Re-add feature/a with a different base via the importer.
		const stack = fakeStack([['feature/a', 'develop']])
		const summary = await importer.apply(stack, true)
		assert.strictEqual(summary.addedBranches, 1)
		assert.strictEqual(summary.skipped, 0)
		const entry = config.getBranch('feature/a')
		assert.ok(entry)
		assert.strictEqual(entry!.base, 'develop')
	})

	test('apply: adds parents before children regardless of input order', async () => {
		const stack: DetectedStack = {
			tool: 'graphite',
			source: '(test)',
			warnings: [],
			branches: [
				// Deliberately reverse order.
				{ name: 'feature/b', base: 'feature/a', order: 2 },
				{ name: 'feature/a', base: 'main', order: 1 },
			],
		}
		const summary = await importer.apply(stack)
		assert.strictEqual(summary.addedBranches, 2)
		// The `addBranch` validation in ConfigService does not verify that
		// the base exists in the stack, so ordering is not strictly required
		// for success — but we still want parent-first order to hold so the
		// resulting stack is sensible.
		const [first] = config.getStack()
		assert.strictEqual(first.name, 'feature/a', 'parent branch should land first')
	})
})
