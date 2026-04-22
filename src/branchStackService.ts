import * as vscode from 'vscode'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import { log } from './channelLogger'
import { BranchStackError } from './errors'
import { BranchStackEntry } from './configTypes'
import { ConfigService } from './configService'
import { git, checkRefFormat } from './gitFunctions'
import { getDefaultGitRunner } from './gitRunner'

const WORKTREES_DIR = '.worktrees'

/** Valid git branch name characters (subset: safe for shell args with quoting). */
const BRANCH_NAME_RE = /^[a-zA-Z0-9_./-]+$/

/**
 * Maps a git branch name to a safe directory name under `.worktrees/`.
 * e.g. "feature/docs" → "feature-docs__a1b2c3d"
 *
 * The 7-character sha1 suffix makes the mapping injective so two branches
 * that would otherwise slug-collide (e.g. "feature/a" and "feature-a") map
 * to distinct directories.  See `docs/remediation/02-p1-correctness.md#T9`
 * and `docs/reviews/bugs.md` B4.
 */
export function branchToWorktreeDirName(branchName: string): string {
	const slug = branchName.replaceAll('/', '-').replaceAll(/[^a-zA-Z0-9._-]/g, '_')
	const suffix = crypto.createHash('sha1').update(branchName).digest('hex').slice(0, 7)
	return `${slug}__${suffix}`
}

/**
 * Matches a directory name produced by the legacy (pre-T9) slug-only
 * implementation.  Used by `_migrateLegacyDirs` to rename existing worktrees
 * to the new hashed format without data loss.
 */
function legacySlugFor(branchName: string): string {
	return branchName.replaceAll('/', '-').replaceAll(/[^a-zA-Z0-9._-]/g, '_')
}

/**
 * Run `task` across `items` with at most `concurrency` in flight at a time.
 * Resolves once every task has settled.  Individual task failures are
 * propagated via `Promise.allSettled` so a single slow/failing entry does
 * not block the others.
 */
async function runWithConcurrency<T>(
	items: readonly T[],
	concurrency: number,
	task: (item: T) => Promise<void>,
): Promise<void> {
	if (items.length === 0) return
	const limit = Math.max(1, concurrency)
	let cursor = 0
	const workers: Promise<void>[] = []
	for (let i = 0; i < Math.min(limit, items.length); i++) {
		workers.push((async () => {
			for (;;) {
				const idx = cursor++
				if (idx >= items.length) return
				try {
					await task(items[idx])
				} catch (e) {
					log.warn(`runWithConcurrency: task for item #${String(idx)} failed: ${e instanceof Error ? e.message : String(e)}`)
				}
			}
		})())
	}
	await Promise.all(workers)
}

function validateBranchName(name: string): void {
	// Cheap pre-filter — rejects obvious junk without spawning git.
	if (!BRANCH_NAME_RE.test(name)) {
		throw new BranchStackError(
			`Invalid branch name: "${name}". Only alphanumeric characters, dots, dashes, underscores, and slashes are allowed.`
		)
	}
	// Reject values git would reject even though they pass the regex:
	// `.foo`, `foo.`, `foo..bar`, `foo.lock`, leading/trailing `/`.
	// Full validation via `git check-ref-format` runs asynchronously at
	// addBranch time — see validateBranchNameStrict.
	if (
		name.startsWith('.') || name.endsWith('.') ||
		name.startsWith('/') || name.endsWith('/') ||
		name.includes('..') || name.endsWith('.lock') ||
		name === 'HEAD' || name === '@'
	) {
		throw new BranchStackError(`Invalid branch name: "${name}". git would reject this as a branch ref.`)
	}
}

/**
 * Validate a branch name against git's own rules via `git check-ref-format`.
 * Runs `validateBranchName` first (cheap, synchronous) and then consults git.
 * Throws `BranchStackError` with a friendly message when the name is rejected.
 */
async function validateBranchNameStrict(name: string): Promise<void> {
	validateBranchName(name)
	const ok = await checkRefFormat(name)
	if (!ok) {
		throw new BranchStackError(
			`Invalid branch name: "${name}" (git check-ref-format rejected it).`
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

	/**
	 * Public constructor — each `FolderContext` creates its own instance
	 * paired with that folder's `ConfigService`.  The `getInstance()` /
	 * `resetInstance()` pair below remains for the test suite.
	 */
	constructor(private readonly _config: ConfigService) {}

	/** Legacy singleton, retained for tests (see class header). */
	static getInstance(config?: ConfigService): BranchStackService {
		if (!BranchStackService._instance) {
			config ??= ConfigService.getInstance()
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

		// Migrate legacy slug-only worktree directories (pre-T9) to the new
		// hashed form so we don't accidentally treat them as orphans.
		await this._migrateLegacyDirs(stack, worktreesDirUri.fsPath)

		// Create missing worktrees.  Parallel up to CONCURRENCY because each
		// target directory is distinct; sequential initialisation was costing
		// ~500 ms * N on cold starts.  Capped so we don't hammer the pack file
		// lock on low-CPU hosts.  (T46 in the remediation plan.)
		await runWithConcurrency(stack, 3, (entry) => this._ensureWorktree(entry))

		// Prune orphans
		await this._pruneOrphans(stack)
	}

	/**
	 * Rename any pre-T9 slug-only worktree directory to the new hashed name.
	 * The check is cheap: if the target (hashed) directory exists we skip,
	 * otherwise we rename and update git's internal worktree registration
	 * via `git worktree repair`.
	 */
	private async _migrateLegacyDirs(stack: BranchStackEntry[], worktreesDirPath: string): Promise<void> {
		for (const entry of stack) {
			const legacyName = legacySlugFor(entry.name)
			const newName = branchToWorktreeDirName(entry.name)
			if (legacyName === newName) {
				continue
			}
			const legacyPath = path.join(worktreesDirPath, legacyName)
			const newPath = path.join(worktreesDirPath, newName)
			if (!fs.existsSync(legacyPath) || fs.existsSync(newPath)) {
				continue
			}
			try {
				fs.renameSync(legacyPath, newPath)
				log.info(`BranchStackService: migrated legacy worktree dir ${legacyName} → ${newName}`)
				try {
					await git.worktree.repair()
				} catch (e) {
					log.warn(`git worktree repair failed after migration: ${e instanceof Error ? e.message : String(e)}`)
				}
			} catch (e) {
				log.warn(`BranchStackService: could not migrate ${legacyPath} → ${newPath}: ${e instanceof Error ? e.message : String(e)}`)
			}
		}
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
		// Two-tier validation: synchronous pre-filter rejects obvious junk
		// without spawning git; `git check-ref-format` catches the edge cases
		// the regex misses (`foo..bar`, `foo.lock`, `HEAD`, etc.).  See T19.
		await validateBranchNameStrict(name)
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
		const { stdout, exitCode, stderr } = await getDefaultGitRunner().run(
			['status', '--porcelain'],
			{ cwd: worktreeFsPath },
		)
		if (exitCode !== 0) {
			log.warn(`_worktreeIsDirty(${worktreeFsPath}): exit=${String(exitCode)}: ${stderr}`)
			return false
		}
		return stdout.trim().length > 0
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

		// Detect the already-checked-out case up-front rather than relying on
		// git's "already exists" error for diagnosis.  Emits a friendly error
		// before any worktree directory is created (T74 in the remediation plan).
		const alreadyCheckedOut = await this._isCheckedOut(branchName)
		if (alreadyCheckedOut) {
			throw new BranchStackError(
				`Branch "${branchName}" is already checked out in another worktree. ` +
				`Remove that worktree first before adding it to the stack.`
			)
		}

		// Check whether the branch already exists locally before calling git so
		// we pick the right worktree-add form first time.  Using the runner
		// (shell: false) avoids the gitExec error-notification path firing for
		// a perfectly normal "branch already exists" condition.
		const branchExists = await this._localBranchExists(branchName)

		if (branchExists) {
			// Existing branch — check it out into a new worktree.
			await git.worktree.add(`"${absPath}" "${branchName}"`)
			log.info(`BranchStackService: added existing branch "${branchName}" at ${absPath}`)
		} else {
			// New branch — create it from base and add the worktree in one step.
			await git.worktree.add(`-b "${branchName}" "${absPath}" "${base}"`)
			log.info(`BranchStackService: created new branch "${branchName}" at ${absPath}`)
		}
	}

	private async _localBranchExists(branchName: string): Promise<boolean> {
		try {
			const { exitCode } = await getDefaultGitRunner().run(
				['rev-parse', '--verify', `refs/heads/${branchName}`],
				{ cwd: this._workspaceRoot!.fsPath },
			)
			return exitCode === 0
		} catch {
			return false
		}
	}

	private async _isCheckedOut(branchName: string): Promise<boolean> {
		try {
			const worktrees = await git.worktree.list()
			return worktrees.some((wt) => wt.branch === 'refs/heads/' + branchName)
		} catch (e) {
			log.warn(`_isCheckedOut(${branchName}): git worktree list failed — ${e instanceof Error ? e.message : String(e)}`)
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
		} catch (e) {
			log.warn(`_pruneOrphans: failed to read ${worktreesDirPath}: ${e instanceof Error ? e.message : String(e)}`)
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
			// Explicit dirty-check before touching git worktree — never
			// force-remove in the auto-prune path. T4: orphans with
			// uncommitted changes are left in place; the user must clean them
			// up via `removeBranchFromStack(name, force=true)` after seeing
			// the modal prompt.
			if (await this._worktreeIsDirty(orphanPath)) {
				log.warn(`BranchStackService: skipping dirty orphan worktree at ${orphanPath} — manual cleanup required`)
				continue
			}
			log.info(`BranchStackService: pruning orphan worktree at ${orphanPath}`)
			try {
				await git.worktree.remove('"' + orphanPath + '"', false)
			} catch (e) {
				log.warn(`BranchStackService: could not auto-prune "${orphanPath}": ${e instanceof Error ? e.message : String(e)}`)
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
