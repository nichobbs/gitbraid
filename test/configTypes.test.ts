import * as assert from 'node:assert'
import {
	CONFIG_SCHEMA_VERSION,
	emptyConfig,
	isValidConfig,
	migrateConfig,
	BranchConfig,
} from '../src/configTypes'

// ─── Suite: emptyConfig ───────────────────────────────────────────────────────

suite('emptyConfig', () => {

	test('returns object with correct version', () => {
		const cfg = emptyConfig()
		assert.strictEqual(cfg.version, CONFIG_SCHEMA_VERSION)
	})

	test('returns object with empty stack array', () => {
		const cfg = emptyConfig()
		assert.deepStrictEqual(cfg.stack, [])
	})

	test('returns object with empty assignments record', () => {
		const cfg = emptyConfig()
		assert.deepStrictEqual(cfg.assignments, {})
	})

	test('returns object with empty hunkAssignments record', () => {
		const cfg = emptyConfig()
		assert.deepStrictEqual(cfg.hunkAssignments, {})
	})

	test('each call returns a distinct object', () => {
		const a = emptyConfig()
		const b = emptyConfig()
		assert.notStrictEqual(a, b)
		assert.notStrictEqual(a.stack, b.stack)
	})

})

// ─── Suite: isValidConfig ─────────────────────────────────────────────────────

suite('isValidConfig', () => {

	test('returns true for a minimal valid config', () => {
		const raw = { version: 1, stack: [], assignments: {} }
		assert.strictEqual(isValidConfig(raw), true)
	})

	test('returns true for a full valid config', () => {
		const raw: BranchConfig = {
			version: 1,
			stack: [{ name: 'feature/docs', color: '#4CAF50', order: 1, base: 'main' }],
			assignments: { 'src/foo.ts': 'feature/docs' },
			hunkAssignments: {},
		}
		assert.strictEqual(isValidConfig(raw), true)
	})

	test('returns false for null', () => {
		assert.strictEqual(isValidConfig(null), false)
	})

	test('returns false for undefined', () => {
		assert.strictEqual(isValidConfig(undefined), false)
	})

	test('returns false for a string', () => {
		assert.strictEqual(isValidConfig('not an object'), false)
	})

	test('returns false for a number', () => {
		assert.strictEqual(isValidConfig(42), false)
	})

	test('returns false when version is missing', () => {
		const raw = { stack: [], assignments: {} }
		assert.strictEqual(isValidConfig(raw), false)
	})

	test('returns false when version is a string', () => {
		const raw = { version: '1', stack: [], assignments: {} }
		assert.strictEqual(isValidConfig(raw), false)
	})

	test('returns false when stack is missing', () => {
		const raw = { version: 1, assignments: {} }
		assert.strictEqual(isValidConfig(raw), false)
	})

	test('returns false when stack is null', () => {
		const raw = { version: 1, stack: null, assignments: {} }
		assert.strictEqual(isValidConfig(raw), false)
	})

	test('returns false when stack is not an array', () => {
		const raw = { version: 1, stack: {}, assignments: {} }
		assert.strictEqual(isValidConfig(raw), false)
	})

	test('returns false when assignments is missing', () => {
		const raw = { version: 1, stack: [] }
		assert.strictEqual(isValidConfig(raw), false)
	})

	test('returns false when assignments is null', () => {
		const raw = { version: 1, stack: [], assignments: null }
		assert.strictEqual(isValidConfig(raw), false)
	})

	test('returns false when assignments is an array', () => {
		const raw = { version: 1, stack: [], assignments: [] }
		assert.strictEqual(isValidConfig(raw), false)
	})

	test('returns false for an empty object', () => {
		assert.strictEqual(isValidConfig({}), false)
	})

})

// ─── Suite: migrateConfig ─────────────────────────────────────────────────────

suite('migrateConfig', () => {

	test('sets version to CONFIG_SCHEMA_VERSION', () => {
		const cfg = emptyConfig()
		cfg.version = 0
		const result = migrateConfig(cfg)
		assert.strictEqual(result.version, CONFIG_SCHEMA_VERSION)
	})

	test('fills in missing assignments field', () => {
		const cfg = {
			version: 1,
			stack: [],
			assignments: undefined as unknown as Record<string, string>,
		}
		const result = migrateConfig(cfg as BranchConfig)
		assert.deepStrictEqual(result.assignments, {})
	})

	test('assigns default color to stack entries missing a color', () => {
		const cfg: BranchConfig = {
			version: 1,
			stack: [
				{ name: 'feature/docs', color: '', order: 1, base: 'main' },
			],
			assignments: {},
		}
		const result = migrateConfig(cfg)
		assert.strictEqual(result.stack[0].color, '#888888')
	})

	test('keeps existing colors intact', () => {
		const cfg: BranchConfig = {
			version: 1,
			stack: [
				{ name: 'feature/docs', color: '#4CAF50', order: 1, base: 'main' },
			],
			assignments: {},
		}
		const result = migrateConfig(cfg)
		assert.strictEqual(result.stack[0].color, '#4CAF50')
	})

	test('re-numbers entries missing order values', () => {
		const cfg = {
			version: 1,
			stack: [
				{ name: 'feature/a', color: '#fff', order: 1, base: 'main' },
				{ name: 'feature/b', color: '#fff', order: undefined as unknown as number, base: 'feature/a' },
			],
			assignments: {},
		}
		const result = migrateConfig(cfg as BranchConfig)
		// The entry without order should get assigned order = maxOrder + 1 = 2
		const b = result.stack.find((e) => e.name === 'feature/b')
		assert.ok(typeof b?.order === 'number', 'order should be a number after migration')
		assert.ok(b!.order > 0, 'order should be positive')
	})

	test('fills in missing hunkAssignments field', () => {
		const cfg: BranchConfig = {
			version: 1,
			stack: [],
			assignments: {},
			hunkAssignments: undefined,
		}
		const result = migrateConfig(cfg)
		assert.deepStrictEqual(result.hunkAssignments, {})
	})

	test('returns the same object (in-place mutation)', () => {
		const cfg = emptyConfig()
		const result = migrateConfig(cfg)
		assert.strictEqual(result, cfg)
	})

	test('handles multiple entries with missing order', () => {
		const cfg = {
			version: 1,
			stack: [
				{ name: 'a', color: '#fff', order: 2, base: 'main' },
				{ name: 'b', color: '#fff', order: undefined as unknown as number, base: 'a' },
				{ name: 'c', color: '#fff', order: undefined as unknown as number, base: 'b' },
			],
			assignments: {},
		}
		const result = migrateConfig(cfg as BranchConfig)
		const b = result.stack.find((e) => e.name === 'b')
		const c = result.stack.find((e) => e.name === 'c')
		assert.ok(typeof b?.order === 'number')
		assert.ok(typeof c?.order === 'number')
		assert.notStrictEqual(b!.order, c!.order)
	})

})
