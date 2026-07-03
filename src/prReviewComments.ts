import { fetchJson } from './prHostAdapter'

/** A single line-level PR review comment, normalised across hosts. */
export interface PrReviewComment {
	/** Workspace-relative path (matches the PR diff's path verbatim). */
	path: string
	/** 1-based line number in the file's current (head) version. */
	line: number
	body: string
	author: string
	url?: string
}

/**
 * Fetch line-level review comments for a GitHub PR.
 *
 * GitHub's `pulls/{n}/comments` endpoint returns `line` (the comment's
 * position in the current head revision) as `null` once the surrounding
 * diff context has been edited away — those comments are skipped rather
 * than placed at a stale/incorrect line. `original_line` (the position at
 * comment time) is used as a fallback only while `line` is still present
 * in spirit (GitHub nulls both together once a comment goes fully stale).
 */
export async function fetchGithubPrReviewComments(
	owner: string,
	repo: string,
	prNumber: number,
	token: string,
): Promise<PrReviewComment[]> {
	const raw = await fetchJson<unknown[]>(
		`https://api.github.com/repos/${owner}/${repo}/pulls/${String(prNumber)}/comments?per_page=100`,
		{ token },
	)
	if (!Array.isArray(raw)) return []

	const out: PrReviewComment[] = []
	for (const item of raw) {
		if (typeof item !== 'object' || item === null) continue
		const c = item as Record<string, unknown>
		const path = typeof c.path === 'string' ? c.path : undefined
		const line = typeof c.line === 'number' ? c.line
			: typeof c.original_line === 'number' ? c.original_line
			: undefined
		const body = typeof c.body === 'string' ? c.body : undefined
		if (!path || line === undefined || !body) continue
		const user = c.user as Record<string, unknown> | undefined
		out.push({
			path,
			line,
			body,
			author: typeof user?.login === 'string' ? user.login : 'unknown',
			url: typeof c.html_url === 'string' ? c.html_url : undefined,
		})
	}
	return out
}
