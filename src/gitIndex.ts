import * as fs from 'node:fs'
import * as path from 'node:path'
import { log } from './channelLogger'
import type { IGitRunner } from './gitRunner'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function excludeFilePath(workspaceRoot: string): string {
	return path.join(workspaceRoot, '.git', 'info', 'exclude')
}

/** Convert a workspace-relative path to a root-anchored gitignore pattern. */
function excludePattern(relativePath: string): string {
	return '/' + relativePath.replaceAll('\\', '/')
}

function addToExclude(workspaceRoot: string, relativePath: string): void {
	const excludePath = excludeFilePath(workspaceRoot)
	const pattern = excludePattern(relativePath)
	const marker = `# gitbraid: ${relativePath}`

	let content = ''
	try {
		content = fs.readFileSync(excludePath, 'utf8')
	} catch {
		// File does not exist yet; we will create it below.
	}

	if (content.includes(pattern)) {
		return // Already present — nothing to do.
	}

	const addition = `${marker}\n${pattern}\n`
	const separator = content === '' || content.endsWith('\n') ? '' : '\n'
	fs.mkdirSync(path.dirname(excludePath), { recursive: true })
	fs.writeFileSync(excludePath, content + separator + addition, 'utf8')
}

function removeFromExclude(workspaceRoot: string, relativePath: string): void {
	const excludePath = excludeFilePath(workspaceRoot)
	const pattern = excludePattern(relativePath)
	const marker = `# gitbraid: ${relativePath}`

	let content: string
	try {
		content = fs.readFileSync(excludePath, 'utf8')
	} catch {
		return // Nothing to remove.
	}

	const lines = content.split('\n')
	const filtered = lines.filter((line) => line !== pattern && line !== marker)
	if (filtered.length !== lines.length) {
		fs.writeFileSync(excludePath, filtered.join('\n'), 'utf8')
	}
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Hide an assigned file from the main workspace's `git status`.
 *
 * - If the file is **tracked** in the main repo's index, applies
 *   `git update-index --skip-worktree` so git ignores local modifications.
 * - If the file is **untracked** (brand-new, never committed to main), adds a
 *   root-anchored pattern to `.git/info/exclude` so it does not appear as an
 *   untracked file.
 *
 * Both operations are idempotent — calling again for an already-hidden file
 * is safe.
 *
 * @param runner        Git runner (uses `shell: false` — no injection risk).
 * @param workspaceRoot Absolute path to the main workspace / repo root.
 * @param relativePath  Workspace-relative POSIX path to the file.
 */
export async function hideAssignedFile(
	runner: IGitRunner,
	workspaceRoot: string,
	relativePath: string,
): Promise<void> {
	try {
		const { exitCode } = await runner.run(
			['ls-files', '--error-unmatch', '--', relativePath],
			{ cwd: workspaceRoot },
		)

		if (exitCode === 0) {
			// Tracked — skip-worktree hides local modifications from git status.
			await runner.run(
				['update-index', '--skip-worktree', '--', relativePath],
				{ cwd: workspaceRoot },
			)
			log.info(`gitIndex: skip-worktree applied to "${relativePath}"`)
		} else {
			// Untracked — .git/info/exclude suppresses the "??" entry.
			addToExclude(workspaceRoot, relativePath)
			log.info(`gitIndex: added "${relativePath}" to .git/info/exclude`)
		}
	} catch (e) {
		// Non-fatal: worst case the file stays visible in git status on main.
		log.warn(`gitIndex.hideAssignedFile("${relativePath}"): ${e instanceof Error ? e.message : String(e)}`)
	}
}

/**
 * Reverse the effects of {@link hideAssignedFile} when a file is unassigned
 * or its branch is removed from the stack.
 *
 * Removes the `--skip-worktree` flag (no-op if not set) and strips any
 * `.git/info/exclude` entry added by this module.
 */
export async function unhideAssignedFile(
	runner: IGitRunner,
	workspaceRoot: string,
	relativePath: string,
): Promise<void> {
	try {
		// --no-skip-worktree is a no-op if the bit was never set.
		await runner.run(
			['update-index', '--no-skip-worktree', '--', relativePath],
			{ cwd: workspaceRoot },
		)
		removeFromExclude(workspaceRoot, relativePath)
		log.info(`gitIndex: unhidden "${relativePath}"`)
	} catch (e) {
		log.warn(`gitIndex.unhideAssignedFile("${relativePath}"): ${e instanceof Error ? e.message : String(e)}`)
	}
}
