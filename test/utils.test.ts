import * as assert from 'node:assert'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as vscode from 'vscode'
import { validateUri, fileExists, dirExists, deleteFile } from '../src/utils'

function wsRoot(): vscode.Uri {
	return vscode.workspace.workspaceFolders![0].uri
}

function tmpPath(...parts: string[]): string {
	return path.join(wsRoot().fsPath, '.worktrees', 'utils-test', ...parts)
}

suite('utils', () => {

	suiteSetup(() => {
		fs.mkdirSync(tmpPath(), { recursive: true })
	})

	suiteTeardown(() => {
		try { fs.rmSync(tmpPath(), { recursive: true }) } catch {}
	})

	// ── validateUri ─────────────────────────────────────────────────────────────

	test('validateUri: returns true when uri is defined', () => {
		const fakeNode = { id: 'test', uri: vscode.Uri.file('/tmp') } as any
		assert.strictEqual(validateUri(fakeNode), true)
	})

	test('validateUri: throws when uri is undefined and throwError=true (default)', () => {
		const fakeNode = { id: 'missing-uri', uri: undefined } as any
		assert.throws(
			() => validateUri(fakeNode),
			/Uri is undefined/,
		)
	})

	test('validateUri: returns false when uri is undefined and throwError=false', () => {
		const fakeNode = { id: 'missing-uri', uri: undefined } as any
		assert.strictEqual(validateUri(fakeNode, false), false)
	})

	// ── fileExists ────────────────────────────────────────────────────────────

	test('fileExists: returns true for an existing file', () => {
		const filePath = tmpPath('exists.txt')
		fs.writeFileSync(filePath, 'hello')
		const uri = vscode.Uri.file(filePath)
		assert.strictEqual(fileExists(uri), true)
	})

	test('fileExists: returns false for a non-existent path', () => {
		const uri = vscode.Uri.file(tmpPath('does-not-exist.txt'))
		assert.strictEqual(fileExists(uri), false)
	})

	test('fileExists: returns false for a directory', () => {
		const dirPath = tmpPath('subdir')
		fs.mkdirSync(dirPath, { recursive: true })
		const uri = vscode.Uri.file(dirPath)
		assert.strictEqual(fileExists(uri), false)
	})

	// ── dirExists ─────────────────────────────────────────────────────────────

	test('dirExists: returns true for an existing directory', () => {
		const dirPath = tmpPath('existsdir')
		fs.mkdirSync(dirPath, { recursive: true })
		const uri = vscode.Uri.file(dirPath)
		assert.strictEqual(dirExists(uri), true)
	})

	test('dirExists: returns false for a non-existent path', () => {
		const uri = vscode.Uri.file(tmpPath('no-such-dir'))
		assert.strictEqual(dirExists(uri), false)
	})

	test('dirExists: returns false for a file path', () => {
		const filePath = tmpPath('a-file.txt')
		fs.writeFileSync(filePath, 'content')
		const uri = vscode.Uri.file(filePath)
		assert.strictEqual(dirExists(uri), false)
	})

	// ── deleteFile ────────────────────────────────────────────────────────────

	test('deleteFile: deletes an existing file and returns true', () => {
		const filePath = tmpPath('to-delete.txt')
		fs.writeFileSync(filePath, 'bye')
		const uri = vscode.Uri.file(filePath)
		const result = deleteFile(uri)
		assert.strictEqual(result, true)
		assert.ok(!fs.existsSync(filePath), 'File should be deleted')
	})

	test('deleteFile: returns false for a non-existent path', () => {
		const uri = vscode.Uri.file(tmpPath('nonexistent-delete.txt'))
		const result = deleteFile(uri)
		assert.strictEqual(result, false)
	})

	test('deleteFile: deletes a directory recursively and returns true', () => {
		const dirPath = tmpPath('dir-to-delete')
		fs.mkdirSync(path.join(dirPath, 'nested'), { recursive: true })
		fs.writeFileSync(path.join(dirPath, 'nested', 'file.txt'), 'x')
		const uri = vscode.Uri.file(dirPath)
		const result = deleteFile(uri)
		assert.strictEqual(result, true)
		assert.ok(!fs.existsSync(dirPath), 'Directory should be deleted')
	})

	test('deleteFile: accepts a string path', () => {
		const filePath = tmpPath('string-path-delete.txt')
		fs.writeFileSync(filePath, 'data')
		const result = deleteFile(filePath)
		assert.strictEqual(result, true)
		assert.ok(!fs.existsSync(filePath))
	})

})
