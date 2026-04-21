import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { spawnSync } from 'node:child_process'

/**
 * A self-contained temporary git repository for a single test suite.
 *
 * Every suite that previously shared `test_projects/proj1/` can instead
 * create its own `TmpRepo` in `before()` and dispose it in `after()`.  The
 * directory lives under `os.tmpdir()/gitbraid-<suite>-<random>/` so suites
 * no longer race on shared workspace state (T55 in the plan).
 *
 * ```ts
 * let repo: TmpRepo
 * before(() => { repo = TmpRepo.create('my-suite') })
 * after(() => repo.dispose())
 * ```
 */
export class TmpRepo {

	readonly root: string

	private constructor(root: string) {
		this.root = root
	}

	/** Create a fresh tmp git repo seeded with an initial commit on `main`. */
	static create(suiteName: string): TmpRepo {
		const safeName = suiteName.replace(/[^A-Za-z0-9_.-]/g, '-')
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), `gitbraid-${safeName}-`))
		run('git', ['init', '-b', 'main'], dir)
		// Create a minimal commit so refs like `HEAD` resolve; tests that need
		// more content can add files and commit via `commit()`.
		const readme = path.join(dir, 'README.md')
		fs.writeFileSync(readme, `# ${suiteName}\n`)
		// Some `git init` templates enable gpg-sign; force it off for tests.
		run('git', ['-c', 'user.email=test@gitbraid', '-c', 'user.name=test', 'add', 'README.md'], dir)
		run('git', ['-c', 'user.email=test@gitbraid', '-c', 'user.name=test', '-c', 'commit.gpgsign=false', 'commit', '-m', 'initial'], dir)
		return new TmpRepo(dir)
	}

	/** Write a file relative to the repo root. */
	writeFile(relativePath: string, content: string): void {
		const full = path.join(this.root, relativePath)
		fs.mkdirSync(path.dirname(full), { recursive: true })
		fs.writeFileSync(full, content)
	}

	/** Stage and commit every dirty file with the given message. */
	commit(message: string): void {
		run('git', ['add', '-A'], this.root)
		run('git', ['-c', 'user.email=test@gitbraid', '-c', 'user.name=test', '-c', 'commit.gpgsign=false', 'commit', '-m', message], this.root)
	}

	/** Remove the tmp directory.  Safe to call multiple times. */
	dispose(): void {
		try {
			fs.rmSync(this.root, { recursive: true, force: true })
		} catch {
			// Ignore cleanup failures in CI — the OS will reclaim /tmp.
		}
	}
}

function run(cmd: string, args: string[], cwd: string): void {
	const result = spawnSync(cmd, args, { cwd, encoding: 'utf-8' })
	if (result.status !== 0) {
		throw new Error(
			`${cmd} ${args.join(' ')} failed in ${cwd}: ` +
			`exit=${String(result.status)} stderr=${result.stderr}`,
		)
	}
}
