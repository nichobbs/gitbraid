import { spawn } from 'node:child_process'

/**
 * Contract for invoking the `git` CLI.  Abstracted behind an interface so
 * tests can drop in a fake without touching the real binary.  Implementations
 * MUST:
 *   - Launch git without a shell (`shell: false`) so argv entries are passed
 *     verbatim and no metacharacters are interpreted.
 *   - Resolve with the final `stdout`, `stderr`, and `exitCode` on every
 *     outcome — never throw on non-zero exit.  Callers decide how to react.
 *
 * This is the substrate for the `exec` → `spawn` migration tracked in
 * `docs/remediation/03-security-hardening.md#T18`.
 */
export interface IGitRunner {
	run(args: readonly string[], opts: GitRunOptions): Promise<GitRunResult>
}

export interface GitRunOptions {
	cwd: string
	/** Optional stdin payload piped into the process (e.g. a patch). */
	input?: string
	/** Hard cap (in bytes) on the collected stdout.  Default: 100 MB. */
	maxBuffer?: number
	/** Abort the run if it hasn't completed by the deadline (ms).  Optional. */
	timeoutMs?: number
}

export interface GitRunResult {
	stdout: string
	stderr: string
	exitCode: number
}

const DEFAULT_MAX_BUFFER = 100 * 1024 * 1024

/** Default production runner — spawns `git` directly with `shell: false`. */
export class ProcessGitRunner implements IGitRunner {

	run(args: readonly string[], opts: GitRunOptions): Promise<GitRunResult> {
		const cap = opts.maxBuffer ?? DEFAULT_MAX_BUFFER
		return new Promise<GitRunResult>((resolve, reject) => {
			const child = spawn('git', [...args], {
				cwd: opts.cwd,
				shell: false,
				stdio: ['pipe', 'pipe', 'pipe'],
			})
			let stdout = ''
			let stderr = ''
			let overflowed = false

			const append = (buf: string, src: 'stdout' | 'stderr') => {
				const combined = (src === 'stdout' ? stdout : stderr) + buf
				if (combined.length > cap) {
					overflowed = true
					child.kill('SIGKILL')
					return
				}
				if (src === 'stdout') stdout = combined
				else stderr = combined
			}

			child.stdout?.on('data', (d: Buffer) => append(d.toString('utf-8'), 'stdout'))
			child.stderr?.on('data', (d: Buffer) => append(d.toString('utf-8'), 'stderr'))

			let timer: NodeJS.Timeout | undefined
			if (opts.timeoutMs && opts.timeoutMs > 0) {
				timer = setTimeout(() => {
					child.kill('SIGKILL')
					reject(new Error(`git ${args.join(' ')} timed out after ${String(opts.timeoutMs)}ms`))
				}, opts.timeoutMs)
			}

			child.on('error', (e) => {
				if (timer) clearTimeout(timer)
				reject(e)
			})
			child.on('close', (code) => {
				if (timer) clearTimeout(timer)
				if (overflowed) {
					reject(new Error(`git ${args.join(' ')} output exceeded ${String(cap)} bytes`))
					return
				}
				resolve({ stdout, stderr, exitCode: code ?? -1 })
			})

			if (opts.input !== undefined) {
				child.stdin?.write(opts.input)
			}
			child.stdin?.end()
		})
	}
}

/** Lazily-constructed default runner, shared by modules that don't inject one. */
let _defaultRunner: IGitRunner | undefined
export function getDefaultGitRunner(): IGitRunner {
	if (!_defaultRunner) {
		_defaultRunner = new ProcessGitRunner()
	}
	return _defaultRunner
}

/** Test seam: replace the default runner.  Pass `undefined` to reset. */
export function setDefaultGitRunnerForTest(runner: IGitRunner | undefined): void {
	_defaultRunner = runner
}
