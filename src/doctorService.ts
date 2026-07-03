import * as vscode from 'vscode'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { ConfigService } from './configService'
import { BranchStackService, branchToWorktreeDirName, detectStackCycle } from './branchStackService'
import { encodeBranchToFilename } from './virtualBranchStore'
import { requireInside } from './pathGuard'
import { getDefaultGitRunner } from './gitRunner'

export type DoctorSeverity = 'error' | 'warning'

export interface DoctorFinding {
	severity: DoctorSeverity
	/** One-line description shown to the user. */
	message: string
	/** Branch the finding is about, if applicable — used for grouping/display. */
	branch?: string
	/** Present only when a safe, reversible remediation is available. */
	fix?: () => Promise<void>
	/** Label for the fix action, e.g. "Remove orphaned worktree". */
	fixLabel?: string
}

/**
 * Audits a single folder's GitBraid state for the class of silent-corruption
 * issues this project has repeatedly turned up during review: circular base
 * chains, orphaned worktrees/virtual-store files left behind by a crash or a
 * manual `rm`, assignments that would escape the workspace root, and
 * assignments pointing at branches no longer in the stack.
 *
 * Read-only by default — `run()` never mutates anything. Individual
 * findings may carry a `fix` the caller can invoke explicitly (with the
 * user's confirmation), following the same "never surprise, always
 * confirm" pattern as `gitbraid.discardVirtualBranch`.
 */
export class DoctorService {
	constructor(
		private readonly _config: ConfigService,
		private readonly _branchStack: BranchStackService,
		private readonly _root: vscode.Uri,
	) {}

	async run(): Promise<DoctorFinding[]> {
		const findings: DoctorFinding[] = []
		const stack = this._config.getStack()

		this._checkCycles(stack, findings)
		this._checkOrphanedWorktrees(stack, findings)
		this._checkOrphanedVirtualStoreFiles(stack, findings)
		this._checkMissingWorktrees(stack, findings)
		this._checkAssignments(stack, findings)

		return findings
	}

	private _checkCycles(
		stack: ReturnType<ConfigService['getStack']>,
		findings: DoctorFinding[],
	): void {
		for (const entry of stack) {
			const others = stack.filter((e) => e.name !== entry.name)
			const cycleAt = detectStackCycle(others, entry.name, entry.base)
			if (cycleAt) {
				findings.push({
					severity: 'error',
					branch: entry.name,
					message: `"${entry.name}" has a circular base reference through "${cycleAt}" — walking the stack from this branch never reaches a real base.`,
				})
			}
		}
	}

	private _checkOrphanedWorktrees(
		stack: ReturnType<ConfigService['getStack']>,
		findings: DoctorFinding[],
	): void {
		const worktreesDir = path.join(this._root.fsPath, '.worktrees')
		if (!fs.existsSync(worktreesDir)) return
		const knownDirs = new Set(stack.map((e) => branchToWorktreeDirName(e.name)))
		let entries: fs.Dirent[]
		try {
			entries = fs.readdirSync(worktreesDir, { withFileTypes: true })
		} catch {
			return
		}
		for (const entry of entries) {
			if (!entry.isDirectory() || entry.name === 'virtual') continue
			if (knownDirs.has(entry.name)) continue
			const full = path.join(worktreesDir, entry.name)
			findings.push({
				severity: 'warning',
				message: `Orphaned worktree directory ".worktrees/${entry.name}" has no matching branch in the stack — likely left behind by a removed branch or an interrupted operation.`,
				fixLabel: 'Remove orphaned worktree',
				fix: async () => {
					const runner = getDefaultGitRunner()
					// `git worktree remove` only succeeds for a directory git
					// actually registered as a worktree. A directory left behind
					// by some other means (a crash mid-`git worktree add`, a
					// manual copy) isn't one, and `remove` fails outright — fall
					// back to a plain filesystem removal so the directory is
					// cleaned up either way.
					const result = await runner.run(['worktree', 'remove', '--force', full], { cwd: this._root.fsPath })
					await runner.run(['worktree', 'prune'], { cwd: this._root.fsPath })
					if (result.exitCode !== 0 && fs.existsSync(full)) {
						await fs.promises.rm(full, { recursive: true, force: true })
					}
				},
			})
		}
	}

	private _checkOrphanedVirtualStoreFiles(
		stack: ReturnType<ConfigService['getStack']>,
		findings: DoctorFinding[],
	): void {
		const virtualDir = path.join(this._root.fsPath, '.worktrees', 'virtual')
		if (!fs.existsSync(virtualDir)) return
		const knownVirtualFiles = new Set(
			stack.filter((e) => e.virtual === true).map((e) => encodeBranchToFilename(e.name) + '.jsonl'),
		)
		let files: string[]
		try {
			files = fs.readdirSync(virtualDir)
		} catch {
			return
		}
		for (const file of files) {
			if (!file.endsWith('.jsonl') || knownVirtualFiles.has(file)) continue
			const full = path.join(virtualDir, file)
			findings.push({
				severity: 'warning',
				message: `Orphaned virtual-branch store file ".worktrees/virtual/${file}" has no matching virtual branch in the stack — its captured snapshots are unreachable.`,
				fixLabel: 'Delete orphaned store file',
				fix: async () => { await fs.promises.unlink(full) },
			})
		}
	}

	private _checkMissingWorktrees(
		stack: ReturnType<ConfigService['getStack']>,
		findings: DoctorFinding[],
	): void {
		for (const entry of stack) {
			if (entry.virtual === true || entry.scratch === true) continue
			if (!this._branchStack.worktreeExists(entry.name)) {
				findings.push({
					severity: 'error',
					branch: entry.name,
					message: `"${entry.name}" is a regular (non-virtual, non-scratch) branch in the stack with no worktree on disk — GitBraid can't sync files to it until the worktree is recreated.`,
				})
			}
		}
	}

	private _checkAssignments(
		stack: ReturnType<ConfigService['getStack']>,
		findings: DoctorFinding[],
	): void {
		const stackNames = new Set(stack.map((e) => e.name))
		for (const [rel, branch] of Object.entries(this._config.getAllAssignments())) {
			try {
				requireInside(this._root.fsPath, rel)
			} catch {
				findings.push({
					severity: 'error',
					branch,
					message: `Assignment "${rel}" → "${branch}" resolves outside the workspace root and will be skipped during sync.`,
				})
				continue
			}
			if (!stackNames.has(branch)) {
				findings.push({
					severity: 'warning',
					message: `"${rel}" is assigned to "${branch}", which is no longer in the stack.`,
				})
			}
		}
	}
}
