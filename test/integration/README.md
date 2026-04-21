# GitBraid integration tests

These tests exercise the real `git` binary via `ProcessGitRunner` against
a fresh temporary repository.  They run noticeably slower than the unit
suites (`test/*.test.ts`) because each test spawns real subprocesses, so
they're useful for catching regressions in argument construction or
output parsing that unit mocks can miss.

Add a new integration test by creating `test/integration/<name>.test.ts`.
Every suite should:

1. Construct a `TmpRepo` in `before()`.
2. Drive the service-under-test directly (no VS Code UI).
3. Dispose the tmp repo in `after()`.

Example skeleton:

```ts
import { TmpRepo } from '../helpers/tmpRepo'
import { ProcessGitRunner } from '../../src/gitRunner'

let repo: TmpRepo
let runner: ProcessGitRunner

suite('my integration suite', () => {
    before(() => {
        repo = TmpRepo.create('my-suite')
        runner = new ProcessGitRunner()
    })
    after(() => repo.dispose())

    test('my scenario', async () => {
        const r = await runner.run(['status', '--porcelain'], { cwd: repo.root })
        assert.strictEqual(r.exitCode, 0)
    })
})
```

The `.vscode-test.mjs` config includes `test/**.test.ts` (double-glob)
which also matches `test/integration/*.test.ts`, so nothing else needs
to change.
