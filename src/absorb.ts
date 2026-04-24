import * as vscode from 'vscode'
import { log } from './channelLogger'
import { IGitRunner, getDefaultGitRunner } from './gitRunner'
import { DiffEngine, DiffHunk } from './diffEngine'

/**
 * Plan 04 — `gitbraid.absorbHunks`.
 *
 * Given uncommitted edits in a file (or group of files), find the commit in
 * the owning branch's history that last touched each hunk's lines and fold
 * the hunk into that commit via `git commit --fixup` + `git rebase --autosquash`.
 *
 * The heuristic for "owning commit" is the dominant `git blame` attribution
 * across the hunk's new-file line range.
 */

export interface AbsorbPlanHunk {
	relativePath: string
	hunk: DiffHunk
	targetSha: string | undefined
	/** If the blame was ambiguous we leave `targetSha` undefined and explain here. */
	reason?: string
}

export interface AbsorbPlan {
	branch: string
	worktreeDir: string
	/** One entry per hunk in the file list; undefined `targetSha` means unresolved. */
	hunks: AbsorbPlanHunk[]
	/** Commits absorb intends to rewrite — present in topological (oldest-first) order. */
	targets: string[]
}

export interface AbsorbSummary {
	planned: number
	absorbed: number
	skipped: number
	errors: Array<{ path: string, message: string }>
	rebaseOk: boolean
}

export interface AbsorbOptions {
	/** Commit SHA (exclusive) that bounds the rewritable range — usually the parent branch tip. */
	mergeBase: string
	/** Allow fixing up commits that have already been pushed.  Default false. */
	allowPushed?: boolean
	/** When true, build the plan but don't mutate anything.  Default false. */
	dryRun?: boolean
}

/**
 * Core absorb routine.  Takes explicit file paths (caller resolves them from
 * the active editor or the tree view) and an options bag; returns a plan and,
 * when not in dry-run mode, an execution summary.
 */
export async function absorbFiles(
	worktreeDir: string,
	branch: string,
	relativePaths: string[],
	diffEngine: DiffEngine,
	opts: AbsorbOptions,
	runner: IGitRunner = getDefaultGitRunner(),
): Promise<{ plan: AbsorbPlan, summary: AbsorbSummary | undefined }> {
	// 1. Collect hunks per file.
	const planHunks: AbsorbPlanHunk[] = []
	for (const rel of relativePaths) {
		const hunks = await diffEngine.getHunksForFile(worktreeDir, rel)
		for (const h of hunks) {
			planHunks.push({ relativePath: rel, hunk: h, targetSha: undefined })
		}
	}

	// 2. Resolve each hunk to a dominant commit via blame.
	for (const entry of planHunks) {
		const target = await dominantCommitForHunk(
			worktreeDir,
			entry.relativePath,
			entry.hunk,
			opts.mergeBase,
			runner,
		)
		if (target.kind === 'ok') {
			entry.targetSha = target.sha
		} else {
			entry.reason = target.reason
		}
	}

	// 3. Compute the ordered list of commits we'll fix up (oldest first).
	const targetOrder = await orderCommitsByHistory(worktreeDir, planHunks, runner)

	const plan: AbsorbPlan = {
		branch,
		worktreeDir,
		hunks: planHunks,
		targets: targetOrder,
	}

	if (opts.dryRun) {
		return { plan, summary: undefined }
	}

	// 4. Safeguard: bail if any target is already pushed unless override.
	if (!opts.allowPushed) {
		const pushed = await firstPushedCommit(worktreeDir, targetOrder, runner)
		if (pushed) {
			return {
				plan,
				summary: {
					planned: planHunks.length,
					absorbed: 0,
					skipped: planHunks.length,
					errors: [{ path: '(all)', message: `Target commit ${pushed} is already pushed; enable gitbraid.absorbRewritePushed to override.` }],
					rebaseOk: false,
				},
			}
		}
	}

	// 5. Execute: for each target commit, stage only its hunks and
	//    `git commit --fixup=<sha>`.  Then autosquash-rebase.
	const summary: AbsorbSummary = {
		planned: planHunks.length,
		absorbed: 0,
		skipped: 0,
		errors: [],
		rebaseOk: false,
	}

	for (const target of targetOrder) {
		const group = planHunks.filter((h) => h.targetSha === target)
		if (group.length === 0) continue
		try {
			await stageHunks(worktreeDir, group, runner)
			const commit = await runner.run(
				['commit', `--fixup=${target}`, '--no-verify'],
				{ cwd: worktreeDir },
			)
			if (commit.exitCode !== 0) {
				summary.errors.push({ path: '(fixup)', message: commit.stderr.trim() || 'git commit failed' })
				continue
			}
			summary.absorbed += group.length
		} catch (e) {
			summary.errors.push({ path: '(stage)', message: e instanceof Error ? e.message : String(e) })
		}
	}

	// Unresolved hunks are kept in the worktree as ordinary edits.
	summary.skipped = planHunks.filter((h) => h.targetSha === undefined).length

	if (summary.absorbed > 0) {
		const rebase = await runner.run(
			['-c', 'sequence.editor=:', 'rebase', '--autosquash', '--autostash', opts.mergeBase],
			{ cwd: worktreeDir },
		)
		if (rebase.exitCode !== 0) {
			summary.rebaseOk = false
			summary.errors.push({ path: '(rebase)', message: rebase.stderr.trim() || 'rebase --autosquash failed' })
		} else {
			summary.rebaseOk = true
		}
	} else {
		summary.rebaseOk = true
	}

	log.info(`absorbFiles: ${JSON.stringify(summary)}`)
	return { plan, summary }
}

// ─── Blame / attribution heuristic ───────────────────────────────────────────

type DominantResult =
	| { kind: 'ok', sha: string }
	| { kind: 'unresolved', reason: string }

/**
 * Call `git blame` over the new-file line range of `hunk` and pick the commit
 * that authored the most lines.  A majority of >=51% wins outright; otherwise
 * we require at least a 2x margin over the runner-up to avoid silently
 * attributing ambiguous hunks.  Commits at-or-older than `mergeBase` are
 * excluded — we never rewrite history outside the branch's range.
 */
export async function dominantCommitForHunk(
	worktreeDir: string,
	relativePath: string,
	hunk: DiffHunk,
	mergeBase: string,
	runner: IGitRunner = getDefaultGitRunner(),
): Promise<DominantResult> {
	if (hunk.endLine < hunk.startLine) {
		// Pure deletion — blame the deleted lines in HEAD by diffing-based blame
		// would need an old-line range we don't track; treat as unresolved.
		return { kind: 'unresolved', reason: 'pure-deletion hunk — blame not supported' }
	}
	const range = `${String(hunk.startLine)},${String(hunk.endLine)}`
	const r = await runner.run(
		['blame', '--line-porcelain', '-L', range, '--', relativePath],
		{ cwd: worktreeDir },
	)
	if (r.exitCode !== 0) {
		return { kind: 'unresolved', reason: r.stderr.trim() || 'git blame failed' }
	}
	const shas = parseBlameShas(r.stdout)
	if (shas.length === 0) return { kind: 'unresolved', reason: 'blame produced no output' }

	const counts = new Map<string, number>()
	for (const sha of shas) counts.set(sha, (counts.get(sha) ?? 0) + 1)

	// Filter: no zero sha (uncommitted), no sha at-or-older than mergeBase.
	const filtered: Array<[string, number]> = []
	for (const [sha, n] of counts) {
		if (/^0+$/.test(sha)) continue
		if (await isAncestor(runner, worktreeDir, sha, mergeBase)) continue
		filtered.push([sha, n])
	}
	if (filtered.length === 0) return { kind: 'unresolved', reason: 'no in-branch commits for this hunk' }
	filtered.sort((a, b) => b[1] - a[1])

	const [topSha, topCount] = filtered[0]
	const runner2 = filtered[1]?.[1] ?? 0
	// A strict majority (>50% of the blamed lines) wins outright.  Otherwise
	// we require at least a 2x margin over the runner-up — a 50/50 split is
	// intentionally unresolved so we don't silently pick one side.
	if (topCount > shas.length / 2 || topCount >= runner2 * 2) {
		return { kind: 'ok', sha: topSha }
	}
	return { kind: 'unresolved', reason: 'blame is ambiguous — no dominant commit' }
}

/**
 * Parse `git blame --line-porcelain` stdout and return the full commit SHA
 * attributed to each line in order.  The porcelain format puts the sha on
 * the first line of each block, followed by a variable number of header
 * lines, then the content line starting with a tab.
 */
export function parseBlameShas(stdout: string): string[] {
	const out: string[] = []
	const lines = stdout.split('\n')
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]
		const m = /^([0-9a-f]{40}) /.exec(line)
		if (m) out.push(m[1])
	}
	return out
}

/** Returns true iff `sha` is an ancestor of (or equal to) `maybeAncestor`. */
async function isAncestor(
	runner: IGitRunner,
	worktreeDir: string,
	sha: string,
	maybeAncestor: string,
): Promise<boolean> {
	const r = await runner.run(
		['merge-base', '--is-ancestor', sha, maybeAncestor],
		{ cwd: worktreeDir },
	)
	return r.exitCode === 0
}

/**
 * Given the set of plan hunks, return the set of distinct target SHAs in the
 * order they appear on the branch (oldest first — so autosquash produces the
 * correct final tree).
 */
async function orderCommitsByHistory(
	worktreeDir: string,
	hunks: AbsorbPlanHunk[],
	runner: IGitRunner,
): Promise<string[]> {
	const unique = new Set<string>()
	for (const h of hunks) if (h.targetSha) unique.add(h.targetSha)
	if (unique.size === 0) return []

	const r = await runner.run(['log', '--format=%H', 'HEAD'], { cwd: worktreeDir })
	if (r.exitCode !== 0) return [...unique]
	const order = r.stdout.split('\n').map((s) => s.trim()).filter(Boolean)
	// Walk the log newest→oldest and collect hits; reverse so oldest-first.
	const hits: string[] = []
	for (const sha of order) if (unique.has(sha)) hits.push(sha)
	return hits.reverse()
}

/**
 * Detect whether any target commit is already pushed to a remote.  Returns
 * the first-found pushed SHA or undefined if none are pushed.
 */
async function firstPushedCommit(
	worktreeDir: string,
	targets: string[],
	runner: IGitRunner,
): Promise<string | undefined> {
	for (const sha of targets) {
		const r = await runner.run(
			['branch', '-r', '--contains', sha],
			{ cwd: worktreeDir },
		)
		if (r.exitCode === 0 && r.stdout.trim().length > 0) return sha
	}
	return undefined
}

/**
 * Reset the index to HEAD then stage exactly the hunks in `group` via
 * `git apply --cached`.  The patch text is what {@link DiffEngine} produced,
 * so it's already self-contained with file headers.
 */
async function stageHunks(
	worktreeDir: string,
	group: AbsorbPlanHunk[],
	runner: IGitRunner,
): Promise<void> {
	await runner.run(['reset', 'HEAD'], { cwd: worktreeDir })
	// Group patches per file so a single `git apply --cached` call handles
	// every hunk for that file.  `DiffHunk.patch` already contains the file
	// header, so concatenation produces a valid diff.
	const byFile = new Map<string, string[]>()
	for (const entry of group) {
		const bucket = byFile.get(entry.relativePath) ?? []
		bucket.push(entry.hunk.patch)
		byFile.set(entry.relativePath, bucket)
	}
	for (const [, patches] of byFile) {
		const combined = patches.join('')
		const r = await runner.run(['apply', '--cached', '--unidiff-zero', '-'], {
			cwd: worktreeDir,
			input: combined,
		})
		if (r.exitCode !== 0) {
			throw new Error(r.stderr.trim() || 'git apply --cached failed')
		}
	}
}

// ─── VS Code facade ──────────────────────────────────────────────────────────

/**
 * Small wrapper around {@link absorbFiles} that surfaces the result as a
 * toast + logs errors to the channel.  Called from the command module.
 */
export async function runAbsorbUi(
	worktreeDir: string,
	branch: string,
	relativePaths: string[],
	diffEngine: DiffEngine,
	opts: AbsorbOptions,
): Promise<void> {
	const { plan, summary } = await absorbFiles(
		worktreeDir,
		branch,
		relativePaths,
		diffEngine,
		opts,
	)
	if (opts.dryRun) {
		const lines = plan.hunks.map((h) => {
			const pretty = `${h.relativePath}:${String(h.hunk.startLine)}-${String(h.hunk.endLine)}`
			if (h.targetSha) return `✓ ${pretty} → ${h.targetSha.slice(0, 7)}`
			return `? ${pretty} (${h.reason ?? 'unresolved'})`
		})
		await vscode.window.showInformationMessage(
			`GitBraid absorb plan for "${branch}":\n${lines.join('\n')}`,
			{ modal: true },
		)
		return
	}
	if (!summary) return
	const msg = `GitBraid absorb: ${String(summary.absorbed)} hunk(s) absorbed, ` +
		`${String(summary.skipped)} skipped, ${String(summary.errors.length)} error(s)` +
		(summary.rebaseOk ? '' : ' — rebase failed; worktree may be mid-rebase')
	if (summary.errors.length === 0) {
		await vscode.window.showInformationMessage(msg)
	} else {
		for (const err of summary.errors) log.error(`absorb: ${err.path}: ${err.message}`)
		const pick = await vscode.window.showWarningMessage(msg, 'Open Output')
		if (pick === 'Open Output') log.show()
	}
}
