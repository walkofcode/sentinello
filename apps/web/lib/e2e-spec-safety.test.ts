import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Mechanically enforces the one thing the portal e2e suite must never do.
//
// testSendNotificationTargetAction (apps/web/lib/actions/settings.ts) is the only notification action
// that fires a REAL outbound HTTP request, and it is not gated by the dryRunNotify flag that contains
// the worker's automatic dispatch. A spec that clicks it would POST to whatever host the fixture
// target names, from a developer laptop or from CI.
//
// A comment asking people not to is not enforcement. This is.
const HERE = dirname(fileURLToPath(import.meta.url))
const SPEC_DIR = resolve(HERE, '..', '..', '..', 'tests', 'e2e', 'portal')

// The button's accessible name (Settings.notifications.testAria) and the translation key behind it.
// Either appearing in a spec means someone is locating that control.
const FORBIDDEN = ['Test send', 'notifications.testAria']

function specFiles(dir: string): string[] {
    const out: string[] = []
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) out.push(...specFiles(path))
        else if (entry.name.endsWith('.spec.ts')) out.push(path)
    }
    return out
}

describe('the portal e2e specs', function () {
    it('never locate the live Test send button', function () {
        const offenders: string[] = []
        for (const file of specFiles(SPEC_DIR)) {
            const source = readFileSync(file, 'utf8')
            for (const needle of FORBIDDEN) {
                if (source.includes(needle)) offenders.push(file.replace(SPEC_DIR + '/', '') + ' → ' + needle)
            }
        }
        expect(
            offenders,
            'These specs reference the Test send control, which performs a real outbound POST: ' +
            offenders.join(', ') + '. Cover adding, editing, enabling, duplicating and deleting a ' +
            'target instead — the send itself is covered by the packages/notifications unit suite.'
        ).toEqual([])
    })
})
