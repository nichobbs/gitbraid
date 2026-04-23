import * as vscode from 'vscode'
import * as path from 'node:path'
import { promises as fsp } from 'node:fs'
import { log } from './channelLogger'
import type { ConfigService } from './configService'
import { isValidConfig, migrateConfig } from './configTypes'

const CHECKPOINTS_DIR = 'checkpoints'

export interface CheckpointMeta {
	/** ISO-8601 timestamp (from filename). */
	timestamp: string
	/** Basename of the checkpoint file. */
	filename: string
	/** Absolute path to the file. */
	filePath: string
	/** Number of branches in the snapshot. */
	branchCount: number
	/** Number of file assignments in the snapshot. */
	assignmentCount: number
}

/**
 * Saves and restores named snapshots of `.worktrees/local-config.json`.
 *
 * Snapshots are written to `.worktrees/checkpoints/<ISO-timestamp>[label].json`.
 * The format is identical to `local-config.json` so they can be inspected and
 * hand-edited.  Restoring replaces the live config atomically via
 * `ConfigService.restoreSnapshot`, which fires the appropriate events so all
 * UI surfaces rebuild.
 */
export class CheckpointService {

	constructor(
		private readonly _config: ConfigService,
		private readonly _worktreesDir: vscode.Uri,
	) {}

	private _checkpointsDir(): string {
		return path.join(this._worktreesDir.fsPath, CHECKPOINTS_DIR)
	}

	/** Write a snapshot of the current config.  Returns the absolute file path. */
	async saveCheckpoint(label?: string): Promise<string> {
		const dir = this._checkpointsDir()
		await fsp.mkdir(dir, { recursive: true })

		const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
		const slug = label ? `-${label.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 30)}` : ''
		const filename = `${timestamp}${slug}.json`
		const filePath = path.join(dir, filename)

		const snapshot = {
			version: 2,
			stack: this._config.getStack(),
			assignments: this._config.getAllAssignments(),
		}
		const tmp = filePath + '.tmp'
		await fsp.writeFile(tmp, JSON.stringify(snapshot, null, 2) + '\n', 'utf-8')
		await fsp.rename(tmp, filePath)
		log.info(`CheckpointService: saved "${filename}"`)
		return filePath
	}

	/** Return metadata for all saved checkpoints, newest first. */
	async listCheckpoints(): Promise<CheckpointMeta[]> {
		const dir = this._checkpointsDir()
		let files: string[]
		try {
			files = await fsp.readdir(dir)
		} catch {
			return []
		}

		const metas: CheckpointMeta[] = []
		for (const filename of files.filter((f) => f.endsWith('.json')).sort().reverse()) {
			const filePath = path.join(dir, filename)
			try {
				const raw = await fsp.readFile(filePath, 'utf-8')
				const parsed: unknown = JSON.parse(raw)
				if (!isValidConfig(parsed)) continue
				const config = migrateConfig(parsed)
				// Reconstruct a readable ISO timestamp from the filename prefix.
				// Filename format: YYYY-MM-DDTHH-MM-SS-mmmZ[-label].json
				const ts = filename.replace(
					/^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z.*/,
					'$1-$2-$3T$4:$5:$6.$7Z',
				)
				metas.push({
					timestamp: ts,
					filename,
					filePath,
					branchCount: config.stack.length,
					assignmentCount: Object.keys(config.assignments).length,
				})
			} catch {
				// Skip corrupted checkpoint files silently
			}
		}
		return metas
	}

	/** Restore the config from a checkpoint file by absolute path. */
	async restoreCheckpoint(filePath: string): Promise<void> {
		const raw = await fsp.readFile(filePath, 'utf-8')
		const parsed: unknown = JSON.parse(raw)
		if (!isValidConfig(parsed)) {
			throw new Error(`Checkpoint file has unexpected structure: ${path.basename(filePath)}`)
		}
		const snapshot = migrateConfig(parsed)
		await this._config.restoreSnapshot(snapshot)
		log.info(`CheckpointService: restored "${path.basename(filePath)}"`)
	}
}
