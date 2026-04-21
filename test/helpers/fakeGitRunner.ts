import type { IGitRunner, GitRunOptions, GitRunResult } from '../../src/gitRunner'

/** Shape of a recorded invocation so tests can assert call arguments. */
export interface RecordedCall {
	args: string[]
	cwd: string
	input?: string
}

/**
 * Deterministic in-memory `IGitRunner` for unit tests.  Register canned
 * responses by (args.join(' ')) prefix and every matching call returns the
 * provided result.  Unmatched calls resolve with exit=128 and a diagnostic
 * stderr so tests fail loudly rather than silently returning empty strings.
 */
export class FakeGitRunner implements IGitRunner {
	readonly calls: RecordedCall[] = []
	private readonly _fixtures = new Map<string, GitRunResult>()

	fixture(argvPrefix: string, result: Partial<GitRunResult>): void {
		this._fixtures.set(argvPrefix, {
			stdout: result.stdout ?? '',
			stderr: result.stderr ?? '',
			exitCode: result.exitCode ?? 0,
		})
	}

	async run(args: readonly string[], opts: GitRunOptions): Promise<GitRunResult> {
		const key = args.join(' ')
		this.calls.push({ args: [...args], cwd: opts.cwd, input: opts.input })
		for (const [prefix, result] of this._fixtures) {
			if (key === prefix || key.startsWith(prefix + ' ')) {
				return result
			}
		}
		return {
			stdout: '',
			stderr: `FakeGitRunner: no fixture registered for "git ${key}"`,
			exitCode: 128,
		}
	}

	reset(): void {
		this.calls.length = 0
		this._fixtures.clear()
	}
}
