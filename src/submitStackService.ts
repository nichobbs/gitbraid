import * as vscode from 'vscode'
import { log } from './channelLogger'
import { ConfigService } from './configService'
import { BranchStackService, worktreePath } from './branchStackService'
import { IGitRunner, getDefaultGitRunner } from './gitRunner'
import {
	PRHostAdapter,
	PRMetadata,
	renderStackBlock,
	mergeStackBlock,
	StackBodyEntry,
} from './prHostAdapter'

export interface SubmitStackResult {
	branch: string
	ok: boolean
	/** undefined while skipped or failed before PR creation/update. */
	prNumber?: number
	action: 'pushed+created' | 'pushed+updated' | 'pushed+unchanged' | 'skipped' | 'failed'
	message?: string
}

export interface SubmitStackOptions {
	remote?: string
	/** Create the PRs as draft (default false). */
	draft?: boolean
	/** Skip body rewriting even if the body would otherwise be updated. */
	skipBodyRewrite?: boolean
}

/**
 * Orchestrates pushing every stack branch and creating/updating the matching
 * PRs via a {@link PRHostAdapter}.
 *
 * Iteration order is the stack's natural (base-first) order so each PR's
 * `base` is already present on the host before its child is submitted.
 *
 * On success the branch's `prNumber` is cached in ConfigService so the UI
 * can display it without re-querying the host.
 */
export class SubmitStackService {

	constructor(
		private readonly _config: ConfigService,
		private readonly _branchStack: BranchStackService,
		private readonly _workspaceRoot: vscode.Uri,
		private readonly _adapter: PRHostAdapter,
		private readonly _runner: IGitRunner = getDefaultGitRunner(),
	) {}

	async submit(options: SubmitStackOptions = {}): Promise<SubmitStackResult[]> {
		const stack = this._config.getStack()
		if (stack.length === 0) return []

		const remote = options.remote ?? 'origin'
		const results: SubmitStackResult[] = []

		// Collect current PRs once so body rewriting sees a consistent view.
		const byBranch = new Map<string, PRMetadata>()
		try {
			const all = await this._adapter.listOpen()
			for (const pr of all) byBranch.set(pr.head, pr)
		} catch (e) {
			log.warn('SubmitStackService: listOpen failed — ' + errMsg(e))
		}

		await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: `GitBraid: submitting ${String(stack.length)} branch(es)…`,
				cancellable: false,
			},
			async (progress) => {
				for (let i = 0; i < stack.length; i++) {
					const entry = stack[i]
					progress.report({
						message: `${String(i + 1)}/${String(stack.length)} ${entry.name}`,
					})
					const result = await this._submitOne(entry.name, entry.base, remote, options, byBranch)
					results.push(result)
					if (result.prNumber !== undefined) {
						try { await this._config.setPrNumber(entry.name, result.prNumber) } catch { /* non-fatal */ }
					}
				}
			},
		)

		if (!options.skipBodyRewrite) {
			await this._rewriteBodies(results)
		}
		return results
	}

	private async _submitOne(
		branch: string,
		base: string,
		remote: string,
		opts: SubmitStackOptions,
		existing: Map<string, PRMetadata>,
	): Promise<SubmitStackResult> {
		if (!this._branchStack.worktreeExists(branch)) {
			return { branch, ok: true, action: 'skipped', message: 'no worktree' }
		}
		const wt = worktreePath(this._workspaceRoot, branch).fsPath

		const push = await this._runner.run(['push', '-u', remote, branch], { cwd: wt })
		if (push.exitCode !== 0) {
			return {
				branch,
				ok: false,
				action: 'failed',
				message: push.stderr.trim() || `git push exited ${String(push.exitCode)}`,
			}
		}

		const currentPr = existing.get(branch)
		if (!currentPr) {
			try {
				const created = await this._adapter.createPR({
					head: branch,
					base,
					title: branch.replace(/[-_/]/g, ' ').trim(),
					body: '',
					draft: opts.draft === true,
				})
				existing.set(branch, created)
				return { branch, ok: true, prNumber: created.number, action: 'pushed+created' }
			} catch (e) {
				return { branch, ok: false, action: 'failed', message: errMsg(e) }
			}
		}

		if (currentPr.base !== base) {
			try {
				const updated = await this._adapter.updatePR(currentPr.number, { base })
				existing.set(branch, updated)
				return { branch, ok: true, prNumber: updated.number, action: 'pushed+updated' }
			} catch (e) {
				return { branch, ok: false, prNumber: currentPr.number, action: 'failed', message: errMsg(e) }
			}
		}

		return { branch, ok: true, prNumber: currentPr.number, action: 'pushed+unchanged' }
	}

	/**
	 * Second pass: once every branch has a PR number we know, rewrite each
	 * body with the "stacked PRs" block so readers can navigate sideways.
	 */
	private async _rewriteBodies(results: SubmitStackResult[]): Promise<void> {
		const entries: StackBodyEntry[] = this._config.getStack().map((e) => ({
			name: e.name,
			prNumber: results.find((r) => r.branch === e.name)?.prNumber ?? e.prNumber,
		}))
		for (const r of results) {
			if (!r.ok || r.prNumber === undefined) continue
			const block = renderStackBlock(entries, r.branch)
			try {
				const current = await this._adapter.getPR(r.branch)
				if (!current) continue
				const nextBody = mergeStackBlock(current.body, block)
				if (nextBody === current.body) continue
				await this._adapter.updatePR(r.prNumber, { body: nextBody })
			} catch (e) {
				log.warn(`SubmitStackService._rewriteBodies(${r.branch}): ${errMsg(e)}`)
			}
		}
	}
}

function errMsg(e: unknown): string {
	return e instanceof Error ? e.message : String(e)
}
