/**
 * Injection safety tests — verify that shell metacharacters in user-supplied
 * strings (branch names, file paths, commit messages) reach `IGitRunner.run()`
 * as literal array elements rather than being interpreted by a shell.
 *
 * These tests close the loop on T18: now that `gitFunctions.ts` and the
 * `Worktree` class use `IGitRunner` exclusively (no `child_process.exec`),
 * we assert the invariant that no argument is split, interpolated, or
 * shell-expanded by the git layer.
 */

import * as assert from 'node:assert'
import * as vscode from 'vscode'
import { FakeGitRunner } from './helpers/fakeGitRunner'
import { setDefaultGitRunnerForTest } from '../src/gitRunner'
import { git } from '../src/gitFunctions'

// Payloads that would cause side effects if passed through a shell.
const METACHAR_PAYLOADS = [
	'$(echo injected)',
	'`whoami`',
	'; rm -rf /',
	'| cat /etc/passwd',
	'&& malicious-cmd',
	'branch-name\nwith-newline',
	'path/with spaces/file.ts',
	'"double-quoted"',
	"'single-quoted'",
]

function wsRoot(): vscode.Uri {
	return vscode.workspace.workspaceFolders![0].uri
}

suite('Injection safety — gitFunctions.ts', () => {

	let runner: FakeGitRunner

	setup(() => {
		runner = new FakeGitRunner()
		setDefaultGitRunnerForTest(runner)
		// Register permissive fixtures so every call succeeds.
		runner.fixture('branch', { stdout: 'main', exitCode: 0 })
		runner.fixture('add', { exitCode: 0 })
		runner.fixture('commit', { exitCode: 0 })
		runner.fixture('check-ignore', { exitCode: 0 })
		runner.fixture('status', { stdout: '', exitCode: 0 })
		runner.fixture('config', { stdout: 'main', exitCode: 0 })
		runner.fixture('rev-parse', { stdout: 'abc123', exitCode: 0 })
		runner.fixture('rev-list', { stdout: '0\t0', exitCode: 0 })
		runner.fixture('worktree', { stdout: '', exitCode: 0 })
		runner.fixture('branch -r', { stdout: '', exitCode: 0 })
		runner.fixture('branch --format', { stdout: '', exitCode: 0 })
	})

	teardown(() => {
		setDefaultGitRunnerForTest(undefined)
		runner.reset()
	})

	for (const payload of METACHAR_PAYLOADS) {
		test(`git.add — path "${payload.slice(0, 40)}" arrives as a single element`, async () => {
			await git.add(wsRoot(), payload).catch(() => { /* fixture may return success=false */ })
			const call = runner.calls.find(c => c.args[0] === 'add')
			assert.ok(call, 'expected an "add" call')
			// The payload must appear exactly once in the args array as a
			// single element — not split across multiple elements.
			assert.ok(
				call.args.includes(payload),
				`payload not found as a single element in args: ${JSON.stringify(call.args)}`,
			)
			// And it must NOT appear when the array is joined (i.e. not
			// split into sub-tokens).
			const joined = call.args.slice(1).join(' ')
			// Every metacharacter in the payload must survive verbatim.
			for (const ch of ['$', '`', ';', '|', '&', '\n', '"', "'", ' ']) {
				if (payload.includes(ch)) {
					// The character must be present in the joined string
					// (since the path contains it), but must NOT have caused
					// the path to be split.
					const elementCount = call.args.filter(a => a === payload).length
					assert.strictEqual(elementCount, 1, `payload should appear as exactly one element, got ${elementCount}`)
				}
			}
		})
	}

	for (const payload of METACHAR_PAYLOADS) {
		test(`git.commit — message "${payload.slice(0, 40)}" arrives as a single element`, async () => {
			await git.commit(payload, undefined, wsRoot()).catch(() => {})
			const call = runner.calls.find(c => c.args[0] === 'commit')
			assert.ok(call, 'expected a "commit" call')
			// Message is passed as the arg after '-m'.
			const mIdx = call.args.indexOf('-m')
			assert.ok(mIdx >= 0, 'expected -m flag in commit args')
			assert.strictEqual(
				call.args[mIdx + 1],
				payload,
				`message after -m should be exactly the payload, got: ${JSON.stringify(call.args[mIdx + 1])}`,
			)
		})
	}

	for (const payload of METACHAR_PAYLOADS) {
		test(`git.checkIgnore — path "${payload.slice(0, 40)}" arrives as a single element`, async () => {
			await git.checkIgnore(payload).catch(() => {})
			const call = runner.calls.find(c => c.args[0] === 'check-ignore')
			assert.ok(call, 'expected a "check-ignore" call')
			assert.ok(
				call.args.includes(payload),
				`payload not found as single element in args: ${JSON.stringify(call.args)}`,
			)
		})
	}

	test('git.listBranches — filter with metacharacters is passed as a single --list argument', async () => {
		const filter = '$(malicious)'
		await git.listBranches(wsRoot(), filter).catch(() => {})
		const call = runner.calls.find(c => c.args.includes('--list'))
		assert.ok(call, 'expected a branch -r call with --list')
		const listIdx = call.args.indexOf('--list')
		assert.ok(listIdx >= 0, '--list flag not found in args')
		const pattern = call.args[listIdx + 1]
		assert.ok(pattern?.includes(filter), `expected filter to be embedded in glob pattern, got: ${pattern}`)
		// The filter must not have caused extra elements after splitting
		assert.strictEqual(
			call.args.filter(a => a.includes('$(malicious)')).length,
			1,
			'metacharacter should appear in exactly one argument',
		)
	})
})

suite('Injection safety — Worktree', () => {

	let runner: FakeGitRunner

	setup(() => {
		runner = new FakeGitRunner()
		setDefaultGitRunnerForTest(runner)
		runner.fixture('worktree', { exitCode: 0 })
	})

	teardown(() => {
		setDefaultGitRunnerForTest(undefined)
		runner.reset()
	})

	const PATH_PAYLOADS = [
		'/tmp/path with spaces',
		'/tmp/path;rm -rf /',
		'/tmp/path$(echo injected)',
		'/tmp/path\nwith-newline',
	]

	const BRANCH_PAYLOADS = [
		'feature/$(whoami)',
		'feature/`date`',
		'branch; cat /etc/passwd',
	]

	for (const wtPath of PATH_PAYLOADS) {
		test(`worktree.add — path "${wtPath.slice(0, 40)}" arrives as a single element`, async () => {
			await git.worktree.add(wtPath, 'main').catch(() => {})
			const call = runner.calls.find(c => c.args[0] === 'worktree' && c.args[1] === 'add')
			assert.ok(call, 'expected a "worktree add" call')
			assert.ok(
				call.args.includes(wtPath),
				`path not found as single element: ${JSON.stringify(call.args)}`,
			)
		})
	}

	for (const branch of BRANCH_PAYLOADS) {
		test(`worktree.add — branch "${branch.slice(0, 40)}" arrives as a single element`, async () => {
			await git.worktree.add('/tmp/safe-path', branch).catch(() => {})
			const call = runner.calls.find(c => c.args[0] === 'worktree' && c.args[1] === 'add')
			assert.ok(call, 'expected a "worktree add" call')
			assert.ok(
				call.args.includes(branch),
				`branch not found as single element: ${JSON.stringify(call.args)}`,
			)
		})
	}

	for (const wtPath of PATH_PAYLOADS) {
		test(`worktree.remove — path "${wtPath.slice(0, 40)}" arrives as a single element`, async () => {
			await git.worktree.remove(wtPath).catch(() => {})
			const call = runner.calls.find(c => c.args[0] === 'worktree' && c.args[1] === 'remove')
			assert.ok(call, 'expected a "worktree remove" call')
			assert.ok(
				call.args.includes(wtPath),
				`path not found as single element: ${JSON.stringify(call.args)}`,
			)
		})
	}

	test('worktree.addNew — all three args arrive as separate elements', async () => {
		const branch = 'feature/$(injected)'
		const wtPath = '/tmp/path with spaces'
		const base = 'main; echo pwned'
		await git.worktree.addNew(branch, wtPath, base).catch(() => {})
		const call = runner.calls.find(c => c.args[0] === 'worktree' && c.args[1] === 'add' && c.args[2] === '-b')
		assert.ok(call, 'expected a "worktree add -b" call')
		assert.strictEqual(call.args[3], branch, 'branch should be arg[3]')
		assert.strictEqual(call.args[4], wtPath, 'worktreePath should be arg[4]')
		assert.strictEqual(call.args[5], base, 'base should be arg[5]')
	})
})
