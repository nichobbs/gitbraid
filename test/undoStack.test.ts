import * as assert from 'node:assert'
import { UndoStack, UndoableOp } from '../src/undoStack'

// Focused unit test for the UndoStack itself — driving it with
// throwaway ops so we exercise the ring semantics without needing a
// ConfigService or filesystem.

function makeOp(label: string, log: string[]): UndoableOp {
	return {
		label,
		async undo() { log.push(`undo:${label}`) },
		async redo() { log.push(`redo:${label}`) },
	}
}

suite('UndoStack (T69)', () => {

	test('canUndo/canRedo: empty stack reports false on both', () => {
		const s = new UndoStack()
		assert.strictEqual(s.canUndo(), false)
		assert.strictEqual(s.canRedo(), false)
		s.dispose()
	})

	test('push: records an op and enables undo', () => {
		const s = new UndoStack()
		const log: string[] = []
		s.push(makeOp('one', log))
		assert.strictEqual(s.canUndo(), true)
		assert.strictEqual(s.canRedo(), false)
		assert.strictEqual(s.undoSize, 1)
		s.dispose()
	})

	test('undo: moves the op to the redo stack and invokes the callback', async () => {
		const s = new UndoStack()
		const log: string[] = []
		s.push(makeOp('one', log))
		const result = await s.undo()
		assert.strictEqual(result?.label, 'one')
		assert.deepStrictEqual(log, ['undo:one'])
		assert.strictEqual(s.canUndo(), false)
		assert.strictEqual(s.canRedo(), true)
		s.dispose()
	})

	test('redo: moves the op back and invokes the redo callback', async () => {
		const s = new UndoStack()
		const log: string[] = []
		s.push(makeOp('one', log))
		await s.undo()
		const result = await s.redo()
		assert.strictEqual(result?.label, 'one')
		assert.deepStrictEqual(log, ['undo:one', 'redo:one'])
		assert.strictEqual(s.canUndo(), true)
		assert.strictEqual(s.canRedo(), false)
		s.dispose()
	})

	test('push: clears the redo stack', async () => {
		const s = new UndoStack()
		const log: string[] = []
		s.push(makeOp('one', log))
		await s.undo()
		assert.strictEqual(s.canRedo(), true)
		s.push(makeOp('two', log))
		assert.strictEqual(s.canRedo(), false, 'fresh push must drop redo history')
		s.dispose()
	})

	test('undo: on empty stack returns undefined, no-op', async () => {
		const s = new UndoStack()
		const result = await s.undo()
		assert.strictEqual(result, undefined)
		s.dispose()
	})

	test('ring bound: oldest op drops when capacity exceeded', () => {
		const s = new UndoStack()
		const log: string[] = []
		for (let i = 0; i < UndoStack.CAPACITY + 5; i++) {
			s.push(makeOp(`op${String(i)}`, log))
		}
		assert.strictEqual(s.undoSize, UndoStack.CAPACITY)
		// The oldest entries should have been dropped; the most recent is on top.
		assert.strictEqual(s.peekUndo()?.label, `op${String(UndoStack.CAPACITY + 5 - 1)}`)
		s.dispose()
	})

	test('failed undo: op stays on the undo stack', async () => {
		const s = new UndoStack()
		const op: UndoableOp = {
			label: 'fail',
			async undo() { throw new Error('nope') },
			async redo() { /* ignore */ },
		}
		s.push(op)
		await assert.rejects(() => s.undo(), /nope/)
		assert.strictEqual(s.canUndo(), true, 'failed undo must leave the op on the stack')
		assert.strictEqual(s.canRedo(), false)
		s.dispose()
	})

	test('loop safety: push() during an undo callback is ignored', async () => {
		const s = new UndoStack()
		const log: string[] = []
		const reentrant: UndoableOp = {
			label: 'reentrant',
			async undo() {
				log.push('undo:reentrant')
				// Simulate a service event re-entering push.
				s.push(makeOp('from-within-undo', log))
			},
			async redo() { log.push('redo:reentrant') },
		}
		s.push(reentrant)
		await s.undo()
		// The `from-within-undo` op must NOT have been recorded.
		assert.strictEqual(s.undoSize, 0)
		assert.strictEqual(s.canRedo(), true)
		s.dispose()
	})

	test('onDidChange: fires on push, undo, redo, and clear', async () => {
		const s = new UndoStack()
		let fires = 0
		const d = s.onDidChange(() => { fires++ })
		s.push(makeOp('a', []))
		await s.undo()
		await s.redo()
		s.clear()
		d.dispose()
		assert.strictEqual(fires, 4)
		s.dispose()
	})

	test('clear: empties both stacks', async () => {
		const s = new UndoStack()
		s.push(makeOp('a', []))
		s.push(makeOp('b', []))
		await s.undo()
		s.clear()
		assert.strictEqual(s.canUndo(), false)
		assert.strictEqual(s.canRedo(), false)
		s.dispose()
	})
})
