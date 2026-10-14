import * as assert from 'node:assert'
import {
	scmProviderId,
	branchNameFromScmProviderId,
	branchNameFromScmArg,
} from '../src/scmProviderId'

suite('scmProviderId', () => {

	test('scmProviderId: regular branch uses the gitbraid- prefix', () => {
		assert.strictEqual(scmProviderId('feature/a', false), 'gitbraid-feature/a')
	})

	test('scmProviderId: virtual branch uses the gitbraid-virtual: prefix', () => {
		assert.strictEqual(scmProviderId('feature/a', true), 'gitbraid-virtual:feature/a')
	})

	test('scmProviderId: a regular branch named "virtual-x" never collides with a virtual id', () => {
		// ":" is illegal in git ref names, so the virtual prefix is unambiguous.
		assert.notStrictEqual(scmProviderId('virtual-x', false), scmProviderId('x', true))
		assert.strictEqual(branchNameFromScmProviderId(scmProviderId('virtual-x', false)), 'virtual-x')
	})

	test('branchNameFromScmProviderId: round-trips regular and virtual ids', () => {
		for (const name of ['main', 'feature/a', 'fix/x-y.z']) {
			assert.strictEqual(branchNameFromScmProviderId(scmProviderId(name, false)), name)
			assert.strictEqual(branchNameFromScmProviderId(scmProviderId(name, true)), name)
		}
	})

	test('branchNameFromScmProviderId: rejects ids that are not GitBraid providers', () => {
		assert.strictEqual(branchNameFromScmProviderId('git'), undefined)
		assert.strictEqual(branchNameFromScmProviderId(''), undefined)
		assert.strictEqual(branchNameFromScmProviderId(undefined), undefined)
		assert.strictEqual(branchNameFromScmProviderId(42), undefined)
	})

	test('branchNameFromScmArg: reads the id of a SourceControl-like argument', () => {
		assert.strictEqual(branchNameFromScmArg({ id: 'gitbraid-feature/a' }), 'feature/a')
		assert.strictEqual(branchNameFromScmArg({ id: 'gitbraid-virtual:idea' }), 'idea')
	})

	test('branchNameFromScmArg: ignores strings, nodes and foreign providers', () => {
		assert.strictEqual(branchNameFromScmArg('feature/a'), undefined)
		assert.strictEqual(branchNameFromScmArg(undefined), undefined)
		assert.strictEqual(branchNameFromScmArg(null), undefined)
		assert.strictEqual(branchNameFromScmArg({ entry: { name: 'x' } }), undefined)
		assert.strictEqual(branchNameFromScmArg({ id: 'git' }), undefined)
	})
})
