import { defineConfig } from '@vscode/test-cli'
import { fileURLToPath } from 'url'
import * as path from 'path'

// https://github.com/microsoft/vscode-test-cli/issues/48
import { env } from 'process'
delete env['VSCODE_IPC_HOOK_CLI']
env['DONT_PROMPT_WSL_INSTALL'] = true

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
        reporter: [ 'text', 'lcovonly' ],
        output: path.resolve(__dirname, 'artifacts'),
    }
}

export default defineConfig(config)
