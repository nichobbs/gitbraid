import * as vscode from 'vscode'
import * as fs from 'fs'
import * as path from 'path'
import util from 'node:util'
import child_process from 'node:child_process'
import { log } from './channelLogger'
import { BranchStackError } from './errors'
import { BranchStackEntry } from './configTypes'
import { ConfigService } from './configService'
import { git } from './gitFunctions'

const execAsync = util.promisify(child_process.exec)

const WORKTREES_DIR = '.worktrees'

/** Valid git branch name characters (subset: safe for shell args with quoting). */
const BRANCH_NAME_RE = /^[a-zA-Z0-9_./-]+$/

/**
 * Maps a git branch name to a safe directory name under `.worktrees/`.
 * e.g. "feature/docs" → "feature-docs"
 */
export function branchToWorktreeDirName(branchName: string): string {
	return branchName.replaceAll('/', '-').replaceAll(/[^a-zA-Z0-9._-]/g, '_')
}

function validateBranchName(name: string): void {
	if (!BRANCH_NAME_RE.test(name)) {
		throw new BranchStackError(
			`Invalid branch name: "${name}". Only alphanumeric characters, dots, dashes, underscores, and slashes are allowed.`
		)
	}
}

/**
 * Returns the expected filesystem path of the worktree for a given branch.
 */
export function worktreePath(workspaceRoot: vscode.Uri, branchName: string): vscode.Uri {
	return vscode.Uri.joinPath(workspaceRoot, WORKTREES_DIR, branchToWorktreeDirName(branchName))
}

/**
 * Manages git worktrees that back the branch stack.
 *
 * Each branch in the ConfigService stack gets a corresponding worktree under
 * `.worktrees/<branch-dir>/`. This service keeps the worktrees in sync with
 * the config.
 */
export class BranchStackService implements vscode.Disposable {

	private static _instance: BranchStackService | undefined

	private _workspaceRoot: vscode.Uri | undefined
	private readonly _disposables: vscode.Disposable[] = []

	private constructor(private readonly _config: ConfigService) {}

	static getInstance(config?: ConfigService): BranchStackService {
		if (!BranchStackService._instance) {
			if (!config) {
				config = ConfigService.getInstance()
			}
			BranchStackService._instance = new BranchStackService(config)
		}
		return BranchStackService._instance
	}

	/** Reset the singleton — for use in tests only. */
	static resetInstance(): void {
		BranchStackService._instance?.dispose()
		BranchStackService._instance = undefined
	}

	dispose(): void {
		for (const d of this._disposables) {
			d.dispose()
		}
	}

	// ─── Initialisation ──────────────────────────────────────────────────────

	/**
	 * Initialise the service for the given workspace.
	 * Creates worktrees for any stack branches that don't have one,
	 * and prunes orphaned worktrees (in `.worktrees/` with no config entry).
	 */
	async initStack(workspaceRoot: vscode.Uri): Promise<void> {
		this._workspaceRoot = workspaceRoot
		const stack = this._config.getStack()

		log.info(`BranchStackService.initStack: ${stack.length} branch(es) in config`)

		// Ensure .worktrees dir exists
		const worktreesDirUri = vscode.Uri.joinPath(workspaceRoot, WORKTREES_DIR)
		fs.mkdirSync(worktreesDirUri.fsPath, { recursive: true })

		// Create missing worktrees
		for (const entry of stack) {
			await this._ensureWorktree(entry)
		}

		// Prune orphans
		await this._pruneOrphans(stack)
	}

	// ─── Stack mutations ──────────────────────────────────────────────────────

	/**
	 * Add a new branch to the stack. Creates the git branch and worktree.
	 *
	 * @param name - Git branch name (e.g. "feature/docs")
	 * @param base - Base branch name (e.g. "main" or another stack branch)
	 * @param color - Hex colour for decorations (defaults to grey)
	 */
	async addBranchToStack(name: string, base: string, color = '#888888'): Promise<void> {
		this._assertInitialised()
		validateBranchName(name)
		validateBranchName(base)
		this._validateNoCycle(name, base)

		log.info(`BranchStackService.addBranchToStack: ${name} (base=${base})`)

		// Create the worktree (which creates the branch too)
		await this._createWorktree(name, base)

		// Record in config
		await this._config.addBranch({ name, base, color })

		log.info(`BranchStackService: branch "${name}" added to stack`)
	}

	/**
	 * Remove a branch from the stack. Removes its worktree and config entry.
	 * If the worktree has uncommitted changes the user is prompted to confirm
	 * before proceeding. Passing `force = true` bypasses the prompt (for
	 * programmatic callers that have already confirmed with the user).
	 */
	async removeBranchFromStack(name: string, force = false): Promise<void> {
		this._assertInitialised()
		log.info(`BranchStackService.removeBranchFromStack: ${name} (force=${force})`)

		const wtPath = worktreePath(this._workspaceRoot!, name)
		if (fs.existsSync(wtPath.fsPath)) {
			if (!force && await this._worktreeIsDirty(wtPath.fsPath)) {
				const answer = await vscode.window.showWarningMessage(
					`Branch "${name}" has uncommitted changes in its worktree. Remove anyway?`,
					{ modal: true },
					'Remove',
				)
				if (answer !== 'Remove') {
					return
				}
				force = true
			}
			await git.worktree.remove('"' + wtPath.fsPath + '"', force)
		}
		await this._config.removeBranch(name)

		log.info(`BranchStackService: branch "${name}" removed from stack`)
	}

	private async _worktreeIsDirty(worktreeFsPath: string): Promise<boolean> {
		try {
			const { stdout } = await execAsync('git status --porcelain', { cwd: worktreeFsPath })
			return stdout.trim().length > 0
		} catch {
			return false
		}
	}

	/**
	 * Reorder the stack by providing the desired branch order.
	 * Does not move worktrees on disk.
	 */
	async reorderStack(orderedNames: string[]): Promise<void> {
		this._assertInitialised()
		await this._config.reorderStack(orderedNames)
	}

	// ─── Queries ─────────────────────────────────────────────────────────────

	/**
	 * Returns the filesystem URI of the worktree for a given branch.
	 * Does not check whether the worktree exists on disk.
	 */
	getWorktreePath(branchName: string): vscode.Uri {
		this._assertInitialised()
		return worktreePath(this._workspaceRoot!, branchName)
	}

	/**
	 * Returns true if the worktree directory for the given branch exists.
	 */
	worktreeExists(branchName: string): boolean {
		if (!this._workspaceRoot) {
			return false
		}
		return fs.existsSync(worktreePath(this._workspaceRoot, branchName).fsPath)
	}

	// ─── Private helpers ──────────────────────────────────────────────────────

	private _assertInitialised(): void {
		if (!this._workspaceRoot) {
			throw new BranchStackError('BranchStackService not initialised — call initStack() first')
		}
	}

	private async _ensureWorktree(entry: BranchStackEntry): Promise<void> {
		const wtPath = worktreePath(this._workspaceRoot!, entry.name)
		if (fs.existsSync(wtPath.fsPath)) {
			log.info(`BranchStackService: worktree already exists for "${entry.name}"`)
			return
		}
		await this._createWorktree(entry.name, entry.base)
	}

	private async _createWorktree(branchName: string, base: string): Promise<void> {
		const wtPath = worktreePath(this._workspaceRoot!, branchName)
		const absPath = wtPath.fsPath

		try {
			// Attempt to create a new branch from base and add a worktree for it
			await git.worktree.add(`-b "${branchName}" "${absPath}" "${base}"`)
			log.info(`BranchStackService: created new branch "${branchName}" at ${absPath}`)
		} catch (e: unknown) {
			const msg = e instanceof Error ? e.message : JSON.stringify(e)
			if (!msg.includes('already exists')) {
				throw e
			}
			// Branch already exists — check it out into the new worktree
			const checkedOut = await this._isCheckedOut(branchName)
			if (checkedOut) {
				throw new BranchStackError(
					`Branch "${branchName}" is already checked out in another worktree. ` +
					`Remove that worktree first before adding it to the stack.`
				)
			}
			await git.worktree.add(`"${absPath}" "${branchName}"`)
			log.info(`BranchStackService: added existing branch "${branchName}" at ${absPath}`)
		}
	}

	private async _isCheckedOut(branchName: string): Promise<boolean> {
		try {
			const worktrees = await git.worktree.list()
			return worktrees.some((wt) => wt.branch === 'refs/heads/' + branchName)
		} catch {
			return false
		}
	}

	private async _pruneOrphans(configStack: BranchStackEntry[]): Promise<void> {
		if (!this._workspaceRoot) {
			return
		}
		const worktreesDirPath = vscode.Uri.joinPath(this._workspaceRoot, WORKTREES_DIR).fsPath
		if (!fs.existsSync(worktreesDirPath)) {
			return
		}

		const expectedDirs = new Set(
			configStack.map((e) => branchToWorktreeDirName(e.name))
		)

		let entries: string[]
		try {
			entries = fs.readdirSync(worktreesDirPath)
		} catch {
			return
		}

		for (const entry of entries) {
			if (entry === 'local-config.json' || entry === 'local-config.json.tmp') {
				continue
			}
			if (expectedDirs.has(entry)) {
				continue
			}
			const orphanPath = path.join(worktreesDirPath, entry)
			const stat = fs.statSync(orphanPath, { throwIfNoEntry: false })
			if (!stat?.isDirectory()) {
				continue
			}
			log.info(`BranchStackService: pruning orphan worktree at ${orphanPath}`)
			try {
				await git.worktree.remove('"' + orphanPath + '"', false)
			} catch {
				// Worktree may have uncommitted changes — log and skip, don't force
				log.warn(`BranchStackService: could not auto-prune "${orphanPath}" (has uncommitted changes?)`)
			}
		}

		// Let git clean up internal refs
		await git.worktree.prune()
	}

	/**
	 * Detect circular base references before writing to config.
	 * e.g. A→B, B→A would be circular.
	 */
	private _validateNoCycle(newBranch: string, base: string): void {
		const stack = this._config.getStack()
		const visited = new Set<string>([newBranch])
		let current: string = base

		while (current) {
			if (visited.has(current)) {
				throw new BranchStackError(
					`Circular base reference detected: adding "${newBranch}" with base "${base}" ` +
					`creates a cycle through "${current}"`
				)
			}
			visited.add(current)
			const entry = stack.find((e) => e.name === current)
			if (!entry) {
				break
			}
			current = entry.base
		}
	}
}
