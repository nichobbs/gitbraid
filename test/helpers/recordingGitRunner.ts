import { ProcessGitRunner } from '../../src/gitRunner'
import type { GitRunOptions, GitRunResult, IGitRunner } from '../../src/gitRunner'

/**
 * Runs real git and records every invocation, so tests can assert how many
 * processes of a given kind were spawned (for example, how many `git diff`).
 */
export class RecordingGitRunner implements IGitRunner {
	readonly calls: string[][] = []
	private readonly _real = new ProcessGitRunner()

	run(args: readonly string[], opts: GitRunOptions): Promise<GitRunResult> {
		this.calls.push([...args])
		return this._real.run(args, opts)
	}

	/** How many recorded invocations used `subcommand` (the first non-option argument). */
	count(subcommand: string): number {
		return this.calls.filter((a) => a.find((x) => !x.startsWith('-')) === subcommand).length
	}

	reset(): void { this.calls.length = 0 }
}
