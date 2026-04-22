import * as assert from 'node:assert'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
	CONFIG_SCHEMA_VERSION,
	BranchConfig,
	migrateConfig,
	isValidConfig,
} from '../src/configTypes'

// Snapshot-style migration test: every historical config fixture under
// `test/fixtures/config-v*.json` must be recognised by `isValidConfig`
// and produce a v-current config via `migrateConfig` that preserves the
// user's stack / assignments / hunk assignments intact.

const FIXTURE_DIR = path.resolve(__dirname, 'fixtures')

function loadFixture(name: string): unknown {
	const p = path.join(FIXTURE_DIR, name)
	// The test runner copies `test/` into `out/test/`; fixtures live next to
	// the source tree so we resolve relative to __dirname's src location.
	const candidates = [p, path.join(__dirname, '..', '..', '..', 'test', 'fixtures', name)]
	for (const c of candidates) {
		if (fs.existsSync(c)) {
			return JSON.parse(fs.readFileSync(c, 'utf-8'))
		}
	}
	throw new Error(`fixture not found: ${name} (tried ${candidates.join(' | ')})`)
}

suite('configTypes — schema migration snapshots', () => {

	test('v1 fixture is recognised as valid', () => {
		const raw = loadFixture('config-v1.json')
		assert.ok(isValidConfig(raw), 'v1 fixture must pass isValidConfig')
	})

	test('v1 fixture migrates to the current schema', () => {
		const raw = loadFixture('config-v1.json') as BranchConfig
		const migrated = migrateConfig(raw)
		// Stack, assignments, hunkAssignments preserved verbatim.
		assert.strictEqual(migrated.stack.length, 1)
		assert.strictEqual(migrated.stack[0].name, 'feature/a')
		assert.deepStrictEqual(migrated.assignments, { 'src/foo.ts': 'feature/a' })
		assert.deepStrictEqual(
			migrated.hunkAssignments?.['src/foo.ts'],
			{ '0': 'feature/a' },
		)
	})

	test('v1 fixture gains an empty hunkAnchors map after migration', () => {
		const raw = loadFixture('config-v1.json') as BranchConfig
		const migrated = migrateConfig(raw)
		// T8 schema introduced hunkAnchors in v2 — legacy configs are
		// carried forward with an empty map until the user re-assigns.
		assert.ok(migrated.hunkAnchors, 'hunkAnchors should be present')
		assert.deepStrictEqual(migrated.hunkAnchors, {})
	})

	test('migration stamps version to CONFIG_SCHEMA_VERSION', () => {
		const raw = loadFixture('config-v1.json') as BranchConfig
		const migrated = migrateConfig(raw)
		assert.strictEqual(migrated.version, CONFIG_SCHEMA_VERSION)
	})

	test('migration is idempotent', () => {
		const raw = loadFixture('config-v1.json') as BranchConfig
		const first = migrateConfig(structuredClone(raw) as BranchConfig)
		const second = migrateConfig(structuredClone(first))
		assert.deepStrictEqual(first, second)
	})
})
