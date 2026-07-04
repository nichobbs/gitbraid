import * as vscode from 'vscode'
import * as path from 'node:path'
import { log } from './channelLogger'
import { ConfigService } from './configService'
import type { PRAwareness } from './prAwareness'
import { parseGithubSlug } from './prHostAdapter'
import { fetchGithubPrReviewComments, PrReviewComment } from './prReviewComments'
import { IGitRunner, getDefaultGitRunner } from './gitRunner'

/**
 * Surfaces GitHub PR line-level review comments as native inline comment
 * threads (VS Code's `CommentController` API) on the file they were left
 * on, so reviewing feedback is visible without leaving the editor or
 * switching to the PR's web view.
 *
 * GitHub-only for now — comments are fetched via a stored
 * `gitbraid.githubToken` (the same token the Octokit PR adapter uses),
 * independent of which `PRHostAdapter` is active, since the review-comments
 * endpoint isn't part of the shared `PRHostAdapter` interface. Read-only:
 * no "start a new thread" affordance is offered (this mirrors the source
 * of truth — the PR on GitHub — rather than trying to be a second place to
 * write reviews from).
 *
 * Best-effort throughout: any failure (no token, network error, rate
 * limit) just means no comments are shown for that file — never an error
 * dialog interrupting the editing flow.
 */
export class PrReviewCommentsProvider implements vscode.Disposable {

	private readonly _controller: vscode.CommentController
	private readonly _threadsByFile = new Map<string, vscode.CommentThread[]>()
	private readonly _cache = new Map<number, { fetchedAt: number, comments: PrReviewComment[] }>()
	private static readonly CACHE_TTL_MS = 60_000
	/** Shown at most once per session — see `_commentsForPr`. */
	private _hintedNonGithubRemote = false

	private readonly _disposables: vscode.Disposable[] = []

	constructor(
		private readonly _config: ConfigService,
		private readonly _prAwareness: PRAwareness,
		private readonly _secrets: vscode.SecretStorage,
		private readonly _workspaceRoot: vscode.Uri,
		private readonly _runner: IGitRunner = getDefaultGitRunner(),
	) {
		this._controller = vscode.comments.createCommentController('gitbraid-pr-reviews', 'GitBraid: PR Review Comments')
		this._disposables.push(
			this._controller,
			vscode.workspace.onDidOpenTextDocument((doc) => { void this.refreshForFile(doc.uri) }),
			vscode.workspace.onDidSaveTextDocument((doc) => { void this.refreshForFile(doc.uri) }),
			vscode.workspace.onDidChangeConfiguration((e) => {
				if (e.affectsConfiguration('gitbraid.showPrReviewComments')) {
					for (const doc of vscode.workspace.textDocuments) void this.refreshForFile(doc.uri)
				}
			}),
		)
	}

	dispose(): void {
		for (const threads of this._threadsByFile.values()) {
			for (const t of threads) t.dispose()
		}
		this._threadsByFile.clear()
		this._cache.clear()
		for (const d of this._disposables) d.dispose()
	}

	/** Force-refresh every currently open editor — used after a manual "refresh" command. */
	async refreshAllOpenEditors(): Promise<void> {
		this._cache.clear()
		for (const doc of vscode.workspace.textDocuments) {
			await this.refreshForFile(doc.uri)
		}
	}

	/**
	 * Recompute comment threads for a single file. Safe to call for any
	 * URI — non-`file://` schemes, files outside the workspace, and files
	 * with no branch assignment or no known PR all resolve to "no threads"
	 * without error.
	 */
	async refreshForFile(uri: vscode.Uri): Promise<void> {
		this._clearThreadsFor(uri.fsPath)
		if (uri.scheme !== 'file') return
		if (!vscode.workspace.getConfiguration('gitbraid').get<boolean>('showPrReviewComments', true)) return

		const rel = path.relative(this._workspaceRoot.fsPath, uri.fsPath).replaceAll('\\', '/')
		if (rel.startsWith('..') || rel.split('/').includes('.worktrees')) return

		const branch = this._config.getAssignment(rel)
		if (!branch) return
		const prInfo = this._prAwareness.getForBranch(branch)
		if (!prInfo) return

		try {
			const comments = (await this._commentsForPr(prInfo.number)).filter((c) => c.path === rel)
			if (comments.length === 0) return

			const byLine = new Map<number, PrReviewComment[]>()
			for (const c of comments) {
				const list = byLine.get(c.line) ?? []
				list.push(c)
				byLine.set(c.line, list)
			}

			const threads: vscode.CommentThread[] = []
			for (const [line, group] of byLine) {
				const zeroBased = Math.max(line - 1, 0)
				const range = new vscode.Range(zeroBased, 0, zeroBased, 0)
				const thread = this._controller.createCommentThread(
					uri,
					range,
					group.map((c) => ({
						author: { name: c.author },
						body: new vscode.MarkdownString(c.body),
						mode: vscode.CommentMode.Preview,
					})),
				)
				thread.label = group.length === 1 ? 'PR review comment' : `${String(group.length)} PR review comments`
				thread.canReply = false
				thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed
				threads.push(thread)
			}
			this._threadsByFile.set(uri.fsPath, threads)
		} catch (e) {
			log.debug(`PrReviewCommentsProvider.refreshForFile: ${e instanceof Error ? e.message : String(e)}`)
		}
	}

	/**
	 * Inline PR review comments only speak GitHub's REST API today — a
	 * GitLab/Bitbucket/Azure DevOps user with a token stored would otherwise
	 * just silently see no comments with no indication why. Surface it once
	 * per session rather than on every file open.
	 */
	private _hintNonGithubRemoteOnce(originUrl: string): void {
		if (this._hintedNonGithubRemote) return
		const lower = originUrl.toLowerCase()
		const isKnownNonGithubHost = /gitlab|bitbucket\.org|dev\.azure\.com|visualstudio\.com/.test(lower)
		if (!isKnownNonGithubHost) return
		this._hintedNonGithubRemote = true
		void vscode.window.showInformationMessage(
			'GitBraid: inline PR review comments currently only support GitHub. ' +
			'This repository\'s remote looks like a different host, so no comments will be shown here.',
		)
	}

	private _clearThreadsFor(fsPath: string): void {
		const existing = this._threadsByFile.get(fsPath)
		if (!existing) return
		for (const t of existing) t.dispose()
		this._threadsByFile.delete(fsPath)
	}

	private async _commentsForPr(prNumber: number): Promise<PrReviewComment[]> {
		const cached = this._cache.get(prNumber)
		const now = Date.now()
		if (cached && now - cached.fetchedAt < PrReviewCommentsProvider.CACHE_TTL_MS) {
			return cached.comments
		}
		const token = await this._secrets.get('gitbraid.githubToken')
		if (!token) return []
		const r = await this._runner.run(['config', '--get', 'remote.origin.url'], { cwd: this._workspaceRoot.fsPath })
		if (r.exitCode !== 0) return []
		const originUrl = r.stdout.trim()
		const slug = parseGithubSlug(originUrl)
		if (!slug) {
			this._hintNonGithubRemoteOnce(originUrl)
			return []
		}
		const comments = await fetchGithubPrReviewComments(slug.owner, slug.repo, prNumber, token)
		this._cache.set(prNumber, { fetchedAt: now, comments })
		return comments
	}
}
