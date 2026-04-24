import { defineConfig } from '@vscode/test-cli'
import { fileURLToPath } from 'url'
import * as path from 'path'

// https://github.com/microsoft/vscode-test-cli/issues/48
import { env } from 'process'
delete env['VSCODE_IPC_HOOK_CLI']
env['DONT_PROMPT_WSL_INSTALL'] = true

// Windows GitHub Actions runners don't ship a default git identity, so
// every `git commit` in the test fixtures fails with "Author identity
// unknown", which in turn means `HEAD` is never created and downstream
// tests that resolve `HEAD` or `main` refs explode.  Set author and
// committer env vars here so they inherit into the extension host and,
// from there, into every `child_process` git call.  Only applied when
// the user hasn't already configured an identity via env or global
// git config — never overwrite a real developer's setup.
if (!env['GIT_AUTHOR_NAME']) env['GIT_AUTHOR_NAME'] = 'gitbraid-test'
if (!env['GIT_AUTHOR_EMAIL']) env['GIT_AUTHOR_EMAIL'] = 'test@gitbraid.local'
if (!env['GIT_COMMITTER_NAME']) env['GIT_COMMITTER_NAME'] = 'gitbraid-test'
if (!env['GIT_COMMITTER_EMAIL']) env['GIT_COMMITTER_EMAIL'] = 'test@gitbraid.local'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** @type {import('mocha').MochaOptions} */
const mochaOpts = {
    bail: !!process.env['CIRCLECI'],
    timeout: 10000,
    require: [
        'mocha',
        '@swc-node/register',
    ],
    reporter: 'spec',
}

const config = {
    /** @type {import('@vscode/test-cli').IDesktopTestConfiguration} */
    tests: [
        {
            files: [ "./test/**.test.ts" ],
            extensionDevelopmentPath: __dirname,
            launchArgs: [
                '--disable-crash-reporter',
                '--disable-dev-shm-usage',
                '--disable-extensions',
                '--disable-gpu',
                '--disable-telemetry',
                '--disable-updates',
                '--sync=off',
                '--no-sandbox',
                '--no-xshm',
            ],
            mocha: mochaOpts,
            workspaceFolder: './test_projects/proj1/'
        },
    ],
    /** @type {import('@vscode/test-cli').ICoverageConfiguration} */
    coverage: {
        // @vscode/test-cli's `lcovonly` reporter writes to `coverage/`
        // regardless of the `output` setting, so don't mislead by
        // specifying one.  CI reads `coverage/lcov.info` directly.
        reporter: [ 'text', 'lcovonly' ],
        // Restrict coverage to our own source — otherwise V8 follows
        // `.ts` source maps shipped inside `node_modules` packages
        // (e.g. ajv nested under @modelcontextprotocol/sdk) and
        // inflates the denominator of the coverage floor check.  `include`
        // whitelists what's reported; `exclude` is the belt-and-braces
        // safety net for anything that slips through.
        include: [ 'src/**' ],
        exclude: [
            '**/node_modules/**',
            'node_modules/**',
            '**/.vscode-test/**',
            '**/dist/**',
            '**/out/**',
            '**/test/**',
        ],
    }
}

export default defineConfig(config)
