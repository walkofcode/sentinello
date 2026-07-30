import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { WORKER_READY_LINE } from '../../../tests/e2e/portal/paths'

// A contract between this worker and the Playwright harness.
//
// The worker exposes no HTTP, so playwright.config.ts starts it with `wait: { stdout: ... }` and
// treats one specific log line as "ready". That makes an ordinary-looking edit to a console.log into
// a harness-breaking change — and the failure is a silent 60-second timeout on every e2e run, with an
// error naming Playwright rather than the line someone reworded.
//
// This test is cheap and turns that into an immediate, obvious failure at the point of the edit.
const HERE = dirname(fileURLToPath(import.meta.url))

describe('the worker readiness contract', function () {
    it('still prints the line the e2e harness waits for', function () {
        const source = readFileSync(resolve(HERE, 'worker.ts'), 'utf8')
        // The line is emitted with a conditional suffix for the watcher, so the constant must be a
        // prefix of what is printed rather than the whole statement.
        expect(
            source.includes(WORKER_READY_LINE.replace('[worker] ', '')),
            'apps/worker/src/worker.ts no longer prints "' + WORKER_READY_LINE + '". Playwright waits ' +
            'for that exact line to know the worker is up — update WORKER_READY_LINE in ' +
            'tests/e2e/portal/paths.ts to match, or the e2e suite will hang for 60s and blame itself.'
        ).toBe(true)
    })
})
