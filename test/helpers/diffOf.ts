import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { parseDiffHunks } from '../../src/diffEngine'
import type { DiffHunk } from '../../src/diffEngine'

/** Real `git diff` hunks between two texts, so fixtures are genuine unified diffs. */
export function diffOf(oldText: string, newText: string, name = 'f.txt', context = 3): DiffHunk[] {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitbraid-diffof-'))
	try {
		fs.mkdirSync(path.join(dir, 'a'))
		fs.mkdirSync(path.join(dir, 'b'))
		fs.writeFileSync(path.join(dir, 'a', name), oldText)
		fs.writeFileSync(path.join(dir, 'b', name), newText)
		const r = spawnSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false', 'diff', '--no-index', '--no-color', `-U${String(context)}`, `a/${name}`, `b/${name}`], { cwd: dir, encoding: 'utf-8' })
		// Exit status 1 means "differences found".
		if (r.status !== 0 && r.status !== 1) throw new Error(`git diff failed: ${r.stderr}`)
		return parseDiffHunks(r.stdout)
	} finally {
		fs.rmSync(dir, { recursive: true, force: true })
	}
}
