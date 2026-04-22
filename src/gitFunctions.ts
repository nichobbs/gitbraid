import * as vscode from 'vscode'
import { log } from './channelLogger'
import util from 'util'
import child_process from 'child_process'
import path from 'path'
import { GitError } from './errors'
const exec = util.promisify(child_process.exec)


interface GitResponse {
	stdout: string
	stderr: string
}

interface GitErrorResponse {
	code: number
	killed: boolean
	signal: string | null
	cmd: string
	stdout: string
	stderr: string
}

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
		.replace(/(https?:\/\/)[^:@/\s]+:[^@/\s]+@/g, '$1***:***@')
		.replace(/(Authorization:\s*)\S+/gi, '$1***')
		.replace(/\b(ghp_|github_pat_)[A-Za-z0-9_]{20,}\b/g, '***')
}

function redactGitError (e: GitErrorResponse): GitErrorResponse {
	return {
		...e,
		cmd: e.cmd ? redactCredentials(e.cmd) : e.cmd,
		stdout: e.stdout ? redactCredentials(e.stdout) : e.stdout,
		stderr: e.stderr ? redactCredentials(e.stderr) : e.stderr,
	}
}


class Git {

	private gitExec (args: string, repoRoot?: vscode.Uri | string) {
		if (!repoRoot) {
			repoRoot = vscode.workspace.workspaceFolders![0].uri
		}
		if (repoRoot instanceof vscode.Uri) {
			repoRoot = repoRoot.fsPath
		}

		const command = 'git ' + args
		log.info('executing: ' + command + ' (in ' + repoRoot + ')')
		return exec(command, { cwd: repoRoot })
			.then((r: GitResponse) => {
				r.stdout = r.stdout.trim()
				log.info('success! (' + command + ') (stdout=' + r.stdout + ')')
				// git writes benign diagnostics to stderr on successful commands
				// (e.g. "warning: LF will be replaced by CRLF…").  Only log these
				// at debug level — never pop a user notification — because they
				// fire on nearly every save on Windows.
				if (r.stderr && r.stderr.trim() !== '') {
					log.debug('stderr=' + r.stderr)
				}
				return r.stdout
			}, (e: GitErrorResponse) => {
				log.error('GitErrorResponse=' + JSON.stringify(redactGitError(e), null, 2))
				if (e.stderr && e.stderr != '') {
					void log.notificationError(redactCredentials(e.stderr))
					throw new GitError(e.stderr, e.code)
				}
				throw e
			})
	}

	// TODO - reset cache when .gitignore changes
	public ignoreCache: string[] = []
	public worktree = new Worktree(this.gitExec)


	init (workspaceUri?: vscode.Uri) {
		if (!workspaceUri) {
			workspaceUri = vscode.workspace.workspaceFolders![0].uri
		}
		return this.gitExec('init -b main', workspaceUri.fsPath)
	}

	defaultBranch () {
		return this.gitExec('config init.defaultBranch').then((r) => {
			log.info('init.defaultBranch: ' + r)
			return r
		}, (e) => {
			log.error('init.defaultBranch failed: ' + e)
			return 'main'
		})
	}

	branch (workspaceUri?: vscode.Uri): Promise<string> {
		if (!workspaceUri) {
			workspaceUri = vscode.workspace.workspaceFolders![0].uri
		}
		log.info('git branch --show-current (cwd=' + workspaceUri.fsPath + ')')
		// gitExec resolves to the trimmed stdout string; do not dereference `.stdout`
		// on it (previously `(r: any) => r.stdout` which was always undefined).
		return this.gitExec('branch --show-current', workspaceUri.fsPath)
			.then((stdout) => stdout.trim())
	}

	version () {
		return this.gitExec('version').then((r) => {
			log.info('git version: ' + r)
			return r
		})
	}

	async revParse (uri: vscode.Uri, topLevel = false) {
		let dirpath: string
		const stat = await vscode.workspace.fs.stat(uri).then((s) => { return s }, (e) => { return undefined })
		if (!stat || stat.type != vscode.FileType.Directory) {
			dirpath = path.dirname(uri.fsPath)
		} else {
			dirpath = uri.fsPath
		}

		let args = 'rev-parse'
		if (topLevel) {
			args += ' --show-toplevel'
		} else {
			args += ' HEAD'
		}
		const resp = await this.gitExec(args, dirpath).then((r) => {
			if (topLevel) {
				log.info('revParse: "' + r + '"')
				return r.split('\n')[0]
			}
			// if (r && r != '') {
			// 	return r.trim()
			// }
			return r
		})
		return resp
	}

	revList (revA: string, revB: string): Promise<{ ahead: number, behind: number }> {
		return this.gitExec('rev-list --left-right --count ' + revA + '...' + revB).then((stdout) => {
			// gitExec already returns stdout as a trimmed string; do not dereference
			// `.stdout` (previously `r.stdout` on a string, giving undefined).
			// Note the `...` (three-dot) form: `--left-right --count A..B` is
			// invalid — `--left-right` requires symmetric difference.
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

		const localRaw = await this.gitExec('branch --format=%(refname:short)', root).catch(() => '')
		const local = localRaw.split('\n').map(s => s.trim()).filter(Boolean)

		let remote: string[] = []
		try {
			const remoteArgs = filter
				? `branch -r --format=%(refname:short) --list "*${filter}*"`
				: 'branch -r --format=%(refname:short)'
			const remoteRaw = await this.gitExec(remoteArgs, root)
			remote = remoteRaw
				.split('\n')
				.map(s => s.trim())
				.filter(Boolean)
				// strip only a leading "origin/" — preserving other remotes' prefixes
				// so `upstream/feature/foo` doesn't collide with `origin/feature/foo`.
				// Earlier code used `^[^/]+\/` which ate the first segment of any
				// branch name that contained slashes (e.g. `origin/feature/docs`
				// became `feature/docs`, but `upstream/fork/main` became `fork/main`).
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

	checkIgnore (path: string) {
		return this.gitExec('check-ignore ' + path)
			.then(() => {
				// log.info('checkIgnore: ' + path + ' -> true (r=' + r + ')')
				this.ignoreCache.push(path)
				log.info('ignore path=' + path)
				return true
			}, (e: any) => {
				log.trace('checkIgnore returned non-zero. path=' + path)
				return false
			})
	}

	statusIgnored () {
		return this.gitExec('status --ignored --porcelain -z').then((r) => {
			const lines: string[] = r.split('\0')
			const ignoredFiles = []
			for (const l of lines) {
				if (l == '') {
					continue
				}
				const status = l.substring(0, 1)
				const path = l.substring(3)
				if (status == '!') {
					ignoredFiles.push(path)
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

		let cwd: vscode.Uri
		if (rootUri == undefined) {
			cwd = vscode.workspace.workspaceFolders![0].uri
		} else {
			cwd = rootUri
		}

		return this.gitExec('add ' + paths.join(' '), cwd)
	}

	commit (message: string, args?: string, repoUri?: vscode.Uri) {
		return this.gitExec('commit -m "' + message + '" ' + args, repoUri)
	}
}


class Worktree {

	constructor(private readonly gitExec: (args: string) => Promise<string>) {}

	public list () {
		return this.gitExec('worktree list --porcelain -z').then((stdout) => {
			const trees: WorktreeStatus[] = []
			const lines = stdout.split('\0\0')
			for (const line of lines) {
				if (line == '') {
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

	public add (args: string) {
		return this.gitExec('worktree add ' + args)
	}

	public remove(args: string, force?: boolean) {
		let cmd = 'worktree remove '
		if (force) {
			cmd = cmd + '--force '
		}
		return this.gitExec(cmd + args)
	}

	public lock(path: string) {
		return this.gitExec('worktree lock ' + path)
	}

	public unlock(path: string) {
		return this.gitExec('worktree unlock ' + path)
	}

	public prune() {
		return this.gitExec('worktree prune')
	}

	/**
	 * Update git's internal worktree metadata after an external rename of a
	 * worktree directory.  Needed by BranchStackService when migrating from
	 * the legacy slug-only directory naming to the hashed form (T9).
	 */
	public repair() {
		return this.gitExec('worktree repair')
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
	if (!branchName || /[\s~^:?*[\\\x00-\x1f\x7f]/.test(branchName) || branchName.includes('..')) {
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
