import * as vscode from 'vscode'
import { FileGroup, WorktreeFile, WorktreeFileGroup, WorktreeNode, WorktreeRoot } from './worktreeNodes'
import { GitExtension, Status } from './@types/git.d'
import { log } from './channelLogger'
import util from 'util'
import child_process from 'child_process'
import path from 'path'
import { GitError } from './errors'
const exec = util.promisify(child_process.exec)

export interface GitUriOptions {
	scheme?: string;
	replaceFileExtension?: boolean;
	submoduleOf?: string;
}

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

const gitExtension = vscode.extensions.getExtension<GitExtension>('vscode.git')?.exports
if (!gitExtension) {
	throw new Error('Git extension not found')
}
const gitAPI = gitExtension.getAPI(1)

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

function getStateFromChar(status: string) {
	switch (status) {
		case 'M':
			return Status.MODIFIED
		case 'A':
			return Status.INDEX_ADDED
		case 'D':
			return Status.DELETED
		case 'R':
			return Status.INDEX_RENAMED
		case 'C':
			return Status.INDEX_COPIED
		case '?':
			return Status.UNTRACKED
		case '!':
			return Status.IGNORED
		default:
			throw new Error('Unknown status: ' + status)
	}
}

// https://github.com/microsoft/vscode/blob/8869a4eca90a111abac23d99b400b156390ed8f0/extensions/git/src/commands.ts#L1911
function cleanMessage (nodes: WorktreeFile[]) {

	const untrackedCount = (nodes.filter((n) => n.group == FileGroup.Untracked)).length
	let message: string
	// let yes: string = vscode.l10n.t('Discard Changes')
	let yes: string = 'Discard Changes'
	if (nodes.length === 1) {
		if (untrackedCount > 0) {
			// const message = vscode.l10n.t('Are you sure you want to DELETE {0}?\nThis is IRREVERSIBLE!\nThis file will be FOREVER LOST if you proceed.', path.basename(untrackedUris[0].fsPath))
			// const yes = vscode.l10n.t('Delete file')
			message = 'Are you sure you want to DELETE {0}?\nThis is IRREVERSIBLE!\nThis file will be FOREVER LOST if you proceed.'
			yes = 'Delete file'
		} else if (nodes[0].state === 'D') {
			// yes = l10n.t('Restore file')
			// message = l10n.t('Are you sure you want to restore {0}?', path.basename(scmResources[0].resourceUri.fsPath));
			yes = 'Restore file'
			message = 'Are you sure you want to restore {0}?'
		} else {
			// message = l10n.t('Are you sure you want to discard changes in {0}?', path.basename(scmResources[0].resourceUri.fsPath))
			message = 'Are you sure you want to discard changes in {0}?'
		}
		message = message.replace('{0}', nodes[0].relativePath)
	} else {
		if (nodes.every((n) => n.state === 'D')) {
			// 	yes = l10n.t('Restore files');
			// 	message = l10n.t('Are you sure you want to restore {0} files?', scmResources.length);
			yes = 'Restore files'
			message = 'Are you sure you want to restore {0} files?'
		} else {
			// 	message = l10n.t('Are you sure you want to discard changes in {0} files?', scmResources.length);
			message = 'Are you sure you want to discard changes in {0} files?'
		}

		if (untrackedCount > 0) {
			// message = `${message}\n\n${l10n.t('This will DELETE {0} untracked files!\nThis is IRREVERSIBLE!\nThese files will be FOREVER LOST.', untrackedCount)}`;
			message = `${message}\n\n${'This will DELETE {0} untracked files!\nThis is IRREVERSIBLE!\nThese files will be FOREVER LOST.'}`
		}
		message = message.replace('{0}', nodes.length.toString())
	}
	log.info('message="' + message + '"')
	return vscode.window.showWarningMessage(message, { modal: true }, yes)
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

	toGitUri (rootNode: WorktreeRoot, uri: vscode.Uri, ref: string = '') {
		// ref == '~': staged
		// ref == '': working tree
		// const relativePath = path.relative(rootNode.uri.fsPath, uri.fsPath)

		uri = uri.with({ fragment: undefined })
		return gitAPI.toGitUri(uri, ref)
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

	show (repoRootUri: vscode.Uri, relativePath: string, tempDir: vscode.Uri) {
		const showUri = vscode.Uri.joinPath(tempDir, relativePath.replace('/', '_'))
		// const outFile = path.join(tempDir.fsPath, relativePath.replace('/', '_'))
		const resp = this.gitExec('show :0:' + relativePath, repoRootUri)
			.then((resp) => {
				log.info('resp=' + resp)
				return vscode.workspace.fs.writeFile(showUri, Buffer.from(resp))
			})
			.then(() => {
				log.info('return resp=' + resp)
					return showUri
			}, (e) => { throw e })
		return resp
	}

	// TODO: MOVE ME
	createWorktreeFileNode (repoNode: WorktreeRoot, path: string, group: FileGroup, status: string) {
		const groupNode = repoNode.getFileGroupNode(group)
		const uri = vscode.Uri.joinPath(repoNode.uri, path)
		const existing = groupNode.children.find((f) => f.uri?.fsPath == uri.fsPath)
		if (!existing) {
			return [new WorktreeFile(uri, groupNode, status)]
		}
		return []
	}

	async status (node: WorktreeNode) {
		const repoNode = node.getRepoNode()
		if (!repoNode.pathExists) {
			return []
		}
		let args = 'status --porcelain -z'
		if (node instanceof WorktreeFile) {
			args += ' ' + node.relativePath
		}
		const r = await this.gitExec(args, repoNode.uri)
			.then((r) => { return r }
			, (e: any) => {
				if (e.stderr == '' && e.stdout == '') {
					return ''
				}
				throw e
			})
		const newFiles: WorktreeFile[] = []
		const lines: string[] = r.split('\0')
		for (const l of lines) {
			if (l == '') {
				continue
			}
			const statusStaged = l.substring(0, 1)
			const statusChanged = l.substring(1, 2)
			const path = l.substring(3)

			const status: string | undefined = undefined
			const wg: WorktreeFileGroup | undefined = undefined
			if (statusStaged == '?' && statusChanged == '?') {
				newFiles.push(...this.createWorktreeFileNode(repoNode, path, FileGroup.Untracked, 'A'))
			} else {
				if (statusStaged.trim() != '') {
					newFiles.push(...this.createWorktreeFileNode(repoNode, path, FileGroup.Staged, statusStaged))
				}
				if (statusChanged.trim() != '') {
					newFiles.push(...this.createWorktreeFileNode(repoNode, path, FileGroup.Changes, statusChanged))
				}
			}
		}
		return newFiles
	}

	diff (repo: WorktreeRoot | vscode.Uri, ref1: string, ref2?: string) {
		let repoUri: vscode.Uri
		if (repo instanceof WorktreeRoot) {
			repoUri = repo.uri
		} else {
			repoUri = repo
		}

		let args = 'diff ' + ref1
		if (ref2) {
			args += ' ' + ref2
		}
		return this.gitExec(args, repoUri)
	}

	// dialogResponse should only be set during test runs.
	// Correctly splits the "discard" action by file state:
	//   - Untracked files are removed via `git clean -f`.
	//   - Tracked files (modified / staged) are restored via
	//     `git checkout HEAD -- <path>` so their edits are actually reverted.
	// The previous implementation ran `git clean -f` on every node, which is a
	// no-op for modified tracked files (the file stays dirty) and deleted
	// untracked files without enough warning.
	async clean (nodes: WorktreeFile[] | WorktreeFile, dialogResponse?: string) {
		if (!Array.isArray(nodes)) {
			nodes = [nodes]
		}
		if (nodes.length === 0) {
			return false
		}

		const repoRoot = nodes[0].getRepoNode()
		log.info('clean changes in ' + nodes.length + ' files')

		log.info('dialogResponse=' + dialogResponse)
		if (dialogResponse == undefined) {
			dialogResponse = await cleanMessage(nodes)
			log.info('dialogResponse=' + dialogResponse)
		}
		if (!dialogResponse) {
			log.info('clean cancelled')
			return false
		}

		const untrackedPaths: string[] = []
		const trackedPaths: string[] = []
		for (const node of nodes) {
			if (node.group === FileGroup.Untracked) {
				untrackedPaths.push(node.uri.fsPath)
			} else {
				trackedPaths.push(node.uri.fsPath)
			}
		}

		if (trackedPaths.length > 0) {
			await this.gitExec('checkout HEAD -- ' + trackedPaths.join(' '), repoRoot.uri)
		}
		if (untrackedPaths.length > 0) {
			await this.gitExec('clean -f -- ' + untrackedPaths.join(' '), repoRoot.uri)
		}
		return true
	}

	add (rootNode: WorktreeRoot | undefined, ...targets: (WorktreeFile | vscode.Uri | string)[]) {
		const paths: string[] = []
		for (const target of targets) {
			if (target instanceof WorktreeFile) {
				paths.push(target.uri.fsPath)
			} else if (target instanceof vscode.Uri) {
				paths.push(target.fsPath)
			} else {
				paths.push(target)
			}
		}

		let cwd: vscode.Uri
		if (rootNode == undefined) {
			cwd = vscode.workspace.workspaceFolders![0].uri
		} else {
			cwd = rootNode.uri
		}

		return this.gitExec('add ' + paths.join(' '), cwd)
	}

	reset (...nodes: WorktreeFile[]) {
		const paths: string[] = []
		for (const node of nodes) {
			paths.push(node.uri.fsPath)
		}
		return this.gitExec('reset ' + paths.join(' '), nodes[0].getRepoNode().uri)
	}

	rm (...nodes: WorktreeFile[]) {
		const paths: string[] = []
		for (const node of nodes) {
			paths.push(node.uri.fsPath)
		}
		return this.gitExec('rm ' + paths.join(' '), nodes[0].getRepoNode().uri)
	}

	commit (message: string, args?: string, repoRoot?: WorktreeRoot) {
		return this.gitExec('commit -m "' + message + '" ' + args, repoRoot?.uri)
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
}

const git = new Git()
export { git }
