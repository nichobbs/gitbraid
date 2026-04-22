import * as vscode from 'vscode'
import { log } from './channelLogger'
import child_process from 'node:child_process'
import path from 'node:path'
import { GitError } from './errors'
import { IGitRunner, getDefaultGitRunner } from './gitRunner'


interface WorktreeStatus {
	name: string
	path: string
	uri: vscode.Uri
	refName: string
	refSha: string
	branch: string
	locked: boolean
}

/**
 * Strip anything that looks like a credential (user:pass@ prefix, PAT,
 * Authorization header) from a string before logging.  Defensive — we don't
 * currently run operations against remote URLs here, but worktree add with a
 * custom URL, or future push/pull features, could expose tokens otherwise.
 */
function redactCredentials (s: string): string {
	return s
		.replaceAll(/(https?:\/\/)[^:@/\s]+:[^@/\s]+@/g, '$1***:***@')
		.replaceAll(/(Authorization:\s*)\S+/gi, '$1***')
		.replaceAll(/\b(ghp_|github_pat_)\w{20,}\b/g, '***')
}


class Git {

	private readonly _runner: IGitRunner

	constructor(runner?: IGitRunner) {
		this._runner = runner ?? getDefaultGitRunner()
		this.worktree = new Worktree(this._runner, () => this._defaultCwd())
	}

	private _defaultCwd(): string {
		return vscode.workspace.workspaceFolders![0].uri.fsPath
	}

	/**
	 * Spawn-based runner for all git calls.  Uses `IGitRunner` so tests can
	 * inject a fake.  Never passes arguments through a shell.
	 */
	private async _run(args: string[], cwd?: string | vscode.Uri): Promise<string> {
		const cwdPath = cwd instanceof vscode.Uri ? cwd.fsPath : (cwd ?? this._defaultCwd())
		log.info(`executing (spawn): git ${redactCredentials(args.join(' '))} (in ${cwdPath})`)
		const { stdout, stderr, exitCode } = await this._runner.run(args, { cwd: cwdPath })
		if (exitCode !== 0) {
			const msg = redactCredentials(stderr || `git ${args[0]} exited ${String(exitCode)}`)
			log.error(`git ${args.join(' ')} failed: ${msg}`)
			throw new GitError(msg, exitCode)
		}
		if (stderr.trim()) {
			log.debug(`git ${args.join(' ')} stderr: ${redactCredentials(stderr)}`)
		}
		return stdout.trim()
	}

	// Reset cache when .gitignore changes
	public ignoreCache: string[] = []
	public worktree: Worktree


	init (workspaceUri?: vscode.Uri) {
		workspaceUri ??= vscode.workspace.workspaceFolders![0].uri
		return this._run(['init', '-b', 'main'], workspaceUri)
	}

	defaultBranch () {
		return this._run(['config', 'init.defaultBranch']).then((r) => {
			log.info('init.defaultBranch: ' + r)
			return r
		}, (e) => {
			log.error('init.defaultBranch failed: ' + e)
			return 'main'
		})
	}

	branch (workspaceUri?: vscode.Uri): Promise<string> {
		workspaceUri ??= vscode.workspace.workspaceFolders![0].uri
		log.info('git branch --show-current (cwd=' + workspaceUri.fsPath + ')')
		return this._run(['branch', '--show-current'], workspaceUri)
	}

	version () {
		return this._run(['version']).then((r) => {
			log.info('git version: ' + r)
			return r
		})
	}

	async revParse (uri: vscode.Uri, topLevel = false) {
		let dirpath: string
		const stat = await vscode.workspace.fs.stat(uri).then((s) => { return s }, () => { return undefined })
		if (stat?.type === vscode.FileType.Directory) {
			dirpath = uri.fsPath
		} else {
			dirpath = path.dirname(uri.fsPath)
		}

		const args = topLevel ? ['rev-parse', '--show-toplevel'] : ['rev-parse', 'HEAD']
		return this._run(args, dirpath).then((r) => {
			if (topLevel) {
				log.info('revParse: "' + r + '"')
				return r.split('\n')[0]
			}
			return r
		})
	}

	revList (revA: string, revB: string): Promise<{ ahead: number, behind: number }> {
		// Three-dot form required by --left-right --count: A...B (symmetric difference)
		return this._run(['rev-list', '--left-right', '--count', `${revA}...${revB}`]).then((stdout) => {
			const counts = stdout.trim().split('\t')
			return {
				ahead: Number.parseInt(counts[0] ?? '0', 10) || 0,
				behind: Number.parseInt(counts[1] ?? '0', 10) || 0,
			}
		}, (e) => {
			log.error('revList failed: ' + e)
			return { ahead: 0, behind: 0 }
		})
	}

	/**
	 * Returns all local branch names, and optionally remote branches
	 * whose names contain `filter`.
	 */
	async listBranches(workspaceUri?: vscode.Uri, filter?: string): Promise<{ local: string[], remote: string[] }> {
		const root = workspaceUri ?? vscode.workspace.workspaceFolders![0].uri

		const localRaw = await this._run(['branch', '--format=%(refname:short)'], root).catch(() => '')
		const local = localRaw.split('\n').map(s => s.trim()).filter(Boolean)

		let remote: string[] = []
		try {
			const remoteArgs = filter
				? ['branch', '-r', '--format=%(refname:short)', '--list', `*${filter}*`]
				: ['branch', '-r', '--format=%(refname:short)']
			const remoteRaw = await this._run(remoteArgs, root)
			remote = remoteRaw
				.split('\n')
				.map(s => s.trim())
				.filter(Boolean)
				// strip only a leading "origin/" — preserving other remotes' prefixes
				// so `upstream/feature/foo` doesn't collide with `origin/feature/foo`.
				.map(s => s.replace(/^origin\//, ''))
				.filter(s => s !== 'HEAD' && !s.endsWith('/HEAD'))
				// exclude branches that are already local
				.filter(s => !local.includes(s))
		} catch (e) {
			// remote listing failing is non-fatal, but log it so real errors aren't lost
			log.warn('listBranches: remote listing failed: ' + (e instanceof Error ? e.message : String(e)))
		}

		return { local, remote }
	}

	checkIgnore (filePath: string) {
		return this._run(['check-ignore', filePath])
			.then(() => {
				this.ignoreCache.push(filePath)
				log.info('ignore path=' + filePath)
				return true
			}, () => {
				log.trace('checkIgnore returned non-zero. path=' + filePath)
				return false
			})
	}

	statusIgnored () {
		return this._run(['status', '--ignored', '--porcelain', '-z']).then((r) => {
			const lines: string[] = r.split('\0')
			const ignoredFiles = []
			for (const l of lines) {
				if (l === '') {
					continue
				}
				const status = l.substring(0, 1)
				const filePath = l.substring(3)
				if (status === '!') {
					ignoredFiles.push(filePath)
				}
			}
			return ignoredFiles
		})
	}

	add (rootUri: vscode.Uri | undefined, ...targets: (vscode.Uri | string)[]) {
		const paths: string[] = []
		for (const target of targets) {
			if (target instanceof vscode.Uri) {
				paths.push(target.fsPath)
			} else {
				paths.push(target)
			}
		}

		const cwd = rootUri ?? vscode.workspace.workspaceFolders![0].uri
		return this._run(['add', ...paths], cwd)
	}

	commit (message: string, args?: string, repoUri?: vscode.Uri) {
		const argsList = ['commit', '-m', message]
		if (args?.trim()) {
			argsList.push(...args.trim().split(/\s+/))
		}
		return this._run(argsList, repoUri)
	}
}


class Worktree {

	private readonly _runner: IGitRunner
	private readonly _defaultCwd: () => string

	constructor(runner: IGitRunner, defaultCwd: () => string) {
		this._runner = runner
		this._defaultCwd = defaultCwd
	}

	private async _run(args: string[]): Promise<string> {
		const cwd = this._defaultCwd()
		log.info(`executing (spawn): git ${args.join(' ')} (in ${cwd})`)
		const { stdout, stderr, exitCode } = await this._runner.run(args, { cwd })
		if (exitCode !== 0) {
			const msg = stderr || `git ${args[0]} exited ${String(exitCode)}`
			log.error(`git worktree command failed: ${msg}`)
			throw new GitError(msg, exitCode)
		}
		if (stderr.trim()) {
			log.debug(`git ${args.join(' ')} stderr: ${stderr}`)
		}
		return stdout.trim()
	}

	public list () {
		return this._run(['worktree', 'list', '--porcelain', '-z']).then((stdout) => {
			const trees: WorktreeStatus[] = []
			const lines = stdout.split('\0\0')
			for (const line of lines) {
				if (line === '') {
					continue
				}
				const tree = line.split('\0')
				if (tree.length < 3) {
					throw new Error('Invalid worktree: ' + line)
				}
				trees.push({
					name: tree[0].split(' ')[0],
					path: tree[0].split(' ')[1],
					uri: vscode.Uri.file(tree[0].split(' ')[1]),
					refName: tree[1].split(' ')[0],
					refSha: tree[1].split(' ')[1],
					branch: tree[2].split(' ')[1],
					locked: tree[3] === 'locked'
				})
			}

			log.info('worktree list: ' + trees.map((t) => t.name).join(', '))
			return trees
		})
	}

	/** Check out an existing branch into a new worktree directory. */
	public add (worktreePath: string, branch: string) {
		return this._run(['worktree', 'add', worktreePath, branch])
	}

	/** Create a new branch and add a worktree for it in one step. */
	public addNew (branchName: string, worktreePath: string, base: string) {
		return this._run(['worktree', 'add', '-b', branchName, worktreePath, base])
	}

	public remove(worktreePath: string, force?: boolean) {
		const args = ['worktree', 'remove']
		if (force) {
			args.push('--force')
		}
		args.push(worktreePath)
		return this._run(args)
	}

	public lock(worktreePath: string) {
		return this._run(['worktree', 'lock', worktreePath])
	}

	public unlock(worktreePath: string) {
		return this._run(['worktree', 'unlock', worktreePath])
	}

	public prune() {
		return this._run(['worktree', 'prune'])
	}

	/**
	 * Update git's internal worktree metadata after an external rename of a
	 * worktree directory.  Needed by BranchStackService when migrating from
	 * the legacy slug-only directory naming to the hashed form (T9).
	 */
	public repair() {
		return this._run(['worktree', 'repair'])
	}
}

/**
 * Validate a branch name using git's own rules via `git check-ref-format`.
 * Returns `true` if git accepts the name as a branch ref, `false` otherwise.
 * Never throws — a missing git binary is reported as `false` and logged at
 * debug level, so callers can layer their own cheap pre-filter before this.
 */
export async function checkRefFormat(branchName: string): Promise<boolean> {
	// Cheap pre-filter: obviously-bad inputs never reach the spawn.
	if (!branchName || /[ ~^:?*[\\\x00-\x1f\x7f]/.test(branchName) || branchName.includes('..')) {
		return false
	}
	try {
		await new Promise<void>((resolve, reject) => {
			const child = child_process.spawn('git', ['check-ref-format', '--branch', branchName], { shell: false })
			child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`exit=${String(code)}`))))
			child.on('error', reject)
		})
		return true
	} catch (e) {
		log.debug('checkRefFormat rejected: ' + branchName + ' (' + (e instanceof Error ? e.message : String(e)) + ')')
		return false
	}
}

const git = new Git()
export { git }
