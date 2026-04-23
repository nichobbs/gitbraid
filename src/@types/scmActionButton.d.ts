/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Proposed API: scmActionButton
// https://github.com/microsoft/vscode/blob/main/src/vscode-dts/vscode.proposed.scmActionButton.d.ts

declare module 'vscode' {
	export interface SourceControlActionButton {
		command: Command & { shortTitle?: string }
		secondaryCommands?: Command[][]
		enabled: boolean
	}

	export interface SourceControl {
		actionButton?: SourceControlActionButton
	}
}
