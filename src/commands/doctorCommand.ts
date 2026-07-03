import * as vscode from 'vscode'
import { log } from '../channelLogger'
import { withErrorHandler } from '../errorSurfacer'
import { DoctorService, DoctorFinding } from '../doctorService'
import type { FolderContext } from '../folderContext'
import type { CommandDeps } from './types'

const cmd = withErrorHandler

/** A finding plus the folder it came from — needed once results are flattened across folders. */
interface FolderFinding {
	ctx: FolderContext
	finding: DoctorFinding
}

export function registerDoctorCommand(deps: CommandDeps): vscode.Disposable[] {
	const { registry } = deps

	return [
		vscode.commands.registerCommand(
			'gitbraid.runDoctor',
			cmd(async () => {
				const all: FolderFinding[] = []
				for (const ctx of registry.getAll()) {
					const svc = new DoctorService(ctx.config, ctx.branchStack, ctx.root)
					const findings = await svc.run()
					for (const finding of findings) all.push({ ctx, finding })
				}

				if (all.length === 0) {
					await vscode.window.showInformationMessage('GitBraid: Doctor found no issues.')
					return
				}

				const multiRoot = registry.getAll().length > 1
				const items = all.map((f) => ({
					label: `${f.finding.severity === 'error' ? '$(error)' : '$(warning)'} ${f.finding.message}`,
					description: multiRoot ? f.ctx.root.fsPath : undefined,
					detail: f.finding.fix ? `Fix available: ${f.finding.fixLabel ?? 'Apply fix'}` : undefined,
					finding: f.finding,
				}))

				const errorCount = all.filter((f) => f.finding.severity === 'error').length
				const warningCount = all.length - errorCount
				const picked = await vscode.window.showQuickPick(items, {
					title: `GitBraid: Doctor — ${String(errorCount)} error(s), ${String(warningCount)} warning(s)`,
					placeHolder: 'Select an issue to see details or apply its fix',
					matchOnDescription: true,
				})
				if (!picked) return

				if (!picked.finding.fix) {
					await vscode.window.showInformationMessage(picked.finding.message, { modal: true })
					return
				}

				const confirm = await vscode.window.showWarningMessage(
					`${picked.finding.message}\n\nApply fix: ${picked.finding.fixLabel ?? 'Apply fix'}?`,
					{ modal: true },
					'Apply Fix',
				)
				if (confirm !== 'Apply Fix') return

				try {
					await picked.finding.fix()
					log.info(`gitbraid.runDoctor: applied fix for "${picked.finding.message}"`)
					await vscode.window.showInformationMessage('GitBraid: fix applied. Run Doctor again to verify.')
				} catch (e) {
					await vscode.window.showErrorMessage(
						`GitBraid: fix failed — ${e instanceof Error ? e.message : String(e)}`,
					)
				}
			}),
		),
	]
}
