import * as assert from 'node:assert'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as vscode from 'vscode'
import { ConfigService } from '../src/configService'
import { BranchStackService } from '../src/branchStackService'
import { VirtualBranchStore } from '../src/virtualBranchStore'
import { DoctorService } from '../src/doctorService'
import { git } from '../src/gitFunctions'

// The underlying `git` singleton always operates against
// `vscode.workspace.workspaceFolders[0]` (see gitFunctions.ts `Git._defaultCwd`),
// not an arbitrary repo path, so — like every other suite that exercises real
// worktree creation (branchStackService.test.ts, virtualBranchStore.test.ts) —
// this suite uses the shared test workspace rather than a standalone TmpRepo.

function wsRoot(): vscode.Uri {
	return vscode.workspace.workspaceFolders![0].uri
}

function cleanup(): void {
	try { fs.rmSync(path.join(wsRoot().fsPath, '.worktrees'), { recursive: true, force: true }) } catch { /* ignore */ }
	try { fs.rmSync(path.join(wsRoot().fsPath, '.gitignore')) } catch { /* ignore */ }
}

/** Remove any worktree directories left under `.worktrees/` between tests. */
async function removeAllTestWorktrees(): Promise<void> {
	const wtDir = path.join(wsRoot().fsPath, '.worktrees')
	if (!fs.existsSync(wtDir)) return
	for (const entry of fs.readdirSync(wtDir)) {
		if (entry === 'virtual') continue
		const p = path.join(wtDir, entry)
		if (fs.statSync(p, { throwIfNoEntry: false })?.isDirectory()) {
			try { await git.worktree.remove('"' + p + '"', true) } catch { /* ignore */ }
		}
	}
}

suite('DoctorService', () => {
	let config: ConfigService
	let store: VirtualBranchStore
	let svc: BranchStackService
	let doctor: DoctorService

	suiteSetup(async () => {
		await git.init()
		await git.worktree.prune()
		try { await git.add(undefined, '.gitkeep') } catch { /* ignore */ }
		try { await git.commit('initial commit', '--no-gpg-sign') } catch { /* ignore */ }
	})

	setup(async () => {
		cleanup()
		config = new ConfigService()
		await config.load(wsRoot())
		store = new VirtualBranchStore()
		await store.load(wsRoot(), config.getVirtualBranches())
		svc = new BranchStackService(config, store)
		await svc.initStack(wsRoot())
		doctor = new DoctorService(config, svc, wsRoot())
	})

	teardown(async () => {
		await removeAllTestWorktrees()
		store.dispose()
		config.dispose()
		cleanup()
	})

	test('clean stack → no findings', async () => {
		await svc.addBranchToStack('zdoc/clean', 'main', '#abc')
		const findings = await doctor.run()
		assert.deepStrictEqual(findings, [])
	})

	test('detects a circular base reference', async () => {
		await config.addBranch({ name: 'zdoc/cycle-a', base: 'zdoc/cycle-b', color: '#abc' })
		await config.addBranch({ name: 'zdoc/cycle-b', base: 'zdoc/cycle-a', color: '#abc' })
		const findings = await doctor.run()
		const cycleFindings = findings.filter((f) => f.message.includes('circular base reference'))
		assert.strictEqual(cycleFindings.length, 2, 'both branches in the 2-cycle should be flagged')
		assert.ok(cycleFindings.every((f) => f.severity === 'error'))
	})

	test('detects and can fix an orphaned worktree directory', async () => {
		await svc.addBranchToStack('zdoc/wt', 'main', '#abc')
		// Simulate a branch that was removed from the stack (e.g. by a manual
		// config edit) without its worktree being cleaned up.
		const orphanDir = path.join(wsRoot().fsPath, '.worktrees', 'orphan-leftover')
		fs.mkdirSync(orphanDir, { recursive: true })

		const findings = await doctor.run()
		const finding = findings.find((f) => f.message.includes('orphan-leftover'))
		assert.ok(finding, 'should report the orphaned directory')
		assert.strictEqual(finding?.severity, 'warning')
		assert.ok(finding?.fix, 'should offer a fix')

		await finding!.fix!()
		assert.strictEqual(fs.existsSync(orphanDir), false, 'orphaned directory should be gone after the fix')
	})

	test('detects and can fix an orphaned virtual-branch store file', async () => {
		await svc.addBranchToStack('zdoc/vsf', 'main', '#abc')
		const virtualDir = path.join(wsRoot().fsPath, '.worktrees', 'virtual')
		fs.mkdirSync(virtualDir, { recursive: true })
		const orphanFile = path.join(virtualDir, 'stale-branch__1234567.jsonl')
		fs.writeFileSync(orphanFile, '')

		const findings = await doctor.run()
		const finding = findings.find((f) => f.message.includes('stale-branch__1234567.jsonl'))
		assert.ok(finding, 'should report the orphaned store file')
		assert.strictEqual(finding?.severity, 'warning')

		await finding!.fix!()
		assert.strictEqual(fs.existsSync(orphanFile), false, 'orphaned store file should be gone after the fix')
	})

	test('does not flag a virtual branch\'s own store file as orphaned', async () => {
		await svc.addBranchToStack('zdoc/virt', 'main', '#abc', { virtual: true })
		await store.writeFile('zdoc/virt', 'a.ts', Buffer.from('x'))
		const findings = await doctor.run()
		assert.strictEqual(findings.filter((f) => f.message.includes('Orphaned virtual-branch store file')).length, 0)
	})

	test('detects a non-virtual branch with no worktree on disk', async () => {
		await config.addBranch({ name: 'zdoc/ghost', base: 'main', color: '#abc' })
		// No worktree created for it — addBranch (config-only) doesn't create one.
		const findings = await doctor.run()
		const finding = findings.find((f) => f.branch === 'zdoc/ghost' && f.message.includes('no worktree on disk'))
		assert.ok(finding, 'should flag the branch as missing a worktree')
		assert.strictEqual(finding?.severity, 'error')
	})

	test('detects an assignment that resolves outside the workspace root', async () => {
		await svc.addBranchToStack('zdoc/escape', 'main', '#abc')
		// ConfigService.setAssignment does not itself validate path containment
		// (that guard lives at the sync layer) — Doctor exists precisely to
		// catch a config that got into this state some other way (hand edit,
		// a bug in an importer, etc).
		await config.setAssignment('../../etc/passwd', 'zdoc/escape')
		const findings = await doctor.run()
		const finding = findings.find((f) => f.message.includes('resolves outside the workspace root'))
		assert.ok(finding, 'should flag the escaping assignment')
		assert.strictEqual(finding?.severity, 'error')
	})
})
