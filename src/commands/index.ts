import * as vscode from 'vscode'
import { registerViewCommands } from './viewCommands'
import { registerFileCommands } from './fileCommands'
import { registerHunkCommands } from './hunkCommands'
import { registerBranchCommands } from './branchCommands'
import { registerScmCommands } from './scmCommands'
import { registerPrCommands } from './prCommands'
import type { CommandDeps } from './types'

export type { CommandDeps }

export function registerAllCommands(
	deps: CommandDeps,
	secrets: vscode.SecretStorage,
): vscode.Disposable[] {
	return [
		...registerViewCommands(deps),
		...registerFileCommands(deps),
		...registerHunkCommands(deps),
		...registerBranchCommands(deps),
		...registerScmCommands(deps),
		...registerPrCommands(deps, secrets),
	]
}
