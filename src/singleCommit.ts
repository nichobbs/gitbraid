import * as vscode from 'vscode'
import { log } from './channelLogger'
import { ConfigService } from './configService'
import { IGitRunner, getDefaultGitRunner } from './gitRunner'

/**
 * Plan 03 enforcement — helpers that turn the persisted `singleCommit`
 * branch flag into actual commit-amend / push-time-invariant behaviour.
 *
 * Kept in its own module (as opposed to inlined in `BranchScmProvider` or
 * `SubmitStackService`) so both entry points share one implementation and
 * tests can exercise the helpers via a `FakeGitRunner` without booting
 * VS Code.
 */

/** Does the given branch carry the `singleCommit: true` flag in config? */
export function isSingleCommitBranch(config: ConfigService, branchName: string): boolean {
	return config.getBranch(branchName)?.singleCommit === true
}

/**
 * Count commits in `cwd`'s HEAD that are not in `parent`.  Returns
 * `undefined` if git fails (e.g. `parent` doesn't exist locally), so
 * callers can fall back to "skip the invariant check".
 */
export async function countCommitsAheadOf(
	runner: IGitRunner,
	cwd: string,
	parent: string,
): Promise<number | undefined> {
	const { exitCode, stdout } = await runner.run(
		['rev-list', '--count', `${parent}..HEAD`],
		{ cwd },
	)
	if (exitCode !== 0) return undefined
	const n = Number.parseInt(stdout.trim(), 10)
	return Number.isNaN(n) ? undefined : n
}

/**
 * Decide whether a `git commit` on a single-commit branch should `--amend`
 * the existing HEAD instead of appending a new commit.
 *
 *   ahead === 0   → normal commit (this is the first commit on the branch)
 *   ahead  >= 1   → amend
 *   undefined     → default to normal commit (can't tell; err on the safe
 *                   side of "don't rewrite history we might not own")
 */
export async function shouldAmendForSingleCommit(
	runner: IGitRunner,
	cwd: string,
	parent: string,
): Promise<boolean> {
	const ahead = await countCommitsAheadOf(runner, cwd, parent)
	return ahead !== undefined && ahead >= 1
}

/** Result of validating a branch against the single-commit invariant. */
export interface SingleCommitValidation {
	branch: string
	/** Number of commits the branch is ahead of its parent (or `undefined`). */
	ahead: number | undefined
	/**
	 * `true` if the branch is `singleCommit: true` AND has more than one
	 * commit past its parent.  Callers decide how to recover (prompt the
	 * user to squash, abort the push, etc.).
	 */
	violated: boolean
}

/** Run `validateBranch` across every single-commit branch in the stack. */
export async function validateStack(
	runner: IGitRunner,
	config: ConfigService,
	worktreeDirOf: (branch: string) => string | undefined,
): Promise<SingleCommitValidation[]> {
	const results: SingleCommitValidation[] = []
	for (const entry of config.getStack()) {
		if (entry.singleCommit !== true) continue
		const cwd = worktreeDirOf(entry.name)
		if (!cwd) continue
		const ahead = await countCommitsAheadOf(runner, cwd, entry.base)
		results.push({
			branch: entry.name,
			ahead,
			violated: ahead !== undefined && ahead > 1,
		})
	}
	return results
}

/**
 * Squash HEAD down to a single commit on `parent` with `message`.  Used as
 * the "Squash now" recovery action when a `singleCommit: true` branch has
 * accumulated more than one commit past its parent.
 *
 * Runs `git reset --soft <parent>` followed by `git commit -m <message>`
 * in one sequence, so either both happen or neither does (reset failures
 * short-circuit before the commit).
 */
export async function squashToOne(
	runner: IGitRunner,
	cwd: string,
	parent: string,
	message: string,
): Promise<{ ok: boolean; error?: string }> {
	const reset = await runner.run(['reset', '--soft', parent], { cwd })
	if (reset.exitCode !== 0) {
		return { ok: false, error: reset.stderr || `git reset exited ${String(reset.exitCode)}` }
	}
	const commit = await runner.run(['commit', '-m', message], { cwd })
	if (commit.exitCode !== 0) {
		return { ok: false, error: commit.stderr || `git commit exited ${String(commit.exitCode)}` }
	}
	return { ok: true }
}

// ─── VS Code integration helpers ───────────────────────────────────────────

/**
 * Prompt the user before amending on a single-commit branch, honouring the
 * `gitbraid.singleCommit.confirmAmend` setting so experienced users can
 * silence the confirmation.  Returns `true` if the caller should proceed
 * with the amend, `false` if the user cancelled.
 */
export async function confirmAmend(
	branchName: string,
	options: { runnerForTest?: IGitRunner } = {},
): Promise<boolean> {
	void options // reserved — future parity with confirmSquash
	const cfg = vscode.workspace.getConfiguration('gitbraid')
	if (cfg.get<boolean>('singleCommit.confirmAmend', true) !== true) return true

	const choice = await vscode.window.showWarningMessage(
		`Branch "${branchName}" is single-commit mode — amending the existing commit.  Continue?`,
		{ modal: true },
		'Amend',
		"Don't ask again",
	)
	if (choice === undefined) return false
	if (choice === "Don't ask again") {
		await cfg.update('singleCommit.confirmAmend', false, vscode.ConfigurationTarget.Global)
	}
	return true
}

/**
 * Prompt the user with a summary of every violated branch and offer to
 * squash each one to a single commit before push.  Returns the list of
 * branches the user explicitly approved to squash; everything else is left
 * alone for the caller to abort / proceed with.
 */
export async function promptSquashForViolations(
	violations: SingleCommitValidation[],
): Promise<string[]> {
	const violated = violations.filter((v) => v.violated)
	if (violated.length === 0) return []
	const names = violated.map((v) => `"${v.branch}" (${String(v.ahead ?? '?')} commits)`).join(', ')
	const choice = await vscode.window.showWarningMessage(
		`Single-commit mode violated: ${names}.  Squash each to a single commit?`,
		{ modal: true },
		'Squash all',
		'Cancel push',
	)
	return choice === 'Squash all' ? violated.map((v) => v.branch) : []
}

/** Convenience: the default runner, for code paths that don't inject one. */
export function defaultRunner(): IGitRunner {
	return getDefaultGitRunner()
}

log.trace?.('singleCommit helpers loaded')
