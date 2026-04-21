import * as vscode from 'vscode'
import * as fs from 'fs'
import { WorktreeNode } from './worktreeNodes'
import { log } from './channelLogger'
import { ConfigError } from './errors'

export function validateUri (node: WorktreeNode, throwError = true) {
	if (!node.uri) {
		if (throwError) {
			throw new ConfigError('Uri is undefined for node.id:' + node.id)
		}
		return false
	}
	return true
}

export function pathExists (uri: vscode.Uri) {
	try {
		fs.statSync(uri.fsPath)
		return true
	} catch {
		return false
	}
}

export function fileExists (uri: vscode.Uri) {
	try {
		const r = fs.statSync(uri.fsPath)
		return r.isFile()
	}
	catch (e) {
		return false
	}
}

export function dirExists (uri: vscode.Uri) {
	try {
		const r = fs.statSync(uri.fsPath)
		return r.isDirectory()
	} catch (e) {
		return false
	}
}

export function toUri (path: string) {
	if (path.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(path)) {
		// absolute path (POSIX /... or Windows C:\... or C:/...)
		return vscode.Uri.file(path)
	}

    const wsFolder = vscode.workspace.workspaceFolders?.[0].uri
    if (!wsFolder) {
        throw new ConfigError('No workspace folder found')
    }
    return vscode.Uri.joinPath(wsFolder, path)
}

export function deleteFile(uri: vscode.Uri | string) {
	if (!(uri instanceof vscode.Uri)) {
		uri = toUri(uri)
	}
	log.debug('Deleting ' + uri.fsPath)
	try {
		const stat = fs.statSync(uri.fsPath)
		if (stat.isDirectory()) {
			// fs.rmSync(uri.path, { recursive: true })
			fs.rmdirSync(uri.fsPath, { recursive: true })
		} else {
			fs.rmSync(uri.fsPath, { recursive: true })
		}
	} catch (e) {
		log.info('File not found: ' + uri.fsPath)
		return false
	}
	log.debug('Deleted ' + uri.fsPath)
	return true
}
