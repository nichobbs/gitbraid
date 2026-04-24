import * as vscode from 'vscode'
import { IGitRunner, getDefaultGitRunner } from './gitRunner'
import { log } from './channelLogger'

/**
 * Plan 06 — content provider for the `gitbraid-commit:` scheme used when a
 * {@link CommitNode} in the tree is clicked.  Runs `git show --patch <sha>`
 * inside the branch's worktree and surfaces the output as a read-only
 * editor document so the user gets a proper scrollable diff with VS Code
 * syntax colouring (the `.diff` path suffix triggers the language mode).
 *
 * URI shape:
 *
 *   gitbraid-commit://<hex-encoded-worktreeDir>/<sha>.diff
 *
 * The worktree path is hex-encoded so the authority component doesn't
 * collide with the URI syntax rules (slashes, spaces, etc.).
 */

export const COMMIT_SCHEME = 'gitbraid-commit'

export class CommitDetailProvider implements vscode.TextDocumentContentProvider {

	private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>()
	readonly onDidChange = this._onDidChange.event

	constructor(private readonly _runner: IGitRunner = getDefaultGitRunner()) {}

	async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
		const parsed = parseCommitUri(uri)
		if (!parsed) return `(invalid commit URI: ${uri.toString()})\n`
		const { worktreeDir, sha } = parsed
		const result = await this._runner.run(
			['show', '--patch', '--color=never', sha],
			{ cwd: worktreeDir },
		)
		if (result.exitCode !== 0) {
			log.warn(`CommitDetailProvider: git show ${sha} failed: ${result.stderr}`)
			return `# git show ${sha} failed (exit ${String(result.exitCode)})\n${result.stderr}\n`
		}
		return result.stdout
	}

	dispose(): void {
		this._onDidChange.dispose()
	}
}

/** Build a `gitbraid-commit://…` URI for a commit in a given worktree. */
export function buildCommitUri(worktreeDir: string, sha: string): vscode.Uri {
	const authority = Buffer.from(worktreeDir, 'utf-8').toString('hex')
	return vscode.Uri.parse(`${COMMIT_SCHEME}://${authority}/${sha}.diff`)
}

export function parseCommitUri(uri: vscode.Uri): { worktreeDir: string; sha: string } | undefined {
	if (uri.scheme !== COMMIT_SCHEME) return undefined
	const authority = uri.authority
	if (!authority) return undefined
	let worktreeDir: string
	try {
		worktreeDir = Buffer.from(authority, 'hex').toString('utf-8')
	} catch {
		return undefined
	}
	const match = /^\/([0-9a-f]+)\.diff$/.exec(uri.path)
	if (!match) return undefined
	return { worktreeDir, sha: match[1] }
}
