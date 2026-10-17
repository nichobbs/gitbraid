import * as fs from 'node:fs'
import * as path from 'node:path'
import { log } from './channelLogger'
import { ConfigService } from './configService'
import { BranchStackService } from './branchStackService'
import { IGitRunner, getDefaultGitRunner } from './gitRunner'

/**
 * Adopts git worktrees created outside GitBraid (e.g. by a coding agent)
 * into the stack.
 *
 * Each adopted branch is rebased onto the layer below it, its external
 * worktree is replaced by a GitBraid-managed one under `.worktrees/`, and
 * any uncommitted changes are carried across via `git stash`.  Before
 * anything is touched, {@link StackSimulation} predicts which layers will
 * conflict for a proposed order so the user can reorder up front.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

/** One entry from `git worktree list --porcelain`. */
export interface WorktreeListEntry {
	path: string
	head?: string
	/** Short branch name; undefined for detached HEADs and bare repos. */
	branch?: string
	bare: boolean
	locked: boolean
	prunable: boolean
}

/** A worktree outside GitBraid's `.worktrees/` that can be adopted. */
export interface ExternalWorktree {
	branch: string
	path: string
	dirty: boolean
	locked: boolean
}

export interface LayerPrediction {
	branch: string
	/** False when `merge-tree --write-tree` is unavailable (git < 2.38). */
	supported: boolean
	conflicted: boolean
	/** Paths that conflict when this branch is placed on the current stack. */
	files: string[]
	/**
	 * Layers below (or the stack base) that also change the conflicting
	 * files — the likely culprits.
	 */
	conflictsWith: string[]
}

export interface AdoptStep {
	worktree: ExternalWorktree
	/** Branch the adopted branch is rebased onto and recorded with as `base`. */
	base: string
}

export interface AdoptResult {
	branch: string
	ok: boolean
	/** True when the step never ran because an earlier one failed. */
	skipped?: boolean
	message?: string
	/** Stash commit still holding uncommitted changes that weren't restored. */
	stash?: string
}

// ─── Parsing ─────────────────────────────────────────────────────────────────

/** Parse `git worktree list --porcelain` (newline-separated) output. */
export function parseWorktreeList(stdout: string): WorktreeListEntry[] {
	const entries: WorktreeListEntry[] = []
	let cur: WorktreeListEntry | undefined
	for (const raw of stdout.split('\n')) {
		const line = raw.replace(/\r$/, '')
		if (line.startsWith('worktree ')) {
			cur = { path: line.slice('worktree '.length), bare: false, locked: false, prunable: false }
			entries.push(cur)
			continue
		}
		if (!cur) continue
		if (line.startsWith('HEAD ')) cur.head = line.slice('HEAD '.length)
		else if (line.startsWith('branch ')) cur.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '')
		else if (line === 'bare') cur.bare = true
		else if (line === 'locked' || line.startsWith('locked ')) cur.locked = true
		else if (line === 'prunable' || line.startsWith('prunable ')) cur.prunable = true
	}
	return entries
}

/**
 * Parse `git status --porcelain=v1 -z` into the paths that exist in the
 * working tree (added, modified, renamed, untracked); deletions are dropped.
 */
export function parseLiveStatusPaths(stdout: string): string[] {
	const tokens = stdout.split('\0')
	const out: string[] = []
	for (let i = 0; i < tokens.length; i++) {
		const tok = tokens[i]
		if (tok.length < 4) continue
		const x = tok[0]
		const y = tok[1]
		const p = tok.slice(3)
		// Renames and copies carry the original path as the next token.
		if (x === 'R' || x === 'C') i++
		if (x === 'D' || y === 'D' || x === '!') continue
		out.push(p)
	}
	return out
}

function realPath(p: string): string {
	try {
		return fs.realpathSync.native(p)
	} catch {
		return path.resolve(p)
	}
}

function isInside(child: string, parent: string): boolean {
	const rel = path.relative(parent, child)
	return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

// ─── Conflict simulation ─────────────────────────────────────────────────────

/**
 * Simulates stacking branches one at a time on top of `base`, entirely on
 * git objects (`merge-tree --write-tree` + `commit-tree`), so no working
 * tree, index or ref is touched.  Each clean layer is folded into a
 * throwaway merge commit that becomes the tip the next candidate is
 * checked against.  A conflicted layer is recorded but not folded in, so
 * later predictions aren't polluted by its conflict markers.
 *
 * Like {@link RebaseSuggestionService.predictConflict}, a merge of tips is a
 * proxy for the commit-by-commit rebase adoption performs; it catches the
 * common case of two branches editing the same lines.
 */
export class StackSimulation {

	private readonly _layers: string[] = []
	private readonly _folded = new Set<string>()
	private readonly _changed = new Map<string, Set<string>>()

	private constructor(
		private readonly _runner: IGitRunner,
		private readonly _cwd: string,
		private readonly _base: string,
		private _tip: string,
	) {}

	static async start(runner: IGitRunner, cwd: string, base: string): Promise<StackSimulation> {
		const tip = await resolveCommit(runner, cwd, base)
		if (!tip) {
			throw new Error(`Cannot resolve base "${base}" to a commit`)
		}
		return new StackSimulation(runner, cwd, base, tip)
	}

	/** Branches pushed so far, bottom first. */
	get layers(): readonly string[] {
		return this._layers
	}

	/** Predict placing `branch` on top of the layers pushed so far. */
	async predict(branch: string): Promise<LayerPrediction> {
		return (await this._mergeOnto(branch)).prediction
	}

	/** Place `branch` on top of the stack and return its prediction. */
	async push(branch: string): Promise<LayerPrediction> {
		const { prediction, tree } = await this._mergeOnto(branch)
		this._layers.push(branch)
		if (prediction.supported && !prediction.conflicted && tree) {
			const head = await resolveCommit(this._runner, this._cwd, branch)
			const { stdout, exitCode, stderr } = await this._runner.run(
				[
					'-c', 'user.name=GitBraid', '-c', 'user.email=gitbraid@localhost',
					'commit-tree', tree, '-p', this._tip, '-p', head ?? branch,
					'-m', 'gitbraid: adoption simulation',
				],
				{ cwd: this._cwd },
			)
			if (exitCode === 0 && stdout.trim()) {
				this._tip = stdout.trim()
				this._folded.add(branch)
			} else {
				log.warn(`StackSimulation: commit-tree failed for "${branch}": ${stderr}`)
			}
		}
		return prediction
	}

	private async _mergeOnto(branch: string): Promise<{ prediction: LayerPrediction, tree?: string }> {
		const unsupported = { prediction: { branch, supported: false, conflicted: false, files: [], conflictsWith: [] } }
		// merge-tree exits 1 for both "conflict" and "bad ref", so make sure
		// the ref resolves before reading anything into its exit code.
		const head = await resolveCommit(this._runner, this._cwd, branch)
		if (!head) return unsupported

		const { stdout, stderr, exitCode } = await this._runner.run(
			['merge-tree', '--write-tree', '--name-only', '--no-messages', this._tip, head],
			{ cwd: this._cwd },
		)
		const lines = stdout.split('\n')
		const tree = lines[0]?.trim()
		if (exitCode === 0) {
			return { prediction: { branch, supported: true, conflicted: false, files: [], conflictsWith: [] }, tree }
		}
		if (exitCode !== 1 || /unknown option|usage:/i.test(stderr)) {
			return unsupported
		}
		const files: string[] = []
		for (const l of lines.slice(1)) {
			const f = l.trim()
			if (f === '') break
			if (!files.includes(f)) files.push(f)
		}
		const conflictsWith = await this._attribute(files)
		return { prediction: { branch, supported: true, conflicted: true, files, conflictsWith } }
	}

	/** Which folded layers (or the base, failing that) touch any of `files`. */
	private async _attribute(files: string[]): Promise<string[]> {
		const culprits: string[] = []
		for (const layer of this._layers) {
			if (!this._folded.has(layer)) continue
			const changed = await this._changedFiles(layer)
			if (files.some((f) => changed.has(f))) culprits.push(layer)
		}
		return culprits.length > 0 ? culprits : [this._base]
	}

	private async _changedFiles(branch: string): Promise<Set<string>> {
		let set = this._changed.get(branch)
		if (!set) {
			const { stdout } = await this._runner.run(
				['diff', '--name-only', `${this._base}...${branch}`],
				{ cwd: this._cwd },
			)
			set = new Set(stdout.split('\n').map((s) => s.trim()).filter(Boolean))
			this._changed.set(branch, set)
		}
		return set
	}
}

async function resolveCommit(runner: IGitRunner, cwd: string, ref: string): Promise<string | undefined> {
	const { stdout, exitCode } = await runner.run(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd })
	return exitCode === 0 ? stdout.trim() : undefined
}

// ─── Adoption ────────────────────────────────────────────────────────────────

export class WorktreeAdopter {

	constructor(
		private readonly _config: ConfigService,
		private readonly _branchStack: BranchStackService,
		private readonly _root: string,
		private readonly _runner: IGitRunner = getDefaultGitRunner(),
	) {}

	/**
	 * Worktrees on a branch that aren't the primary checkout, aren't managed
	 * by GitBraid, and whose branch isn't already in the stack.
	 */
	async listExternalWorktrees(): Promise<ExternalWorktree[]> {
		const { stdout, exitCode, stderr } = await this._runner.run(['worktree', 'list', '--porcelain'], { cwd: this._root })
		if (exitCode !== 0) {
			throw new Error(`git worktree list failed: ${stderr.trim()}`)
		}
		const root = realPath(this._root)
		const managed = path.join(root, '.worktrees')
		const inStack = new Set(this._config.getStack().map((e) => e.name))

		const out: ExternalWorktree[] = []
		for (const e of parseWorktreeList(stdout)) {
			if (e.bare || e.prunable || !e.branch) continue
			const p = realPath(e.path)
			if (p === root || isInside(p, managed)) continue
			if (inStack.has(e.branch)) continue
			out.push({ branch: e.branch, path: e.path, dirty: await this._isDirty(e.path), locked: e.locked })
		}
		return out
	}

	simulate(base: string): Promise<StackSimulation> {
		return StackSimulation.start(this._runner, this._root, base)
	}

	/**
	 * Adopt `steps` in order.  Stops at the first failure — each layer is
	 * rebased onto the one before it, so carrying on past a broken layer
	 * would stack onto the wrong history.  Remaining steps are reported as
	 * skipped and their worktrees are left untouched.
	 */
	async adopt(
		steps: readonly AdoptStep[],
		color: string,
		onStep?: (branch: string, index: number) => void,
	): Promise<AdoptResult[]> {
		const results: AdoptResult[] = []
		let failed = false
		for (const [i, step] of steps.entries()) {
			if (failed) {
				results.push({ branch: step.worktree.branch, ok: false, skipped: true })
				continue
			}
			onStep?.(step.worktree.branch, i)
			const r = await this._adoptOne(step, color)
			results.push(r)
			if (!r.ok) failed = true
			log.info(`WorktreeAdopter: ${r.branch} → ${r.ok ? 'adopted' : 'failed'}${r.message ? ` (${r.message})` : ''}`)
		}
		return results
	}

	private async _adoptOne(step: AdoptStep, color: string): Promise<AdoptResult> {
		const { branch, path: oldPath, locked } = step.worktree
		const fail = (message: string, stash?: string): AdoptResult => ({ branch, ok: false, message, stash })

		if (locked) {
			return fail(`worktree at ${oldPath} is locked; unlock it with "git worktree unlock" first`)
		}

		// 1. Park uncommitted work so the rebase and removal see a clean tree.
		let stash: string | undefined
		if (await this._isDirty(oldPath)) {
			stash = await this._stash(oldPath, branch)
			if (!stash) return fail('could not stash uncommitted changes')
		}

		// 2. Rebase onto the layer below unless it's already an ancestor.
		const isAncestor = await this._runner.run(['merge-base', '--is-ancestor', step.base, branch], { cwd: oldPath })
		if (isAncestor.exitCode !== 0) {
			const rebase = await this._runner.run(['rebase', step.base], { cwd: oldPath })
			if (rebase.exitCode !== 0) {
				const unmerged = await this._runner.run(['diff', '--name-only', '--diff-filter=U'], { cwd: oldPath })
				await this._runner.run(['rebase', '--abort'], { cwd: oldPath })
				const files = unmerged.stdout.split('\n').map((s) => s.trim()).filter(Boolean)
				const restored = stash ? await this._restoreStash(oldPath, stash) : true
				return fail(
					`rebase onto "${step.base}" conflicts${files.length > 0 ? ` in ${files.join(', ')}` : ''}; ` +
					`branch left as it was in ${oldPath}`,
					restored ? undefined : stash,
				)
			}
		}

		// 3. Free the branch so GitBraid can check it out under .worktrees/.
		const remove = await this._runner.run(['worktree', 'remove', oldPath], { cwd: this._root })
		if (remove.exitCode !== 0) {
			const restored = stash ? await this._restoreStash(oldPath, stash) : true
			return fail(`could not remove worktree ${oldPath}: ${remove.stderr.trim()}`, restored ? undefined : stash)
		}

		// 4. Add to the stack, re-applying the stash before StackPopulator
		//    reads the new worktree.
		let applied = false
		let newDir: string | undefined
		try {
			await this._branchStack.addBranchToStack(branch, step.base, color, {
				prepareWorktree: async (dir) => {
					newDir = dir
					if (stash) applied = await this._applyStash(dir, stash)
				},
			})
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e)
			// Put the original worktree back so nothing is lost.
			const readd = newDir
				? { exitCode: 1, stderr: 'GitBraid worktree was created' }
				: await this._runner.run(['worktree', 'add', oldPath, branch], { cwd: this._root })
			const restored = readd.exitCode === 0 && (!stash || await this._restoreStash(oldPath, stash))
			return fail(`adding to stack failed: ${msg}`, restored ? undefined : stash)
		}

		if (!stash) return { branch, ok: true }
		if (!applied) {
			return {
				branch,
				ok: true,
				message: 'uncommitted changes did not re-apply cleanly; resolve them in the new worktree',
				stash,
			}
		}
		await this._dropStash(stash)
		if (newDir) await this._mirrorDirtyFiles(newDir, branch)
		return { branch, ok: true }
	}

	/**
	 * Copy the carried-over uncommitted files into the primary workspace and
	 * assign them to `branch`, so the workspace shows them and later saves
	 * route back to the right worktree.  Committed files are already handled
	 * by `StackPopulator`.
	 */
	private async _mirrorDirtyFiles(worktreeDir: string, branch: string): Promise<void> {
		const { stdout, exitCode } = await this._runner.run(
			['status', '--porcelain=v1', '-z', '--untracked-files=all'],
			{ cwd: worktreeDir },
		)
		if (exitCode !== 0) return
		for (const rel of parseLiveStatusPaths(stdout)) {
			const src = path.join(worktreeDir, rel)
			const dest = path.join(this._root, rel)
			try {
				if (!fs.statSync(src).isFile()) continue
				await fs.promises.mkdir(path.dirname(dest), { recursive: true })
				await fs.promises.copyFile(src, dest)
				await this._config.setAssignment(rel.replaceAll('\\', '/'), branch)
			} catch (e) {
				log.warn(`WorktreeAdopter: could not mirror ${rel}: ${e instanceof Error ? e.message : String(e)}`)
			}
		}
	}

	private async _isDirty(cwd: string): Promise<boolean> {
		const { stdout, exitCode } = await this._runner.run(['status', '--porcelain'], { cwd })
		return exitCode === 0 && stdout.trim().length > 0
	}

	/** Stash everything (untracked included) and return the stash commit. */
	private async _stash(cwd: string, branch: string): Promise<string | undefined> {
		const push = await this._runner.run(
			['stash', 'push', '--include-untracked', '-m', `gitbraid-adopt: ${branch}`],
			{ cwd },
		)
		if (push.exitCode !== 0) {
			log.warn(`WorktreeAdopter: stash failed in ${cwd}: ${push.stderr}`)
			return undefined
		}
		return resolveCommit(this._runner, cwd, 'stash@{0}')
	}

	private async _applyStash(cwd: string, stash: string): Promise<boolean> {
		const { exitCode, stderr } = await this._runner.run(['stash', 'apply', stash], { cwd })
		if (exitCode !== 0) log.warn(`WorktreeAdopter: stash apply ${stash} in ${cwd} failed: ${stderr}`)
		return exitCode === 0
	}

	private async _restoreStash(cwd: string, stash: string): Promise<boolean> {
		if (!await this._applyStash(cwd, stash)) return false
		await this._dropStash(stash)
		return true
	}

	/** `git stash drop` only takes `stash@{n}`, so find the entry's index. */
	private async _dropStash(stash: string): Promise<void> {
		const { stdout } = await this._runner.run(['stash', 'list', '--format=%H'], { cwd: this._root })
		const idx = stdout.split('\n').map((s) => s.trim()).indexOf(stash)
		if (idx >= 0) {
			await this._runner.run(['stash', 'drop', `stash@{${String(idx)}}`], { cwd: this._root })
		}
	}
}
