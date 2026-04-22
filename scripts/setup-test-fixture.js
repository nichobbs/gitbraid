#!/usr/bin/env node
// Ensure test_projects/proj1/ exists for the vscode-test harness.
//
// The fixture directory is intentionally not tracked in git (test runs
// reinitialise it with `git init` and mutate its contents). This script
// recreates the minimum shape the harness needs — the workspace folder
// and a `.vscode/settings.json` that hides `.worktrees/` from the
// Explorer during tests — so a fresh clone can run `npm test`.

const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const fixture = path.join(root, 'test_projects', 'proj1')
const settingsPath = path.join(fixture, '.vscode', 'settings.json')

fs.mkdirSync(path.dirname(settingsPath), { recursive: true })

if (!fs.existsSync(settingsPath)) {
	const settings = {
		'files.exclude': {
			'.worktrees/': true,
		},
	}
	fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 4) + '\n')
}
